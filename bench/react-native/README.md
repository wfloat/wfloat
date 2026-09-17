# Wfloat Bench · React Native

This Android/iOS prototype collects low-level OS
telemetry available to an ordinary foreground app while it runs a local workload.
It has a minimal UI and preserves native observations in bounded JSONL captures.
The [metric inventory](./METRICS.md) lists the collection surface and source semantics.
Wfloat SDK instrumentation remains outside this prototype’s scope.

Choose one workload at a time: native CPU stress, Android CPU/GPU stress, or a
repeating SmolLM2-360M-Instruct generation loop. The dashboard samples thermal,
power, memory, CPU, scheduling, I/O, and lifecycle signals around that workload.

The complete pre-condensation research record, including per-field contracts,
test designs, physical-device observations, and primary-source links, is kept as
[the archived README](./docs/archive/README-before-condensation-2026-09-10.md).
It is historical evidence, not the current operating guide. The Samsung battery
current unit problem also has a focused [evidence note](./battery-current-units.md).

## Source collection refactor

Thread and broad OS-source polling now belong to the app rather than its display cards.
The existing idle overhead experiment still explicitly pauses those sources in
its paused phases. Other families retain their existing lifecycle for now.

Thread samples also retain source observations: complete Android `stat`/`status`
text, and all named iOS `THREAD_BASIC_INFO`/`THREAD_IDENTIFIER_INFO` fields already
returned by the collector. Raw observations are evidence, not newly validated
interpretations; identity-check failures remain explicit. Existing metric fields
and compact diagnostic logs remain available.

Thread and broad OS-source samples are flushed as UTF-8 JSONL to `source-captures/` under
Android app external files (internal fallback) or iOS Documents. The thread card
shows capture state/path. Signal files are capped at 64 MiB, thread/MetricKit files at 32 MiB, and the directory at
128 MiB; reaching a limit stops recording without deleting old files or stopping
metric reads. After reaching a limit, export and explicitly remove old files, then force-quit
and relaunch the app to start another capture. Pull individual Android JSONL files through ADB where permitted; a whole-directory
pull can fail on the private `.capture.lock` file. local iOS files are
in the simulator's app data container. Physical-farm file retrieval is validated on an AWS iPhone 14; Android validation
is recorded with each run. iOS enables Documents file sharing for export. A crash can leave an incomplete final line; flushing is not an fsync or
power-loss guarantee. This is bounded prototype evidence, not a result service.

MetricKit may deliver delayed iOS metric/diagnostic payloads into separate
`metrickit-*.jsonl` files; no payload delivery is claimed yet. Android also has an
explicit system-trace, native/Java heap and stack-sampling experiments: requests
cancel after about 30 seconds and retain
platform rate limits. Profile exports use a separate 32 MiB directory and a
16 MiB per-file copy bound; the OS manages its original profiling files.

The Android memory JNI payload uses named keys instead of positional slots;
its existing metric meanings and UI are unchanged.

## Run locally

Requirements: Node 18+, JDK 17 and Android SDK tools for Android; Xcode, an iOS
simulator runtime, and CocoaPods for iOS. The project uses React Native 0.76.5.
The SDK is linked from `../../packages/react-native-wfloat`; prepare and stage its
JavaScript, codegen, and native libraries according to the
[SDK development instructions](../../packages/react-native-wfloat/CONTRIBUTING.md).

From this directory:

```sh
npm ci
cd ios && pod install && cd ..
npm start
```

In another terminal:

```sh
npm run ios -- --simulator "iPhone 16"
# Or, with an Android emulator already running:
npm run android
```

For Android, set `ANDROID_HOME` or add `sdk.dir=...` to
`android/local.properties`. The supported staged ABIs are `arm64-v8a` and
`x86_64`; use an `arm64-v8a` image on Apple Silicon. Native collector changes
require a rebuild; Fast Refresh updates only JavaScript.

```sh
npm run typecheck
npm test
```

