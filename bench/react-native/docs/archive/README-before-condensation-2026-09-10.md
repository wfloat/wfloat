# Wfloat Bench · React Native

A small prototype: choose a local workload and display **OS thermal state,
Android current thermal headroom, battery temperature, signed battery current,
voltage and remaining charge, app CPU usage and Android CPU headroom, RSS
and platform-specific memory accounting, Android system available memory,
iOS memory-warning events and page-fault activity**. Android also displays
UID network receive/send byte and packet counters and rates, and offers manual
energy-monitor readings where the OS exposes them.
Android initially selects combined CPU/GPU stress; iOS selects CPU
stress. The LLM workload remains available on both platforms.
Only one workload can run at a time.

## Energy monitors (Android)

**Read energy monitors** uses the public Android 15 / API 35
`SystemHealthManager` power-monitor API. It enumerates the OS inventory and reads
cumulative energy since boot, including plugged-in use. A measured rail and a
subsystem consumer are labeled separately: consumers may combine rails or use
a model. Vendor names and coverage are device-specific. Do not sum monitors;
their coverage may overlap. These values cover device subsystems, not just the app.

The card displays joules and each snapshot's **age when read**. This age is
static until another manual read; it is not the age at the moment you look at
the screen. Snapshot time comes from the API's elapsed-realtime timestamp,
independently of request and callback times. Android may cache readings and
add noise even to measured-rail values. Repeated requests need not produce new
snapshots. Waiting about 25 seconds is an initial freshness experiment, not a
portable refresh guarantee or hardware sampling interval. No watts or inferred
per-inference energy are displayed.

There is no automatic polling, permission request or inference-SDK change.
Reads require the foreground app and allow one active request. A 10-second
watchdog frees a stalled request for retry; the API provides no cancellation
handle, so late callbacks are discarded. Backgrounding cancels publication and
clears the displayed result. Original monitor objects and their inventory-local
identities are retained for subsequent reads; names alone are not identities.

API-too-old, empty enumeration, missing energy (`ENERGY_UNAVAILABLE = -1`),
errors and genuine zero energy remain distinct. Empty enumeration cannot explain
whether hardware is absent or the service is disabled. `WfloatEnergy` logs retain
exact signed 64-bit energy and snapshot integers as decimal strings, query and
callback timing, raw names/types, fingerprint and fine-access permission state.
One request summary and one entry per monitor avoid a large single logcat row;
use the inventory ID, PID and request sequence to join them, and require the
reported row count. The app neither requests nor grants fine-access permission.