Standalone native probes and Android test-APK recipes remain beside their exact
acceptance rules in the [archive](./docs/archive/README-before-condensation-2026-09-10.md).

## Workloads and stop behavior

- **CPU stress** runs cancellable native arithmetic workers, ramping from two
  workers to half the reported processors at 10 seconds and all processors at
  20 seconds, capped at 64. It stops on a nonzero or unavailable thermal state,
  backgrounding, monitor failure, manual Stop, or a ten-minute deadline.
- **Combined CPU/GPU stress (Android)** adds offscreen OpenGL ES 3.1 compute and
  leaves one reported processor available for GPU submission and driver work.
  A fence and reference check prove progress, not GPU utilization. Unsupported
  devices fail explicitly.
- **LLM workload** loads SmolLM2-360M-Instruct once, requests CPU execution with
  four threads and zero GPU layers, and repeatedly generates up to 64 tokens.
  It stops scheduling after five minutes, manual Stop, backgrounding, or a
  thermal problem. With no SDK cancellation API, an in-flight operation may
  finish after the stop request.

Native thermal and foreground guards operate independently of JavaScript.
Simulator results validate wiring and failure handling only; they do not
establish physical thermal, memory, power, or performance behavior.

## Source inventory

The [complete metric checklist](./METRICS.md) lists every interpreted metric and
additional source family, including availability and native-unit caveats.
Capture processing and writes contribute to the app’s own CPU, memory and I/O
readings. Earlier overhead results predate this expansion.
New broad OS observations go to `signals-*.jsonl` about every ten seconds; the
small status panel shows capture state and top-level errors; nested API failures remain in the records. The native probe buttons exercise page state, GPU queries, TCP counters, frame timing and platform-specific kernel counters.


All metrics are app/process scoped unless labeled system or device scoped. Most
foreground gauges are sampled about every two seconds; thermal category is
queried about once per second and at workload checkpoints. Missing access,
unsupported APIs, malformed values, and genuine zeroes remain distinct.

| Family | Android | iOS |
| --- | --- | --- |
| Thermal | `PowerManager.getCurrentThermalStatus()` (API 29+); normalized `getThermalHeadroom(0)` (API 30+, at most every 10 seconds) | `ProcessInfo.thermalState` |
| Device energy | `SystemHealthManager` power monitors (API 35+), manual reads and one idle-versus-CPU comparison | No public equivalent implemented |
| Battery | `ACTION_BATTERY_CHANGED` temperature/voltage; `BatteryManager` current-now and charge-counter properties | Battery level/state, low-power mode |
| Current memory | `/proc/self/smaps_rollup` with complete `/proc/self/smaps` fallback; `/proc/self/status`; runtime/native-heap APIs | `task_info(MACH_TASK_BASIC_INFO/TASK_VM_INFO)`, malloc zones, `os_proc_available_memory()` |
| Memory events | Major/minor process faults; controlled file mapping probe | Page-ins, copy-on-write faults, decompressions, memory warnings, file and purgeable probes |
| CPU/process | `getrusage`, `/proc/self/task/*`, `/proc/self/status`, CPU headroom on API 36+ | `getrusage`, Mach threads and `THREAD_BASIC_INFO` |
| Network | `TrafficStats` UID receive/send bytes and packets | Whole-interface `getifaddrs` counters |
| Storage I/O | `getrusage` `ru_inblock`/`ru_oublock`, interpreted in 512-byte units | `proc_pid_rusage(RUSAGE_INFO_V2)` `ri_diskio_bytesread`/`ri_diskio_byteswritten` |
| Resources | `/proc/self/fd` count | Bounded `fcntl(F_GETFD)` scan; `/dev/fd` probe; Mach port namespace |

### Memory fields retained

The dashboard preserves platform-native names because superficially similar
counters are not cross-platform equivalents.