Sources: [SystemHealthManager](https://developer.android.com/reference/android/os/health/SystemHealthManager),
[monitor types](https://developer.android.com/reference/android/os/PowerMonitor),
[energy units and timestamps](https://developer.android.com/reference/android/os/PowerMonitorReadings),
[Android 16 reference cache/noise implementation](https://android.googlesource.com/platform/frameworks/base/+/android16-release/services/core/java/com/android/server/powerstats/PowerStatsService.java).

### Idle-versus-CPU energy comparison

**Compare idle and CPU energy** opens a dedicated screen and unmounts the
dashboard. Each phase settles for 35 seconds, then measures for 35 seconds.
The second phase uses the existing CPU arithmetic workers, ramps to all cores
over 20 seconds and has a native 120-second maximum. No GPU workload or model is
started. The run stops on cancellation, backgrounding, a nonzero/unavailable
thermal state or unexpected workload state. Native thermal/foreground guards
operate independently of JavaScript. CPU workers must drain before completion.

The result lists each monitor's energy change in joules, its actual snapshot
interval and average watts (`delta joules / delta seconds`). Cumulative counters
are subtracted as decimal strings before conversion, preserving small differences
between large integers. The app flags missing energy, repeated/backwards
timestamps, decreasing counters and phase contamination. Valid snapshot intervals
must span 25–50 seconds; this is an experiment acceptance rule, not an OS cadence
claim. CPU snapshots must start after the 20-second ramp. A CPU utilization
comparison from adjacent process-counter reads verifies that load increased;
those CPU timing boundaries are not identical to every energy snapshot.

This is one ordered idle/load pair. It measures whole-subsystem response, with
OS activity, Android noise, thermal drift and farm instrumentation included.
Lifetime native observers remain active in both phases; dashboard polling is
paused. The idle-to-load watt difference is descriptive, not exact app-attributed
power. Negative differences are retained. Monitor coverage can overlap, so no
total is calculated. Emulator results validate software behavior only.

Energy records use `collectionMode: comparison`. Separate `WfloatEnergyCheck`
records identify the run, phases, boundary energy references, CPU/thermal/workload
evidence, per-monitor calculations and completion or cancellation. A complete
export joins these references to the original `WfloatEnergy` rows and checks the
declared row counts. The native permission/access path is unchanged.

## Battery voltage (Android)

The card displays **volts**, with three decimal places preserving the raw
**millivolts** reported by `ACTION_BATTERY_CHANGED` / `EXTRA_VOLTAGE`.
This is battery voltage, not charger voltage, and displayed resolution does
not establish accuracy. No SDK or iOS collector is added.

Voltage uses the existing foreground battery receiver and background handler;
there is no additional OS listener or sensor poll. Each voltage report shares
the temperature report's PID, sequence and wall/monotonic receipt timestamps,
with its own source, raw value, conversion and availability. Battery presence,
charging and connection fields come from that same broadcast. A missing voltage
or absent battery shows **Unavailable**. Zero is retained as raw evidence but
marked **Unavailable** because it supplies no usable positive battery voltage;
this does not diagnose why the OS reported zero. A negative or malformed voltage
shows **Read failed**. No arbitrary device-specific upper-voltage cutoff is used.

The UI reads the existing native cache about every two seconds while active.
Cache reads retain the report's identity and timestamps; only an actual OS
delivery produces a new `WfloatBatteryVoltage` JSON row. Initial sticky reports,
including after resume, are explicitly labeled as cached. Monitoring unregisters
in the background, and stale JS responses are discarded across lifecycle changes.

The voltage card prominently shows **time since this app received the report**,
updated by that same cache read. Age uses Android's monotonic clock, so changing
the wall clock does not change it. A sticky report has unknown original age and
is labelled accordingly, including after resume. Cache reads and refresh requests
do not reset the age; a newly received OS report does. This is receipt age, not
sensor age, and the UI assigns no arbitrary fresh/stale threshold.

**Receipt time is not sensor time.** Another battery field can trigger a report
without a new voltage measurement. Sharing a broadcast with temperature also
does not prove their sensors sampled simultaneously. Android supplies no sensor
timestamp here (`sensorSampledAtMs: null`). Current uses a separate property-query
path; this increment does not multiply the readings into watts or integrate
energy. Logcat remains rotating diagnostic evidence with uncalibrated overhead.

Sources: [battery voltage extra](https://developer.android.com/reference/android/os/BatteryManager#EXTRA_VOLTAGE),
[Android broadcast and millivolt mapping](https://android.googlesource.com/platform/frameworks/base/+/master/services/core/java/com/android/server/BatteryService.java).

### Experimental battery refresh

The voltage card has an optional **60-second refresh probe**. It sends at most
30 requests, two seconds apart on the native battery handler, and stops on
completion, Stop, backgrounding or an access failure. Passive reporting remains
the default. Requests do not manufacture battery reports or update cached
voltage timestamps.

The probe uses a hidden `ServiceManager.getService("batteryproperties")` lookup,
checks the Binder interface descriptor, then sends the one-way
`IBatteryPropertiesRegistrar.scheduleUpdate` transaction. AOSP's interface layout
was checked for Android 10–16 (API 29–36); the probe rejects other API levels.
The numeric transaction is an internal implementation detail: an OEM can change
it, and an accepted one-way request does not confirm service execution. This is
a compatibility experiment, not a portable Android API guarantee. No shell
process, root access, permission grant or hidden-API exemption is used by the app.

`WfloatBatteryRefresh` records each start, request and stop, with app UID/PID,
target/device API, build fingerprint, monotonic and wall timing, call duration,
previous voltage receipt sequence and an explicit outcome. Temperature, voltage
and current rows carry `collectionMode` and `refreshProbeId`; these identify a
collection window, not a causal relationship or sensor freshness. The UI's
report count excludes initial sticky deliveries but can include updates triggered
by battery fields other than voltage. End-to-end collection overhead remains
unmeasured; one-way call duration excludes asynchronous system work.

When validating ordinary-app access with automation, verify Android's hidden-API
policy and recreate the app process after enabling enforcement. Appium can relax
that policy during setup, which would otherwise confound an access experiment.

Sources: [Android 10 interface](https://android.googlesource.com/platform/frameworks/base/+/android-10.0.0_r1/core/java/android/os/IBatteryPropertiesRegistrar.aidl),
[Android 16 interface](https://android.googlesource.com/platform/frameworks/base/+/android-16.0.0_r1/core/java/android/os/IBatteryPropertiesRegistrar.aidl),
[non-SDK restrictions](https://developer.android.com/guide/app-compatibility/restrictions-non-sdk-interfaces),
[Appium's hidden-API policy capability](https://github.com/appium/appium-uiautomator2-driver#capabilities).

## Battery current (Android)

The card displays signed **mA**, preserving Android's raw integer from
`BATTERY_PROPERTY_CURRENT_NOW`: positive enters the battery, negative leaves,
and zero remains a valid reported value. This is net battery flow, not total
phone power or app-attributed consumption. External power can supply the phone
while the battery charges, stays flat or discharges. No iOS equivalent or
inference-SDK API is added.

The native collector calls `BatteryManager.getLongProperty` on the existing
battery handler thread. Both property getters use the same underlying Android
query; the long getter preserves `Long.MIN_VALUE` on older Android releases
whose int getter can truncate that sentinel to zero. Decode the sentinel before
crossing the JS bridge, retain its exact decimal string and show **Unavailable**
(unsupported or service error). Missing service/battery and thrown failures
remain explicit. Values outside the current property's signed-int range are
errors, not silently rounded measurements. `rawPropertyValue` retains the exact
OS integer; `rawMicroamps` names that integer using Android's declared unit.
The display always divides by 1000 to convert the API-declared µA to mA.

**Known issue:** some Samsung firmware returns mA through Android's µA API,
making that display 1,000× too small. The app mentions this limitation and
applies no device-specific correction. See the brief
[issue note and evidence](./battery-current-units.md).

The UI requests a reading two seconds after the previous request completes,
with only one request in flight, while foregrounded. Pausing cancels scheduling;
resume starts fresh and ignores old bridge responses. Native wall and monotonic
timestamps bracket the property query; each row keeps its duration, PID,
sequence, OS/API version and `sensorSampledAtMs: null`. **API query time is not
sensor sample time**: the fuel gauge/OS may return cached values, and polling
does not establish its refresh rate or accuracy. The three decimal places in
mA preserve the API-declared integer µA representation, not an accuracy claim
or proof that the firmware uses those units.

Charging/presence/plugged context comes from the last separately delivered
battery broadcast, with its own receipt time, origin and sequence. It is not
an atomic snapshot with current. A missing context does not suppress an
otherwise valid current read. Each accepted query logs one `WfloatBatteryCurrent`
JSON row; repeated numeric values remain separate API reads. Logcat is rotating
diagnostic storage; collector and observer overhead remain uncalibrated.

Sources: [Android battery property contract](https://developer.android.com/reference/android/os/BatteryManager#BATTERY_PROPERTY_CURRENT_NOW),
[Android 7 getter implementation](https://android.googlesource.com/platform/frameworks/base/+/android-7.0.0_r1/core/java/android/os/BatteryManager.java),
[current getter implementation](https://android.googlesource.com/platform/frameworks/base/+/main/core/java/android/os/BatteryManager.java).

## Battery charge remaining (Android)

The card reads `BATTERY_PROPERTY_CHARGE_COUNTER` and displays estimated
remaining battery charge in **mAh**, retaining Android's integer **µAh**.
This is a remaining quantity that can rise or fall, not a lifetime consumption
or charge-cycle counter. Zero remains a reported value and does not establish
a physically empty battery. Negative or out-of-range readings retain their
raw evidence with an error.

`BatteryManager.getLongProperty` runs on the existing battery handler. The long
getter preserves the unavailable sentinel before crossing the JS bridge,
including on older Android versions whose integer getter could truncate it to
zero. A successful numeric return does not establish functioning sensor support:
some configurations can report a flat zero despite a full battery and changing
current. The UI preserves that zero with an explicit interpretation caveat.
`Long.MIN_VALUE` means unsupported or a service error; absent battery,
missing service and thrown exceptions remain explicit. No new permission,
hidden API, battery override or inference-SDK change is needed by this collector.

One query runs at a time, with the next scheduled two seconds after completion
while foregrounded. Backgrounding clears the display and cancels scheduling;
resume requests a new sample and ignores stale bridge responses. Native
`WfloatBatteryCharge` JSON rows preserve the exact decimal property string,
µAh/mAh, availability/reason, battery scope, PID/sequence, OS/API and build-based
emulator detection, wall times and `SystemClock.elapsedRealtimeNanos` query
bounds/duration. They also identify passive or experimental-refresh collection
windows without claiming that a refresh request caused a new sensor reading.

Charging context comes from the last separately delivered battery broadcast,
with its own receipt time and origin. It is not simultaneous with the property
query. Sensor time is unavailable; query frequency and three displayed decimal
places do not establish fuel-gauge update rate, resolution or accuracy. The
card retains the latest sample; logs preserve each query, subject to logcat
rotation. Collector overhead remains uncalibrated.

On a powered device-farm phone, a change describes **net battery charge**, not
total phone or app energy. External power can support the workload with little
battery change. Fuel-gauge estimates can also be adjusted internally. No watts,
joules, energy-efficiency ranking or derived current is produced by this card.
Physical-device access and useful changes over test durations must be verified
on each relevant configuration; emulator data is synthetic.

Sources: [Android charge-counter API](https://developer.android.com/reference/android/os/BatteryManager#BATTERY_PROPERTY_CHARGE_COUNTER),
[fuel-gauge properties and limitations](https://source.android.com/docs/core/power/device),
[Android 7 property getters](https://android.googlesource.com/platform/frameworks/base/+/android-7.0.0_r1/core/java/android/os/BatteryManager.java).

## Battery temperature (Android)

The card displays the temperature reported by
`ACTION_BATTERY_CHANGED` / `BatteryManager.EXTRA_TEMPERATURE`, converted from
tenths of a degree Celsius. This identifies the battery; CPU/GPU temperatures
are separate measurements. The decimal resolution does not establish sensor
accuracy. There is no new iOS collector or inference-SDK API.

A native receiver listens while the app is foregrounded, using a background
handler thread. Each OS delivery retains the raw integer, converted value,
battery-presence flag, charging status and plugged state, PID, sequence, OS/API
version and wall/monotonic receipt timestamps. Charging status and connection
state are independent context fields. An absent battery or missing temperature
shows unavailable; malformed temperature data shows an error. Zero and negative
temperatures remain valid reported values.

**Receipt time is not sensor sample time.** The initial sticky broadcast is
labeled as a cached OS report, including after foreground resume. Later battery
updates may be triggered by another field without a new temperature measurement.
Android does not give this collector a sensor timestamp or a refresh-rate
guarantee. The UI checks the native cache every two seconds; that does not query
the sensor, change receipt timestamps or create another report.

The receiver unregisters in the background and on module cleanup. Delayed JS
responses across lifecycle transitions are discarded. One `WfloatBattery`
logcat JSON line records each actual delivery, including its cached/broadcast
origin; cache reads do not log. Logcat remains rotating diagnostic storage and
collection/observer overhead remains uncalibrated. Emulator overrides check
conversion and delivery behavior, not physical temperature response.

Sources: [Battery API](https://developer.android.com/reference/android/os/BatteryManager.html#EXTRA_TEMPERATURE),
[sticky battery report](https://developer.android.com/reference/android/content/Intent.html#ACTION_BATTERY_CHANGED),
[temperature units](https://android.googlesource.com/platform/hardware/interfaces/+/master/health/aidl/android/hardware/health/HealthInfo.aidl).

## Current thermal headroom (Android)

The card reads `PowerManager.getThermalHeadroom(0)` on Android 11 / API 30+.
Despite its name, **higher values mean more thermal stress**: 1.0 is the severe
throttling threshold. Zero is valid and values above 1.0 are retained. It is a
normalized OS estimate based on slow-moving thermal sensors, not degrees Celsius,
remaining performance, or an exact translation of the thermal category.
No equivalent iOS metric is claimed or displayed.

Sampling runs on a native background queue while the app is foregrounded.
A process-wide guard waits at least 10 seconds after each query completes,
including unavailable/error results. Earlier requests return the cached sample
with its original timestamp and sequence. This conservative cadence follows
Android's older-device guidance; the current API reference permits faster
sampling on newer implementations. It is independent of the thermal-category
monitor and does not change any workload stop condition.

Each actual query retains the raw float/string, availability/reason, source,
zero-second forecast horizon, API/OS version, PID, sequence, native wall and
monotonic timestamps, query duration and a nearby thermal-category reading.
`NaN` displays **Unavailable**, with support, readiness and rate limiting left
as possible causes. It never becomes zero. Read failures remain explicit.
Stale bridge responses across background transitions are discarded.

For prototype evidence, each actual query writes one JSON line under the
`WfloatHeadroom` logcat tag. Cached deliveries do not log another sample.
Logcat is a rotating diagnostic buffer, not durable run storage. Logging and
collector overhead remain uncalibrated. Emulator values only prove the code
path; physical support and response must be tested per device/OS.

Sources: [Android API contract](https://developer.android.com/reference/android/os/PowerManager.html#getThermalHeadroom(int)),
[Android thermal guidance](https://developer.android.com/games/optimize/adpf/thermal).

## App resident memory (RSS)

The card reports **current process RSS in MiB** (1,048,576 bytes), including
shared resident pages. It covers the whole app process, not just a model or
the JS/native heap. It is distinct from peak RSS, proportional set size (PSS)
and Apple's physical footprint; those counters must keep separate names.

Android reads `Rss` from `/proc/self/smaps_rollup`, falling back to the sum of
`Rss` entries in `/proc/self/smaps` if the rollup cannot be opened. These
page-table readings avoid the asynchronously updated fast RSS counters in
`statm`/`status`, at a higher collection cost. iOS reads `resident_size` from
`task_info(MACH_TASK_BASIC_INFO)`. Neither collector needs a farm integration
or changes to an inference SDK. Device/OS access still needs physical testing.

Both run on a native background queue, sampled about every two seconds while
foregrounded. Each sample retains bytes, source, PID, native wall/monotonic
timestamps, query duration and held test bytes. The latest 120 samples remain
in component memory; persistent export and collector-overhead calibration are
deferred. Failures show an error, not zero; stale responses across background
transitions are discarded. Current RSS polling can miss short-lived memory peaks; the separately named OS peak below has its own accounting limits.

**Hold 64 MiB to check** creates a temporary anonymous native mapping and writes
each page. **Release** unmaps it directly, so allocator retention does not hide
the expected drop. The native collector also releases it after 60 seconds, on
backgrounding, or on module cleanup. A second hold cannot stack allocations.
This checks the measurement path; normal app activity can change the total
alongside the probe, and virtual devices do not establish physical-phone RAM
requirements. Starting the check is disabled during a running workload.
Holding a mapping does not lock its pages in RAM: compression or reclamation
can reduce RSS before release. Held bytes report the allocation, not residency.

### Peak RSS since process start

The card preserves the **OS-recorded process-lifetime peak RSS**, in MiB.
Android reads `getrusage(RUSAGE_SELF).ru_maxrss` and converts KiB to bytes with
an exact-integer range check. iOS reads `TASK_VM_INFO.resident_size_peak` in bytes
from the Mach response already queried for footprint, checking the returned
structure revision independently. This is peak RSS, not peak PSS or peak physical
footprint.

The value can preserve evidence of memory bursts between our two-second polls.
It does not identify when the peak occurred, which workload caused it, or the
peak of each benchmark run. Releasing memory and backgrounding do not reset it.
A fresh process begins its own accounting. Earlier startup activity can exceed
a later test allocation,
so an unchanged peak during another allocation can be valid. Differences between
before/after lifetime peaks do not yield a per-run peak.

This is the OS's recorded high-water mark, not a guarantee of a perfectly captured
instantaneous maximum. Android's current RSS comes from a smaps page-table walk,
while `ru_maxrss` uses the kernel's RSS accounting. They have different timing
and accounting precision, so the app does not clamp the OS peak upward to a
current smaps value or substitute a maximum of its own samples. Mach current RSS
and peak are also queried sequentially. Platform definitions remain named.

`peakRss` preserves bytes, source, the explicit `process_lifetime` scope, and an
error when unavailable. A peak failure leaves a valid current RSS/PSS/footprint
visible. Validation rejects missing provenance, imprecise integers, out-of-order
readings, and a decreasing peak within the same process identity. An unavailable
reading or foreground transition does not erase the last valid peak used for
these checks; the display waits for a fresh native reading after resume.

`WfloatMemory` (Android) and numbered `WfloatMemoryChunk` records (iOS)
preserve every native memory snapshot, including
peak, current memory, held probe bytes, PID, sequence, platform/OS metadata,
wall time, named monotonic clock, and query bounds. Bounds bracket all memory
queries and exclude logging/bridge/rendering overhead. Native foreground checks
suppress background snapshots while cleanup still releases held allocations.

The existing 64 MiB hold/release button checks that current memory rises and
falls while the peak persists. The standalone native test also touches and
releases 64 MiB without an intermediate read, checking an unsampled burst. It
runs before other test allocations so a previous larger peak cannot mask it.

Sources: [Linux getrusage](https://man7.org/linux/man-pages/man2/getrusage.2.html),
[Apple resident peak accounting](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c).

### Android PSS and iOS physical footprint

The memory card also displays the platform's additional counter, with a
separate name and interpretation:

| Platform | Counter | Meaning and source |
|---|---|---|
| Android | **PSS**, in MiB | Private resident pages plus a proportional share of shared pages. Read `Pss` alongside `Rss` in the same `smaps_rollup` scan, or sum per-mapping `Pss` in the `smaps` fallback. `SwapPss`, `Pss_Dirty` and other subcounters are not added to it. |
| iOS | **Physical footprint**, in MiB | OS-accounted memory charged to the app, including compressed memory. Read `phys_footprint` from `task_info(TASK_VM_INFO)` and verify the returned structure revision includes that field. |

PSS and physical footprint are **different metrics**, not interchangeable
cross-platform totals. Android's value covers the kernel's mapped-memory PSS;
it does not add Android framework/vendor estimates for other resources.
The smaps fallback sums values rounded to KiB per mapping, so it can differ
slightly from rollup accounting. PSS can also change when other processes
start or stop sharing a page, without our app allocating or freeing it.

On Apple, compression can reduce RSS while the allocation still contributes
to footprint. Footprint is not a count of live heap objects or model bytes,
and a falling RSS alone does not demonstrate that an allocation was freed.

Both counters use the existing two-second polling and 64 MiB hold/release
check. A sample retains either a named `pss` or `physicalFootprint` object with
bytes, source and an explicit error. An unavailable additional counter shows
an error beside a still-valid RSS value; it never becomes zero. The common
query duration/timestamps now bracket both reads. On iOS the two Mach calls
are sequential, not an atomic snapshot. Measurement overhead remains uncalibrated.

Sources: [Linux RSS/PSS accounting](https://www.kernel.org/doc/html/latest/filesystems/proc.html),
[Apple footprint and memory limits](https://developer.apple.com/videos/play/wwdc2022/10106/?time=604),
[Mach task-info fields](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/task_info.h).

Native parser/allocation tests:

```sh
clang++ -std=c++17 -O2 -pthread tests/resident-memory.cpp -o /tmp/wfloat-resident-memory-test
/tmp/wfloat-resident-memory-test
```

Sources: [Linux process memory accounting](https://www.kernel.org/doc/html/latest/filesystems/proc.html),
[Apple Mach task information](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/task_info.h).

### Android virtual memory area count

The app counts complete VMA records from `/proc/self/maps`. A virtual memory area
is a contiguous address range with common mapping attributes. Splitting or merging
areas can change the count without changing mapped bytes or resident RAM. The
count covers this process, including the runtime and collectors. It does not count
heap objects, allocation calls, unique backing objects or leaks. Android VMAs and
iOS top-level map entries have different accounting and are not interchangeable.

The `vmas` object retains the derived integer as `rawCount`, its numeric count,
source, calling-process scope, region units, gauge aggregation and independent
errors. The parser validates address ranges, ordering, permissions and required
numeric fields, then discards each line. Addresses and paths are not retained in
the sample. Empty, malformed, unterminated or failed reads produce unavailable
values, never a partial count. The collector caps counting at INT32_MAX with an
explicit error; this is a collector limit, not an asserted OS limit. The bridge
contract accepts numeric zero, but an empty maps file is treated as a read failure.

This adds one maps scan per existing foreground memory query, inside its timing
bounds. Cost grows with the mapping list and is not yet calibrated. Maps can change
while being read; this is a scan observation, not a guaranteed atomic snapshot or
a synchronized snapshot with RSS and virtual size. No SDK API, permission or app
control was added. Background pause follows the existing memory collector.

`tests/android-vmas.cpp` validates parser failures and an untouched 65-page
mapping split with alternating permissions. The controlled test checks the count
response, unchanged virtual size, cleanup, and an independent newline count of
the quiescent process's maps file. JavaScript tests cover exact counts, gauge
increases/decreases, provenance and independent unavailable states.
Physical-device access and representative overhead still need validation.

Source: [Linux process maps documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

### iOS memory-region count

`TASK_VM_INFO.region_count` reports the number of entries in the process's
top-level virtual memory map. It counts map entries, including submap entries,
without recursively counting their contents. It is a current gauge: creating,
splitting, merging or removing mappings can raise or lower the count. It does
not count bytes, heap objects, allocation calls, unique backing objects or leaks.
Growth across comparable repeated workloads is a reason to investigate mappings,
not proof of a leak or a measure of address-space fragmentation.

The existing Mach query supplies the field. `regions` retains the exact signed
raw count, source, `calling_process` scope, `regions` unit, `gauge` aggregation,
simulator/device environment and independent errors. A failed or short reply is
unavailable. Negative values remain raw diagnostics with no numeric count;
zero is valid. The signed 32-bit range is preserved without rate derivation or
monotonicity assumptions. No new OS query, permission or Wfloat SDK API is added.
Foreground polling and background cleanup follow the existing memory collector.

`tests/memory-regions.cpp` reserves 65 untouched pages, gives alternating pages
read permission, restores uniform permissions, then releases the mapping. This
checks region growth without a virtual-size or resident-memory increase, and
cleanup back to baseline. Restoring permissions may permit coalescing; immediate
merging is observed in this test but is not a promise for arbitrary mappings.
Fixture and JavaScript tests cover field selection, reply revisions, signed
bounds, independent errors and gauge semantics. Simulator behavior does not
establish physical-iPhone coverage or representative collection overhead.

Source: [XNU exports the map's entry count](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c).

### iOS peak physical footprint

`TASK_VM_INFO.ledger_phys_footprint_peak` reports the OS-maintained lifetime
maximum of this process's physical-footprint ledger. It complements current
physical footprint and includes compressed-memory accounting. It is separate
from peak resident RAM, virtual address-space reservations and model allocations.
Earlier activity in the same process counts, including peaks between polls;
background/resume does not reset it. A new process has its own history.

The existing Mach query supplies the field when its reply includes revision 3.
`peakPhysicalFootprint` retains source, byte units, process-lifetime scope,
simulator/device environment and exact signed raw bytes. Mach failures or short
replies are unavailable; negative values remain raw diagnostic data with an error.
Values beyond JavaScript's exact integer range retain their raw decimal string
but no rounded numeric value. Zero is valid. Availability is independent of
current footprint, RSS and the other memory readings. The app does not compute
a sampled maximum, clamp the value upward, or reset the OS ledger for a run.
Current and peak fields are read within the same query but are not promised to
be an atomic snapshot while other threads allocate or release memory.

The card displays MiB. Simulator readings reflect the Mac's memory management;
physical-iPhone behavior and representative overhead need separate validation.
No additional OS query, permission or SDK change is required by this collector.

`tests/peak-physical-footprint.cpp` checks reply revisions, signed raw values and
field selection, then touches and releases 128 MiB entirely between collector
reads. The next read must retain the peak while current footprint recovers;
a smaller allocation must not lower it. A direct Mach reply checks the retained
value. `tests/peak-physical-footprint.test.mjs` validates the bridge contract,
including independent unavailable states and exact integer boundaries.

Sources: [Apple task VM fields](https://developer.apple.com/documentation/kernel/task_vm_info_data_t),
[XNU lifetime-footprint export](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c).

### Android private dirty memory

The memory card also shows `Private_Dirty`: resident pages classified by the
kernel as private and modified. This is a **subset of RSS/PSS**, not an amount to
add to them. It covers the whole process, including runtime allocations; it is
not a model-memory counter. Read-only model mappings can occupy resident memory
without contributing to private dirty. This counter does not include swapped-out
pages. See the [Linux memory-accounting definitions](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

The existing smaps scan now reads RSS, PSS and private dirty together. It prefers
`/proc/self/smaps_rollup:Private_Dirty`, falling back to
`/proc/self/smaps:sum(Private_Dirty)`. Missing, malformed, duplicate or overflowing
private-dirty fields produce an independent **Unavailable** state, preserving
valid RSS/PSS. Each mapping must supply the field in the fallback. Other fields
such as `Pss_Dirty`, `Shared_Dirty` and `Private_Clean` are not added to it.

The additive `privateDirty` object retains `bytes`, exact `rawBytes`, source,
`calling_process` scope, unit and an explicit error. Source `kB` units are
converted using 1,024 bytes; the UI displays MiB. Values outside JavaScript's exact
integer range retain their raw string and an unavailable numeric value. Existing
process identity, sequence and query timing cover the combined read, with the
same two-second foreground cadence and bounded 64 MiB write/release check.
Memory can change during collection, so the values are not an atomic snapshot.

The native tests check rollup and per-mapping parsing, independent failures,
an untouched address-space reservation, and three written 64 MiB allocations
followed by release. Android in-app validation uses the existing **Hold 64 MiB**
button. No new native query, SDK interface, Android permission or iOS metric is
introduced.

### Android private clean memory

`Private_Clean` completes the private clean/dirty split in the memory card.
It counts resident pages the kernel classifies as private and clean; this can
include file-backed pages. It does not measure total file-cache size or all
read-only model weights. Pages can move between private and shared accounting
as their mappings change. Like private dirty, it is already part of RSS/PSS.
See the [kernel accounting definitions](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

The same scan reads `/proc/self/smaps_rollup:Private_Clean`, with a fallback to
`/proc/self/smaps:sum(Private_Clean)`. The independent `privateClean` object uses
the same source, raw-byte precision, process scope, timing and unavailable-state
contract as `privateDirty`. Missing or malformed clean data does not hide valid
dirty, RSS or PSS readings. No extra scan, SDK API or Android permission is added.

**Hold 64 MiB clean file pages** creates a private temporary file in the app cache,
writes and syncs its contents, maps it read-only, then verifies one byte per page.
The descriptor closes after mapping and the file is unlinked immediately after
creation. Release unmaps it; no named test file remains. This exercise deliberately
affects memory, storage-I/O and page-fault counters. It is not a storage-speed or
cold-cache test, and it does not lock pages against reclamation.

Only one memory check can be active. Manual release, backgrounding, module
teardown and a 60-second native deadline release its mappings. Disk preparation
is bounded to 64 MiB but a blocked system call cannot be interrupted; lifecycle
cleanup follows when it returns. Android rows retain `heldKind` (`none`,
`file_clean`, `file_clean_twice`, `anonymous_dirty`, `shared_dirty_once`,
`shared_dirty_twice`), `heldBytes` (total mapped bytes), `heldFileBytes` (the clean
check's unique file size, or zero), and `heldSharedRegionBytes` (the shared dirty
check's region size, or zero). These describe the check's resources, not their
current residency.

`tests/private-clean.cpp` verifies parsing, error isolation, three file-mapping
cycles, repeated release, failure recovery, destructor cleanup and descriptor
counts. Its live allocation checks require Linux/Android and a writable directory
argument. iOS keeps its existing metrics and anonymous allocation check.

### Android shared clean memory

`Shared_Clean` counts resident clean pages the kernel classifies as shared.
Repeated mappings of a page within the same process can count as shared too;
this is not limited to pages shared with other apps. RSS counts those mappings
fully, while PSS apportions shared pages. Do not add shared clean on top of RSS
or interpret it as uniquely owned physical memory. Private/shared accounting
does not simply follow the `MAP_PRIVATE`/`MAP_SHARED` flag; see the
[kernel definitions](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

The existing scan reads `/proc/self/smaps_rollup:Shared_Clean`, falling back to
`/proc/self/smaps:sum(Shared_Clean)`. The additive `sharedClean` object follows
the private counters' exact raw-byte, source, scope and independent error
contract. Zero is valid. Existing process identity and query timing cover this
field too; there is no additional scan, SDK API or permission.

**Map 64 MiB clean file twice** prepares the same synced file as the private-clean
check and reads two read-only mappings of it. **Remove second mapping** leaves
the first mapping open without resetting the original release deadline. On the
tested Android emulator, two mappings added 128 MiB of shared clean and about
64 MiB of PSS. Removing one mapping moved the remaining 64 MiB into private
clean, with unchanged PSS in the isolated native test. These are observed kernel
accounting transitions, not values manufactured from the check's size. Pages
remain reclaimable, and live process activity or kernel configuration can affect
the result.

`tests/shared-clean.cpp` verifies parsing and independent failures, three
two-to-one-to-zero mapping cycles, failure recovery, descriptor cleanup and
destruction. Live allocation checks require Linux/Android and a writable
directory. The React Native release app also exercises the transitions and
background/deadline cleanup. This metric is Android-only.

### Android shared dirty memory

`Shared_Dirty` counts resident pages the kernel classifies as shared and
modified, including shared-memory pages. As with shared clean, repeated
mappings inside one app can count as shared. The value is included fully in
RSS and proportionally in PSS; it is not additional memory to add to either,
nor a measurement of pending disk writes.

The existing scan reads `/proc/self/smaps_rollup:Shared_Dirty`, falling back to
`/proc/self/smaps:sum(Shared_Dirty)`. The additive `sharedDirty` object retains
exact raw bytes, unit, calling-process scope, source and an independent error.
It preserves zero and uses the existing sequence and query bounds. Malformed,
missing, duplicate or overflowing shared-dirty fields do not hide valid RSS,
PSS or other clean/dirty counters. No additional sampling query is needed.

**Map 64 MiB dirty region twice** uses the public
[`ASharedMemory_create`](https://developer.android.com/ndk/reference/group/memory#asharedmemory_create)
API, available from Android 8 / API 26. It maps one region twice with
`MAP_SHARED`, writes one byte per page through the first mapping, and verifies
the value through the second. This uses shared memory rather than a disk test
file. The descriptor closes after mapping; the mappings keep the region alive.
The API is resolved when the check runs, allowing the collector to continue
loading on the app's API 24 minimum. On API 24/25 the check button is disabled;
the shared-dirty metric remains independently readable.

**Remove second mapping** leaves one mapping and preserves the original
60-second deadline. On the tested emulator, two mappings added 128 MiB of
shared dirty and about 64 MiB of PSS. Removing one moved the remaining 64 MiB
into private dirty without changing PSS in the isolated test. These are live
kernel readings; no counter is derived from the check's capacity. The check
does not pin pages or continuously write to keep the gauge at a target value.
Manual release, backgrounding and teardown release both mappings.

`tests/shared-dirty.cpp` covers parser failures and provenance, verified aliasing,
three two-to-one-to-zero cycles, duplicate-action rejection, repeated release,
descriptor counts and destructor cleanup. Live shared-memory checks require
Android API 26 or later. The existing shared-clean check is regression-tested
after extending the common mapping cleanup. No Wfloat SDK or iOS metric changes.

### Android peak virtual memory

`VmPeak` is the largest virtual address-space size recorded by the OS for the
current process. It includes earlier reservations that were released between
polls. It persists across background/resume and is separate from peak resident
RAM, current virtual size and model-allocation totals. A fresh app process has
its own peak, which may already include startup activity.

The existing status scan reads `/proc/self/status:VmPeak`. The `peakVirtual`
object preserves exact raw bytes, units, source, `process_lifetime` scope and
independent errors. Missing, malformed, duplicate or overflowing values stay
unavailable; zero is valid. The app neither synthesizes this peak from its polls
nor clamps a reported value upward. Android status and smaps remain sequential
reads inside the existing query bounds.

`tests/peak-virtual-memory.cpp` reserves and unmaps 128 MiB entirely between
collector reads, then verifies that the OS retained the peak while current
virtual size returned to baseline. A smaller reservation must not lower the
peak. This is a standalone diagnostic, not a new app button. Parser fixtures
and `tests/peak-virtual-memory.test.mjs` check independent failures and the bridge
contract. No extra query, permission, Wfloat SDK API or iOS metric is added.

Source: [Linux VmPeak export](https://github.com/torvalds/linux/blob/master/fs/proc/task_mmu.c).

### Android locked memory

The `VmLck` card shows memory ranges marked as locked against swapping, in KiB
(1 KiB = 1,024 bytes). It reads `/proc/self/status:VmLck` alongside `VmPTE` and
`VmSize` in the existing foreground poll. Exact raw bytes, source, scope, units
and independent errors cross the bridge in `locked`. Missing, malformed,
duplicate or overflowing values remain unavailable; zero is valid.

This is lock accounting, not an additional amount to add to RSS or a measurement
of every kind of pinned memory. Deferred locking (`MLOCK_ONFAULT`) can count
ranges whose pages have not become resident yet. The value also does not report
the process's permission or remaining allowance to lock more memory.

Collection does not lock memory. `tests/locked-memory.cpp` separately checks
four pages under the process's existing `RLIMIT_MEMLOCK`: lock, repeated lock,
unlock, unmap cleanup and deferred locking with a residency check. Unsupported
locking is reported separately from reading the counter. The test changes no
limits and uses no elevated permissions. `tests/locked-memory.test.mjs` checks
the bridge contract. No new OS query, app control, permission or SDK API is added.

Sources: [Linux status fields](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
and [Linux memory locking semantics](https://man7.org/linux/man-pages/man2/mlock.2.html).

### Virtual memory size · Android and iOS

The virtual-memory card shows address space mapped or reserved by the app,
including nonresident pages. A large value can exceed device RAM without using
that much physical memory. It is neither RSS, free memory, swap usage nor a
model-allocation total. Runtime reservations and OS mappings can dominate it;
compare changes within a controlled run before interpreting cross-device totals.

Android reads `VmSize` alongside `VmPTE` in one `/proc/self/status` scan. Fields
fail independently; file-read failure makes both unavailable. The kernel's `kB`
values become bytes with overflow checks. iOS uses `virtual_size` from the
existing `MACH_TASK_BASIC_INFO` reply that supplies RSS. Both bridges preserve
exact raw bytes, source, process scope, units and errors in `virtualSize`.
Missing/invalid data stays unavailable, zero is valid, and unsafe JavaScript
integers retain their raw value without a rounded numeric result.

This uses the existing foreground polling and query bounds. Android's status
read remains sequential with smaps, not an atomic snapshot. No additional OS
query, permission, workload button or Wfloat SDK API is added by this increment.

`tests/virtual-memory.cpp` checks status parsing and independent failures, then
reserves 64 MiB without touching it, writes 4 MiB, verifies the data and unmaps.
It distinguishes virtual-size growth from resident-memory growth on Android and
Apple platforms. `tests/virtual-memory.test.mjs` covers both bridge contracts.

Sources: [Linux status fields](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
and [Apple's Mach task information definition](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/task_info.h).

### Android page-table memory

The `VmPTE` card shows kernel memory accounted to the app's page tables, in KiB
(1 KiB = 1,024 bytes). Page tables track address translations. This is separate
from RSS/PSS, reserved virtual space and app-data size; it does not represent
all kernel overhead attributable to the app. Layout, page size and OS accounting
affect the value, so do not assume a fixed ratio to RSS or compare unlike devices
as if they used identical tables.

The collector reads `/proc/self/status:VmPTE` once per existing foreground memory
poll. Linux's `kB` value is converted to bytes with overflow checks; `pageTables`
preserves exact raw bytes, source, scope, units and independent errors. Missing,
duplicate, malformed or unreadable fields remain unavailable; zero is valid.
This additional file read falls inside the native query's existing time bounds.
It is sequential with the smaps read, not an atomic combined snapshot.

`tests/page-table-memory.cpp` checks parsing and a bounded sparse mapping that
touches 256 pages across 512 MiB of virtual space, verifies their contents and
unmaps them. It reports observed changes without requiring an architecture-specific
byte ratio. The allocation is a standalone diagnostic, not a new app control.
`tests/page-table-memory.test.mjs` checks raw precision, metadata and failure
independence. No Wfloat SDK or iOS collector changes are required.

Sources: [Linux status fields](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
and [kernel VmPTE export](https://github.com/torvalds/linux/blob/master/fs/proc/task_mmu.c).

### Android anonymous resident memory

The `Anonymous` card displays resident pages that the kernel classifies as
anonymous. These include heap/stack allocations and private copies made when
the app modifies a `MAP_PRIVATE` file mapping. A file-backed virtual mapping
can therefore contain anonymous pages. This is resident accounting, not the
size of reserved address space, all live heap objects or model allocations.

The collector reads `Anonymous` in the existing `smaps_rollup` scan or sums
the field across `smaps` mappings. The `anonymous` object preserves exact raw
bytes, source, process scope, units and independent errors. Missing, malformed,
duplicate or overflowing fields remain unavailable; zero is valid. The current
value can rise or fall. It is already included in RSS and overlaps the
clean/dirty categories; do not add it to those totals. It is not proportional
anonymous PSS (`Pss_Anon`) or the `AnonHugePages` subset.

The existing two-second foreground poll and allocation controls are unchanged.
No extra query, permission or SDK API is needed. The native
`tests/anonymous-memory.cpp` check distinguishes untouched reservation, written
anonymous pages, file-backed reads and private file copies, and verifies that
the original file remains unchanged. `tests/anonymous-memory.test.mjs` checks
the bridge contract and unavailable states.

Source: [Linux anonymous-memory accounting](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

### Android anonymous PSS

The **App anonymous PSS** card shows the process's proportional share of resident
anonymous pages: heap, stack and private copies of modified file pages. Sharing
can reduce this value without reducing anonymous RSS; private copies can increase
it again. It is already included in total PSS. Do not add it to that total or
treat it as model-allocation size, swapped memory or file-backed PSS.

The collector reads `Pss_Anon` from the existing `/proc/self/smaps_rollup` query.
If rollup or this field is unavailable, it reports unavailable; no estimate from
the `smaps` fallback is implemented. Missing, duplicate, malformed and overflowing
values have independent errors. Zero is valid. The `anonymousPss` object preserves
the decimal raw byte value, source, process scope and unit. Values beyond exact
JavaScript integer range retain their raw string but have no numeric value.
Kernel kB are converted using 1,024 bytes; preserving that integer does not undo
the kernel's rounding of proportional shares.

This adds no OS query, permission, SDK API or polling loop. Collection remains
inside the existing memory query's timing bounds and is not a guaranteed atomic
snapshot. `tests/anonymous-pss.cpp` validates parsing and a standalone 64 MiB
allocation: fork shares pages and reduces PSS while RSS stays unchanged; child
copy-on-write restores the parent's proportional share. This diagnostic does not
add process forking to the React Native app. The JavaScript tests validate the
sample contract and failure independence. Emulator results establish wiring and
accounting behavior, not representative physical-device performance or coverage.

Source: [Linux proportional-memory accounting](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

### Android file-backed PSS

The **App file-backed PSS** card reads `Pss_File`, the process's proportional
share of resident file pages. Mapped libraries and model files can contribute;
this is not file size, bytes read from storage or all model memory. It excludes
the shmem category and private copies of modified file pages, which become
anonymous. File-backed does not mean exclusively clean. The value is already
included in total PSS and must not be added to that total.

The `filePss` object uses the existing `/proc/self/smaps_rollup` query and
preserves raw bytes, source, process scope, unit and independent errors. No extra
OS query, permission, SDK API or polling loop is added. Missing, duplicate,
malformed or overflowing fields are unavailable; zero is valid. If collection
falls back to `smaps`, no file-PSS estimate is implemented. Numeric values beyond
exact JavaScript integer range are unavailable while the raw string is retained.
Kernel kB are converted using 1,024 bytes; kernel proportional-accounting rounding
remains part of the reading. Collection shares the existing query's timing bounds
and is not a guaranteed atomic snapshot.

`tests/file-pss.cpp` checks a temporary 64 MiB file: faulting in one mapping raises
file PSS; mapping and reading it twice increases RSS without doubling file PSS.
Private writes produce anonymous copies while the second mapping and original
file retain their contents. Unmapping restores the baseline. The diagnostic
reads the original mapping again after private writes because file pages can be
reclaimed in between; mapped bytes alone do not establish residency. JavaScript
tests cover raw precision, source validation and independent unavailable states.
Emulator validation does not establish physical-device coverage or representative
performance.

Source: [Linux file-page proportional accounting](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

### Android shared-memory PSS

The **App shared-memory PSS** card reads `Pss_Shmem`, the process's proportional
share of resident pages in the kernel's shmem category. Android shared-memory
regions and tmpfs-backed memory can contribute. This category is distinct from
the fact that a page is shared: shared library pages remain file-backed, and
anonymous pages shared after fork remain anonymous. A shmem region can contribute
even when only one process maps it. This is not all shared pages, IPC traffic,
swapped memory or an additional amount to add to total PSS.

`Pss_Anon`, `Pss_File` and `Pss_Shmem` now expose the three resident PSS categories
from the same rollup scan. Keep the OS's total PSS rather than replacing it with
their sum; separately rounded exports can differ slightly. These categories do
not replace the clean/dirty or RSS views of the same memory.

The `shmemPss` object retains raw bytes, source, process scope, unit and independent
errors. Missing, duplicate, malformed or overflowing values remain unavailable;
zero is valid. No estimate from the `smaps` fallback is implemented. Values beyond
exact JavaScript integer range retain their raw string without a numeric value.
The existing query, polling interval and timing bounds are unchanged, and the
read is not a guaranteed atomic snapshot. No permission or SDK API is added.

`tests/shmem-pss.cpp` uses Android's public `ASharedMemory_create` API in a standalone
diagnostic. A 64 MiB region remains in shmem when mapped twice; RSS counts both
mappings while PSS apportions their backing pages. A child process shares the
charge, and its writes are visible in the parent. Child exit and unmapping restore
the expected values. This diagnostic requires API 26; the collector still uses
field availability and does not acquire a new API-26 dependency. Forking is not
added to the React Native app. JavaScript tests cover the contract and unavailable
states. Emulator results do not establish physical-device coverage or representative
performance.

Sources: [Linux PSS categories](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
and [Android shared-memory API](https://developer.android.com/ndk/reference/group/memory).

### Android dirty-page PSS

The **App dirty-page PSS** card reads `Pss_Dirty`, the portion of total PSS
accounted as dirty resident pages. Shared dirty pages contribute proportionally,
so this differs from adding `Private_Dirty` and `Shared_Dirty`, which count their
resident mappings without proportional weighting. It overlaps the anonymous,
file and shmem categories and is already included in total PSS.

This is a current gauge, not bytes written, write bandwidth or pending disk I/O.
For example, modified private file pages become dirty anonymous copies while
the original file stays unchanged. Sharing can reduce the process's dirty PSS
without reducing its RSS. A dirty page is not necessarily file-backed or destined
to be written to the original file.

The `dirtyPss` object preserves raw bytes, source, process scope, units and
independent errors. It reads `Pss_Dirty` in the existing `smaps_rollup` scan, or
sums that field across every mapping in the `smaps` fallback. Missing fields in
any mapping, duplicates, malformed values and overflow remain unavailable;
zero is valid. The source distinguishes rollup from a sum of individually rounded
mapping values. No additional query, permission, polling loop or SDK API is added.
Raw strings survive JavaScript precision limits; the numeric value is unavailable
when it cannot be represented exactly. Kernel rounding is retained. Collection
shares the existing timing bounds and is not guaranteed to be atomic.

`tests/dirty-pss.cpp` checks parsing and a temporary 64 MiB file: clean reads raise
total PSS without raising dirty PSS, private writes raise dirty PSS, and a child
sharing those pages reduces the parent's proportional charge. Child exit restores
it, unmapping releases it, and the original file contents remain intact. Forking
is confined to this standalone diagnostic. JavaScript tests check the sample
contract and failure independence. Emulator validation does not establish
physical-device coverage or representative performance.

Source: [Linux dirty PSS definition](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

### Android calculated clean-page PSS

The **App clean-page PSS · Calculated** card derives clean PSS as **total PSS minus
dirty-page PSS**, using both inputs from the same native memory sample. It adds
no OS query or native counter. The source values remain in the native memory log;
the calculation can be reproduced from each record. The result is part of total
PSS, not an extra amount to add to it.

`deriveCleanPss` returns bytes, process scope, unit, an explicit derivation marker
and a source expression identifying both inputs. It does not label the result as
a raw OS reading. Both inputs must be valid, exactly representable integers with
matching rollup or mapping-sum sources. Missing or invalid inputs make the card
unavailable. Dirty PSS greater than total PSS also makes it unavailable; the result
is never clamped to zero. Valid zero is supported, and original inputs are retained.

This inherits OS rounding, including per-mapping rounding on the `smaps` fallback,
and the existing scan's timing and consistency limits. It is proportional clean
resident memory, not `Private_Clean + Shared_Clean`, free memory, file size or a
guarantee of immediate reclaimability. A clean file mapping can raise this value;
modifying private copies can lower it without lowering total PSS. It overlaps the
anonymous/file/shmem categories.

`tests/clean-pss.test.mjs` checks zero, exact subtraction, input independence,
source matching, precision limits, contradictory values and unavailable states.
The existing `tests/dirty-pss.cpp` workload supplies measured total/dirty inputs
for a clean-file-read, private-write and sharing check. Emulator validation does
not establish physical-device coverage or representative performance. No SDK API,
permission or polling change is needed.

Source: [Linux definition of calculated clean PSS](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

### Android referenced resident memory

The **App referenced resident memory** card reads `Referenced`: resident memory
the kernel currently marks as referenced or accessed. It is already included in
RSS; shared pages are not apportioned as they are in PSS. It overlaps the other
resident categories and can rise or fall independently of allocated bytes.

These markers are managed by the OS. Collection does not clear them or establish
a common starting time, so the number is not bytes accessed since the last poll,
a cumulative access counter, or a working-set measurement over a fixed interval.
Repeated access to the same marked pages does not count each access again. An
unmarked resident page is not necessarily unused or immediately reclaimable.

The `referenced` object reads the field in the existing `smaps_rollup` scan, or
sums it across all mappings in the `smaps` fallback. It preserves raw bytes,
source, process scope, unit and independent errors. Missing fields in any mapping,
duplicates, malformed values and overflow remain unavailable; zero is valid.
Values beyond exact JavaScript integer range retain the raw string without a
numeric value. Collection adds no query, permission, SDK API or polling loop and
shares the existing query's timing and consistency limits.

`tests/referenced-memory.cpp` validates parsing and a 64 MiB anonymous mapping.
Its optional marker-reset experiment writes to the diagnostic process's own
`clear_refs`: clearing lowers `Referenced` without reducing RSS; reading half
and then all pages restores their markers. A denied reset is reported explicitly
and does not establish that part of the experiment. This operation is confined to
the standalone diagnostic. The app never writes `clear_refs`, and support under
the diagnostic's identity does not establish app or device-farm permission to do
so. JavaScript tests cover provenance, precision and independent unavailable
states. Emulator validation does not establish physical-device coverage or
representative performance.

Source: [Linux referenced-page accounting and clear_refs](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

### Android merged memory and locked resident memory

**KSM** reports resident bytes backed by Kernel Samepage Merging pages. This is
non-proportional mapping accounting already included in RSS, not bytes saved or
all shared memory. The field excludes KSM zero pages. The collector retains
`ksm` bytes, exact raw bytes, source, units and independent availability/errors.
Missing is not zero, and zero alone does not establish KSM support or daemon state.

**smaps Locked** reports the proportional resident-memory share attributed to
locked mappings, displayed in KiB as `lockedResident`. It is already part of PSS.
Our separate **VmLck** card measures ranges marked for locking: deferred locking
can count untouched, nonresident pages there. Neither metric measures every kind
of pinned memory or remaining lock allowance.

Both fields use the existing smaps rollup scan or complete per-mapping sum, with
independent errors and raw precision. No additional query, polling loop, permission
or SDK change is added. Diagnostic logs retain the existing numbered fragments.

`tests/ksm.cpp` checks field parsing and a bounded eight-page anonymous mapping.
It fills identical nonzero page data, requests merging only for that mapping, and
waits at most ten seconds if the KSM daemon is already enabled. Advice acceptance
is not proof of merging. The test never enables KSM globally and releases the
mapping. `tests/lockedResident.cpp` checks four pages within the existing lock
allowance, ordinary lock/unlock, and deferred locking as zero, one and all pages
become resident. Raw rollup and complete sums are checked independently. No lock
limits are changed. These diagnostic programs run separately from app polling.

Sources: [KSM operation](https://www.kernel.org/doc/html/latest/admin-guide/mm/ksm.html),
[smaps fields](https://www.kernel.org/doc/html/latest/filesystems/proc.html),
and [Android kernel locked-PSS accounting](https://android.googlesource.com/kernel/common/+/bb9513914902/fs/proc/task_mmu.c).

### Android shared HugeTLB memory

The **App shared HugeTLB memory · Shared_Hugetlb** card reports explicit
HugeTLB-backed bytes classified as shared in the app's mappings. The kernel does
not apportion them. Its classification can include possibly shared pages; this
is not proof that another app currently uses the memory, nor simply the size of
mappings created with `MAP_SHARED`. It is separate from transparent huge pages,
private HugeTLB memory and pool reservations. Linux excludes it from smaps RSS,
PSS and shared clean/dirty counters.

The `sharedHugetlb` object preserves numeric bytes, exact raw bytes, source, scope,
units and independent errors. The existing rollup scan or complete per-mapping
smaps sum supplies it; missing/invalid fields remain unavailable and zero is valid.
No SDK change, extra query, permission or polling loop is added.

`tests/shared-hugetlb.cpp` validates parsing, independent private/shared selection,
complete sums, missing/malformed fields and overflow. The Android diagnostic
compares raw rollup and full smaps sums with the collector before, during and after
an ordinary shared 1 MiB mapping. Ordinary shared memory must not become HugeTLB
usage. Nonzero HugeTLB validation remains pending: the local emulator has HugeTLB
disabled, as established in the private-HugeTLB investigation. A MAP_SHARED mapping
alone would also be insufficient to prove shared classification on a supporting
kernel; a controlled sharing experiment is required.

Android memory records now use `WfloatMemoryChunk pid=… seq=… part=N/M …`
fragments under the existing `WfloatMemory` log tag. Each fragment stays below
Android's entry limit and preserves Unicode boundaries. Reassemble the full JSON
before parsing; reject incomplete or conflicting parts. This changes diagnostic
log framing, not the native-to-JavaScript sample or polling cadence. Older captures
retain their original one-line format.

Android's own [libmeminfo parser](https://android.googlesource.com/platform/system/memory/libmeminfo/+/refs/heads/main/procmeminfo.cpp)
recognizes both HugeTLB fields. This confirms platform tooling support, not
allocation access or nonzero usage on every Android device. See also
[Linux field definitions](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

### Android private HugeTLB memory

The **App private HugeTLB memory · Private_Hugetlb** card reports mapped
HugeTLB-backed bytes classified as private by the kernel. This explicit huge-page
mechanism is separate from transparent huge pages. Linux excludes this field from
smaps RSS, PSS and private clean/dirty counters. It is not reserved pool capacity,
a performance score, or simply the size of mappings created with `MAP_PRIVATE`;
classification follows the kernel's page-sharing accounting.

The `privateHugetlb` object retains numeric bytes, exact raw bytes, source, process
scope, units and independent errors. It comes from the existing smaps rollup scan
or a complete per-mapping sum. Missing/invalid fields are unavailable; zero is a
valid reading. No extra scan, polling loop, permission or SDK change is added.

`tests/private-hugetlb.cpp` covers parsing, partial sums, malformed/duplicate fields,
overflow and independence from RSS/PSS. Its Android diagnostic compares the collector
with raw rollup and full smaps sums, excludes an ordinary 1 MiB allocation, and
probes one bounded 2 MiB explicit mapping without changing the HugeTLB pool. Mapping
acceptance alone is not a nonzero residency test; accepted untouched reservations
are immediately released.

On the tested Android 16 emulator, HugeTLB is disabled in the kernel configuration.
The kernel still prints the field as zero; the explicit mapping request fails with
`EINVAL`. Thus collection works, but this emulator cannot validate nonzero HugeTLB
usage. A supporting kernel and allocation access are required for that follow-up.
Zero alone on another device would not establish the same cause. Production
collection neither probes allocation nor reads kernel configuration.

Sources: [Linux smaps accounting](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
and [HugeTLB configuration and allocation](https://www.kernel.org/doc/html/latest/admin-guide/mm/hugetlbpage.html).

### Android shared-memory huge-page mappings

The **App shared-memory huge pages · ShmemPmdMapped** card reports resident bytes
of shared-memory/tmpfs objects mapped through PMD-level transparent huge pages.
It overlaps RSS and does not apportion shared pages. Two mappings of the same
object can count twice; it is not unique physical memory, total object size or
proportional PSS. It excludes ordinary file-backed and private anonymous huge
pages, smaller/PTE-mapped transparent huge pages and explicit HugeTLB memory.

The `shmemPmdMapped` object retains numeric bytes, exact decimal raw bytes, source,
process scope, units and independent errors. It uses the existing rollup scan or
a complete per-mapping smaps sum. Missing/invalid fields remain unavailable;
zero is valid. Unsafe numeric values preserve the raw string. No SDK, permission,
extra scan or polling loop is added.

`tests/shmem-pmd-mapped.cpp` creates one bounded memfd object and validates its
tmpfs backing. A no-huge-page control precedes an aligned shared read/write
mapping with a bounded explicit collapse request. A second mapping of the same
object repeats that request and checks mapping-based accounting and shared writes.
Each mapping and the memfd
are released. Raw kernel values are printed independently. Explicit collapse
can obtain huge pages even with automatic shmem allocation set to `never`; it
can invoke reclaim/compaction. No global policy is changed. Production collection
never creates these mappings or requests collapse. Shell diagnostic success
does not establish equivalent app/farm allocation behavior.

Sources: [Linux smaps categories](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
and [shared-memory huge-page policy](https://www.kernel.org/doc/html/latest/admin-guide/mm/transhuge.html).

### Android file huge-page mappings

The **App file huge pages · FilePmdMapped** card reports file-backed resident
bytes mapped through PMD-level transparent huge pages. It overlaps RSS and does
not apportion shared pages. It excludes tmpfs/shared-memory objects, anonymous
huge pages, smaller/PTE-mapped transparent huge pages and explicit HugeTLB memory.
It is not file size, total page-cache size or a performance score.

The `filePmdMapped` object retains numeric bytes, exact decimal raw bytes, source,
process scope, units and independent errors. Collection uses the existing
`smaps_rollup` scan or a complete per-mapping smaps sum. Missing/invalid fields
remain unavailable; zero is valid. Large values retain raw precision. No SDK,
permission, extra scan or polling-loop change is needed.

`tests/file-pmd-mapped.cpp` creates one small temporary regular file, syncs it,
closes the writer and maps it read/execute without executing its contents. This
meets the executable/no-writer conditions of the read-only file THP path; an
ordinary non-executable model-data mapping may not qualify. PMD alignment and
file offset are controlled. A no-huge-page mapping is compared with a huge-page
request and one bounded explicit collapse. Advice acceptance alone is not proof:
the diagnostic prints the raw mapping fields and checks read data before release.
The file is unlinked after opening read-only; all mappings and descriptors are
released. It rejects tmpfs, which belongs to a different metric. **Production
collection does not create mappings or request collapse.** Shell diagnostic
access does not establish equivalent app/farm allocation behavior.

Sources: [Linux smaps fields](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
and [file huge-page advice requirements](https://man7.org/linux/man-pages/man2/madvise.2.html).

### Android anonymous huge pages

The **App anonymous huge pages · AnonHugePages** card reports bytes of anonymous
resident memory backed by transparent huge pages at the PMD page-table level.
It overlaps RSS and is not proportionally shared. It excludes smaller/PTE-mapped
transparent huge pages, file/shared-memory huge-page categories and explicit
HugeTLB allocations. Zero means none reported in this category, not absent
hardware support. It is context for memory behavior, not a performance score.

The `anonHugePages` object retains numeric bytes, exact decimal raw bytes, source,
process scope, units and independent errors. The existing `smaps_rollup` scan
reads `AnonHugePages`, or the fallback sums the field from every smaps mapping.
Missing, malformed, duplicate or overflowing values remain unavailable; zero is
valid. Unsafe JavaScript numbers retain the raw string without rounding.
There is no extra scan, polling loop, permission or SDK API.

`tests/anon-huge-pages.cpp` compares two sequential 64 MiB private anonymous
allocations aligned to the readable PMD size: one with `MADV_NOHUGEPAGE`, one
with `MADV_HUGEPAGE`. It writes and verifies one byte per base page, records the
counter response and releases each mapping. Advice acceptance does not guarantee
huge-page allocation. The experiment skips explicitly if PMD size is unavailable
or outside its bounded limits. No global THP setting changes, forced compaction
or HugeTLB pool configuration are made. Production collection never advises
allocations. Shell diagnostic access does not establish app or farm behavior.

Sources: [Linux smaps accounting](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
and [transparent huge-page support](https://www.kernel.org/doc/html/latest/admin-guide/mm/transhuge.html).

### Android lazily freeable memory

The **App lazily freeable memory · LazyFree** card reads the OS's accounting of
resident pages marked with `MADV_FREE`. These pages can be reclaimed later;
writing to a marked page cancels its pending reclamation. The value overlaps
RSS and is not free RAM, a cumulative freed-byte count, or all reclaimable memory.
Linux documents possible underreporting due to accounting optimizations.

The `lazyFree` object retains bytes, exact decimal raw bytes, source, process
scope, units and independent errors. It uses the existing `smaps_rollup` scan
or a complete per-mapping `smaps` sum. Missing or invalid fields remain
unavailable; zero is valid. Numeric precision limits retain the raw string.
There is no new permission, scan, polling loop or SDK API.

`tests/lazy-free-memory.cpp` uses a separate disposable 64 MiB private anonymous
allocation. It writes pages, requests `MADV_FREE`, then rewrites half and all
pages to observe cancellation. It logs whether the response actually occurred;
request acceptance alone does not validate it. Old contents are not relied on
after marking. The rewritten bytes are verified and the mapping is released.
**Production collection never marks pages for reclamation.** The diagnostic's
shell access does not establish app or farm support for the advisory operation.

Sources: [Linux LazyFree accounting](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
and [MADV_FREE behavior](https://man7.org/linux/man-pages/man2/madvise.2.html).

### Android swapped memory

The **App swapped memory · Swap** card reports non-proportional swap accounting
from `Swap` in the existing `smaps_rollup` scan, or a complete sum of per-mapping
`Swap` fields in `smaps`. Shared pages are not divided among their mappings.
Unlike `SwapPss`, this also includes swapped pages in the mapped, non-copy-on-write
portion of underlying shared-memory objects. These are separate views of swap;
do not add them together or interpret either as resident memory.

This measures original memory bytes accounted to swap, not compressed storage
size, disk space, cumulative swap traffic or a swap rate. Swapped memory may
exceed RSS. Android may use RAM-backed compressed swap; the field does not
identify its backing store.

The `swap` object preserves `bytes`, exact decimal `rawBytes`, source, process
scope, units and an independent error. Zero is valid; missing fields, incomplete
mapping sums, malformed values, duplicates and overflow remain unavailable.
Values above JavaScript's exact integer range retain their raw string. Collection
adds no scan, polling loop or permission and shares the existing query timing.

`tests/swapped-memory.cpp` tests parser boundaries and uses a separate, bounded
64 MiB diagnostic with an advisory `MADV_PAGEOUT` request on its own allocation.
The diagnostic verifies data after rereading it and releases the allocation.
A successful request alone does not establish that pages were swapped; the log
reports whether a counter increase was observed. The app never requests pageout.
The shell diagnostic does not establish whether a farm or app permits pageout.

Sources: [Linux Swap and SwapPss accounting](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

### Android proportional swap memory

The `SwapPss` card displays the app's proportional share of swap accounting.
It reads `SwapPss` in the same self-owned `smaps_rollup` scan as RSS and PSS,
or sums it across `smaps` mappings when rollup cannot be opened. This is a
current gauge: zero is valid, and the value may rise or fall. It is separate
from resident PSS and must not be clamped to RSS or added to the clean/dirty
resident categories.

The kernel distinguishes `SwapPss` from `Swap`: proportional accounting
excludes swapped pages in underlying shmem objects. It also does not report
compressed swap storage size, unique model allocations or swap I/O activity.
On Android, swap may be backed by compressed RAM; this field does not identify
the backing store. See the [kernel accounting contract](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
and [Android's explanation of zRAM](https://developer.android.com/topic/performance/memory-management).

The `swapPss` object retains exact decimal `rawBytes`, numeric bytes when safely
representable, source, process scope, byte units and independent errors. Missing,
malformed, duplicate or overflowing fields stay unavailable without hiding RSS
or the other counters. The existing sequence, timestamps and query bounds cover
the field; no extra scan, permission or SDK API is added.

Collection follows the existing two-second foreground poll. The allocation
buttons remain unchanged: holding memory does not guarantee that the OS swaps
it out. Native `tests/swap-pss.cpp` separately exercises a bounded 64 MiB mapping
and requests `MADV_PAGEOUT` where available, then rereads and verifies the data
before releasing it. That request is advisory and is not an app button or a
requirement for collecting the metric. Parser and bridge-contract checks cover
nonzero values, valid zero and independent unavailable states.

### Android Java heap limit

**Java heap limit · Android** reads `Runtime.maxMemory()`, the maximum managed
heap size the runtime will attempt to use. It is a process runtime allowance,
not the current heap total, free device RAM, a native-memory limit or the app's
overall OS memory budget. It does not promise that an allocation below the
limit will succeed. No remaining-byte or utilization percentage is derived here.

The collector makes one public API call within each existing foreground memory
sample. It preserves the signed raw value, source, process scope, byte units and
`managed_heap_limit_bytes` accounting. It neither requests GC nor changes heap
settings. Other memory counters remain independently usable if this call fails.

The `limitKind` field distinguishes `finite`, `no_inherent_limit` and
`unavailable`. The API's `Long.MAX_VALUE` marker is displayed as **No inherent
limit reported**, with raw evidence retained and numeric bytes absent. It is a
valid nonnumeric state, not an error or a claim of unlimited physical memory.
Finite values outside JavaScript's exact integer range keep their raw value but
have unavailable numeric bytes and an explicit precision error. Negative values
and query failures are unavailable; a raw finite zero is preserved as zero.

`tests/JavaHeapLimitProbe.java` calls the production collector from the release
APK in separate ART processes launched with `dalvikvm64`. It compares the result with a direct Runtime
query and a configured test-process maximum, then holds eight one-MiB Java arrays
and verifies the limit again before and after dropping references. It does not
attempt an out-of-memory boundary or request collection. The test-only VM options
apply to those separate processes, not the installed app or device-wide settings.
JVM and JavaScript checks cover finite values, exact-range boundaries, missing
and negative readings, query failure and the no-inherent-limit marker.

Sources: [Android Runtime.maxMemory contract](https://developer.android.com/reference/java/lang/Runtime#maxMemory())
and [Android runtime heap-property loading](https://github.com/aosp-mirror/platform_frameworks_base/blob/android16-release/core/jni/AndroidRuntime.cpp).

### iOS peak internal memory

**Peak internal memory · iOS**, added in **0.0.61**, records
`TASK_VM_INFO.internal_peak`: the OS-maintained lifetime maximum of the process's
internal-memory ledger. It adds native field extraction, bridge transport,
production logging, validation and UI to the existing query and two-second poll.
It does not derive the peak from dashboard samples.

Internal accounting includes resident anonymous memory such as heap and stack
pages. Compressed and reusable pages have separate ledgers. This peak can retain
an allocation after release and capture increases between polls; a new process
starts a new lifetime. It is not peak RSS, physical footprint, current headroom,
or cumulative allocation volume. Peaks for different categories may occur at
different times and must not be added into a supposed total peak.

`peakInternal` preserves raw unsigned bytes as decimal text, exact nonnegative
numeric bytes when representable, source, `process_lifetime` scope, units,
`internal_ledger_bytes` accounting and simulator/device environment. A short or
failed Mach response is unavailable; zero is valid. Inexact numeric values retain
the raw text with an explicit error.

`tests/mach-peak-internal.cpp` exercises a bounded 32-MiB anonymous allocation,
checks a positive current/peak response, releases it and verifies peak retention.
Direct queries bracket collection because the observations are not atomic.
The existing app memory button provides a separate 64-MiB integration check.
These local diagnostics do not establish physical-device validation.

Sources: [Apple task ledger export](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c)
and [public task layout](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/task_info.h).

### iOS peak external memory

**Peak external memory · iOS**, added in **0.0.62**, records
`TASK_VM_INFO.external_peak`: the OS-maintained process-lifetime maximum of the
external-memory ledger. This adds field extraction, bridge transport, production
logging, validation and UI through the existing query and two-second poll.

External accounting includes resident file-backed mappings such as executable
code and mapped files. It is not disk usage, file size, I/O volume or peak RSS.
Private writes to file mappings can create copies charged to internal accounting;
shared mappings are not proportionally divided. The peak survives unmapping and
can capture increases between polls. A new process starts a new lifetime. Different
category peaks can occur at different times, so they must not be summed into a
supposed total peak.

`peakExternal` preserves raw unsigned bytes, exact numeric bytes when representable,
source, `process_lifetime` scope, units, `external_ledger_bytes` accounting,
simulator/device environment and errors. Zero remains valid; failed or short Mach
responses are unavailable. Inexact numeric values retain raw text with an error.

`tests/mach-peak-external.cpp` checks the exported field and uses a bounded 32-MiB
file-backed mapping to exercise a positive peak and retention after unmapping.
Direct OS queries bracket collection. Simulator checks do not establish physical
device validation.

Sources: [Apple ledger export](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c)
and [public task layout](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/task_info.h).

### iOS cumulative compression

**Cumulative compression · iOS**, added in **0.0.63**, reads
`TASK_VM_INFO.compressed_lifetime`. XNU exports total credits to the process's
`internal_compressed` ledger, measured in original page bytes. Current compressed
memory is the ledger balance (credits minus debits); peak compressed memory is
its lifetime maximum balance. This new cumulative reading is neither of those.

Restoring or releasing compressed pages does not subtract earlier credits.
Compressing the same pages again can add to the total again. It is not unique
allocated memory, compressed storage size, bytes saved or compression CPU time.
It can exceed RAM and its process-lifetime value includes activity before a
benchmark begins. A new process starts a new lifetime. No rate is derived here.

This adds field extraction, bridge transport, production logging, validation and
UI through the existing native query and two-second poll. `cumulativeCompressed`
preserves unsigned raw decimal bytes, exact numeric bytes when representable,
source, process-lifetime scope, byte units, `internal_compressed_ledger_credit_bytes`
accounting, simulator/device environment and errors. Zero is valid. Failed or short
Mach responses are unavailable; inexact numeric values retain raw text with an error.

`tests/mach-cumulative-compressed.cpp` checks extraction and direct-query bounds.
Its optional simulator-only diagnostic uses two compression/restoration cycles on
the same 32-MiB anonymous mapping. `--natural` waits up to 30 seconds per cycle for
the OS to compress it. `--pageout` instead uses Apple's internal `MADV_PAGEOUT`
advice only in the standalone diagnostic, never production collection. Advice
may be refused or produce no compression; that is reported as unobserved, not
positive validation. It does not induce global pressure or change OS settings.
Simulator validation does not establish physical-device behavior.

Sources: [Apple task export](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c),
[ledger credit/debit semantics](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/ledger.c)
and [page accounting](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/arm/pmap/pmap.c).

### iOS compression-accounting rate

**Compression accounting rate · iOS**, added in **0.0.64**, derives bytes per second
from the already recorded `cumulativeCompressed.rawBytes` field. It adds a
JavaScript tracker and UI, with no new native field, OS query or sampling loop.
The native input logs remain sufficient to replay the arithmetic; the derived
rate is not an additional native log field.

The tracker subtracts unsigned raw totals with `BigInt` before converting a safe
interval delta to a number. This preserves small changes even when lifetime totals
exceed JavaScript's exact numeric range. It divides by elapsed time between native
query midpoints, rather than assuming an exact two-second interval. The dashboard
converts bytes/s to MiB/s and displays the contributing byte delta, duration and
sample sequence numbers. A positive value below 0.01 MiB/s is shown as `<0.01`,
while a true zero remains `0.00`.

Only consecutive valid readings from the same process, OS version and environment
produce a rate. Background/resume, missing or failed samples and identity changes
start a fresh interval. Decreasing counters, reordered/overlapping queries and
invalid metadata produce an error and clear the baseline. Gaps over five seconds
also start fresh: this is a prototype display-freshness policy for nominal two-second
polling, not an OS restriction. The first sample after a reset shows “Measuring…”.
An interval delta outside the exact numeric range is unavailable.

This is a whole-process interval average of original page bytes charged to
compressed accounting. Repeated compression can count the same pages again.
It is not compressed output throughput, bytes saved, compression CPU cost or proof
of a workload slowdown. Compare it with decompression events and workload timing.
Physical validation and controlled repeated compression remain separate from
validation of this derivation.

Tests cover arithmetic, timing, raw precision, gaps, invalid data and identity
changes. Actual React component tests cover native failures, resume, stale in-flight
responses, zero and small positive UI values.

### Foreground state at startup

iOS **0.0.60** and Android **0.0.70** synchronize metric-card and diagnostic-control
state when their effects initialize. React Native can resolve the app state
between the first render and effect setup. Previously, native polling could run
while a card retained its initial **Paused** label or disabled its controls.
The energy-monitor control also refreshes its foreground reference before use.

The change preserves polling intervals, pause/resume behavior, metric definitions
and native collectors. `tests/foreground-startup.test.mjs` renders the actual
components with React's test renderer and changes app state before their effects
attach. It covers foreground and background initialization, subsequent lifecycle
events and listener cleanup for 19 components on both platforms. Native reads and
timers are controlled in these tests; they are not metric-response measurements.

### iOS purgeable-memory diagnostic

Version **0.0.59** adds **Run purgeable memory check** to validate the four
existing purgeable readings on a simulator or physical iPhone. It allocates and
writes 16 MiB, samples a resident nonvolatile/volatile transition, waits about
30 seconds for natural compression, then samples another transition before
emptying and releasing its own allocation. The complete check takes about
31 seconds. Stop, backgrounding and module invalidation release the allocation.
It does not request global memory pressure or global purge. Compression may
not occur; zero compressed bytes cannot establish a positive-response test.

Normal collectors and their two-second schedule are unchanged. While the check
runs, it adds phase snapshots and a separate direct `TASK_VM_INFO` query for
comparison. `purgeableCheck` records the run, stage, held allocation, error and
direct diagnostic values. These are observations of the whole process, not
isolated counters for the test allocation. The extra query follows the normal
query interval and has its own completion timestamp; comparisons are not atomic.
This diagnostic adds measurement work and must not be treated as an idle baseline.

`tests/apple-purgeable-probe.cpp` checks bounded allocation, state transitions,
rewriting, emptying and repeated release. Farm orchestration and results live in
the internal repository.

### iOS compressed volatile purgeable memory

**Compressed volatile purgeable memory · iOS** records
`TASK_VM_INFO.ledger_purgeable_volatile_compressed`. This adds native extraction,
bridge transport, production logging, validation and UI for another previously
discarded field. It uses the existing OS query and polling schedule.

The value is the ordinary volatile purgeable compressed ledger charged to the
owning task, in **original page bytes**. It is not the physical size of compressed
storage, a compression ratio or bytes already discarded. The contents remain
eligible for discard. Resident and nonvolatile compressed pages use separate
ledgers; specially tagged objects may use others. A fall may reflect discard,
restoration or a state change, so it is not a cause-of-release counter.

`purgeableVolatileCompressed` retains signed raw bytes, exact nonnegative numeric
bytes, source, calling-process scope, units,
`purgeable_volatile_compressed_original_page_bytes` accounting and environment.
Revision 3 is required. Zero is valid; failed/short responses are unavailable.
Negative or inexact values retain their raw text with an explicit error.

`tests/mach-purgeable-volatile-compressed.cpp` writes a separate 16-MiB
nonvolatile allocation, waits at most 30 seconds for natural compression, marks
it volatile and immediately samples. It requires a positive collected value
agreeing with direct queries on either side; no agreement after at most two
attempts is inconclusive. Compression and discard can change volatile balances
in either direction, so all three observations are preserved rather than assumed
atomic. The test restores the allocation, verifies contents when they survived,
reinitializes if needed, empties only that allocation and releases it. No global
pressure or purge controls are used. This diagnostic is outside production polling.

Sources: [Apple task ledger export](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c),
[state changes and original-page accounting](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/vm/vm_object.c)
and [public task layout](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/task_info.h).

### iOS compressed nonvolatile purgeable memory

**Compressed nonvolatile purgeable memory · iOS** records
`TASK_VM_INFO.ledger_purgeable_novolatile_compressed` (Apple's public spelling).
This adds native extraction, bridge transport, logging, validation and UI for
another field discarded by production sampling. The previous native diagnostic
read it separately. No additional OS query or polling call is added.

The ledger counts compressed pages owned by the task's ordinary nonvolatile
purgeable objects, in **original page bytes**. It is not compressed storage size,
a compression ratio or cumulative compression traffic. Resident bytes and
volatile compressed bytes use separate ledgers. Specially tagged objects may
use other ledgers. This category contributes to physical-footprint accounting;
do not add it to footprint as extra memory. Nonvolatile contents are protected
from purgeable discard but can still be compressed and restored.

`purgeableNonvolatileCompressed` preserves signed raw bytes, exact nonnegative
numeric bytes, source, calling-process scope, byte units,
`purgeable_nonvolatile_compressed_original_page_bytes` accounting and environment.
Revision 3 is required. Zero is valid. Failed/short replies are unavailable;
negative or inexact values retain raw text with an explicit error.

`tests/mach-purgeable-nonvolatile-compressed.cpp` creates one 16-MiB purgeable
nonvolatile allocation and waits up to 30 seconds for ordinary compression.
Direct queries bracket the production collector, allowing compression to advance
between reads. The test reads back every byte to verify content preservation,
then releases the allocation. It requires a positive collected value; no natural
compression reports inconclusive. It does not change global pressure controls or
use the previously unsupported MADV_PAGEOUT. It runs separately from production.

Sources: [Apple task ledger export](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c),
[compressed-page accounting](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/vm/vm_object.c)
and [public task layout](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/task_info.h).

### iOS volatile purgeable memory

**Volatile purgeable memory · iOS** records
`TASK_VM_INFO.ledger_purgeable_volatile`. This adds native extraction, bridge
transport, production logging, validation and UI for a field previously read
only by the separate nonvolatile-memory diagnostic. It uses the existing
`TASK_VM_INFO` call; no polling call is added.

This is the current resident-byte balance charged to the task's ordinary
volatile purgeable ledger. These contents are eligible for discard, so the
balance can fall between queries. Compressed pages use a separate ledger;
wired purgeable pages remain charged as nonvolatile. Specially tagged objects
can use other ledgers. This is an owner-attributed ledger balance, distinct from
`purgeable_volatile_resident`, which belongs to the map-query accounting exposed
by `TASK_VM_INFO_PURGEABLE`. It is not free RAM, all cache memory, a lifetime
peak or cumulative bytes discarded.

`purgeableVolatile` preserves signed raw bytes, exact nonnegative numeric bytes,
source, calling-process scope, byte units,
`purgeable_volatile_resident_ledger_bytes` accounting and simulator/device
provenance. Revision 3 is required. Missing/failed/short replies remain
unavailable; zero is valid. Negative or inexact values retain raw text with an
error rather than becoming zero or a rounded number.

`tests/mach-purgeable-volatile.cpp` uses a separate bounded 16-MiB allocation.
Writing it nonvolatile leaves this reading at zero; marking it volatile raises
the reading until the pages are discarded. Restoring it nonvolatile removes
its volatile charge. Explicitly emptying only that allocation and releasing it
are checked too. Direct queries bracket the production collector to allow real
asynchronous decreases. At least one positive collector reading is required;
four unsuccessful attempts report inconclusive rather than passing. Discardable
contents are reinitialized before reuse. The diagnostic never performs a global
purge and is not run by production polling.

Sources: [Apple ledger export and map-query distinction](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c),
[purgeable states and owner-ledger routing](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/vm/vm_object.c)
and [public task layout](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/task_info.h).

### iOS nonvolatile purgeable memory

**Nonvolatile purgeable memory · iOS** records
`TASK_VM_INFO.ledger_purgeable_nonvolatile`. This adds native extraction, bridge
transport, logging, validation and UI for a previously discarded field in the
existing query. It adds no polling call.

This is the current resident-byte balance charged to the task's ordinary
nonvolatile purgeable ledger. Compressed bytes use a separate ledger and are
excluded. Nonvolatile contents are protected from purgeable discard; this does
not mean permanent storage or pages that can never be compressed. Wired
purgeable pages remain charged as nonvolatile even if their object is volatile.
Specially tagged objects can use other ledgers, so this is not every cache or
all memory capable of being reclaimed. It is neither reusable-memory accounting
nor an estimate of free RAM, and should not be added to footprint as new memory.

`purgeableNonvolatile` preserves signed raw bytes, exact nonnegative numeric
bytes where representable, source, calling-process scope, byte units,
`purgeable_nonvolatile_resident_ledger_bytes` accounting and environment.
Revision 3 is required. Failed/short replies remain unavailable; zero is valid.
Negative ledger values retain their signed raw text with an error. Values above
the exact JavaScript integer range likewise remain raw with an error.

`tests/mach-purgeable-nonvolatile.cpp` exercises a separate bounded 16-MiB
`VM_FLAGS_PURGABLE` allocation: untouched, written nonvolatile, volatile,
restored/reinitialized and released. It compares the production collector with
direct Mach queries and checks 0/16/0/16/0-MiB response. Volatile contents may be
lost, so the test checks returned state and rewrites before use. No global purge
or memory-pressure controls are used. The test is not part of production polling.

Sources: [Apple task ledger export](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c),
[purgeable states and ledger routing](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/vm/vm_object.c)
and [public task layout](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/task_info.h).

### iOS peak reusable memory

**Peak reusable memory · iOS** exposes `TASK_VM_INFO.reusable_peak` from the
existing native OS query. This adds native extraction, bridge transport, logging,
validation and UI for a previously discarded field, without another polling loop.

Apple exports the process-lifetime maximum of its reusable-memory ledger.
This is a peak of reusable-page accounting, not current free RAM, guaranteed
allocation headroom or cumulative bytes ever made reusable. Pages counted as
reusable have discardable contents. The OS retains the peak after those pages
are reused or released; a new process starts a new lifetime. This is the OS
peak, not a maximum calculated from dashboard samples.

`peakReusable` retains raw unsigned bytes, exact numeric bytes where representable,
source, process-lifetime scope, byte units, `reusable_page_bytes` accounting and
simulator/device provenance. A failed or short Mach response is unavailable;
zero is valid. Unsafe numeric values retain their raw string with an explicit
error. Revision 0 includes this field. It remains separate from current reusable
memory and other memory categories; collection is not an atomic snapshot.

`tests/mach-peak-reusable.cpp` checks field selection, response length, failure,
zero and the full raw range, then compares the production collector with direct
Mach queries. A separate bounded 16-MiB mapping is marked `MADV_FREE_REUSABLE`,
reused in halves with `MADV_FREE_REUSE`, marked again and unmapped. The test fully
rewrites discardable memory before relying on its contents. It verifies current
0/16/8/0-MiB behavior while the OS peak persists, without global pressure or
allocator settings. This diagnostic is not run by production sampling.

Sources: [Apple task/ledger export](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c)
and [task_vm_info layout](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/task_info.h).

### iOS peak compressed memory

**Peak compressed memory · iOS** reads `TASK_VM_INFO.compressed_peak` from the
existing native OS query. This increment adds field extraction, native-to-JS
transport, structured logging, validation and UI; the field was previously
discarded rather than recorded. No additional sampling loop or SDK change is needed.

Apple's kernel exports the lifetime maximum of the task's `internal_compressed`
ledger. Units are original page bytes, not the compressed payload's physical size.
This differs from current `compressed` and cumulative `compressed_lifetime`.
The OS records the peak between app polls; it is not a JavaScript maximum over
observed samples. It persists after the current balance falls and starts a new
lifetime with a new process. The kernel also has interval tracking internally;
this field specifically uses the lifetime maximum.

The `peakCompressed` record retains unsigned raw decimal bytes, exact numeric
bytes when representable, source, process-lifetime scope, units,
`original_page_bytes` accounting and simulator/device provenance. A failed or
truncated Mach reply is unavailable, not zero. Zero is a valid returned peak.
Values above JavaScript's safe integer range keep raw evidence with an explicit
numeric error. A revision-0 response is sufficient for this field. It is kept
independent of current compressed memory; readings are not an atomic snapshot.

Native fixtures distinguish peak/current/cumulative fields, zero, the full raw
range, short replies and failures. The separate diagnostic in
`tests/mach-peak-compressed-probe.cpp` tries page-out advice on its own bounded
32-MiB mapping. Apple's headers mark that advice internal; it is never used by
production code. The local release kernel returned ENOTSUP. This is a restriction
on forcing page-out, not evidence that the compressed peak API is unavailable.
Normal app activity subsequently supplied nonzero peak/current evidence.

Sources: [Apple task_info export and ledger setup](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c),
[task_vm_info layout](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/task_info.h),
[page-out restriction](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_mman.c).

### Android Java heap free space

**Java heap free · Android** promotes the existing `Runtime.freeMemory()` input
into a validated gauge and dashboard card. That native call was added with Java
heap used in 0.0.65; this increment adds no OS query or duplicate native field.
The runtime estimates free space for future objects within the managed heap.
This is not free device RAM, native allocator space, maximum-minus-used headroom,
or a guarantee that a particular allocation will succeed. GC and heap resizing
can affect the reading; unreachable objects may still occupy space before GC.

`deriveJavaHeapFree(sample)` reads `javaHeapUsed.rawFreeBytes` and retains the
exact raw string, input path, API source, process scope, byte unit and
`managed_heap_free_bytes` accounting. Sample identity and timing stay on the
enclosing record, so this gauge is reproducible from existing recorded samples.
It does not subtract rounded display values or request GC.

A valid free reading remains available if a later total query fails or a resize
invalidates used heap. These separate calls are not atomic; do not force free
space to fit a later capacity reading or derive a used value from inconsistent
inputs. Missing, negative or numerically unsafe free values remain unavailable
with raw evidence and an error. Zero is valid. Corrupt input/provenance is rejected.

Source: [Android Runtime.freeMemory contract](https://developer.android.com/reference/java/lang/Runtime#freeMemory()).

### Android current Java heap capacity

**Java heap capacity · Android** displays the final `Runtime.totalMemory()`
reading already captured by the Java-used collector. It is the managed heap's
current total space for current and future objects, including used and free
space. It can vary over time and is distinct from `Runtime.maxMemory()`'s ceiling,
RSS, native heap allocation and free device RAM. It is not an allocation guarantee.
In the reviewed Android 16 ART source, `GetTotalMemory()` returns the larger of
its target heap footprint and allocated bytes. This is runtime accounting, not a
measurement of mapped, committed or resident pages. A startup reading equal to
the maximum therefore does not establish that the app physically uses that much RAM.

`deriveJavaHeapCapacity()` uses `javaHeapUsed.rawTotalAfterBytes` without another
native query, sampling loop or duplicated native field. The returned gauge retains
that input path, exact raw bytes, API source, process scope, byte unit and
`managed_heap_current_capacity_bytes` accounting. The enclosing sample supplies
identity and query timing; consumers can reproduce the display from recorded logs.

If the before/after totals differ, the used estimate is unavailable but the final
capacity reading remains usable. This does not make the readings atomic. A missing
final read is unavailable even if the earlier total succeeded. Zero is valid;
negative or numerically unsafe totals preserve raw evidence with an error.
Malformed input or provenance is rejected. No GC or heap-setting changes are made.

Sources: [Android Runtime.totalMemory contract](https://developer.android.com/reference/java/lang/Runtime#totalMemory())
and [ART heap implementation](https://android.googlesource.com/platform/art/+/refs/heads/android16-release/runtime/gc/heap.cc).

### Android Java heap used bytes

**Java heap used · Android** estimates managed heap occupancy from
`Runtime.totalMemory() - Runtime.freeMemory()`. This covers the process's
Java/Kotlin runtime heap, including unreachable objects that have not yet been
collected. It is not exact live-object memory, a model-only allocation total,
Hermes/JavaScript heap usage, native heap accounting or RSS. Do not add it to
RSS/PSS or treat it as a complete inventory of app memory.

`totalMemory()` describes the runtime's current heap total for current and future
objects. It can change over time and is distinct from `maxMemory()`'s maximum
heap allowance. `freeMemory()` estimates reusable space inside that heap, not
free device RAM. The collector does not request garbage collection, change heap
settings or add a polling loop. Dropping a reference need not immediately lower
the reading; actual reclamation depends on the runtime.

For each existing foreground memory sample, the collector reads total, free,
then total again. Changed totals, negative values, incomplete inputs and free
bytes exceeding total are unavailable for that poll, with raw evidence retained.
It does not retry in production. Equal bracketing totals detect some capacity
changes but do not prove an atomic snapshot: allocations/GC can occur between
calls, including changes that return to the same total.

The `javaHeapUsed` record preserves all three signed raw inputs, exact raw used
bytes when derivable, source, process scope, byte units and
`managed_heap_used_bytes` accounting. Subtraction happens before conversion to a
JavaScript number; out-of-range results remain unavailable while raw evidence
survives. Zero is valid, and this metric's failure does not erase RSS/native heap.

`tests/JavaHeapProbe.java` runs in a separate ART process and calls the production
collector loaded from the release APK. It allocates sixteen one-MiB byte arrays,
releases them in halves, checks retained contents and uses weak references to
confirm reclamation. Only that diagnostic requests GC, with bounded retries;
a request is not a universal guarantee of collection. It is not bundled in the
app. JVM and JavaScript tests cover changing capacity, partial read failure,
invalid inputs and exact subtraction beyond JavaScript's safe input range.

Sources: [Android Runtime heap APIs](https://developer.android.com/reference/java/lang/Runtime#totalMemory())
and [garbage-collection request semantics](https://developer.android.com/reference/java/lang/Runtime#gc()).

### iOS native heap allocated bytes

**Native heap allocated · iOS** reports `malloc_zone_statistics(NULL, &stats)`'s
current `size_in_use`, summed by the public API across registered malloc zones.
It includes allocations through those zones, such as ordinary malloc/new and
many framework objects. It does not cover direct mappings or allocators that
bypass registered malloc zones. A pool backed by malloc can remain counted even
when objects inside that pool are freed. This is not exact model memory.

Use it as allocator accounting, separate from resident memory, physical footprint
and the internal/external VM ledgers. `size_allocated` is a different field for
reserved allocator memory; we deliberately read `size_in_use`. Zone rounding and
cached frees can affect its value. **Freed blocks can remain counted**: Apple's
medium allocator caches frees per magazine, and its statistics include the
corresponding object-byte counters. A positive reading after free is not, by
itself, a leak. Zone statistics are not a process-wide atomic snapshot. Custom
zone implementations supply their own statistics, so the aggregate is not a
universal inventory of unique live objects.

The call occurs once within the existing foreground memory sampling interval.
The record retains unsigned raw bytes, source, process scope, byte units,
`malloc_zone_size_in_use_bytes` accounting, registered-zone coverage and
simulator/device provenance. Numeric values outside JavaScript's exact integer
range are unavailable while raw evidence survives. Zero is valid. The API has
no status return: it does not offer a separate success/error or zone-completeness
signal. No entitlement, SDK modification or enumeration of another task is used.

`tests/apple-native-heap.cpp` checks field selection and precision, then holds
8 MiB through ordinary malloc and another 8 MiB in a registered custom zone.
The iOS 18 simulator returned +8, +16, +8 and 0 MiB through allocation and release;
a touched direct 16-MiB mapping added zero allocator bytes. Direct API samples
agreed with the collector within 48 bytes of its own bookkeeping in that run.
The diagnostic uses observable writes to prevent optimized-away allocations.
It runs outside the app and is not bundled into it.

A supplementary macOS run retained some freed blocks in its reported zone usage,
consistent with Apple's caching implementation; destroying the diagnostic custom
zone removed its contribution. No global allocator or pressure-relief settings
were changed. Simulator/macOS results do not establish every physical iPhone's
allocator configuration or release timing. Android and iOS retain distinct
source/accounting definitions under the common display name.

Sources: [public malloc API and all-zone contract](https://github.com/apple-oss-distributions/libmalloc/blob/main/include/malloc/malloc.h),
[all-zone aggregation](https://github.com/apple-oss-distributions/libmalloc/blob/main/src/malloc.c),
[zone statistics](https://github.com/apple-oss-distributions/libmalloc/blob/main/src/magazine_malloc.c),
and [medium allocator cached frees](https://github.com/apple-oss-distributions/libmalloc/blob/main/src/magazine_medium.c).

### Android native heap free bytes

**Native heap free · Android** displays `Debug.getNativeHeapFreeSize()` for the
calling process. Android's JNI implementation returns `mallinfo().fordblks`.
This is allocator-reported free space, not free device RAM, Java heap space,
resident memory or a guaranteed allocation budget. Do not subtract it from RSS
or assume it covers every free region in the process.

Coverage depends on the allocator. In Android 16's Scudo source, `fordblks`
comes from `StatFree`; small-block allocation/free updates that statistic by
size class. The secondary large-allocation path instead updates allocated and
mapped accounting, so freeing a large block need not increase this counter.
Allocator rounding, caches and pool growth also affect changes. A first
allocation can grow a pool instead of consuming an already reported free pool.
Direct `mmap` bypasses this accounting.

The existing foreground memory sampler reads this gauge every two seconds on
its worker queue. `nativeHeapFree` carries the exact signed raw decimal string,
byte value, API source, calling-process scope, `native_allocator_free_bytes`
accounting and any error within the sample's identity and query interval.
Zero is valid. Failed, negative or numerically unsafe readings remain unavailable
with their evidence; they do not replace other counters. No allocator settings,
GC requests or extra polling loop are introduced.

`tests/NativeHeapFreeProbe.java` loads the production helper from the release
APK in a separate diagnostic process. Its JNI companion holds at most 16 MiB
of requested memory, warms a small-block pool, tests reuse and half/full release,
then records large-block and direct-mmap controls. It compares the collector
with adjacent direct API queries and cleans up held memory. The existing UI
memory test buttons use mmap and do not exercise this metric.

Sources: [Android API](https://developer.android.com/reference/android/os/Debug#getNativeHeapFreeSize()),
[Android JNI](https://github.com/aosp-mirror/platform_frameworks_base/blob/android16-release/core/jni/android_os_Debug.cpp),
[Scudo mallinfo fields](https://android.googlesource.com/platform/external/scudo/+/refs/heads/android16-release/standalone/wrappers_c.inc),
[small-block accounting](https://android.googlesource.com/platform/external/scudo/+/refs/heads/android16-release/standalone/local_cache.h)
and [secondary allocator](https://android.googlesource.com/platform/external/scudo/+/refs/heads/android16-release/standalone/secondary.h).

### Android native allocation check

**Run native allocation check**, beneath Native heap free, exercises the existing allocated/free/size readings inside the app. It holds at most **16 MiB** of requested payload at a time: 4,096 × 4 KiB allocations, release and a second allocation cycle, half/full release, 16 × 1 MiB allocations and release, then a touched 16 MiB direct mapping and unmap. The second small-block cycle tests allocator reuse behavior; it does not establish that individual addresses were reused.

Ten phase rows retain the three separate public `Debug` API results, raw signed byte strings, availability and a native query window. The dashboard shows allocated / free / size in MiB. These are whole-process readings: concurrent app activity and the diagnostic's own bookkeeping are included. Android has no private malloc zone in this check. Direct mapping is a control outside native malloc accounting, although unrelated allocator activity can still occur while it is held. Completion means the workload finished; it does not assert a particular counter response or return to baseline.

The check runs on the existing memory worker. It releases an existing mmap test first, blocks overlapping memory requests through the normal action queue, and checks the foreground generation and a cooperative ten-second budget between allocations and page touches. Rapid background/resume invalidates that generation. Native ownership releases partial allocations on completion, failure and cancellation; a paused OS thread can delay cleanup until it runs again. No allocator tuning, trimming, forced GC, farm integration or SDK change is involved.

The final `nativeMallocCheck` report retains a completed/cancelled/failed status, partial phases on failure, query timing, run number and zero terminal held payload after cleanup. Regular `WfloatMemory` samples retain the latest report; a separate framed `WfloatNativeMalloc` export is emitted once after cleanup, including interrupted results that cannot be returned while backgrounded. Do not mix its run identity with normal sample sequences when parsing logs. JS validates phase order, holdings, chronology, cleanup metadata and all three existing counter contracts before displaying results. Counter unavailability remains independent.

`tests/android-malloc-check.cpp` checks ownership with tracked allocation/mapping operations and interruption/failure injection under sanitizers. JVM tests exercise ordering, lifecycle/deadline cancellation and partial results. The test-only `NativeMallocInstrumentation` runner exercises real JNI cancellation and exception propagation in the app UID. These tests complement the actual dashboard button check; the emulator's allocator values are debugging evidence, not physical-device benchmarks.

### Android native heap allocated bytes

**Native heap allocated · Android** reads the public
`Debug.getNativeHeapAllocatedSize()` API (available since API 1; this app requires
API 24). It reports this process's native allocator accounting in bytes, displayed
as MiB. No permission, root access, farm instrumentation or SDK change is needed.

This covers allocations tracked by Android's native heap allocator, including
ordinary `malloc`/`new` use through it. It is not Java heap usage, exact live
requested bytes, model-only memory or RSS. Direct `mmap`, GPU allocations and
custom allocators that bypass this allocator are outside its coverage. A custom
allocator backed by `malloc` can leave its entire backing pool counted even when
some of its own objects are freed. Do not add this counter to RSS or PSS.

Android 16's implementation returns `mallinfo().uordblks`. Allocator rounding,
metadata and implementation details affect the total: Scudo's small-allocation
accounting uses size classes, and its large-allocation accounting uses committed
block sizes. Statistics taken while other threads allocate are not an atomic
snapshot of all app memory. Freeing objects can reduce this counter without
immediately returning resident pages to the OS; a retained pool can also keep
allocator usage elevated. Neither a plateau nor a single increase proves a leak.

The collector reads the API once inside the existing foreground memory sample's
monotonic timing interval. It preserves the signed raw decimal string, source,
process scope, byte units and `native_allocator_bytes` accounting. Zero remains
valid. A failed call, negative value or value beyond exact JavaScript integer
range is shown as unavailable, with evidence retained, independently of RSS.
The queries within a memory sample are sequential, not simultaneous.

The existing memory buttons use `mmap` and do not exercise this allocator.
`tests/NativeHeapProbe.java` and `tests/android-native-heap-probe.cpp` provide a
separate, bounded Android diagnostic using the actual public Debug API. It holds
16 one-MiB malloc blocks, frees them in stages, compares a touched 16-MiB direct
mapping and repeats allocation/release. Nothing from this diagnostic is bundled
in the app. Local Android 16 validation observed +16.0625 MiB, +8.03125 MiB, then
baseline; the direct mapping added zero allocator bytes. This establishes behavior
on that emulator, not identical overhead or release timing on every allocator.

Sources: [Android Debug API](https://developer.android.com/reference/android/os/Debug#getNativeHeapAllocatedSize()),
[Android 16 framework implementation](https://github.com/aosp-mirror/platform_frameworks_base/blob/android16-release/core/jni/android_os_Debug.cpp),
[Scudo small allocation accounting](https://llvm.googlesource.com/scudo/+/83180c4b1ecf52e72f7be4b3e9c114f3498d8ab7/local_cache.h),
and [Scudo large allocation accounting](https://github.com/llvm/llvm-project/blob/main/compiler-rt/lib/scudo/standalone/secondary.h).

### iOS external/file-backed memory

The **App external memory · iOS** card reports the current `TASK_VM_INFO.external`
ledger in MiB. This is OS memory accounting for external-backed mappings,
including resident mapped-file and executable pages. “External” does not mean
external storage or a peripheral. It is not file length, total cached files on the
device, cumulative disk reads or the app's entire virtual file-mapping size.

The accounting follows mappings and is not proportional: two resident mappings
of the same file can count twice. Writes to a private file mapping create anonymous
copies that can move from external to internal accounting without changing the
file. This is related to Android file-backed memory but is not Android file PSS
or an exact replacement for its clean/dirty breakdown. It is not an independent
allocation to add to RSS, nor the same as physical footprint.

The existing `TASK_VM_INFO` query supplies `external`, guarded by the returned
revision. The bridge preserves numeric and exact raw bytes, source, scope, units,
`external_ledger_bytes` accounting, simulator/device provenance and independent
errors. Zero is valid; missing or inexact data is not rounded or changed to zero.
No extra polling loop, SDK API or entitlement is introduced.

`tests/mach-external.cpp` checks failed/short replies, zero, current-versus-peak
field selection and unsigned precision. Its separate native diagnostic creates
and immediately unlinks a 16 MiB temporary file, writes known data, reads one and
then two private mappings, and modifies half of one mapping. It checks external
and internal transitions, verifies both the file and read-only alias still have
the original contents, then unmaps and closes everything. The file is intentionally
warm in the cache; this is not a cold-storage performance test. Separate direct
and collector calls allow 64 KiB variation; allocation transitions allow 256 KiB
of process-bookkeeping variation. No global cache eviction or pressure is used.

Sources: [Apple task-memory fields](https://developer.apple.com/documentation/kernel/task_vm_info_data_t),
[XNU external-ledger export](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/osfmk/kern/task.c),
and [ARM per-mapping external accounting](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/osfmk/arm/pmap/pmap.c).

### iOS internal memory

The **App internal memory · iOS** card reports the current `TASK_VM_INFO.internal`
ledger in MiB. Apple's kernel describes this as the task's anonymous memory.
Resident heap/stack allocations are examples; this is OS page accounting, not a
count of live malloc objects or model bytes. Compressed pages are accounted in
`internal_compressed` (our compressed-memory card). Ordinary pages marked reusable
move to the separate reusable ledger; the internal value is therefore not an
exact equivalent of Android's `Anonymous` counter or a total of all anonymous
address ranges. Apple's alternate-accounting mappings have additional rules.

The value is distinct from total RSS, private/proportional memory and physical
footprint. Footprint includes other charges and accounting adjustments. Do not
sum these dashboard cards as independent allocations. Each query is an observation
of a changing process, not an atomic cross-counter identity.

The collector takes `internal` from the existing task-info reply, checks its
returned revision, and preserves exact raw bytes, source, scope, units,
`internal_ledger_bytes` accounting, environment and independent errors. Zero is
valid; unavailable or inexact values are never replaced with zero or rounded.
No extra polling loop, SDK API or entitlement is introduced.

`tests/mach-internal.cpp` covers failed/short replies, zero, current-versus-peak
field selection and unsigned precision. A separate bounded native diagnostic
reserves 16 MiB, writes it, marks it reusable, returns it to use and unmaps it.
It compares the collector against a direct Mach query, allowing up to 64 KiB
between reads and 256 KiB of process-bookkeeping variation around allocation
transitions. It rewrites discardable contents before using them and does not
create global memory pressure. Simulator results describe the Mac's kernel;
physical iPhone behavior needs separate validation.

Sources: [Apple task-memory fields](https://developer.apple.com/documentation/kernel/task_vm_info_data_t),
[XNU ledger definitions and export](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/osfmk/kern/task.c),
and [ARM reusable/internal accounting transitions](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/osfmk/arm/pmap/pmap.c).

### iOS reusable memory

The **App reusable memory** card reports `TASK_VM_INFO.reusable`: the current
reusable-page accounting for this process, displayed in MiB. The application or
its allocator can mark contents as discardable while retaining the address range.
This is not free system RAM, free malloc space, remaining app allowance or a
cumulative count. It is distinct from purgeable memory and Android's `LazyFree`.
The counter can rise or fall; zero is valid.

The existing task-info query supplies the field after checking its returned
revision. `reusable` preserves exact raw bytes, source, scope, units, accounting,
simulator/device provenance and independent errors. Values outside JavaScript's
exact integer range retain their raw string and no rounded numeric value. No new
polling loop, SDK API or permission is added. Simulator readings reflect the Mac's
memory management; they do not establish iPhone behavior.

`tests/mach-reusable.cpp` validates failed/truncated replies, zero, current-versus-
peak field selection and the full unsigned raw range. Its bounded 16 MiB anonymous
mapping is written, marked `MADV_FREE_REUSABLE`, returned to active use in two
halves with `MADV_FREE_REUSE`, then marked again and unmapped. It compares the
collector with a direct Mach reading and requires the expected increase/decrease.
Discardable contents are fully rewritten before they are used; their survival is
never assumed. This experiment runs in a separate native process, not in the
production collector, and does not create global memory pressure.

Sources: [Apple task-memory fields](https://developer.apple.com/documentation/kernel/task_vm_info_data_t),
[XNU ledger export](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/osfmk/kern/task.c),
and [Apple's reusable-memory tests](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/tests/vm_test_mach_map.c).

### iOS compressed memory

The iOS card reads the current `TASK_VM_INFO.compressed` field from the existing
Mach query. It reports app memory accounted to the compressor in **original
page bytes**. It does not report the smaller compressed storage size or a
compression ratio. This is a current gauge; it can rise or fall, and zero is valid.
Do not add it to RSS to calculate physical footprint, whose ledger has other
categories and adjustments.

The independent `compressed` object retains exact decimal `rawBytes`, numeric
bytes when exactly representable, source, process scope, original-page accounting,
simulator/device environment and an error. Failed or short Mach responses remain
unavailable without hiding valid RSS. The existing process identity, sequence,
timestamps and query bounds cover the new field. No extra OS query, permission
or inference-SDK API is needed.

The card refreshes with the existing two-second foreground poll. The 64 MiB
hold/release check remains available, but the OS decides which pages to compress
and when; holding an allocation does not guarantee a particular response.
Simulator readings describe memory management on the Mac, not a physical iPhone.

Sources: [Apple's task ledger export](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/osfmk/kern/task.c#L5492),
[original-page accounting and footprint adjustments](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/arm64/sptm/pmap/pmap.c#L3558).
Native response checks: `tests/mach-compressed.cpp`; bridge-contract checks:
`tests/compressed-memory.test.mjs`.

### iOS decompression activity

The adjacent card reads `TASK_VM_INFO.decompressions` from the same memory query.
It displays the OS cumulative event count and events per second. Apple increments
this counter for page decompressions attributed to the app's threads, including
compressor swap-in faults. Repeated decompression of a page counts again. The
counter does not measure unique pages, bytes, latency or CPU cost, and is separate
from the amount currently compressed.

The `decompressions` object preserves `count`, decimal `rawCount`, source,
process scope, event units, cumulative aggregation, environment, saturation and
an independent error. The returned Mach revision must include the field
(`TASK_VM_INFO_REV5_COUNT`). Failed/short replies and negative values remain
unavailable without hiding RSS or compressed memory. Zero is valid.

XNU caps the export at **2,147,483,647**. At that value the UI shows an
**at least** total and stops deriving rates, so a saturated counter cannot look
like zero activity. Ordinary rates use differences between consecutive query
midpoints, not an assumed two seconds. Background transitions, unavailable or
invalid reads, sequence gaps and process changes require a fresh baseline.
Decreasing counters or reordered/overlapping samples are rejected.

The existing foreground poll and allocation controls remain in use. No extra
native query, workload or SDK API is added. Simulator readings reflect the Mac;
the OS controls compression, and a memory hold need not cause decompression.

Sources: [Apple's event increment](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/osfmk/vm/vm_fault.c#L2540),
[task/thread aggregation and cap](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/osfmk/kern/task.c#L5656).
Validation: `tests/mach-decompressions.cpp` and `tests/decompressions.test.mjs`.

### iOS app memory headroom

`os_proc_available_memory()` reports the bytes remaining before the calling
app reaches its current memory limit. The memory card shows this alongside
physical footprint, using the same foreground poll and 64 MiB hold/release
check. It is an instantaneous, changing allowance, not total device RAM or a
promise that an allocation will succeed. It is not derived by subtracting RSS
from system free memory.

The native `headroom` object records bytes, the original integer as `rawBytes`,
API source, `current_app_limit` scope and `simulator`/`device` environment.
Values beyond JavaScript's exact integer range retain their raw string and an
explicit error. Headroom validation is independent of RSS and the other memory
counters. Unlike lifetime peak RSS, headroom may rise or fall.

An API return of zero is preserved but displayed as **Unresolved · API returned
0**. Apple documents zero for both an exceeded app limit and a process that is
not an app; the API does not identify which condition applies. Simulator values
are labeled and cannot establish a physical iPhone's memory allowance. A fresh
native query is needed after resume. Query bounds cover all sequential memory
calls; the values are not one atomic snapshot.

Android's system available-memory and low-memory signals have a different
scope and are not presented as equivalents to this per-app allowance.

Source: [Apple available app memory](https://developer.apple.com/documentation/os/os_proc_available_memory)
and the installed iOS SDK's `os/proc.h` contract.

### Android system available memory

A separate card reads `ActivityManager.getMemoryInfo().availMem` and displays
MiB. This is Android's estimate of available RAM across the whole system,
including reclaimable memory. Other apps and system activity affect it. It is
neither this app's memory allowance nor a guarantee that an allocation will
succeed; it remains separate from RSS, PSS and iOS app headroom.

The collector uses the public API without additional permissions and queries
approximately every two seconds while foregrounded. Reads run sequentially on
a native worker. Backgrounding clears the displayed value and stops polling;
resume requires a fresh query. Read failures display **Unavailable**. Zero is
a valid observation. Negative or numerically imprecise native values preserve
their original signed integer string with an explicit error.

Each `WfloatSystemMemory` log row includes available bytes, `rawAvailableBytes`,
source, `system` scope, OS/API version, collector PID, sequence, wall time and
`SystemClock.elapsedRealtimeNanos` query bounds. These timestamps describe the
API call, not an underlying OS acquisition time. Android 16's reference
implementation has an optional 10 ms rate-limiting cache. The latest 120
validated rows remain in component memory; the changing gauge is not converted
to a consumption rate. Emulator readings describe the virtual Android system.

The same API call also supplies the **OS low-memory state** (`lowMemory`) and
its reported threshold (`threshold`, in bytes). The card displays **Low memory**
or **Not low**, plus the threshold in MiB. The flag is copied directly; it is
never calculated by comparing available memory to the threshold. Android 16's
reference implementation uses an additional internal threshold in that decision,
so the flag can become true above the exposed threshold. The displayed threshold
is a system policy reference, not an exact transition point or an app limit.

Native rows preserve these additive fields as `lowMemory` and
`lowMemoryThreshold`, each with its own source and error. The latter also keeps
the original `rawBytes` string. They share the row's system scope, identity and
query bounds. Validation treats false as a real value and missing data as
unavailable. Threshold errors do not hide a valid flag or available-memory
reading; older rows without these fields still retain their availability.
The new fields use the existing foreground lifecycle and polling interval.

Source: [Android available-memory contract](https://developer.android.com/reference/android/app/ActivityManager.MemoryInfo#availMem),
[low-memory flag and threshold](https://developer.android.com/reference/android/app/ActivityManager.MemoryInfo#lowMemory),
[Android 16 API implementation](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/core/java/android/app/ActivityManager.java),
[Android 16 state decision](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/services/core/java/com/android/server/am/ProcessList.java).

### iOS memory-warning events

An iOS-only card displays the number of
`UIApplication.didReceiveMemoryWarningNotification` notifications received
since the native observer started early in app launch, plus the latest receipt
time and app state. These are UIKit events; the app does not infer warnings
from RSS, physical footprint or available memory.

The count measures notification deliveries, not distinct periods of pressure.
Zero means no warnings observed. UIKit supplies no numeric threshold, severity
or matching all-clear notification, and warnings are best effort: termination
can occur without a prior warning. This is separate from Android's queryable
system low-memory boolean.

A single native observer runs before React Native starts and lasts until
process exit. It retains only the count and latest receipt. The card subscribes
to events before reading the initial snapshot and reconciles the native count
on foreground resume, without polling. Backgrounding or a JS reload does not
reset native state; a new app process does. Missing or invalid data displays
**Unavailable**, never an assumed zero.

Each `WfloatMemoryWarningChunk` record logs either observation start or a
warning receipt. Join numbered parts before parsing JSON. Records include
source/scope, OS and simulator/device metadata, PID, observation UUID,
observation start, cumulative count, latest receipt, and snapshot times.
Wall time and `NSProcessInfo.systemUptime` are preserved separately. Receipt
times describe the native main-queue callback, not an OS-origin timestamp or
the start of memory pressure. Logging is event-driven; durable export and
collector-overhead calibration remain future work.

Simulator-triggered warnings can validate delivery and display, but do not
establish a physical iPhone's warning policy or pressure response. The app
contains no synthetic-warning trigger and adds no permission or SDK API.

Sources: [Apple notification contract](https://developer.apple.com/documentation/uikit/uiapplication/didreceivememorywarningnotification),
[responding to memory warnings](https://developer.apple.com/documentation/uikit/responding-to-memory-warnings),
[best-effort delivery](https://developer.apple.com/documentation/xcode/responding-to-low-memory-warnings).

## App page-fault activity

The card displays cumulative process counters and interval rates, with names
that preserve each platform's accounting:

| Platform | Counters | Native source |
| --- | --- | --- |
| Android | Minor faults (resolved without I/O), major faults (required I/O) | `getrusage(RUSAGE_SELF).ru_minflt` / `ru_majflt` |
| iOS | VM faults and page-ins | `task_info(TASK_EVENTS_INFO).faults` / `pageins` |

These are normal virtual-memory events, not app crashes. They cover all app
threads, including the UI, native workloads and measurement itself. They can
help investigate model loading and first-touch costs, but do not measure stall
duration, unique pages, bytes read, or all storage I/O. The iOS counters are
reported separately: they are not added together or translated into Android's
minor/major split. OS paging, compression and read-ahead behavior differ.

One native background-queue read runs about two seconds after the previous
request completes while foregrounded. Every sample retains the named raw
counters, source, PID, sequence, OS version, system page size, wall time and
monotonic query start/end. Android also records API level. Rates divide counter
deltas by the elapsed time between query midpoints; both endpoints remain
available to reproduce the calculation. These are interval averages, not
instantaneous rates. Page size is context, not a multiplier for deriving I/O.

Resume, read failure, changed process/source, or counter rollback starts a new
averaging window. Stale bridge responses across lifecycle changes are ignored.
Zero is a valid count/rate; failures are explicit and never become zero. XNU's
Mach counters saturate at `INT32_MAX`; the collector rejects saturated or
negative counters instead of interpreting them as inactivity. Android rejects
negative counters and counts at or beyond JavaScript's exact-integer boundary.

The latest 120 samples remain in component memory. Each native read emits a
`WfloatPageFaults` JSON record to Android logcat or the iOS system log; these
remain diagnostic storage, not a durable run export. Query timestamps exclude
JSON logging and UI work, so their duration does not measure total observer
overhead. No inference SDK changes, special permissions or farm access are used.

The existing **Hold 64 MiB to check** button writes to every page of an anonymous
mapping. It should increase Android minor faults / iOS VM faults. Releasing
memory does not decrease cumulative event counts. This probe does not validate
major-fault/page-in response under cold file reads, and virtual devices do not
establish physical-phone behavior or cross-platform comparability.

Sources: [Android getrusage](https://android.googlesource.com/platform/bionic/+/5a7331a4d2913fb84e5667b964b6ea0be60482e7/libc/include/sys/resource.h),
[Linux process accounting](https://www.kernel.org/doc/html/latest/filesystems/proc.html),
[Apple Mach counter definitions](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/osfmk/mach/task_info.h#L183),
[XNU counter saturation](https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.1.10/osfmk/kern/task.c#L5267).

### File-backed memory check

**Run 32 MiB file check** creates a private temporary file in the app cache,
fills it with deterministic pseudorandom data, syncs it, and maps it read-only.
Two passes read and verify the first byte of every system page in a fixed
permuted order. The second pass immediately reuses the same mapping. Results
persist on the card, including per-pass process-counter changes, traversal
duration and the number of pages reported resident before each pass.

File preparation is outside the per-pass measurement windows. Native counter
queries directly bracket each traversal, so the two-second live polling cannot
miss the probe's result. The report preserves all raw counter endpoints and
`CLOCK_MONOTONIC` query/traversal times, wall start time, PID, OS version, run
sequence, file/page sizes, touched-page counts, checksums and cache-operation
return codes. Android includes API level. Completed passes survive a later
cancellation or error; unfinished passes are not presented as complete.

Android syncs the file then requests `POSIX_FADV_DONTNEED` for that file's
contents. Apple requests `F_NOCACHE` before writing, then syncs. Both request
`MADV_RANDOM` on the mapping. These are different platform mechanisms; success
does not establish a cold storage read. `mincore` reports a residency snapshot,
with an explicit unavailable state if it fails. Pages may change residency
after that query, and caches below the OS are not inspected. A zero fault delta
is valid and may reflect cached data. No system-wide cache flush or privilege
change is used.

These are whole-process counter windows, not isolated worker-thread counts.
Traversal time includes page checks, verification, cancellation checks and
scheduling; it is not pure I/O latency or a storage-throughput measurement.
Only the touched bytes are verified, not every byte of the file. An independent
`WfloatFileFaultProbe` JSON diagnostic record preserves each final result.
Android emits one log line. iOS emits numbered chunks of up to 600 characters
to avoid unified-log truncation: group by PID and run sequence, require all
`part=i/n` entries, then concatenate their payloads in order before parsing JSON.

The UI prevents overlap with workload runs and requires releasing the existing
memory allocation check first. Only one file probe can run at a time. Stop,
backgrounding and module cleanup request native cancellation; a 30-second
cooperative budget bounds further work. An in-flight filesystem call or page
fault can delay cancellation. The file is unlinked immediately after creation;
the descriptor and mapping are released on completion, cancellation or failure.
No named probe file remains after an ordinary run or process exit.

Sources: [Linux cache advice](https://man7.org/linux/man-pages/man2/posix_fadvise.2.html),
[Apple file caching controls](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html),
[Linux residency snapshots](https://man7.org/linux/man-pages/man2/mincore.2.html),
[Apple mincore](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/mincore.2.html).

Native file, verification and lifecycle checks:

```sh
clang++ -std=c++17 -O2 -pthread tests/file-fault-probe.cpp -o /tmp/wfloat-file-probe-test
/tmp/wfloat-file-probe-test
```

## App network traffic (Android)

The card reads `TrafficStats.getUidRxBytes(Process.myUid())` and
`getUidTxBytes(Process.myUid())`. It displays received/sent **MiB since device
boot** and **KiB/s averaged over adjacent query intervals**. The counters belong
to the app's Android UID across interfaces and processes. They are not limited
to the current inference, current process lifetime or a particular download.
Traffic performed under another UID is outside this scope.

The same card also reads `getUidRxPackets` and `getUidTxPackets`, showing exact
packet totals since boot and average **packets/s**. These are Android's
network-layer counts for TCP and UDP, not HTTP requests, socket reads/writes or
unique application messages. Segmentation, acknowledgements, retransmissions
and the OS accounting path can affect how they relate to application traffic;
they are not a capture of physical radio frames. No packet-loss estimate,
retransmission count or average packet size is inferred from these totals.

Android measures these bytes at the network layer, including protocol overhead.
They need not match file or HTTP-body sizes. Cached downloads may add no traffic;
development builds can include Metro/debugging traffic. Rates describe observed
traffic, not connection capacity or a calibrated network benchmark. OS accounting
can lag or be cached; a two-second query cadence does not guarantee new source
data, and a flat counter alone is not proof of an entirely offline execution.

One foreground native-worker request runs at a time, with the next scheduled
two seconds after completion. Receive and send are sequential API calls with
separate monotonic query bounds; they are not one atomic snapshot. Backgrounding
or unmounting pauses sampling, clears the display and resets rate baselines.
Native and JS lifecycle generations reject interrupted reads. A new app process
or collector identity also starts a new baseline. Counter rollback retains the
new total and explicitly restarts that direction's interval.

`WfloatNetwork` JSON rows retain exact signed-64-bit decimal counter strings,
independent availability/reasons, UID, PID, collector UUID and sequence, OS/API,
build fingerprint, debug-build flag, wall receipt time and
`SystemClock.elapsedRealtimeNanos` query bounds. Android supplies no source
sample timestamp here (`sourceSampledAtMs: null`). `UNSUPPORTED = -1`, other
negative results and exceptions stay distinct from genuine zero. One direction's
unavailable result does not hide the other's valid reading.

Packet data is an additive `packets` object with its own source, received/sent
`rawPackets` strings, availability and per-call query bounds. The two packet
queries follow the byte queries on the same worker, with no additional timer.
Packet rates use their own query intervals. Missing, malformed or unsupported
packet data leaves valid byte readings visible, and old byte-only logs still
validate. Packet baselines independently reset on pause, errors, identity changes
or counter rollback. Reading bytes and packets in the same request does not
make them an atomic snapshot. A VPN's location and routing should be recorded
with an experiment; these counters do not independently describe a host VPN's
outer tunnel traffic.

Deltas are subtracted as integers before numeric rate conversion. No averaging
window bridges an unavailable sample. MiB display rounding preserves the original
integer in logs, and logcat remains rotating diagnostic storage. Native query
duration excludes bridge, logging and display work; total collector overhead is
not calibrated. No new app permissions, SDK API or iOS collector are added.

Sources: [received-byte contract](https://developer.android.com/reference/android/net/TrafficStats#getUidRxBytes(int)),
[sent-byte contract](https://developer.android.com/reference/android/net/TrafficStats#getUidTxBytes(int)),
[received packets](https://developer.android.com/reference/android/net/TrafficStats#getUidRxPackets(int)),
[sent packets](https://developer.android.com/reference/android/net/TrafficStats#getUidTxPackets(int)).

### Controlled transfer validation

The separate `androidTest` APK contains `NetworkTransferInstrumentation`. It
launches the release dashboard and transfers synthetic data under the target
app's UID to an explicitly supplied TCP server: 2 MiB sent, then 4 MiB received,
with content verification and settling intervals. The normal APK contains no
transfer trigger or hardcoded server. Release builds exclude Metro traffic.

Build with `:app:assembleRelease :app:assembleReleaseAndroidTest`. Install both
APKs on the selected emulator and run:

```sh
adb shell am instrument -w -e host SERVER_IP -e port 28761 \
  com.wfloat.bench.test/com.wfloat.bench.NetworkTransferInstrumentation
```

The internal companion `bench-service/dev/network_probe_server.py` binds to an
explicit address and serves one bounded synthetic exchange. Capture
`WfloatNetwork` and `WfloatNetworkProbe` logs to compare the production collector
with payload counts and independently queried test boundaries. Network-layer
increases should cover the payload; exact equality is not expected. Emulator
validation establishes collection and display behavior, not physical network
performance. The test runner closes its socket after 90 seconds at the latest;
connection and read operations also have timeouts.

For packet validation, start the server with `--packet-check` and add
`-e packetCheck true` to the instrumentation command. After TCP settles, the
runner sends 32 UDP datagrams with 128-byte payloads and verifies 32 matching
echoes. The server validates each sequence and payload. Separate settled OS
queries and production samples can then be compared against this known count;
extra packets or missing responses require investigation. The internal verifier's
`--packets` option checks exact UDP agreement and packet-rate response. This is
a controlled local check, not a universal promise about packet attribution
under every VPN, firmware or network configuration.

## App storage I/O

The card shows cumulative OS-attributed storage read/write bytes and rates over
the actual interval between foreground samples. It refreshes every two seconds.
Rates use native `CLOCK_MONOTONIC` query midpoints, not JavaScript timer spacing
or wall-clock differences. The first reading, resume, and a failed reading all
start a fresh rate interval.

| Platform | Source | Meaning |
|---|---|---|
| Android | `getrusage(RUSAGE_SELF)`: `ru_inblock`, `ru_oublock` | Android/Linux 512-byte accounting units, converted to bytes; storage-layer reads and writes counted at page-dirtying time. |
| iOS | `proc_pid_rusage(getpid(), RUSAGE_INFO_V2, ...)`: `ri_diskio_bytesread`, `ri_diskio_byteswritten` | Apple's process disk-I/O accounting, in bytes. |

These are whole-process counters, including UI, runtime, native work and
collectors. Android uses `RUSAGE_SELF`, which excludes child-process accounting.
They are not per-model counters or device-wide traffic.
OS attribution, filesystem caching, read-ahead and writeback affect the results.
They do not establish exact physical flash traffic, durable writes, storage stall
time, or maximum device throughput.

Android optionally reads `/proc/self/io` for `cancelled_write_bytes`, `rchar`,
`wchar`, `syscr`, `syscw` and its separate byte totals. Unlike `RUSAGE_SELF`, this
procfs source also includes reaped children. This prototype launches none.
Unavailable optional counters retain their source, error and errno, while the
primary read/write counters continue working. Cancelled writes are shown separately: subtracting them
from writes over an arbitrary window can be misleading, since cancellation may
involve pages dirtied earlier or by another process. The logical byte counters
include read/write-style system calls even when no storage access occurs, and
can include non-file I/O and the collector's own reads. They are not substituted
for storage bytes, and iOS does not receive fabricated equivalents.

Android preserves raw `readBlocks`/`writeBlocks`, `accountingUnitBytes: 512`,
and the derived bytes. In the inspected Android 16 common kernel,
`task_io_get_inblock` and `task_io_get_oublock` shift each thread's byte counter
right by nine bits, and `RUSAGE_SELF` sums the thread counters. Therefore, this
path loses sub-unit remainders per thread and is not an exact byte-for-byte
replacement for `/proc/self/io`. The 512-byte unit is neither the filesystem's
block size nor an I/O-operation count. The conversion is grounded in Android/
Linux implementation, not a portable assumption about every OS's `getrusage`.
If task I/O accounting is disabled in the kernel, those fields can remain zero;
a known workload response is needed before trusting a zero as inactivity.
Kernel release is retained with every sample.

The local Android 16 release app could not open `/proc/self/io`: its file and
thread-level equivalent were owned by root with mode `0400`. The standalone
ADB process could read its own file. Using `getrusage` avoids changing the app's
debuggable/dumpable settings or relying on shell access for app readings.

The iOS declaration follows Apple's WWDC22 example for SDKs without `libproc.h`;
the counter structures come from the installed `sys/resource.h`. Version 2 is
requested explicitly because it contains the two disk-I/O fields. No private
symbol discovery, entitlement change or SDK modification is used. Function
availability and successful reads must still be verified on each target.

Missing sources, denied access, malformed counters and values beyond the exact
JavaScript integer range display **Unavailable**. Zero remains a valid reported
value, not evidence that all I/O activity is observable. Raw records retain
source, platform/OS, Android API level, PID, sequence, wall time and native query
bounds. Rates reject counter decreases, overlapping queries and reordered
samples. `WfloatStorageIo` logs each successful native reading; logging and UI
overhead are outside the query bounds and remain uncalibrated. Logs rotate and
are not a durable run export.

### Temporary-file check

Each check creates a private 32 MiB file in the app cache directory, fills it
with a deterministic byte pattern, calls `fsync`, then reads and verifies every
byte twice. It keeps four native snapshots: before writing, after writing and
syncing, after the first read, and after the second read. The result displays
logical work performed separately from the corresponding process counter
changes. Buffered reads may add zero storage bytes because the file is cached;
neither pass claims to be cold. The original button uses normal caching.

**Check reads with cache control** runs the same bounded file workload with a
platform-specific request:

- Android: `posix_fadvise(POSIX_FADV_DONTNEED)` after `fsync`, before the first
  read. It requests eviction of this file's cached pages. The second pass uses
  normal caching without another eviction request.
- iOS: `fcntl(F_NOCACHE, 1)` before writing, kept enabled for both reads. Both
  passes request uncached file I/O; the second is not a warm-cache control.

Results retain `cachePolicy`, the exact cache-control operation and its errno.
A failed request is displayed alongside the actual counter deltas. Acceptance
does not establish that pages were evicted or that counters respond: a zero
first-read delta leaves that response unverified. A positive delta demonstrates
process storage accounting during the read window, which also includes other
app activity. No global caches are flushed; neither this nor `fsync` establishes
cold hardware/host caches, physical flash traffic or media durability.

The check runs on a separate native worker. Stop, backgrounding and invalidation
cancel it cooperatively between operations. Its 30-second deadline cannot
interrupt an already blocked kernel I/O call. The file is unlinked immediately
after creation and closed on every exit, including errors. Other CPU/file check
buttons are disabled while it runs. The UI preserves the completed result;
`WfloatStorageCheck` logs numbered chunks of the full JSON so both platforms'
logging limits do not truncate it.

Native validation covers parsing, unit bounds, repeated verified file work,
cancellation and cleanup in both cache modes. JavaScript tests cover rate arithmetic, cached reads,
independent cancelled-write counters, identity changes, source checks, ordering,
and check-result validation. Run the native test with:

```sh
clang++ -std=c++17 -O2 -pthread tests/storage-io.cpp -o /tmp/wfloat-storage-test
/tmp/wfloat-storage-test
```

Sources: [Linux process I/O documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html#proc-pid-io-display-the-io-accounting-fields),
[Linux procfs and child scope](https://man7.org/linux/man-pages/man5/proc_pid_io.5.html),
[Android accounting-unit implementation](https://android.googlesource.com/kernel/common/+/refs/heads/android16-6.12/include/linux/task_io_accounting_ops.h),
[Android getrusage aggregation](https://android.googlesource.com/kernel/common/+/refs/heads/android16-6.12/kernel/sys.c),
[Linux procfs ownership](https://man7.org/linux/man-pages/man5/proc_pid.5.html),
[Apple's iOS declaration example](https://developer.apple.com/videos/play/wwdc2022/10106/),
[Apple disk-read field](https://developer.apple.com/documentation/kernel/rusage_info_v2/1577572-ri_diskio_bytesread),
[Linux file-cache advice](https://man7.org/linux/man-pages/man2/posix_fadvise.2.html),
[Apple fcntl cache control](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fcntl.2.html).

## App CPU usage

Both platforms read cumulative user and system CPU time in a single
`getrusage(RUSAGE_SELF)` call. **User** is execution in app and native code;
**Kernel** is OS execution charged to the app process. Their sum supplies the
existing total. All process threads contribute, including React Native,
rendering within the process, native workloads and collection. Other processes,
GPU execution and time spent waiting without executing are outside these CPU
counters. Kernel time is not whole-device OS usage.

Android previously used `Process.getElapsedCpuTime()` for its total. It now
uses the same `getrusage` pair as the breakdown, avoiding independently timed
sources. iOS already summed these fields; it now preserves both components.
Old total-only samples fail the new validator and cannot seed a split interval.

The card samples about once per second while active. User, kernel and total
percentages all use `100 × CPU-time delta / native elapsed-time delta` over
the same two samples. **100% means one fully occupied core; multicore usage can
exceed 100%.** These are interval averages in units of core utilization, not
percentages of the app's total CPU time. Faster/slower cores and their clock
speeds are not weighted. Independently rounded displayed values can differ by
0.1 percentage point when added.

Native queries preserve exact integer microseconds for `ru_utime` and `ru_stime`
as `userCpuTimeUs` and `systemCpuTimeUs`, plus derived `cpuTimeMs`, query start
and finish, their midpoint (`monotonicMs`), wall timestamp, named clock source,
PID, sequence, platform and OS version. Android also records API level. A
microsecond representation does not establish microsecond accounting accuracy.
The native converter rejects invalid `timeval` fields and counters whose sum
exceeds JavaScript's exact-integer range. JavaScript subtracts integer counters
before converting deltas to milliseconds, preserving small changes in large
cumulative values.

`WfloatProcessCpu` JSON diagnostics preserve each native sample. The latest
120 samples remain in component memory; the displayed reading retains both
endpoints. The denominator uses the interval between native query midpoints,
so delayed JS delivery and wall-clock changes do not alter the calculated
percentage. Query bounds also expose collection duration, excluding logging,
bridge delivery and rendering.

Backgrounding clears the display and interval, and resume requires two fresh
samples. Native lifecycle checks suppress background reads; the UI discards
responses from a previous foreground period. Missing fields, inconsistent
totals, decreasing component counters and out-of-order samples show an error
and reset the interval. Valid unchanged counters produce zero. Thermal stop
conditions are unchanged. Emulator/simulator results validate collection rather
than physical-phone performance.

Sources: [Linux getrusage](https://man7.org/linux/man-pages/man2/getrusage.2.html),
[Apple process accounting](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/getrusage.2.html).

Native counter conversion and response check:

```sh
clang++ -std=c++17 -O2 -pthread tests/process-cpu-counters.cpp -o /tmp/wfloat-process-cpu-test
/tmp/wfloat-process-cpu-test
```

## App context switches

The card shows context switches per second and a cumulative count since the
app process started. This is process-wide scheduling activity across all app
threads, including the UI, runtime, workloads, and collectors. It is not a count
of function calls or transitions from user mode into the kernel. A switch count
measures neither waiting duration nor switching cost; a high rate alone does not
establish a performance problem.

- **Android:** a dedicated `getrusage(RUSAGE_SELF)` read supplies `ru_nvcsw`
  (voluntary) and `ru_nivcsw` (involuntary). Total is their sum. Voluntary switches
  usually occur when a thread gives up the CPU to wait for a resource;
  involuntary switches include preemption and time-slice expiration.
- **iOS:** `task_info(mach_task_self(), TASK_EVENTS_INFO)` supplies the `csw`
  total. The app does not assign Android's two categories to this counter.
  XNU accumulates task and live-thread switch counts and clamps the exposed
  field to `INT32_MAX`. The collector rejects saturation and negative values
  instead of presenting an exhausted counter as a zero rate.

Samples arrive approximately every two seconds while active. Each native query
records its start and finish on the platform's monotonic clock. Rates use the
count difference divided by the interval between query midpoints, rather than
assuming exactly two seconds. Android's component rates use the same endpoints
as its total. Native and JavaScript checks reject invalid or inexact counters,
inconsistent totals, decreases in either Android component, and out-of-order
samples. Zero change is a valid zero rate. Backgrounding clears the interval;
returning requires two fresh samples. Different processes or platform identities
cannot form one interval. Platform accounting semantics are not assumed identical.

`WfloatContextSwitches` JSON records preserve counters, query bounds, clock and
source names, wall time, PID, sequence, OS version, and Android API level. The
latest 120 samples remain in component memory. This independent two-second
collector uses the same Android API as the CPU collector; it does not change
CPU sampling or reuse a differently timed CPU interval.

The **Run 10 s wait/wake check** button starts one native worker that repeatedly
sleeps for one millisecond and then wakes. Actual waits can last longer because
of scheduling and timer coalescing. The worker ends after its ten-second budget,
on Stop, on backgrounding, or on module invalidation. A cancellation token also
covers a start racing with backgrounding. No worker is retained after completion;
the previous thread is joined before another run starts. The UI keeps this check
separate from the CPU/LLM and file-fault workloads. Memory allocations already
held by another probe can still affect the process.

Probe state records completed waits, elapsed time, run sequence, and whether the
worker is running. It is sampled after the metric query and is diagnostic context,
not an atomic part of the counter read. Completed waits are not a second measure
of context switches: other app threads and scheduler behavior also contribute.
The native test checks response to wait/wake activity, timeout, duplicate start,
stale cancellation tokens, and cleanup. Local emulators/simulators can validate
these mechanics, but do not establish physical-device performance.

Sources: [Linux getrusage](https://man7.org/linux/man-pages/man2/getrusage.2.html),
[Apple TASK_EVENTS_INFO implementation](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/task.c),
[Apple getrusage accounting](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_resource.c).

```sh
clang++ -std=c++17 -O2 -pthread tests/context-switch-counters.cpp -o /tmp/wfloat-context-test
/tmp/wfloat-context-test
```

## CPU time by app thread

The app reads each live thread's cumulative **user and kernel CPU time** and
calculates its usage over two samples. The card shows the five busiest sampled
threads; native logs retain every successful reading and each read failure.
As with process CPU usage, **100% means one occupied core**. This is CPU time,
not clock frequency, instructions executed, waiting time or hardware efficiency.

Android reads `/proc/self/task/<tid>/stat`: fields 14/15 supply raw user/kernel
ticks, and field 22 supplies the start-time identity. `_SC_CLK_TCK` supplies the
conversion frequency; the collector does not hardcode 100 Hz. The parser handles
spaces and parentheses in thread names. Thread IDs plus start ticks prevent
ordinary ID reuse from joining unrelated lifetimes; start time has clock-tick
resolution. Android names are OS labels, potentially truncated.

iOS enumerates its own Mach task and reads `THREAD_BASIC_INFO` CPU times plus
the stable 64-bit ID from `THREAD_IDENTIFIER_INFO`. CPU times are retained in
microseconds and IDs as exact decimal strings. The UI uses these IDs without
guessing thread roles. Returned port references and the thread array are released
on success and exception paths.

Each thread has native query start/end timestamps. Its percentage uses the
elapsed time between its own query midpoints, rather than assuming the entire
scan was simultaneous. Counter quantization can make short intervals noisy;
percentages are not clipped. The two-second foreground polling uses the existing
thread collector's serial queue, with only one CPU scan in flight. Backgrounding,
relaunch, missing reads, new IDs and counter resets require fresh baselines.

Enumeration races are explicit: a thread may exit before its counter is read.
Unreadable entries do not become zero-CPU measurements. Threads born and ended
between scans may be missed, so the visible rows and their sum are **not a complete
replacement for process CPU accounting**. A 1024-thread bound fails explicitly
instead of silently truncating collection. The UI retains only the previous and
current scans; native diagnostic logs rotate.

`WfloatThreadCpu` writes separate `thread` and `error` records keyed by process ID
and sample sequence, followed by a `sample` record with enumeration/read/error
counts, source, units, clock, scan bounds and OS metadata. Reconstruct a scan only
when every expected record is present; a truncated log is incomplete evidence.
The displayed scan duration covers enumeration and counter reads, excluding
logging, bridge transfer and UI rendering. Total observer overhead remains uncalibrated.

Sources: [Linux thread directories](https://man7.org/linux/man-pages/man5/proc_pid_task.5.html),
[stat fields and units](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html),
[Apple thread information definitions](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/thread_info.h).
The SDK is unchanged; this collector belongs to the public benchmark app.

## CPU headroom (Android)

The card reads Android's public `SystemHealthManager.getCpuHeadroom` API on
Android 16 / API 36+. It displays estimated spare CPU capacity from **0–100%**;
zero is a valid report of no additional capacity. This is separate from measured
app CPU time/utilization and thermal headroom. The default thread selection is
based on the calling process's PID; it is not a sum of our per-thread counters.

The request specifies **average** headroom with a **2,000 ms requested window**,
clamped to the device's supported window range. Android may use its closest
feasible window. The collector waits at least two seconds after completion and
at least the OS minimum polling interval before querying again. A native worker
performs all service calls away from the UI and JS threads.

- **Unsupported:** older Android or an explicit OS support rejection. The result
  is retained for this process and polling stops; relaunch to check again.
- **Unavailable:** a temporary `NaN` or missing service. The value stays null and
  normal retries continue; insufficient workload is one possible cause of NaN.
- **Read failed:** an exception or invalid value, with the failed stage retained.

`WfloatCpuHeadroom` logs actual queries/support checks with raw value, request
scope, window/range, cadence, PID/sequence, wall time and monotonic query bounds.
Cached delivery preserves that identity and does not emit a new log. The API
does not supply the estimate's underlying sample timestamp, so query time is
not sensor time. Polling at the permitted cadence does not guarantee fresh data.
Sampling pauses in the background and on unmount; stale bridge responses are
discarded. The overhead check includes the card through the same publication
gate; unsupported or slow-cadence collectors need not update in every window.

The app compiles against Android SDK 36; minimum API 24 and target API 34 remain.
No iOS collector or inference-SDK change is included. Numeric response requires
a supporting device: the local API 36 emulator explicitly rejects CPU headroom.

Sources: [headroom and polling contract](https://developer.android.com/reference/android/os/health/SystemHealthManager#getCpuHeadroom(android.os.CpuHeadroomParams)),
[request scope and calculation window](https://developer.android.com/reference/android/os/CpuHeadroomParams.Builder).

## CPU metric inventory

| Implemented in the app | Android | iOS |
|---|---|---|
| Process cumulative CPU time and interval usage | Total, user, kernel | Total, user, kernel |
| Per-thread cumulative CPU time and interval usage | User/kernel counters, total usage | User/kernel counters, total usage |
| Live app thread count | Yes | Yes |
| Per-thread kernel priority and nice value | Yes | Not yet |
| Per-thread scheduling policy and real-time priority | Yes | Not yet |
| Last logical CPU per thread | Yes | No public parallel implemented |
| Reported CPU affinity per thread | Yes; list and derived count | Not implemented |
| Getter-reported CPU affinity per thread | Yes; returned IDs and derived count | Not implemented |
| Context switches per thread | Cumulative voluntary and involuntary | Not implemented |
| App thread run-state counts | Linux state codes, including running/runnable and sleep states | Mach state codes, including running/runnable and waiting |
| Process context-switch count and rate | Total, voluntary, involuntary | Total |
| CPU capacity headroom estimate | API 36+, device support required | No equivalent collector |
| OS thermal state (related system signal) | Android categories | Apple categories |
| Thermal headroom (related estimate) | Supported devices | No equivalent collector |

Page-fault counters are listed under memory accounting. CPU stress worker counts,
completed blocks and elapsed duration are workload diagnostics, not calibrated
CPU measurements. Separate internal device-farm experiments have collected CPU
temperatures and Pixel CPU-rail energy; those are not ordinary in-app collectors.
CPU/core frequency, hardware cycles, instruction counts and IPC are not implemented.

## Instrumentation CPU cost

Open **Check instrumentation CPU overhead** near the top of Device readings,
then **Start comparison**. Keep the app foregrounded and untouched for about
4½ minutes. The screen stays awake for the check and its prior idle policy is
restored afterward. Cancel or backgrounding discards the incomplete comparison.
Start without a loaded model; relaunch if a model has been loaded in this app.

The check repeats three conditions in a rotated order:

| Mode | What runs |
|---|---|
| Dashboard paused | Quiet comparison screen; metric cards and their polling loops are unmounted |
| Collect · display frozen | The existing collectors, bridge calls, native logging and sample processing continue; metric state stays in refs without scheduling display updates |
| Collect · live display | The same collectors publish normal React state updates |

Each of nine phases settles for ten seconds, then measures twenty seconds.
Collection phases first populate the dashboard; the frozen phase stops publication
one second before measurement to let pending display work finish. Each mode
appears once in each position within the three groups. Phase transitions,
initial mounts and result formatting fall outside the measured windows.
The dashboard remains at its top viewport and cannot be scrolled or used to
start workloads during the comparison.

Two native `getrusage` readings bracket each interval. The existing process CPU
tracker calculates user/kernel/total usage with actual native monotonic elapsed
time. **100% is one occupied core**, and differences are percentage points of
that capacity—not percent application slowdown. The UI shows each mode's median
and observed range, then subtracts medians to estimate collection, live-display
and combined costs. Negative differences are retained as noise/drift. Three
short intervals do not establish confidence bounds or resolve small differences.

The app uses the actual card polling loops, not a second implementation of the
collectors. A context-controlled state hook can withhold publication without
stopping reads. Outside the comparison it returns React's ordinary setter.
The check audits state writes by component and state-hook render executions;
these are control checks, not sensor sample counts. Frozen phases reject any
audited rendering, paused phases reject dashboard activity and extra CPU polls,
and both collection modes require updates from every expected periodic collector.
The event-driven iOS memory-warning card is not expected to update without a
warning. Native errors remain visible in the records.

`WfloatOverhead` logs `begin`, paired raw CPU `boundary` records, each `window`
and `complete` or `cancelled`. Analysis must require all nine valid windows and
their paired boundaries. Result records are emitted after the ending CPU query
and kept below Logcat's message size limit. Existing native collector logs remain
enabled; their app-side cost and the lightweight publication audit are included.

The baseline still contains React Native and app-lifetime native observers, such
as battery/thermal notifications and iOS memory warnings. This is the incremental
cost of the polling dashboard, not the cost of all instrumentation since process
launch. CPU used by Android system services, the compositor, logging daemons or
the simulator host is outside app process accounting. GPU/display power, energy,
and interference with a running inference workload require separate checks.
Use a release build and physical devices for device-specific conclusions; a
simulator result validates the comparison method only.

## App thread count

The card shows the number of live OS threads in the current app process,
including running, idle and waiting threads. Android reads the `Threads` field
from `/proc/self/status`; iOS enumerates the current Mach task with `task_threads`.
The count includes React Native, the UI, native SDK workers and collection.
It excludes other processes and does not represent CPU cores, actively executing
threads, JavaScript tasks, or the number of threads ever created. Thread pools
may retain idle workers after a workload ends.

This is a snapshot, so one fresh read can be displayed immediately and a decrease
is valid. The app samples about every two seconds while active, clears the
display on backgrounding, rejects late responses from a previous foreground
period, and resumes with a new read. A failed or missing reading displays an
error, never zero. Brief thread lifetimes between samples can be missed; the
observed maximum is not a lifetime peak.

Each `WfloatThreads` JSON log entry records the raw count, source, PID, native
sequence, OS version, wall-clock display time and native monotonic query start
and finish. Android also records API level. Clock sources are explicitly named;
their epochs must not be combined across platforms. Collection duration includes
file reading/parsing on Android and enumeration/resource cleanup on iOS; it
excludes bridge delivery, logging and UI rendering. The latest 120 samples are
retained in component memory.

Android uses one stable collector thread, which is included in the result. iOS
uses a serial dispatch queue, whose execution threads belong to the app's
dispatch pool. Every Mach thread send-right reference and the returned array
are released after each query. No SDK changes or additional app permissions
are required. The existing CPU workload provides a local start/stop check;
simulator counts describe the simulator app process, not a physical phone.

Sources: [Linux process status](https://docs.kernel.org/filesystems/proc.html),
[Apple task_threads](https://developer.apple.com/documentation/kernel/1537751-task_threads),
[Darwin task_threads reference](https://web.mit.edu/darwin/src/modules/xnu/osfmk/man/task_threads.html).

Native enumeration and send-right cleanup check (macOS):

```sh
clang++ -std=c++17 -O2 -pthread tests/mach-thread-count.cpp -o /tmp/wfloat-threads-test
/tmp/wfloat-threads-test
```

## iOS app thread states

Below CPU by app thread, the app counts the `run_state` codes returned by each
existing `THREAD_BASIC_INFO` query. This records a previously discarded OS field;
it adds no query or polling loop. Raw codes remain attached to thread IDs and
query timestamps in `WfloatThreadCpu` logs. The sample footer identifies the
source and simulator/device environment.

| Mach code | Display |
|---|---|
| 1 | Running / runnable |
| 2 | Stopped |
| 3 | Waiting |
| 4 | Uninterruptible wait |
| 5 | Halted |
| Other signed 32-bit integer | Unknown code; raw values retained |

“Running” includes threads ready to execute on a CPU. These are sequential
observations of readable app threads, including the collector, not a simultaneous
snapshot, time in state, or CPU utilization. “Waiting” does not identify the
resource being waited on. A suspension count does not guarantee the OS reports
code 2: the local controlled suspended worker reported code 3 with a positive
suspension count. Display the actual enum without reclassifying it.

Observed counts plus unreadable threads equal the enumerated count; failed
queries are separate from unknown codes. The UI marks partial scans and never
fills in missing readings with zero. Missing state fields in an older build leave
CPU counters usable but state counts unavailable. Backgrounding clears the
values, late responses are discarded, and resume takes a fresh sample through
the existing two-second CPU-card loop. Simulator values describe Mac-hosted
app threads. No SDK changes or extra permissions are required.

Sources: [Mach public state definitions](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/thread_info.h),
[kernel running/run-queue flag](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/thread.h).

Controlled native query check (macOS):

```sh
clang++ -std=c++17 -O2 -pthread tests/mach-thread-states.cpp -o /tmp/wfloat-thread-states-test
/tmp/wfloat-thread-states-test
```

## Android app thread states

The CPU-by-thread card also counts the state character in field 3 of each
`/proc/self/task/<tid>/stat` record. The collector already reads those files for
CPU counters; state is newly retained in the same per-thread result and
`WfloatThreadCpu` log, with `runStateSource` identifying the field. No second
scan or polling loop is added.

| Code | Display |
|---|---|
| R | Running / runnable |
| S | Interruptible sleep |
| D | Uninterruptible wait |
| T | Stopped |
| t | Tracing stop |
| X | Dead |
| Z | Zombie |
| P | Parked |
| I | Idle |
| Other printable ASCII character | Unknown code; raw character retained |

Case matters. Malformed tokens make that thread unreadable; unknown valid
characters remain successful observations. Raw codes are never mapped to Mach
or Java thread states. Some kernel states are unlikely to occur for ordinary
app threads, and a two-second sampling loop can miss brief transitions.

Counts cover readable threads in a sequential scan, including the collector.
R includes threads awaiting CPU service; sleep states do not identify the
resource waited on. D is not proof of disk activity. These are gauges, not CPU
percentages, time in state, or a simultaneous snapshot. Partial scans explicitly
report unreadable threads. Missing state metadata leaves existing CPU data usable
but state counts unavailable. The shared CPU-card lifecycle clears stale values
on backgrounding and rejects late responses after resume.

Emulator observations validate collection and display in the emulated Android
system; physical device behavior requires a separate run. The bounded
`ThreadStatesInstrumentation` runner lives only in the test APK and checks a
known running and blocked worker using the production parser and `/proc` status.
No extra permissions or inference-SDK changes are required by the metric.

Sources: [Linux proc interface](https://docs.kernel.org/filesystems/proc.html),
[state-character mapping](https://github.com/torvalds/linux/blob/master/include/linux/sched.h),
[state labels](https://github.com/torvalds/linux/blob/master/fs/proc/array.c).

## Android per-thread priority and nice

Each displayed thread in CPU by app thread now includes two newly recorded
fields from the existing stat read: field 18 (`priority`) and field 19 (`nice`).
All readable threads retain both values in `WfloatThreadCpu` logs, even though
the dashboard lists only the five busiest sampled threads. One sample is enough
to show these gauges; CPU usage still requires a second sample.

Nice ranges from −20 to 19, with lower values more favorable under normal
scheduling. The kernel-priority label means the value exported in stat, not the unscaled
internal `p->prio` integer. Its scale differs: ordinary unboosted
threads usually report nice + 20. Real-time, deadline and inherited priorities
can differ, so the app neither converts between the fields nor infers scheduling
policy from their relationship. Neither number measures CPU consumption or
guarantees execution time. Android `Process.getThreadPriority` reports Linux
nice, not this raw kernel-priority field or Java's 1–10 thread-priority scale.

The sample identifies `prioritySource` as `/proc/self/task/*/stat:priority,nice`,
`priorityUnit` as `kernel_priority`, and `niceUnit` as `linux_nice`. Raw priority
is retained as a signed 32-bit integer; nice is validated against −20…19.
Invalid native fields make that thread unreadable. Older bridge records without
these fields keep their existing CPU data usable while priority/nice shows
unavailable. Missing values are never replaced with zero.

The existing two-second CPU polling/lifecycle and per-thread identity/timing
apply. No extra file read, permission or SDK change is required. The collector
only observes priorities; it does not change them. A separate test-APK runner
lowers one disposable worker's nice through 0, 10 and 19, compares against
Android's public getter and the production parser, and then exits the worker.
These controlled results validate recording, not scheduling fairness or throughput.

Sources: [stat field definitions](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html),
[kernel stat output](https://github.com/torvalds/linux/blob/master/fs/proc/array.c),
[kernel priority conversion](https://github.com/torvalds/linux/blob/master/kernel/sched/syscalls.c),
[Android priority API](https://developer.android.com/reference/android/os/Process#getThreadPriority(int)).

## Android context switches per thread

The **CPU by app thread** rows now show cumulative voluntary and involuntary
context-switch counts. This adds collection of `voluntary_ctxt_switches` and
`nonvoluntary_ctxt_switches` from `/proc/self/task/<tid>/status`, sharing the
status read and subsequent identity check already used for CPU affinity.
It adds parsing and export work, but no additional file read or polling timer.
[Linux status fields](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html).

Voluntary switches usually accompany blocking or sleeping; involuntary switches
reflect scheduler preemption. These are counts since the thread started, not
latency, CPU usage, wakeup counts or a measure of performance by themselves.
The pair is read sequentially, not atomically. Short-lived threads can disappear
between scans; summing visible or surviving threads does not reconstruct the
existing process-wide `getrusage(RUSAGE_SELF)` counters.
[Kernel field export](https://github.com/torvalds/linux/blob/master/fs/proc/array.c),
[getrusage scopes and counters](https://man7.org/linux/man-pages/man2/getrusage.2.html).

Each thread exports `contextSwitches` with `available`, exact decimal strings
`voluntaryCount` and `involuntaryCount`, a nullable `reason`, and query bounds
shared with affinity. Zero is a valid count; missing or invalid fields produce
unavailable values, never invented zeros. Both values must be canonical unsigned
64-bit decimals. Strings preserve precision through the bridge and JSON logs.
Metadata declares the two status fields as `contextSwitchesSource`, unit
`switches`, encoding `uint64_decimal_string`, and identity check
`stat_starttime_before_after`. Original CPU timestamps remain unchanged.
A field-specific parsing failure does not hide the other metric; status-read or
identity-check failure makes both optional metrics unavailable.

The dashboard shows these counts for the five threads ranked by CPU usage and
records all readable threads. Coverage and unavailable reasons remain explicit.
Lifecycle clearing, late-response rejection and foreground sampling use the
existing thread loop. Old CPU-only recordings remain valid, with these new
fields reported as missing. iOS and the inference SDK are unchanged.

The test-only `ThreadSwitchesInstrumentation` compares the production reader
against `getrusage(RUSAGE_THREAD)` before and after each read. Eight sleeping and
eight busy-work checks require values within those bounds and a positive
voluntary/involuntary response respectively. The workload is bounded and failure
to produce a response is inconclusive, not evidence of a universal OS defect.
Build the diagnostic JNI library with `tests/build-switches-probe.sh`, supplying
`ANDROID_NDK_HOME`, and include it only in the test APK via
`-PbenchSwitchesProbeLibs=...`. Physical S23 / Android 14 validation passed
32 direct comparisons across two firmware builds, with eight matching production
scans across sleeping/busy phases. A later combined S23 run passed 16 additional comparisons, four controlled
production scans, 17 ordinary samples, physical dashboard display and
background/resume validation.

## Android getter-reported CPU affinity per thread

**CPU by app thread** now shows a second line, `Getter CPU allowance`, beside
the existing reported/stored allowance. This is a new production collection
path: JNI calls `sched_getaffinity(tid)` for each successfully sampled thread,
then Kotlin checks that thread's stat identity again. It adds one getter call
and one identity-file read per thread, with its own query bounds, on the existing
foreground loop. Original CPU and status timings remain unchanged.
[Linux API contract](https://man7.org/linux/man-pages/man2/sched_getaffinity.2.html).

The getter can apply further kernel/vendor filtering. Both masks remain separate
observations; the app does not correct one with the other, enforce subset/equality,
or infer why they differ. Neither predicts future scheduling. Earlier physical
S23 diagnostics demonstrated differing masks. The new production JNI collector
subsequently passed physical validation on an S23 / Android 14 (CXD7 firmware).

Each thread exports `getterAffinity` with `available`, raw `cpuIds`, nullable
`reason`, and start/finish uptime bounds. Successful IDs are ordered and unique;
the list and count shown in the UI are derived from those IDs. An empty successful
mask is recorded as `[]` and displayed as `none · 0 logical CPUs`. Failure uses
null IDs and an explicit reason, never an empty-mask substitute. API errno is
retained in the reason. A changed thread lifetime invalidates this reading
without discarding the earlier CPU, stored-affinity or context-switch readings.

Metadata identifies `sched_getaffinity(tid)`, unit `logical_cpu_ids`, identity
check `stat_starttime_before_after`, and capacity 1024. JNI explicitly allocates
that mask size on both 32-bit and 64-bit Android ABIs, frees it on all allocated
paths, and scans the full declared capacity. A kernel requiring a larger buffer
returns an error, not a truncated successful result. This prototype does not
probe larger capacities. Count/list validation, malformed JNI results, errno,
missing native libraries and identity-read failures are handled independently.

All readable thread results are recorded; the UI shows the five threads ranked
by CPU usage plus coverage. Backgrounding clears displayed readings and rejects
late responses. Older CPU recordings remain readable with the new getter fields
reported as missing. No inference SDK or iOS change.

`ThreadGetterAffinityInstrumentation` compares the production JNI/helper against
the separate test JNI getter for a disposable worker. Two single-CPU assignments
require matching bracketing API results and execution on the requested CPU;
restoring the original stored mask records broad getter observations without
requiring sequential equality. It also checks the native wrapper's invalid-TID
error path. The one-CPU emulator exercises this path with an explicit test option;
it cannot demonstrate changing CPU assignments.

Physical Android 0.0.85 validation passed CPU 0 → 1 → restored stored mask 0-7:
16 strict pinned comparisons, eight restored observations and nine stable
production scans reading the worker. The restored getter varied while the stored
mask stayed 0-7. Seventeen ordinary samples had no unavailable thread/getter
readings; background quiet (8.047 seconds), seven same-process resumed samples
and visible dashboard rows passed. Ordinary capture retained 440 per-thread
stored/getter differences. This validates the collector on that configuration,
not the exact Samsung filtering mechanism or an atomic relationship between the
two sources. Empty successful masks, oversized buffers and other device/ABI
configurations remain outside this physical trial.

## Android reported CPU affinity per thread

The **CPU by app thread** rows show `Reported CPU allowance 0-3,6 · 5 logical CPUs`.
This newly reads `Cpus_allowed_list` in `/proc/self/task/<tid>/status`; the count
is derived from the reported ranges, not a second OS metric. Source is
`/proc/self/task/*/status:Cpus_allowed_list`, unit `logical_cpu_list`. Every
successfully read CPU thread records its own `affinity` object with availability,
raw list, count, reason and separate query bounds. CPU 0 is valid. Sparse IDs and
ranges are preserved; a missing reading is never replaced with zero or all CPUs.
[Linux status fields](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html).

This describes the reported mask at read time, not CPU use, core type, physical
host cores behind an emulator, or a guarantee that a later pinning request will
succeed. CPU online state and control-group restrictions can affect scheduling.
Last CPU is sampled separately and need not fall inside a later mask; the app
adds no mismatch warning or automatic correction.
[Affinity and CPU-set restrictions](https://man7.org/linux/man-pages/man2/sched_setaffinity.2.html).

Collection adds **two file reads** after each successful existing CPU stat read:
status shared by the mask and context-switch counters, then stat again to check thread ID/start time. The original
CPU reading retains its original timing and counters. Missing fields, invalid
lists, read errors or changed lifetime identity make affinity independently
unavailable. They do not discard that CPU reading. Metadata declares
`affinityIdentityCheck=stat_starttime_before_after`; the affinity timing includes
both added reads. The normal foreground loop and publication gate remain shared.

Lists must be ordered, non-overlapping decimal IDs/ranges within signed-32-bit
CPU IDs and at most 1,024 characters. Oversized/invalid lists are unavailable,
never truncated into partial measurements. Counts are calculated from ranges
without allocating every CPU ID. The list is exported once, keeping ordinary
thread log records small. The UI annotates five ranked threads, reports overall
read/unavailable coverage, clears on backgrounding and rejects late responses.
The new bridge fields are optional so older CPU recordings remain usable.

The separate `ThreadAffinityInstrumentation` test compares the production
helper's decimal list with independently decoded `Cpus_allowed` hexadecimal
fields read before and after it, and with the controlled assignment requested
for its disposable worker. It captures the original **stored** mask, requests
that mask, pins to one currently getter-reported CPU, then restores the stored
mask. The single-CPU phase also checks actual execution with `sched_getcpu()`.
It reuses the placement test JNI library via `-PbenchCpuPlacementProbeLibs=...`;
production collection never sets affinity.

The test records `sched_getaffinity()` separately and retains differences instead
of requiring equality with the stored mask. Earlier physical S23 checks recorded
status `0-5,7` while both getter calls returned `0-5`, with online snapshot `0-7`.
Upstream filtering and vendor scheduler hooks mean equality is not universal;
the exact cause on those Samsung instances remains unestablished. The revised
comparison does not correct or discard the app's reported list. If the stored
assignment itself differs from the controlled request, the diagnostic still stops
and retains the observations.
[Linux getter implementation](https://github.com/torvalds/linux/blob/v6.1/kernel/sched/core.c),
[Qualcomm getter hook](https://android.googlesource.com/kernel/msm.git/%2B/9671bc00773d7f73172f1cf38a7cd638091d0214/kernel/sched/walt/walt.c#4857).

On the one-CPU emulator all phases remain `0`; this validates the new comparison
but cannot establish changing-mask response. The revised physical S23 test then
passed `0-7` → `0` → `0-7`: 24 direct comparisons, nine production scans and
CPU-0 execution during the pinned phase. Getter differences remained in 14 of
24 observations and were retained. Seventeen ordinary samples, physical thread
rows and background/resume passed. The exact vendor filtering cause remains
unproven. iOS and the inference SDK are unchanged.

## Android last logical CPU per thread

The **CPU by app thread** rows show `Last logical CPU 0` (or another reported ID).
The native collector newly records stat field 39, `processor`, from each existing
`/proc/self/task/<tid>/stat` read. No additional file query, permission or sampling
loop is needed. Every readable thread is exported, including those outside the
five displayed rows. Source is `/proc/self/task/*/stat:processor`; unit is
`logical_cpu_id`; each thread carries `lastCpu`, lifetime identity and query bounds.

This is the CPU number the thread last executed on, not time spent there. Zero
is valid, and a sleeping thread can retain its last location. CPU IDs need not be
dense; the collector accepts nonnegative signed-32-bit IDs without comparing them
to a process CPU-count API. It does not identify core type, affinity, every
migration or a host physical core behind an emulator. Thread scans are sequential;
the location may already have changed by display time.
[Linux stat field definition](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html).

Missing/invalid placement data has a separate UI error so older CPU/scheduler
records remain usable. Malformed native stat tokens use the existing unreadable
thread path. Coverage includes all enumerated/read/error records. Values follow
thread ID plus start time across CPU rankings, clear on backgrounding and reject
stale responses. iOS has no new field or UI in this increment.

`ThreadPlacementInstrumentation` is a separate test-APK diagnostic. One disposable
worker visits the first two CPUs from its initial allowed mask, returns to the first, restores its
original mask and exits. Each phase compares the production parser with native
`sched_getcpu()` calls before and after it; ordinary dashboard scans independently
observe the worker. The helper changes only the calling worker's affinity and is
absent from the normal app APK. By default it requires two allowed CPUs and fails explicitly
if affinity access or comparison fails. On a single-CPU device, the explicit
instrumentation argument `-e allowSingleCpu true` permits eight getter/parser
checks on that CPU only; it reports movement as unvalidated.
[Affinity API](https://man7.org/linux/man-pages/man2/sched_setaffinity.2.html),
[current CPU API](https://man7.org/linux/man-pages/man3/sched_getcpu.3.html).

Build its ARM64 JNI library with `tests/build-placement-probe.sh <output-directory>`
and `ANDROID_NDK_HOME` set. Pass the absolute output directory as
`-PbenchCpuPlacementProbeLibs=...` and select
`-PbenchTestRunner=com.wfloat.bench.ThreadPlacementInstrumentation` when building
the test APK. These options enable test instrumentation only; normal collection
never pins app threads.

The test manifest also registers the existing priority, scheduling-policy and
thread-state diagnostics. For a combined APK, pass both
`benchCpuPlacementProbeLibs` and `benchSchedulerProbeLibs` with their corresponding
ARM64 test-library directories. Each instrumentation entry launches independently;
these registrations and libraries belong only to the test APK.

## Android per-thread scheduling policy and real-time priority

The CPU-thread rows also show scheduling policy and real-time priority, newly
retained from fields 41 (`policy`) and 40 (`rt_priority`) of the same stat read.
Every readable thread is logged; only the five busiest sampled threads are
shown. Each field is an unsigned 32-bit value with explicit source/unit metadata.

| Policy code | Label |
|---|---|
| 0 | Normal (SCHED_NORMAL / SCHED_OTHER) |
| 1 | FIFO |
| 2 | Round robin |
| 3 | Batch |
| 5 | Idle |
| 6 | Deadline |
| 7 | Extensible |
| Other | Unknown; raw code retained |

Real-time priority is normally 1–99 for FIFO/round robin, with larger values
stronger, and zero for the other policies. Zero is valid. Deadline timing
parameters are not contained in this number. Unknown policy codes and unexpected
pairs remain visible, with a note; neither is inferred from nice or effective
kernel priority. A flagged pair can reflect a transition and is not proof of an
OS bug. The coverage footer flags such pairs even if they belong to
threads outside the five displayed rows.

This is the thread's reported policy attribute, not proof of its effective
scheduler class, Android task group, Java priority, CPU share or deadline behavior.
The policy field in stat is exported separately from the reset-on-fork flag
returned by `sched_getscheduler`; the production parser does not strip bits from
unfamiliar values. Observations are sequential and follow the existing CPU-card
foreground lifecycle. Missing or older metadata leaves CPU and nice data usable
while scheduler values are unavailable. Malformed native tokens mark the thread
unreadable; unknown but valid integers remain recorded. No added query or SDK change.

The optional test APK uses a small native helper to compare against
`sched_getscheduler` / `sched_getparam` and exercise Normal, Batch and Idle on
one disposable worker. It cannot request real-time policies. Compile it on the
Mac with `tests/build-scheduler-probe.sh OUTPUT_DIR` and `ANDROID_NDK_HOME` set;
build the test APK with `-PbenchSchedulerProbeLibs=OUTPUT_DIR` and
`-PbenchTestRunner=com.wfloat.bench.ThreadSchedulerInstrumentation`. The helper
is not included in the app APK and is not used by normal collection.

Sources: [stat fields](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html),
[Linux policy constants](https://github.com/torvalds/linux/blob/master/include/uapi/linux/sched.h),
[scheduler API semantics](https://man7.org/linux/man-pages/man2/sched_setscheduler.2.html),
[kernel stat export](https://github.com/torvalds/linux/blob/master/fs/proc/array.c).

## Android open file descriptors

The dashboard counts entries in the app's own `/proc/self/fd` directory every
two seconds while foregrounded. A descriptor is an open handle: files, sockets,
pipes, event descriptors and device handles all count. Two descriptors referring
to the same underlying resource count twice. This covers the calling process,
including React Native and our collectors; it does not include other app processes.

The native traversal excludes its own directory descriptor by number and closes
it before returning. It never reads handle targets or records file paths. This is
a **gauge**, so increases, decreases and zero are valid. Other threads can change
handles during enumeration; it is not an atomic snapshot. Sustained growth over
comparable repeated runs is a useful leak clue, not proof or attribution to a model.
`FDSize` in `/proc/self/status` describes allocated table slots and is not used.
See the [Linux proc filesystem documentation](https://www.kernel.org/doc/html/latest/filesystems/proc.html).

`WfloatFileDescriptors` JSON rows retain the count in `descriptors`, process and
collector-observation identity, OS/build metadata, sequence, monotonic query
bounds, wall-clock observation time, source and the excluded descriptor number.
Failures retain a reason with a null count, and display **Read failed**. A native
worker permits one query at a time; foreground transitions invalidate pending
results. There is no iOS collector for this metric yet. No SDK change or additional
Android permission is required by this implementation; support still needs
validation on physical-device firmware. Collection overhead is uncalibrated and
grows with the number of descriptors.

`tests/fileDescriptors.native.cpp` checks an independent `fcntl(F_GETFD)` count,
32 pipe handles, duplicates, a hole in descriptor numbering, cleanup, and 1,000
successive scans without leaked handles. Compile it with the Android NDK for the
test device and run it as a standalone executable. The separate **test APK**
runner `com.wfloat.bench.FileDescriptorInstrumentation` opens 32 `/dev/null`
handles while the ordinary release dashboard samples, then closes them. It logs
eight-second baseline, held and recovery phases under `WfloatFdProbe`; validate
the production rows against those boundaries. The normal APK contains no handle
probe. Build this test APK with
`-PbenchTestRunner=com.wfloat.bench.FileDescriptorInstrumentation`; omit that
property to keep the existing network test runner.

## Combined CPU/GPU stress (Android)

This experiment adds offscreen OpenGL ES 3.1 compute alongside the CPU workload.
CPU workers ramp to one fewer than the available processor count (minimum one),
leaving scheduling capacity for GPU submission and driver work. This is not
core affinity or a reserved physical core. GPU work runs continuously from
startup; it does not depend on display refresh or React Native rendering.

Each GPU batch runs 65,536 invocations, each with eight four-lane arithmetic
chains for 512 iterations, and writes a 1 MiB output buffer. One dispatch is in
flight at a time. A fence confirms completion, then the first output vector is
read back and checked against a CPU reference with a changing input. The app
shows the renderer, verified batch count and last batch duration. These are
work/progress diagnostics, not a calibrated GPU utilization metric or a check
of every output element.

Both workloads share the native stop signal and guards described below. Stop
lets the current GPU batch drain and submits no next batch; completion waits
for both workers to exit. GPU setup, completion or validation failures stop
the whole run and surface an error. A two-second fence timeout detects stalled
completion, but the app cannot guarantee recovery from a hung GPU driver.
Only this Android increment includes GPU compute; iOS retains CPU and LLM
modes. Unsupported ES 3.1 devices report an error instead of silently using
CPU fallback. An emulator may use host or software graphics and cannot prove
physical-device heating.

## CPU stress

Start runs native arithmetic workers without loading a model. On ARM64, each
worker repeatedly executes eight independent four-lane floating-point
multiply-add chains. Short blocks publish a count and checksum, preventing the
compiler from discarding the computation and allowing frequent cancellation
checks. Other architectures use a portable arithmetic loop. Block counts are
progress indicators, not calibrated CPU utilization or performance metrics.

The worker count ramps from two (or the available count if smaller), to half
the available cores at ten seconds, then all available cores at twenty seconds.
The OS schedules the threads; the app does not pin cores or override throttling.
The target is the platform's reported available processor count, capped at 64.

An independent native monitor checks the same OS thermal status every 500 ms.
A nonzero category, unavailable reading or backgrounding stops the workload.
The shared C++ controller also enforces a ten-minute deadline and stops if the
native monitor fails to report for five seconds. Manual Stop takes effect
between short arithmetic blocks. Worker threads are joined before completion
is reported, and a new run cannot start until the old workers exit. UI polling
and native monitoring remain outside the computation loops. Thermal readings
continue during cooldown. No inference SDK changes are involved.

Native lifecycle tests can be run from this directory with a C++17 compiler:

```sh
clang++ -std=c++17 -O3 -pthread tests/cpu-stress.cpp -o /tmp/wfloat-cpu-stress-test
/tmp/wfloat-cpu-stress-test
```

## LLM workload

Start loads SmolLM2-360M-Instruct once, then repeatedly generates up to
64 tokens from a fixed prompt, with one request in flight. CPU execution is
requested explicitly with four threads and zero GPU layers. The first run
downloads the model; later runs reuse the loaded instance. Model files use the
SDK's existing disk cache.
Loading uses stage labels because the current iOS SDK's download progress
callback can report 100% before the download completes.

The workload stops at the first nonzero thermal category, after five minutes,
or when Stop is pressed. Leaving the foreground or losing thermal readings
also requests a stop. There is no SDK cancellation API: the current load or
generation finishes, and no next generation starts. Consequently, the final
workload duration can exceed five minutes by the unfinished operation's time.
Elapsed workload time excludes model preparation. The app shows completed
iterations and only the latest output, updated once per generation. Thermal
polling continues afterward to show cooldown. No SDK APIs were changed.

## Run locally

Use Node 18+, Xcode with an iOS simulator runtime, CocoaPods, and/or Android
SDK tools with JDK 17. This app uses the same React Native 0.76.5 native setup
as the SDK's existing consumer fixture.

The SDK is linked from `../../packages/react-native-wfloat`. Its JavaScript,
codegen outputs, and staged native libraries must exist. Prepare them using
the [SDK development instructions](../../packages/react-native-wfloat/CONTRIBUTING.md)
and its `prepare`, `rn:build-natives`, and `rn:stage-natives` scripts as needed.
There are no changes to the SDK's public API in this prototype.

From this directory:

```sh
npm ci
cd ios
pod install
cd ..
npm start
```

In another terminal, from this directory:

```sh
npm run ios -- --simulator "iPhone 16"
# Or, with an Android emulator already running:
npm run android
```

For Android, set `ANDROID_HOME` to your SDK location or put `sdk.dir=...` in
`android/local.properties`. On an Apple Silicon Mac, use an `arm64-v8a` system
image. The app's Android ABI list is limited to the SDK's staged `arm64-v8a`
and `x86_64` binaries. A local virtual device can be created with:

```sh
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" 'system-images;android-35;google_apis;arm64-v8a'
"$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \
  --name Wfloat_Bench_API_35 --device pixel_7 \
  --package 'system-images;android-35;google_apis;arm64-v8a'
"$ANDROID_HOME/emulator/emulator" -avd Wfloat_Bench_API_35
```

`npm run typecheck` checks the app's TypeScript. Native collectors require
native builds; Fast Refresh only updates JavaScript. CPU workers are built into
the app through Android CMake/JNI and the iOS Objective-C++ module.
`npm test` (Node 22.6+) checks CPU interval calculations, memory sample validation,
and that manual stops, thermal stops, deadlines and errors do not schedule
another generation.

## What the reading means

| Platform | Native source | Values |
| --- | --- | --- |
| iOS | `ProcessInfo.thermalState` | nominal, fair, serious, critical |
| Android API 29+ | `PowerManager.getCurrentThermalStatus()` | NONE, LIGHT, MODERATE, SEVERE, CRITICAL, EMERGENCY, SHUTDOWN |

These are OS thermal classifications, not degrees Celsius or the LLM's own
temperature. The two scales remain separate. A successful Android API call
does **not** establish complete hardware thermal support; `NONE` can be
ambiguous. Older Android versions report unavailable. Read failures appear as
errors and never become a zero or nominal reading.

The app queries the native API approximately once per second while
foregrounded, plus before loading, before sustained execution, after each
generation, and after the run.
The current value includes the native read time. History keeps the latest
24 state changes and run checkpoints, newest first, and resets on Start.
Results live in memory only. Each observation also retains the raw enum,
source, OS version, environment, and native monotonic timestamp. These are
query timestamps, not hardware sensor update times; polling can miss brief
transitions and does not establish causality between a run and a state change.

iOS simulator detection is compile-time; Android emulator detection uses
build identifiers and is a heuristic. Neither simulator provides evidence of
a physical phone's thermal response. A constant nominal/NONE reading is a
valid outcome for this wiring prototype.

The native collectors belong to this public app. Device-farm orchestration,
adapters, and service integration remain outside it in the internal repo.

Sources: [Apple thermal state](https://developer.apple.com/documentation/foundation/processinfo/thermalstate-swift.property),
[Android thermal status](https://developer.android.com/reference/android/os/PowerManager#getCurrentThermalStatus()),
[Android thermal support caveats](https://developer.android.com/games/optimize/adpf/thermal).