Android collects RSS and PSS; private/shared clean and dirty; anonymous,
file-backed, and shared-memory PSS; dirty and calculated-clean PSS; referenced,
KSM, locked-resident, HugeTLB/transparent-huge-page, lazy-free, swap, and SwapPss
accounting; virtual size and lifetime `VmPeak`; page-table and locked bytes; VMA
count; Java heap limit/capacity/free/used; native heap allocated/free/size; and
six ART lifetime counters: GC count/time, blocking GC count/time, bytes allocated,
and bytes freed.

iOS collects RSS, physical footprint, virtual size, internal/external/reusable/
compressed and purgeable ledgers, native heap allocation, region count, current
memory headroom, lifetime RSS/footprint/internal/external/reusable/compressed
peaks, cumulative compression with an interval rate, and decompression activity.
Allocator gauges include malloc-zone bytes in use, reserved bytes, and blocks in
use. Metal reports current resource allocation and the default device's
recommended working-set size; the latter is a device capacity recommendation,
not this process's current use.
`compressed_lifetime` is a cumulative accounting credit, not current compressed
bytes or bytes physically written; its derived rate is accounting activity, not
compressor bandwidth. Counter resets/decreases invalidate the interval.

The 64 MiB resident-memory hold, Android native-allocation check, iOS purgeable
check, and 32 MiB file-backed check validate measurement paths. They do not turn
these counters into per-model attribution. Lifetime peaks include startup and
earlier runs and cannot be reset without starting a new process.

### CPU and scheduler fields retained

Process CPU reports cumulative user/system time and interval utilization.
Context switches retain voluntary and involuntary counts and rates. Thread
inventory reports cumulative and interval CPU time, count, and OS state. Android
also retains per-thread priority, nice, switches, stored `Cpus_allowed_list`,
getter-reported affinity, last logical CPU, scheduling policy, and real-time
priority. The five busiest threads appear in the UI; logs retain every readable
thread.

Android CPU headroom is an OS estimate of spare capacity, available only on API
36+ and subject to device support, warm-up, caching, and calculation-window
semantics. Affinity readings describe permission at read time, not where time was
spent. Samsung/Qualcomm devices have shown differences between the proc status
(stored) mask and getter-reported mask, so neither is silently treated as ground
truth.

## Interpretation rules and pitfalls

- **Query or receipt time is not sensor time.** Battery reports may be sticky or
  triggered by another field; property getters and thermal APIs may return cached
  values. Battery age is time since app receipt and does not prove sample age.
  Power-monitor readings differ: Android supplies an elapsed-realtime snapshot
  timestamp, so their displayed age is source-snapshot age at the manual read.
  Polling cadence still does not establish hardware cadence or accuracy.
- **Thermal scales stay separate.** Android categories and Apple
  nominal/fair/serious/critical are OS classifications, not degrees Celsius.
  Android thermal headroom rises with thermal stress; 1.0 is severe.
- **Platform power access is asymmetric.** Android API 35 can expose cumulative,
  whole-device subsystem energy. iOS has no implemented public equivalent here.
  Monitor coverage can overlap, values include plugged-in use, timestamps may
  repeat, and Android may cache or noise readings. Do not sum monitors or claim
  app-attributed joules. The ordered idle/load comparison is descriptive.
- **Battery current is signed net battery flow.** Positive enters the battery and
  negative leaves it; it is not phone power. Some Samsung firmware returns mA
  through the API declared as µA, producing a 1,000× display error. No correction
  is applied. Charge counter is remaining charge; voltage is not charger voltage.
- **Memory counters overlap.** RSS includes shared pages; PSS apportions them;
  Apple physical footprint includes compressed accounting. Clean/dirty, backing
  type, referenced, huge-page, and swap fields are classifications, not values to
  add to RSS/PSS. Virtual size may exceed physical RAM normally.
- **Rates need valid adjacent samples.** Lifecycle or identity changes, counter
  decreases, invalid intervals, and unavailable inputs suppress derived rates.
  Multi-source scans are sequential, not atomic snapshots.
- **Network is UID-wide and since boot.** It can include other processes sharing
  the UID and unrelated traffic. Storage counters have platform-specific meanings;
  caches can hide physical disk activity.
- **Logs are diagnostic evidence.** Android JSON logcat rows and iOS chunked
  records rotate and are not durable run storage. Join them using PID, sequence/
  run identities, and declared counts. Collection overhead is not fully calibrated.

The optional Android battery refresh probe uses a hidden Binder transaction
checked against AOSP API 29–36. It is a compatibility experiment: an accepted
one-way request proves neither execution nor a fresh sample, and OEMs may change
it. Ordinary-app validation must restore hidden-API enforcement after automation
tools that relax it.

## Access and lifecycle boundaries

The app requests no root access, shell execution, hidden-API exemption, or new
fine-access permission. It reads self-owned procfs data and public OS APIs except
for the labeled battery refresh experiment. An empty energy inventory cannot
distinguish absent hardware from a disabled service. Android procfs/vendor behavior
varies by release; iOS Mach fields require reply-version checks and simulator
behavior may differ from devices.

Periodic collectors use native background queues, allow at most one relevant request in
flight, and publish only while foregrounded. Backgrounding cancels scheduled work,
releases temporary probes, clears or invalidates current display state, and rejects
late bridge responses. OS lifetime counters retain process history after resume. Passive trim/lifecycle
observers and delayed MetricKit report delivery are separate from foreground polling.

## Validation still worth doing

Parser, bridge, lifecycle, controlled-allocation/transfer, and workload-stop paths
have broad native and JavaScript coverage. Remaining work should prioritize:

1. Relevant Android vendor/API combinations under ordinary-app policy: thermal,
   power monitors, battery properties, procfs, CPU headroom, and affinity.
2. Representative iPhones: Mach field availability, purgeable accounting,
   memory headroom/warnings, and collection cost outside the simulator. Existing
   checks prove positive compression counters, not an uninterrupted nonzero rate.
3. End-to-end polling, bridge, rendering, and logging overhead, especially full
   smaps and per-thread scans.
4. Signal usefulness over realistic workloads and device-farm charging/power
   conditions.
5. Durable export/run identity only if this prototype becomes a repeatable
   measurement system; that is a separate design decision.

Detailed acceptance procedures, edge-case contracts, device observations, and
citations remain in the [archived research record](./docs/archive/README-before-condensation-2026-09-10.md).

Native descriptor-lock regression (macOS/Linux; pass an existing writable scratch directory):

```sh
c++ -std=c++17 cpp/tests/DescriptorLockTest.cpp -o /tmp/wfloat-descriptor-lock-test
/tmp/wfloat-descriptor-lock-test /tmp
```

The negative control reproduces lock loss from duplicate/close; ten collector scans must preserve the lock. Android uses the same source compiled with its NDK and run on the emulator.

The Android **CPU/GPU source probe (45 seconds)** beside the source controls uses the existing native workload and thermal/lifecycle stops. Its native deadline needs no automation stop command; progress and verified GPU batches are retained as `BenchCpu_workload_status` in the source capture. This is validation context, not another OS metric.

The TCP source probe also checks owned socket-queue accounting. Native regression
commands (from this app directory):

```sh
clang++ -std=c++17 -fsanitize=address,undefined cpp/tests/AppleInterfaceTest.cpp -o /tmp/wfloat-interface-test
/tmp/wfloat-interface-test
clang++ -std=c++17 -fsanitize=address,undefined cpp/tests/SocketQueueTest.cpp -o /tmp/wfloat-socket-test
/tmp/wfloat-socket-test
```

The first checks Darwin interface message bounds, versions and 64-bit precision;
the second emits raw verified-transfer/queue observations. Android uses the same
socket source compiled with the NDK. Physical/local results and interpretation
limits are linked from the metric inventory.
