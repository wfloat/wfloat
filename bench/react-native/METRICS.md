# Metric inventory

**A = Android; I = iOS.** This is the supported collection surface, not a claim that
all devices return every value. Existing cards show interpreted readings; the
OS-source capture retains additional native fields and explicit failures. Text/dictionary
sources preserve additional OS-supplied fields; native records retain returned
fields and complete ABI bytes where supplied by the collector. Large native integers in the new
capture are decimal strings. Query timestamps describe our reads, not sensor age.

## Interpreted readings

| Platform | Metrics |
|---|---|
| A, I | OS thermal category; workload thermal checks and stop reason |
| A | Thermal headroom and requested forecast window; CPU headroom, calculation window/type, minimum query interval and availability |
| A | Battery temperature; voltage and report receipt age; instantaneous signed current; remaining charge; charging status/power source/level context |
| A | Power-monitor identity/type, cumulative energy (µWs), source timestamp/age; per-monitor interval energy and average power in the explicit idle/load experiment |
| A, I | Process user/system/total CPU time; interval CPU utilization (100% = one core); thread count; per-thread user/system/total CPU time and interval utilization; OS thread state |
| A | Process voluntary/involuntary/total context switches and interval rates; per-thread voluntary/involuntary switches and rates; last logical CPU; scheduling policy; realtime priority; priority; nice; stored CPU affinity mask/count; getter CPU affinity mask/count |
| I | Process total context switches and rate; Mach thread ID, CPU usage, policy, flags, suspend count and sleep time |
| A, I | Resident memory (RSS), peak RSS, virtual address-space size |
| A | PSS; private clean/dirty RSS; shared clean/dirty RSS; anonymous RSS; anonymous/file/shared-memory PSS; dirty PSS; calculated clean PSS; referenced bytes; swap; SwapPss; LazyFree; page-table bytes; locked virtual bytes; locked resident bytes; VmPeak; VMA count |
| A | AnonHugePages; FilePmdMapped; ShmemPmdMapped; private/shared HugeTLB; KSM |
| A | Java heap used/free/capacity/limit; native heap allocated/free/size; ART GC count/time, blocking GC count/time, allocated/freed bytes |
| A | System available/total memory, low-memory threshold and flag |
| I | Current/peak physical footprint; current/peak internal, external, reusable and compressed accounting; cumulative compressed accounting and interval rate; graphics footprint |
| I | Purgeable nonvolatile, nonvolatile compressed, volatile and volatile compressed ledgers; VM region count; app memory headroom; allocator bytes in use/reserved/blocks in use |
| I | Metal allocated resource bytes; recommended working-set bytes |
| A | Minor/major process faults and rates |
| I | Page-ins, copy-on-write faults, decompression events and rates; memory-warning count, last receipt and time since receipt |
| A | Process input/output block counts and derived 512-byte accounting; UID received/sent bytes and packets with interval rates; open descriptor count |
| I | Process disk bytes read/written and rates |

Android’s explicit 45-second source-load probe retains its native state, stop reason, elapsed time and verified GPU batches alongside the OS samples.

Workload/probe counters (CPU/GPU iterations, verified GPU work, allocation sizes,
file operations, wait/wake counts, phase duration and cancellation) validate these
readings; they are not independent hardware metrics.

## Additional source observations

The following are recorded in `signals-*.jsonl` about every ten seconds. Partial
records, API errors and unsupported values remain visible. They have no per-field
cards or automatic derived rates.

### Android

The latest source additions are below. These include raw records and discovery
metadata, not additional dashboard cards.

| Source | Retained observations |
|---|---|
| Generic Linux perf probe | All 62 generic hardware/software/cache event configurations; native counts or individual syscall errors. Counter delivery mechanisms are excluded. |
| Newer framework/event sources | API 37 `MemoryInfo.freeMem`; ANR ID/type/timeout/visibility and bounded native crash/ANR trace bytes in exit history. Explicit OS-triggered profiling and running-trace requests preserve OS-delivered artifacts and errors; no automatic trigger enablement. |
| GPU/DMA/CMA accounting | Existing pinned GPU-memory BPF map for own PID and global totals, with safe child isolation and native errors; ION/DMA pool totals; CMA successful/failed/released pages, total and available pages. No BPF program loading or attachment. |
| PMU definitions | Exposed event types, CPU masks, capabilities, formats and event encodings/scales/units; discovery does not enable counters. |
| UID kernel accounting | Own-UID CPU times, frequency residency, concurrency and foreground/background I/O records, including exited processes. Binary residency retains exact bytes and native words. |
| Kernel resource tables | Scheduler statistics, allocation/vmalloc records, file/inode/dentry/AIO limits and usage, locks, System V IPC tables and additional network protocol tables; full text or access errors. |
| Cached cellular signal | Published CDMA/GSM/LTE/NR/TD-SCDMA/WCDMA strength, quality and CQI getters; native sentinels retained, no active scan or subscriber identifiers. |
| IIO electrical/thermal channels | Exposed temperature, voltage, current, power and energy raw/input values with scale, offset and channel metadata. A raw read may initiate a conversion. |
| Qualcomm core control | Cached per-CPU busy/online/isolation state, cluster running/active/needed CPU counts and policy thresholds; aggregate workload/I/O mode when exposed. |
| Storage/controller and slab additions | UFS existing-monitor read/write request counts, sectors, busy time and latency min/max/average/sum; slab object/capacity/node/CPU allocation/free statistics; F2FS discard, atomic-write and checkpoint state. Explicit monitor enablement and access errors. |
| Driver discovery | Incremental sysfs directory-name inventory, canonical-path deduplication and listing errors; unknown attributes are not read automatically. |

| Audit additions | Retained observations |
|---|---|
| Power policy/context | Discharge-prediction Duration and personalization (null or negative means no usable estimate); light idle; low-power standby enabled/exempt/allowed reasons and wake-on-LAN; own power allowlist and standby bucket; sustained-performance capability and location power-save policy. No policy changes or location reads. |
| App memory/restriction context | Java memory-class/large-memory-class budgets (MiB), low-RAM designation, background restriction, low-memory-kill reporting support, debugger attachment. |
| App code storage | API35+ native byte breakdown for APK, DEXOPT artifacts, DM, libraries and current/reference profiles, inside the existing UID-storage query/cache. |
| Native scheduler/resource scope | Per-TID `ioprio_get` raw value/class/data; class NONE means default policy. Full `getrusage` for calling collector thread and waited-for children; Linux `ru_maxrss` is KiB and the THREAD peak remains process-scoped. Unmaintained fields can be zero. |
| Wakeup/suspend | Kernel wakeup-source activation/event/expiry/suspend-prevention counts and native times; suspend successes/failures/stages, last error/device/IRQ and hardware-sleep durations. Not app-specific CPU wakeups. |
| Device runtime power | Bounded CPU/devfreq/block/GPU power state, active/suspended time, usage/children, wakeup counts/times and PM-QoS policy. No suspend or control writes. |
| Powercap/power supply/hwmon | Energy/power/range/limits by available powercap zone; expanded battery/charger bounds, averages, health/resistance and policy; hwmon extrema, hysteresis, faults, limits and averaging configuration. Raw units and read/scan failures retained. Powercap numeric Android support is unverified. |



| Source | Retained observations |
|---|---|
| Hardware/firmware context | Manufacturer/brand/model/device/product/board/hardware, ABI lists, reported SoC manufacturer/model and SKU variants, bootloader/build/version/security-patch metadata. Unknown strings and older-API nulls stay explicit; no serial or personal device identifier. |
| OS application-start history | Last 16 own-app records (API 35+): startup state/reason/type, PID/UID/process, launch mode/force-stop/component context and every returned native monotonic-nanosecond timestamp. Includes launch/fork/onCreate/bind/first-frame/fully-drawn/renderthread/composition keys when supplied. Incomplete and absent fields stay explicit; no app startup instrumentation or inferred duration. |
| Process execution context | Foreground-exclusive CPU reservations (distinct from affinity), process-start and start-request timestamps in elapsed-realtime and uptime milliseconds. No affinity changes; timestamps are native lifecycle context, not app-ready duration, and prewarmed processes can predate requests. |
| DMA-BUF sysfs inventory | Up to 128 inode-keyed shared hardware buffers: byte size and exporter name, when CONFIG_DMABUF_SYSFS_STATS and permissions permit. System buffer scope, not app attribution; directory/read failures, truncation and concurrent disappearance retained. No buffer contents or synchronization changes. |
| Network-interface sysfs | Full standard per-interface packet/byte/error/drop/multicast/collision and detailed RX/TX error counters; link/carrier state/change counts, MTU, speed/duplex and transmit queue length. Interface scope, driver accounting and explicit read errors; no addresses. |
| Filesystem sysfs | F2FS lifetime writes, segment/accounting/GC/checkpoint/compression fields; ext4 delayed-allocation blocks, session/lifetime writes and error counts/times. Whole-filesystem scope; native missing/denied states. Fixed read-only names, no GC, reset or monitoring-enablement writes. |
| Optional framework thermometers | Enumerate ambient and deprecated device-temperature sensors, native range/resolution, declared power, FIFO/rate/reporting capabilities and registration results. Last 64 sample/accuracy events retain raw Celsius values, sensor elapsed-realtime timestamp and receipt time; requested 1 s period is advisory. Absent sensors are explicit. |
| Power/battery callbacks | Last 64 foreground battery low/okay/charging/power/screen/idle/light-idle/standby receipts, total count, initial-sticky flag and native accompanying battery/power values, including low-battery boolean and chemistry text. Bounded raw extras preserve every delivered scalar/primitive-array key and native type, including unknown OEM keys; unknown units remain unknown. Identifier keys and opaque object payloads are explicitly omitted. Receipt time is not sensor time. |
| Kernel memory and interrupt records | Complete bounded buddy/pagetype/zone/slab accounting, soft/hard interrupt and softnet counters, swaps; self KSM/autogroup/architecture records. Native missing/denied states retained. |
| Memory-policy sysfs/procfs | THP policy and per-size statistics, khugepaged collapse/scan counts, KSM sharing/profit counters, HugeTLB pools, NUMA node memory/statistics/distances and read-only VM reclaim/writeback/overcommit settings. Never changes policy or requests reclaim. |
| `/proc/self/stat` | Complete record: identity/state, faults, CPU time, scheduling, thread count, virtual/resident memory, process lifetime/start and kernel accounting fields. Native procfs field order/units are preserved. |
| `/proc/self/status`, `statm` | Complete records: memory breakdown, peaks, swap, page tables, locked/pinned memory, affinity, context switches, process/thread metadata and kernel capability flags when supplied. `statm` uses pages. |
| `/proc/self/smaps` | Complete per-mapping accounting, including all returned page-size, sharing, dirty/reference, huge-page, swap and VmFlags fields; bounded to 4 MiB with truncation explicit. No memory contents. |
| `/proc/self/fdinfo/*` | Descriptor targets, positions, flags, mount/inode IDs and all returned type-specific fields (for example epoll/eventfd and DMA-BUF size/exporter/reference counts); stat metadata and before/after consistency observation. Up to 512 descriptors, 100 ms between-query deadline, 16 KiB/file and 512 KiB total. Concurrent descriptor reuse remains possible. |
| `/proc/self/{mountinfo,mounts,timers,personality,wchan,syscall,stack,latency}` | Raw process mount/timer/execution metadata where readable; wait channel, syscall and stack refer to the main thread. Access failures retained. |
| Native resource sources | All ten `mallinfo2` fields and bounded allocator XML; all 16 Linux resource limits and infinity sentinel; eight clock values/resolutions; full `sysinfo` memory/swap/load/uptime/process accounting with `mem_unit` and load shift; calling collector thread CPU/nice/RR interval; HWCAP/HWCAP2 auxiliary-vector CPU capabilities; page/tick/minimum signal-stack values; timer slack, seccomp/no-new-privileges/dumpability, THP, tagged-address and SVE/SME vector-length controls; `statfs` filesystem type, sizes, blocks, nodes and flags. Allocator placeholders and policy-dependent scheduler returns are not normalized. |
| `/proc/self/smaps_rollup` | Every returned aggregate field, including existing interpreted memory metrics and additional kernel fields. |
| `/proc/self/maps`, `numa_maps` | Mapping metadata and NUMA accounting when readable; no memory contents. Each text read is capped at 256 KiB and marked if truncated. |
| `/proc/self/task/*/schedstat` | Per-thread execution nanoseconds, run-queue wait nanoseconds and timeslices; raw text with start-time identity checks. Native `sched_getattr` adds policy, flags, nice, priority, runtime/deadline/period nanoseconds and utilization clamps (0–1024 scale), with returned ABI size and errno. These are scheduler parameters, not measured utilization. At most 512 threads with a 250 ms deadline checked between queries; partial scans flagged. An OS call can overrun that deadline. |
| `/proc/self/task/*` complete records | Identity-checked per-thread stat/status/sched/io/frequency residency/cgroup/wait-channel/syscall/stack/latency/timer-slack text, including every supplied scheduler field. 512 threads, 250 ms between-query budget, 32 KiB/file and 1 MiB aggregate; native failures and partial scans retained. |
| Cgroup controllers | Resolve the app's kernel-reported cgroup v1/v2 mounts and membership, then attempt CPU usage/throttling/quota/weight/clamps, cpuset restrictions, memory/swap/zswap accounting/events/limits, I/O accounting/limits/pressure and PID limits/events. Mount-bounded ancestors, additional kernel-memory/memsw, I/O cost/latency, HugeTLB, RDMA, misc and device-memory controller records; 2,048 files/1 MiB/250 ms. Shared hierarchical records must not be summed. Group scope may include other processes; successful membership discovery does not imply readable accounting. |
| Block-device sysfs | Raw block I/O completion/merge/sector/wait/in-flight/discard/flush records; queue geometry, request limits, read-ahead, scheduler, cache/discard/zoned configuration. Zram memory/compression/I/O/backing-device statistics and algorithm/configuration where readable. Fixed filenames, bounded device discovery/fallbacks; whole-device scope and native errors. No settings are changed. |
| `/proc/self/time_in_state` | Per-process frequency residency if the kernel exposes it; raw native frequency/time units. |
| `/proc/self/schedstat`, `sched` | Main-thread execution time, run-queue wait time, timeslices and all kernel scheduler fields when readable. **Main thread, not process total**; scheduler statistics may be disabled. |
| `/proc/self/io` | Character/read/write/syscall and storage accounting fields when readable; denied on tested ordinary-app builds. |
| `/proc/self/limits`, `oom_score`, `oom_score_adj`, `cgroup` | Resource limits, OOM selection score/adjustment and control-group membership. OOM score is not a memory budget. |
| `/proc/meminfo`, `vmstat`, `stat`, `loadavg`, `uptime` | Complete system memory, VM activity, CPU ticks, scheduler/load and uptime records where readable. Access varies. |
| `/proc/diskstats`, `/proc/net/{dev,snmp,netstat,sockstat,sockstat6}` | Raw block-device I/O, interface traffic, network protocol counters and socket-allocation accounting where readable. System/network-namespace scope; access failures retained. |
| `/proc/pressure/{cpu,memory,io}` | PSI `some`/`full` averages (10/60/300 seconds) and cumulative stall microseconds where readable. System scope; no app attribution. |
| CPU sysfs | Online/present/possible CPU sets; per-CPU current/min/max scaling frequency, current/min/max hardware frequency, governor, frequency time-in-state, core/package IDs and capacity where readable. Frequency values are kHz; reported current frequency is not proof of actual instantaneous clock. |
| CPUFreq policy sysfs | Complete generic policy attributes through policy directories: online/all member CPUs, driver/governor/available governors, frequency table and current/min/max frequencies, optional hardware-feedback average frequency, transition latency, firmware limit, userspace requested speed, residency/transitions and global boost policy. These paths can differ in access from per-CPU aliases. Hardware feedback, last requested frequency and limits remain separate; native errors and bounds retained, no policy changes. |
| CPU cache/idle sysfs | Cache level/type/size/line size/set count/associativity/partition/sharing; cluster/core/package/sibling CPU lists; frequency transition counts/matrix; idle-state name, exit latency, target residency, configured power, cumulative time/entries, above/below/rejected counts, disabled/default state and suspend-to-idle time/entries. Native files and failures retained; 32-CPU/150 ms/2,048-file/256 KiB bounds. Standard numbered paths are attempted when directory listing is denied; partial discovery is explicit. Idle-state power is a configured estimate, not a live power reading. |
| `Debug` Binder/classes | Local/proxy Binder object counts, death registrations, raw sent/received transaction returns and loaded-class count. Negative returns (observed −1 for transactions) mean unavailable, not negative traffic. |
| `Debug.getRuntimeStats` | Every returned ART key: existing six counters plus GC-count-rate and blocking-GC-count-rate histograms on the tested runtime. Names/availability can change. |
| `Debug.getMemoryInfo` | All `memoryStats` summary keys: code, stack, graphics, Java/native heap, system, private-other, total PSS/swap; total/swappable PSS; total private/shared clean/dirty; Dalvik/native/other PSS and private/shared dirty. Values are KiB; categories overlap other memory sources. |
| `SystemHealthManager.takeMyUidSnapshot` | All returned measurements, timers, named maps and nested PID/process/package/service records. Public Android key names and numeric IDs are retained. Includes CPU user/system time, battery realtime/uptime timebases, network bytes/packets, radio/controller activity, wakelocks, process-state and device-activity timers when supplied. These are cached BatteryStats accounting, not fresh sensor readings; timer durations are milliseconds. Deprecated CPU-power mA·ms is explicitly vendor-dependent and unreliable. |
| `SystemHealthManager.getGpuHeadroom` | Raw GPU headroom estimate, availability, requested average/window and minimum polling interval (API 36+). Native cadence respected; NaN is unavailable, not zero. |
| `BatteryManager` | Average signed current (µA), current-now (µA), remaining charge (µAh), capacity (%), status, remaining energy (nWh), estimated time to full charge (ms). Unsupported sentinels remain errors. Firmware unit defects remain uncorrected. |
| Sticky battery report | Level/scale, status, health, plugged source, presence, temperature, voltage, low-battery flag, chemistry and bounded typed raw broadcast extras; cycle count, charging status and capacity level if provided. Receipt is not sensor sampling time. |
| Thermal callbacks | Foreground status callbacks (API 29+) and headroom callbacks (API 36+): current/forecast headroom, forecast window and thresholds, receipt times and callback count. Last 64 retained; registration can emit an initial value rather than a transition. |
| Standard hardware sysfs | Bounded discovery of thermal-zone temperatures/trips, cooling-device state/transitions, devfreq frequency/residency/load, power-supply voltage/current/charge/energy/temperature/cycles, open-circuit/design voltage, input/charge limits and time estimates and hwmon sensor fields. Fixed kernel-interface families, with bounded standard thermal/cooling/battery path attempts when listing is denied; inaccessible directories/files remain failures, not absent hardware. Each family has its own 256 KiB/2,048-file cap and between-query deadline (2 seconds for thermal sensor reads, 150 ms otherwise), so a large thermal inventory cannot suppress the other families. Zone identities/temperatures are read before trip/policy details; actual trip filenames are enumerated when allowed. Read timestamps are not sensor sampling timestamps; sentinel and synthetic-zone values remain raw. An ordinary-app S23 run returned thermal-zone data; access remains firmware-dependent. |
| Mali/Pixel driver paths | Read-only GPU identity/memory, utilization, clock/limit context, DVFS table/residency/transitions, power-state accounting, UID frequency residency and capacity-policy fields; native paths/errors retained. `gpu_top` is excluded because reading resets shared interval counters. No debug, pinning, governor or power controls are changed. |
| MediaTek GED driver paths | Cached GPU loading/blocking/idle components, current/previous frequency index/value, frequency-level count and native DVFS/debug/limit policy values. Fixed module/sysfs/debugfs candidates with normal bounds and raw errors; no enablement, reset or clock/power writes. Driver sampling window and native frequency encoding remain unnormalized. The reviewed legacy GED blocking getter returns 100 minus averaged loading, not measured blocking time. |
| Qualcomm KGSL driver paths | Raw GPU clock/limits/frequency table, temperature, reset count, thermal power level, power-level count, model and devfreq frequencies/transitions/residency, where readable. Vendor-specific names/units and unknown sampling window are preserved; no enablement writes. Busy percentage/pair reads are excluded because reviewed KGSL handlers can reset shared cached statistics while powered off. A readable idle zero does not validate load response. Self-process mapped/unmapped/imported and allocation-type current/peak memory, plus driver-wide allocation counters, are attempted separately; not dedicated VRAM. |
| Samsung GPU aliases / Exynos getters | Raw GPU model, clock/limits/frequency table and thermal text through Samsung kernel aliases. Physical A54 returned ten alias fields including GPU thermal text, utilization and clock/limit/table/governor values. Samsung/MediaTek additionally attempts its non-resetting cached GPU-busy getter and native governor labels (hardcoded `Default` in reviewed SKI source). Identified Exynos/Mali hardware additionally attempts cached utilization, governor, frequency/voltage table, cumulative residency/busy accounting and lock/thermal/queue policy getters. Driver units and formatting remain raw; aliases are not independent sensors. Exynos residency reads refresh accounting without resetting it. Frame-profile reads that consume shared records and Qualcomm busy aliases that reset cached statistics are excluded. |
| Samsung Xclipse SGPU interface | Cached utilization and compute-activity values, cumulative job/fence counts, kernel GPU page accounting, frequency residency, voltage/DVFS tables, governor/utilization-source/threshold/compute-weight/lock policy and profiler policy getters. Bounded devfreq discovery plus the reviewed S5E9925 address fallback. Weighted/capped utilization is not pure busy time; compute activity is not hardware compute-unit occupancy; job counters are not outstanding queue depth. Native errors retained; physical numeric access remains unverified. No frame-profile consumption, settings changes or desktop-AMDGPU assumptions. |
| `PowerManager.getThermalHeadroomThresholds` | Throttling-status → normalized thermal-headroom thresholds (API 35+), not temperatures |
| `ComponentCallbacks2` | Trim callback level, receipt time, total count and last 64 events; many pressure levels are no longer delivered on Android 14+. UI-hidden is a lifecycle event, not proof of memory pressure. |
| `ActivityManager.MemoryInfo` | Available/total memory, low-memory threshold/flag; API 34+ advertised RAM separately from kernel-accessible total. |
| `ActivityManager` process state/history | Current importance, trim level, LRU position and importance reason; last 16 exits with PID/name, reason, status, importance, timestamp and last sampled PSS/RSS. Historical zero memory can mean never sampled. |
| `ProfilingManager` | Explicit system trace, native heap, Java heap and stack-sampling requests; delivery/error status and original returned files. Requests cancel after ~30 seconds. Rate limits remain enabled. Trace contents depend on the OS; not periodic polling. Default native heap profiling overran on Pixel 9. An explicit 64 KiB sampling / 8 MiB buffer / 10 s request subsequently delivered without nonzero error/data-loss counters. Requested settings and actual trace metadata are retained; sampled allocations are not an exact heap census. |
| `PowerManager` | Power-save mode, device-idle mode and interactive state |
| Storage accounting | Own UID app/data/cache/external-cache bytes; own cache size/quota; volume free/total and allocatable bytes. OS accounting and reclaim-policy estimates, not physical I/O; sampled at most once per 60 seconds with actual query times and cache age. No allocation/cache eviction requested. |
| Display configuration | Stored Android brightness/mode/screen-off timeout and reviewed sysfs backlight requested/actual/max level, power/type/scale (native driver levels, not nits). Current/supported modes, physical dimensions, reported/alternative refresh rates, VSYNC offset, presentation deadline, display state and HDR capability/luminance fields; supported HDR/SDR ratio and adaptive-refresh capability. Rates and luminance limits are reported configuration, not measured frames or light output. |
| Network/Wi-Fi link | Current network bandwidth estimates, capability/transport IDs, signal strength, metering/background policy and MTU; Wi-Fi RSSI, frequency, current/max Tx/Rx link rates and standard. Normal network/Wi-Fi-state permissions only; no addresses, SSIDs, BSSIDs or location permission. Sentinels remain raw; link rates are not measured throughput. |
| `StatFs` | Filesystem block size/count, free and available blocks; not app storage use or transfer speed |
| `TrafficStats` | UID, total-device and mobile receive/send bytes and packets, since boot; unavailable fields are null |
| `sysconf`, clocks | Page size, clock ticks/second, configured/online processor count, elapsed realtime and uptime |

### iOS

| Latest source additions | Retained observations |
|---|---|
| Per-thread performance levels | XNU instructions, cycles, user/system Mach time and OS-accounted nJ for each performance level; exact counts and returned layout. |
| Mach IPC table | Own-process table size and free entries. |
| Realtime thread faults | Native start/duration, address, PC, thread/process identity and fault type from the own-process ring; an empty ring is valid. Calling-thread interrupt time is a release-kernel placeholder unless scheduler hygiene instrumentation is enabled. |
| Owned VM objects | Object ID hash, virtual/resident/wired/reusable/compressed bytes, ledger tag and purgeable flags; distinct from VM mappings. Physical iPhone returned EPERM; controlled host allocation response passed. |
| XNU numeric declarations | Complete reviewed candidate list in [ScalarSysctlCatalog.h](ios/WfloatBench/ScalarSysctlCatalog.h); exact native bit interpretations, byte count, errors and read timing. Includes resource policy/context, not only activity counters. |
| Native statistical blobs | 28 reviewed network/IPC/VM/cache statistical sources, with exact bytes, native format and errors. Layout-dependent blobs are not guessed into cross-version structs. |
| Network driver properties | Exposed IONetworkData buffers and link speed/state/packet-size context, retained as native plist data; no identifiers or driver control calls. |
| Driver discovery | Incremental exposed IOService class/property-name inventory, resumed until iterator exhaustion; property values excluded from discovery. |

| Audit additions | Retained observations |
|---|---|
| Queried volatile VM bytes | Full `TASK_VM_INFO_PURGEABLE`, including volatile pmap/resident/virtual values that ordinary `TASK_VM_INFO` initializes to zero. Owned 256 KiB volatile/release phases validate the additional query. |
| Full task ledger | Bounded OS template names/groups/units and every returned entry: native balance, credit, debit, limit, refill fields; V2 lifetime maximum when supported, V1 fallback otherwise. Compact entries expose balance as credit and zero debit; fields are not universally cumulative. Native refill fields may be placeholders. Owned purgeable phases also capture the full ledger. |
| Freezer flags | Own-process freezable preference and frozen-accounting flag through read-only `memorystatus_control` getters. Preference is not proof of complete freezer eligibility; a frozen accounting flag does not mean the executing collector is suspended. |
| Task policy | Task base priority and nine named suppression-policy words. Private suppression ABI; requested policy rather than measured throttling. `cpu_limit`/`suspend` are zero placeholders in reviewed XNU. |
| Mach references | Bounded per-port-name user references by right and allocated dead-name notification-table slots. Slots are capacity, not active subscriptions; port names may disappear between calls. |
| Child resource use | Full `getrusage(RUSAGE_CHILDREN)` for terminated children waited for; ordinarily zero here. Darwin native peak-RSS unit is bytes. |


| Source | Retained observations |
|---|---|
| Extended thread information/policy | Per-thread name, user/system nanoseconds, native scaled CPU usage, run state, flags, sleep time and current/base/max priority; timeshare flag, precedence importance, realtime period/computation/constraint/preemptibility and affinity tag. Legacy timeshare/RR/FIFO priority, depression and RR quantum fields are also attempted. Each query retains return code and policy-default flag. Realtime times use Mach units; a returned default is not active realtime policy, and an affinity tag is not a CPU mask. Rights are released after a bounded 512-thread/250 ms scan. |
| App-scene displays | Point/pixel dimensions and scale, current/available modes, maximum refresh rate, brightness/software dimming, capture flag and iOS 16+ current/potential EDR headroom/reference-mode status. Main-thread UIKit read; brightness is not measured nits and maximum refresh is not actual frame rate. |
| Additional CPU/storage configuration | Performance-level logical/physical CPU maxima, CPUs sharing L2 and per-level cache sizes where returned. Full statfs geometry/type/subtype/flags, optimal I/O size, and NSURL volume capacity/important/opportunistic allocation estimates, maximum file size and sparse-file/read-only capabilities. These estimates do not reserve space. |
| Host configuration | Full host CPU/type/count/memory information, minimum scheduler timeout/quantum, and kernel task/thread/port/VM object resource-size fields where supported. The legacy 32-bit `memory_size` and `max_mem` remain separate. Host load averages/Mach factors retain `LOAD_SCALE`; all native priority bands are captured. Purgeable FIFO/LIFO/obsolete queues retain object counts and resident-byte totals (system scope). |
| CPU capabilities | Raw `hw.optional.arm.caps` bytes and all 50 named capability bits in the installed public SDK, including floating point/vector, dot-product, BF16/I8MM, atomics, crypto and SME features. Capability is not speed or backend use. |
| Pressure/thermal/power events | Battery level/state and low-power notification receipts; GCD normal/warning/critical memory-pressure bitmask and thermal-state notification receipts, total callbacks and last 64 events. Pressure flags can coalesce. Physical registration succeeded; no pressure event was delivered in the short test. |
| Own resource coalition | Self resource/jetsam coalition IDs; resource-group tasks started/exited, nonempty time, CPU/QoS/performance-class time/instructions/cycles, wakeups, GPU time, disk/logical/external/metadata writes, CPU/ANE/GPU energy and billing, ANE time, footprint/conclave/swap-in fields when the kernel copies them. Complete published 45-word layout attempted; two differently initialized queries expose unwritten older-kernel tails as null and preserve raw bytes. Calls are separate snapshots, not atomic; coalition scope can include other app processes and exited members. Private ABI, native accounting rather than calibrated energy or NPU utilization. |
| Darwin libproc compatibility probe | Self-task virtual/resident bytes, total/live-thread CPU Mach times, native policy/priority, fault/page-in/COW/message/syscall/context-switch counts, total/TH_RUN (running or runnable) threads; workqueue total/running/blocked threads and state flags. Exact 96/16-byte replies required. XNU/libproc ABI is exported but declarations are absent from iPhone SDK headers; symbol/reply access remains explicit, not an iOS SDK portability guarantee. |
| Process state/fileports | Own BSD state/flags/nice/start time and allocated descriptor-table capacity; Mach fileport names/types, separate from integer descriptors. Exact native records and errors; no rights mutation. |
| Kqueue/workloop ABI | Self descriptor type inventory, FD queue pending-event counts/event-record sizes/state and file guard/open/status flags; dynamic workloop event counts, servicer/owner thread IDs, wait/QoS/request/priority/policy fields. No event consumption or descriptor duplication. 512-entry/100 ms bounds per query family; native non-atomic enumeration and errors retained. |
| Default processor-set load | System task/thread counts, scaled scheduler load and Mach factor through `processor_set_statistics`; exact return code and `LOAD_SCALE`. No enumeration of other tasks or access to their memory. |
| Terminated-task / external-modification host accounting | Whole-system CPU/wakeup/GPU/energy/performance-class accounting for terminated tasks through `HOST_EXPIRED_TASK_INFO`; all six `HOST_EXTMOD_INFO64` counters. Native cumulative/opaque accounting, separate from our live process and from calibrated energy. |
| Thread policy additions | Background priority and latency/throughput QoS tiers from their public Mach policy getters, with return codes and default-policy flags. These are policy inputs, not measured latency or throughput. |
| Task policy/context | Category role; base/override latency and throughput QoS tiers with default flags; task flags; affinity-set count/min/max/task count; kernel private/shared allocation/free accounting; six external-modification counters (task-port lookup, external thread creation/state changes, target/caller). These are not ordinary thread-creation totals. Reply versions and native errors retained. |
| `TASK_VM_INFO` | Every named field returned by the installed SDK's struct and kernel reply version. In addition to the interpreted list: device/device peak, purgeable volatile pmap/resident/virtual; network nonvolatile/volatile and their compressed ledgers; graphics/media/neural footprint and no-footprint ledgers, each compressed/uncompressed; neural no-footprint total/peak; limit bytes remaining; ledger swap-ins; page size and virtual-address bounds. Some legacy fields are kernel placeholders; zero alone establishes no functioning signal. |
| `task_purgable_info` | App-owned FIFO/LIFO/obsolete purgeable queue object counts and resident-byte totals, separate from the host queues and task ledger counters. The page probe validates one 16-page object entering FIFO group 7 and disappearing after release. |
| XNU memory-pressure sysctls | Raw available-page count, legacy memory-status level, dispatch pressure flags and sustained-pressure kill count. Kernel-specific read-only probes with explicit errno; XNU computes the legacy level as integer available-pages × 100 / kernel total-pages (with a build-dependent secluded-page adjustment). Keep the raw value; it is neither app allocation headroom nor a promise that this memory is allocatable. Physical iPhone 14 returned level 41, denied available-pages/pressure-flags reads, and lacked the sustained-kill node. |
| `MACH_TASK_BASIC_INFO`, `TASK_THREAD_TIMES_INFO` | Virtual/current/peak resident bytes, task suspend count and default thread policy; terminated-thread and live-thread user/system CPU seconds/microseconds separately. Live-task snapshots are not atomic. |
| `TASK_EVENTS_INFO` | Faults, page-ins, COW faults, messages sent/received, Mach/Unix system calls and context switches. Native integer saturation/wrap behavior must be considered before computing rates. |
| `TASK_ABSOLUTETIME_INFO` | Total user/system time and surviving-thread user/system time in Mach absolute-time units |
| `TASK_POWER_INFO` | Total user/system time, interrupt wakeups, platform-idle wakeups and two timer-wakeup bins |
| `TASK_POWER_INFO_V2` | Above CPU accounting plus GPU utilisation field, task energy (ARM), performance-class time and processor-set switches. **Opaque native accounting**: no percentage, watts or joules conversion asserted. |
| `proc_pid_rusage` v2–v6 | User/system CPU time; package-idle/interrupt wakeups; page-ins; wired/resident/footprint bytes; process start/exit absolute time; explicit child CPU/wakeup/page-in/elapsed counters; disk bytes read/written; CPU time in default/maintenance/background/utility/legacy/user-initiated/user-interactive QoS; billed/serviced system time; logical writes; lifetime/interval peak footprint; instructions/cycles; billed/serviced energy; runnable time; flags; performance-class user/system time/instructions/cycles; energy and performance-class energy (`*_nj`); secure-system/performance-class secure time; current/lifetime/interval neural footprint. Time fields retain Mach units alongside the capture timebase; `*_nj` names designate native nanojoule accounting. Version fallback omits unsupported tail fields. No IPC ratio or calibrated energy claim is made from returned values alone. |
| `HOST_VM_INFO64` | System free/active/inactive/wired/purgeable/speculative pages; zero-fill, reactivation, page-in/out, fault/COW, lookup/hit and purge counts; decompressions/compressions/swap-ins/outs; compressor/throttled/external/internal page counts; total uncompressed pages in compressor; page size |
| Host CPU load | Whole-system and per-logical-CPU user/system/idle/nice ticks; cumulative native counters, not interval utilization |
| `vm_region_recurse_64` | Per-map address/size, protection/max protection, inheritance, object offset/tag, resident/shared-now-private/swapped/dirtied/reusable pages, reference count, shadow depth, external pager, sharing mode, submap flag/depth, behavior, object IDs and wired count. Version checked; at most 4,096 queries with a 250 ms deadline checked between calls. Completion/partial termination is explicit. Mapping aliases must not be summed as unique RAM. |
| `NET_RT_IFLIST2` | Complete `if_msghdr2`/`if_data64` interface statistics: 64-bit packet/error/drop/multicast counters and native byte/baudrate fields; send-queue length/maximum/drop count, watchdog timer, optional receive/transmit timing, routing metric and link geometry. 128 interfaces/1 MiB, version/length checked, addresses omitted. Published XNU applies 1,024-byte alignment **and a uint32 cast** to byte counters for non-platform apps even in this 64-bit layout; do not promise exact bytes or freedom from 32-bit wrap. Timing/queue zeros are not response validation. |
| `getifaddrs(AF_LINK)` | Interface name/flags, MTU, declared baud rate, receive/send bytes and packets, input/output errors, collisions, input drops, multicast counts and unsupported-protocol count. Whole-interface scope; native counters can wrap. No IP/MAC addresses collected. |
| `malloc_zone_statistics(NULL)` | All four native fields: blocks in use, size in use, size allocated and `max_size_in_use` (documented high-water mark of touched memory). The simulator returned `max_size_in_use` below current `size_in_use`; do not interpret it as an app-wide allocation peak. Allocator-specific semantics apply. |
| `statvfs` | Filesystem block/fragment size, total/free/available blocks, total/free/available file nodes, mount flags and maximum filename length |
| `mach_port_names` | Current process port names and native right-type masks; namespace snapshot, plus receive-port queue count/limit, sequence, make-send count, send/send-once rights, request flags, native flags and boost count where readable. Detail queries are bounded to 512 ports/100 ms; names can change between reads. Not a leak verdict. |
| Native descriptor details | Existing handles use independent read-only lookups on both platforms (no duplication or closing app-owned handles): fstat native size (object-dependent units), blocks/geometry/mode/link/device/inode/timestamps, status flags, socket buffer/low-water/type/policy values, unread bytes and TCP connection information on IPv4/IPv6 stream sockets. No SO_ERROR reads or data consumption. 16,384-FD range, 512 observed handles, 100 ms; concurrent descriptor reuse can mix observations. Duplicating/closing handles can release POSIX record locks, and Darwin guards can terminate on duplication. |
| `fcntl(F_GETFD)` | Open descriptors within the scanned range, bound, completion and error; at most 16,384 descriptors or 50 ms. Descriptors above a lowered soft limit and concurrent changes prevent a universal exact-count claim. |
| `/dev/fd`, `getrlimit` | Descriptor count excluding scanner; all nine Darwin resource limits: CPU, file/data/stack/core size, address space/RSS, locked memory, process count and open files with explicit infinity sentinel |
| IOKit registry visibility | Read-only matching for power sources/root power domain, IOAccelerator/IOGPU, IOCPU/AppleARMCPU, block-storage and known ANE interface/load-balancer classes; registry entry IDs and complete returned property dictionaries as lossless binary plist, bounded to 8 services/256 KiB each. Native matching/property errors and filtered/empty replies remain explicit. No user-client connection, entitlement, host access or guessed electrical-unit conversion. Physical iPhone `IOGPU` supplied device/renderer/tiler utilization %, allocated/in-use/driver memory, parameter-buffer allocation/limits, tiled-scene bytes, split-scene/recovery counts and last-recovery time. Whole-driver scope and unknown averaging/caching; registry aliases share entry IDs within a boot, not permanent hardware identifiers. Physical ANE interface returned core count, architecture, version/minor and board/subtype metadata; no NPU activity claim. |
| IOHID thermal/electrical events | Simple/default-client comparison for Apple thermal and power-sensor pages: registry/sender IDs, product, native usage/event type, exact floating value, power type/subtype, event timestamp/options and receipt time. Complete serialized events up to 4 KiB each/64 KiB total; 128 services/64 sensors and 100 ms between-query bound. Physical default client returned 38 numeric events while the simple client returned null events. Some virtual temperatures stayed zero and one haptics event was stale; no calibration, electrical-unit inference or sensor-freshness guarantee. No input-event subscription or sensor writes. Private iOS ABI. |
| KPC performance-counter access | Native available-class mask, PMU version and counter/config-word counts for masks 1/2/4/8; attempts existing collector-thread raw counter slots with exact return sizes/errors. Query selectors do not configure or enable counters. Capability counts are not activity; XNU restricts most sampling queries to tracing-authorized callers. |
| Root IOKit allocation diagnostics | The explicit `IOKitDiagnostics` property only: full returned native driver class-instance/allocation dictionary as bounded binary plist, or absent/filtered error. Whole-driver scope; no unrelated root properties, user-client connection or controls. |
| IOReport catalog | One-time per-process private-ABI channel discovery: group/subgroup/name/unit labels and complete bounded binary plist. This is availability metadata; no subscription or sampled energy/residency claim. |
| UIDevice/ProcessInfo | Battery level/state, low-power mode and thermal state; level −1/state unknown remain unknown |
| `sysctl` | Device model identifier and OS/kernel build strings; memory size, CPU counts, page/cache-line/L1/L2/L3 sizes, CPU/timebase frequency and performance-level CPU counts where available |
| Clocks | Absolute/continuous Mach time and timebase numerator/denominator; eight POSIX clock values/resolutions covering realtime, monotonic/raw/approximate uptime and process/collector-thread CPU time. |

### Explicit native probes

- **Both:** 16-page anonymous mapping observed before access, after reading even pages, writing odd pages and `MADV_DONTNEED` on the first half. Per-page raw `mincore` flags, phase timestamps and process fault counters. Android additionally attempts raw pagemap words; iOS captures page disposition/reference count and native return code. Advice success does not promise eviction. Android emulator pagemap was denied; residency worked on both simulators.
- **Both TCP:** verified 64 KiB transfer over owned loopback sockets; complete returned `TCP_INFO` (Android) or `TCP_CONNECTION_INFO` (iOS) fields before/after, including state/options, RTT/timeouts, congestion/receive windows, packet/byte/retransmission/ordering counters and implementation-specific pacing/delivery/limitation fields. Native units differ; this validates access, not external-network performance.
- **Both frames:** three-second bounded capture. Android retains all public `FrameMetrics` timing fields, first-draw flag, vsync IDs/timestamps and dropped-report counts, plus Choreographer frame timelines/deadlines/expected presentation. iOS retains CADisplayLink timestamp, target timestamp, duration, callback time and preferred rate range. Callback timing is not proof of actual presentation or GPU execution; up to 256 entries per stream.
- **Android perf:** attempts CPU cycles, instructions, cache references/misses, branch misses, task-clock, faults and context switches through `perf_event_open` on a short child workload under the same app identity. Raw count/enabled/running times or native errors/signals. No profiling permissions are relaxed.
- **iOS IPC:** an owned kqueue validates pending events 0 → 1 → 0 using a user event; three empty messages through an owned Mach port, with queue/sequence/right accounting before sends, after sends and after receives; native send/receive results retained.
- **Android Vulkan:** driver/API versions, device type; every core limits, features and sparse-properties field; advertised extensions; queue flags/count, timestamp precision and transfer granularity; memory heap sizes/flags and type flags; per-heap budget/usage estimates when `VK_EXT_memory_budget` is available. If advertised, `VK_KHR_performance_query` counter names/descriptions/units/scope/storage are enumerated per queue (not yet sampled). A verified 1 MiB fill records raw GPU timestamp-query values, availability, valid bits and period. On compute-capable queues, an additional 1 MiB compute buffer verifies 262,144 outputs; when pipeline-statistics queries are supported, the invocation counter is checked separately. Timestamps cover the submitted fill/compute work. Vulkan 1.1/1.2/1.3 aggregate properties and features retain all 186 native fields when the negotiated core version supports them: subgroup, dot-product acceleration, numeric behavior, descriptors, memory/buffer limits and driver identity. Owned compute pipeline executable properties/statistics and valid pipeline/stage creation durations are retained when supported, plus calibrated host/device timestamps and maximum deviation. Compiler statistics are not runtime counters. Explicit driver discovery/work, not continuous GPU utilization.
- **Android OpenGL ES:** separate owned context retains driver/extension strings, timer-query precision, bounded one-pixel-clear elapsed nanoseconds and GPU-disjoint flags. If advertised, AMD performance-monitor groups/counters retain names, types, native ranges and maximum simultaneous counters (enumeration only, bounded to 1,024 counters/250 ms). Qualcomm global-monitoring mode is never enabled. ARM shader-core properties are read when advertised: physical/configured-active count, presence mask, warp capacity and theoretical per-clock pixel/texel/FMA rates. No core controls are changed; configured-active is not busy-core count. No continuous occupancy claim.
- **iOS Metal:** advertised counter sets/names and sampling points; resource limits/context; verified 1 MiB GPU fill with command-buffer GPU/kernel start/end seconds, paired CPU/GPU timestamps, and resolved standard counter-set data when supported. Native 64-bit words and original resolved bytes retained. Additional owned compute verifies 262,144 words and retains pipeline thread width/threadgroup limits/static memory, device GPU families/features, CPU-side compilation timing and compute-boundary counter samples. Compilation timing includes host/driver/cache effects. The simulator supplies no counter sets; physical iPhone blit and compute timestamp counters worked; compute output verification passed. The explicit compute check also runs a bounded 20 s repeated-dispatch phase and 5 s recovery, retaining IOGPU registry and raw HID sensor snapshots with verified output; stops on foreground loss, collector closure or serious thermal state, with a 5 s per-command deadline. This pauses the module’s ordinary sampler; driver percentages are not app attribution.

### iOS delayed MetricKit reports

The subscriber retains complete metric and diagnostic JSON payloads in
`metrickit-*.jsonl`, plus receipt time and delivery state. **Delivery is not yet
validated**; no report during a short session is expected. Reporting intervals
come from the payload and are unrelated to the live sampler. No custom signposts
or SDK instrumentation are added.

- CPU time/instructions; GPU time; logical writes; peak memory and average suspended memory.
- Foreground/background/audio/location runtimes; Wi-Fi/cellular upload/download; cellular-condition histogram; pixel luminance.
- First-draw, optimized-first-draw, resume and extended-launch histograms; hang-time histogram; scrolling hitch ratio.
- Location-accuracy duration categories if reported; no location collection is enabled by this app.
- Foreground/background exit counts: normal, memory limit/pressure, CPU limit, bad access, abnormal, illegal instruction, watchdog, locked-file suspension and background-task timeout where applicable.
- Crash, hang, CPU exception, disk-write exception and launch diagnostics, retaining native JSON and call-stack data when supplied.
- Any supplied signpost or future payload fields are preserved without adding signpost instrumentation.

### Common POSIX source

Existing socket descriptors now also retain **Android `SO_MEMINFO`**: RMEM_ALLOC, RCVBUF, WMEM_ALLOC, SNDBUF, FWD_ALLOC, WMEM_QUEUED, OPTMEM, BACKLOG and DROPS (native 32-bit values; bytes except the drop count). These are overlapping kernel socket allocations/limits, not process RSS or payload size. Linux `SIOCOUTQ` is protocol-specific: TCP includes unacknowledged bytes; Unix sockets can report allocation size. TCP `SIOCOUTQNSD` reports not-yet-sent bytes separately. **iOS `SO_NREAD`/`SO_NWRITE`** retain native receive/send-buffer occupancy; datagram receive semantics differ from streams. Read-only queries preserve native errors and returned lengths.

The existing TCP button additionally runs an owned stream-socket pair: queue 1,024 bytes, capture both endpoints, verify and drain. Android ordinary-app validation showed kernel write memory **0 → 2,304 → 0 bytes**; payload unread bytes were **0 → 1,024 → 0**. No network transmission outside the device.

The native descriptor-detail collector above also runs on Android; Linux additionally
attempts pipe capacity. The TCP button now validates an owned pipe: 1,024 written
bytes are reported unread, then return to zero after verified consumption.


Full `getrusage(RUSAGE_SELF)` retains user/system seconds and microseconds;
`ru_maxrss`, `ru_ixrss`, `ru_idrss`, `ru_isrss`, `ru_minflt`, `ru_majflt`, `ru_nswap`,
`ru_inblock`, `ru_oublock`, `ru_msgsnd`, `ru_msgrcv`, `ru_nsignals`, `ru_nvcsw`,
`ru_nivcsw`. Several historical fields are not maintained by an OS. **Do not treat
all returned fields as working metrics.** `ru_maxrss` is KiB on Linux and bytes on
Darwin; native source contracts, not column-name similarity, determine units.

## Boundaries

Denied sources are supported **probes**, not supported numeric measurements.
No root, private entitlement, hidden-API exemption or device-setting changes are
used by these collectors. Simulator success does not establish device support.
GPU/NPU occupancy, exact CPU/GPU temperatures, calibrated whole-phone power and
fresh rail data remain hardware/access dependent. Host tracing and vendor tools
are separate sources; this inventory does not claim to replace them.

Primary contracts: [Linux procfs](https://www.kernel.org/doc/html/latest/filesystems/proc.html),
[PSI](https://www.kernel.org/doc/html/latest/accounting/psi.html),
[Android Debug](https://developer.android.com/reference/android/os/Debug),
[Android HealthStats](https://developer.android.com/reference/android/os/health/HealthStats),
[Android profiling](https://developer.android.com/reference/android/os/ProfilingManager),
[Mach port enumeration](https://developer.apple.com/documentation/kernel/1578814-mach_port_names),
[BatteryManager](https://developer.android.com/reference/android/os/BatteryManager),
[Apple thread implementation](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/thread.c),
[Apple scheduling policies](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/thread_policy.h),
[Apple task structs](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/task_info.h),
[Apple resource structs](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/resource.h),
[Apple VM statistics](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/vm_statistics.h).

Additional contracts: [page-map flags](https://www.kernel.org/doc/html/latest/admin-guide/mm/pagemap.html), [Bionic allocator](https://android.googlesource.com/platform/bionic/+/main/libc/include/malloc.h), [Metal counters](https://developer.apple.com/documentation/metal/gpu-counters-and-counter-sample-buffers), [Vulkan memory budgets](https://docs.vulkan.org/refpages/latest/refpages/source/VK_EXT_memory_budget.html).

[Android frame timing](https://developer.android.com/reference/android/view/FrameMetrics), [Apple display-link timing](https://developer.apple.com/documentation/quartzcore/cadisplaylink), [Apple CPU capability ABI](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/arm/cpu_capabilities_public.h), [Linux ARM capabilities](https://www.kernel.org/doc/html/latest/arch/arm64/elf_hwcaps.html).

[Linux CPU sysfs ABI](https://github.com/torvalds/linux/blob/master/Documentation/ABI/testing/sysfs-devices-system-cpu), [Linux scheduler attributes](https://man7.org/linux/man-pages/man2/sched_getattr.2.html), [Apple purgeable queue accounting](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/vm/vm_purgeable.c).

[OpenGL ES disjoint timers](https://registry.khronos.org/OpenGL/extensions/EXT/EXT_disjoint_timer_query.txt), [OpenGL performance monitors](https://registry.khronos.org/OpenGL/extensions/AMD/AMD_performance_monitor.txt).

[Apple memory-pressure sysctls](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus_notify.c), [Apple memory-status accounting](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus.c).

[Apple memory-status level calculation](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/vm/vm_pageout.c).

[Linux cgroups](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html), [block statistics](https://www.kernel.org/doc/html/latest/block/stat.html), [Android storage accounting](https://developer.android.com/reference/android/os/storage/StorageManager), [Wi-Fi link readings](https://developer.android.com/reference/android/net/wifi/WifiInfo), [ARM shader-core properties](https://registry.khronos.org/OpenGL/extensions/ARM/ARM_shader_core_properties.txt), [Vulkan executable statistics](https://docs.vulkan.org/refpages/latest/refpages/source/VkPipelineExecutableStatisticKHR.html).

[Qualcomm memory accounting](https://android.googlesource.com/kernel/msm/+/5769cd22da372693769613747186433723a838c3/drivers/gpu/msm/kgsl_sharedmem.c), [THP](https://www.kernel.org/doc/html/latest/admin-guide/mm/transhuge.html), [KSM](https://www.kernel.org/doc/html/latest/admin-guide/mm/ksm.html), [profiling request contract](https://developer.android.com/reference/androidx/core/os/HeapProfileRequestBuilder), [Metal compute pipeline](https://developer.apple.com/documentation/metal/mtlcomputepipelinestate).

[Android display timing](https://developer.android.com/reference/android/view/Display), [Apple display context](https://developer.apple.com/documentation/uikit/uiscreen).

[Darwin process/workqueue structs](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h), [task accounting implementation](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/bsd_kern.c).

[Interface counter semantics](https://www.kernel.org/doc/html/latest/networking/statistics.html), [F2FS accounting ABI](https://github.com/torvalds/linux/blob/master/Documentation/ABI/testing/sysfs-fs-f2fs), [Darwin descriptor guards](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/guarded.h).

[Pixel GPU source](https://android.googlesource.com/kernel/google-modules/gpu/+/refs/heads/android-gs-shusky-6.1-android16/mali_kbase/platform/pixel/pixel_gpu_sysfs.c).

[Android temperature sensors](https://developer.android.com/develop/sensors-and-location/sensors/sensors_environment), [IOKit matching](https://developer.apple.com/documentation/iokit/1514535-ioservicegetmatchingservice).

[Darwin queue semantics](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_event.c), [host accounting](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/host.c).

[Apple HID service discovery](https://github.com/apple-oss-distributions/IOKitUser/blob/main/hidsystem.subproj/IOHIDEventSystemClient.h), [HID sensor reader implementation](https://github.com/freedomtan/sensors/blob/master/sensors/sensors.m), [IOReport collector implementation](https://github.com/vladkens/macmon/blob/main/src_lib/sources.rs), [IOKit property access filtering](https://github.com/apple-oss-distributions/xnu/blob/main/iokit/Kernel/IOUserClient.cpp).

[DMA-BUF statistics](https://www.kernel.org/doc/html/v6.16/driver-api/dma-buf.html).

[Apple KPC access checks and query contracts](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_kpc.c).

[Android exclusive-core and process-start contracts](https://developer.android.com/reference/android/os/Process).

[Apple HID event serialization/getters](https://github.com/apple-oss-distributions/IOHIDFamily/blob/main/HID/HIDEvent.m), [published Apple HID event fields](https://github.com/aosm/IOHIDFamily/blob/master/IOHIDFamily/IOHIDEventTypes.h).

[Android OS startup records](https://developer.android.com/reference/android/app/ApplicationStartInfo).

[Apple coalition layout](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/coalition.h), [coalition query semantics](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/sys_coalition.c), [coalition accounting](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/coalition.c). CPU and ANE time use Mach units; GPU and nonempty time use nanoseconds; energy fields use native nanojoule accounting.

[IOKit allocation diagnostics implementation](https://github.com/apple-oss-distributions/xnu/blob/main/iokit/Kernel/IOKitDebug.cpp), [root power-domain properties](https://github.com/apple-oss-distributions/xnu/blob/main/iokit/Kernel/IOPMrootDomain.cpp).

[MediaTek GED read handlers](https://android.googlesource.com/kernel/mediatek/+/android-mtk-3.18/drivers/misc/mediatek/gpu/ged/src/ged_hal.c), [GED cached counters and parameters](https://android.googlesource.com/kernel/mediatek/+/android-mtk-3.18/drivers/misc/mediatek/gpu/ged/src/ged_dvfs.c). These establish a driver-family lead, not phone permissions.

[POSIX record-lock close semantics](https://man7.org/linux/man-pages/man2/fcntl_locking.2.html). The native `cpp/tests/DescriptorLockTest.cpp` regression verifies that passive descriptor capture preserves locks.

[Samsung KGSL read handlers and aliases](https://android.googlesource.com/kernel/msm/+/f32e95c6374b76de8f94a3839a25a6357ddfa19e/drivers/gpu/msm/kgsl_pwrctrl.c), [Samsung Exynos clock getters](https://github.com/Vaz15k/android_kernel_samsung_a54x/blob/squeak-16/drivers/gpu/arm/exynos/frontend/gpex_clock_sysfs.c), [Exynos utilization getters](https://github.com/Vaz15k/android_kernel_samsung_a54x/blob/squeak-16/drivers/gpu/arm/exynos/frontend/gpex_dvfs_sysfs.c). Reviewed source establishes read semantics, not binary identity or permission on every firmware.

[CPUFreq policy interface and hardware-feedback semantics](https://docs.kernel.org/admin-guide/pm/cpufreq.html).

[Samsung SGPU getters](https://github.com/ExtremeXT/android_kernel_samsung_s5e9925/blob/lineage-23.2/drivers/gpu/drm/samsung/sgpu/sgpu_user_interface.c), [SGPU utilization calculation](https://github.com/ExtremeXT/android_kernel_samsung_s5e9925/blob/lineage-23.2/drivers/gpu/drm/samsung/sgpu/sgpu_governor.c).

[MediaTek Samsung kernel aliases](https://github.com/0x410c/android_kernel_samsung_a34x/blob/sep-15/stock/drivers/gpu/mediatek/ged/src/ged_ski.c), [GED cached utilization getter](https://github.com/0x410c/android_kernel_samsung_a34x/blob/sep-15/stock/drivers/gpu/mediatek/ged/src/ged_dvfs.c).

[Linux socket-memory getter](https://github.com/torvalds/linux/blob/master/net/core/sock.c), [TCP queue ioctl semantics](https://github.com/torvalds/linux/blob/master/net/ipv4/tcp.c), [Apple interface query and rounding](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/net/rtsock.c), [Apple socket queue getters](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_socket.c).

### Additional native source coverage

| Source | Retained observations |
|---|---|
| Android Qualcomm bus DCVS | DDR/DDRQOS/L3/LLCC current votes, available/min/max/boost frequencies; memlat adaptive/sampling/monitor votes, CPU-to-bus maps and policy thresholds; bwmon votes, windows and policy; CPUCP sampling and clock offset. Votes are not measured memory bandwidth. |
| Android Qualcomm/Samsung GPU and CPU | Own/global KGSL mapping entries/current/peak mapped bytes (not resident bytes), GPU idle-collapse count and power-policy flags; hardware-reported CPU thermal frequency limit; Samsung real/virtual CPU limits and request context. Raw hex, sentinel and native frequency scales retained. |
| Android rtnetlink | Separate link and statistics requests. Full native interface RX/TX packets, bytes, errors/drops; multicast/collisions; RX length/overrun/CRC/frame/FIFO/missed errors; TX aborted/carrier/FIFO/heartbeat/window errors; compressed packets, no-handler and other-host drops. Extended link/slave/offload/protocol statistics retained as native attributes. Not app-only traffic. |
| iOS native sysctls | Reviewed numeric kernel resource and policy records, including timer queues/scans/latencies, lock contention/event handoffs, memory-pressure thresholds and compressor fragmentation. Whole turnstile, mbuf-tag, kernel-object, stackshot and interface statistics; boot/sleep/wake/bridge-clock records. Candidate inventory preserves unavailable nodes and exact native words, not a claim that every queried name returned a metric. |

The two XNU memorystatus `*_idle_delay_time_ns` handlers return **whole seconds** in the reviewed source despite their names. `net.link.generic.system.ifcount` returns the native interface-index bound. These semantic notes also travel with captured records.

Passive collection excludes Samsung `limit_stat` (reads rebase rounded time accounting) and `vtable` (logging and reference-leak paths), and Qualcomm `gpubusy` (can reset cached values). See the vendor source references above for these getter semantics.

| Additional source | Native values retained |
| --- | --- |
| Android complete memory records | Full version-tagged Parcels from `Debug.MemoryInfo`, `ActivityManager.MemoryInfo`, and `getMyMemoryState`, alongside named readings. Includes OS category arrays and memory thresholds absent from public getters. Decode against the matching Android layout. |
| Android explicit network driver probe | `ethtool` driver/firmware, link/ring/channel/coalescing/pause/timestamp/EEE/FEC configuration and named 64-bit driver counters where permitted. Explicit because queries may wake hardware; access failures remain null, not zero. |
| Vulkan performance queries | Every advertised counter in graphics/compute queue families: native unit, scope, storage, UUID, description/flags, required passes and exact results. Explicit owned fill/compute experiment; no partial-pass estimate. Unsupported extension and bounded completion are explicit. |
| Qualcomm existing hardware counters | Explicit KGSL group/register count and configured countable IDs; native 64-bit readings before/after GPU probe where allowed. No counter allocation, selection or global configuration changes; native IDs require matching GPU semantics. |
| iOS complete kernel records | Clock-rate/load-average structs, zone-map size/capacity, own coalition page counts and allocator ranges; Skywalk interface/flowswitch/queue counters and tuple-scoped owned TCP flow records; existing-enabled IP timing/histograms and scheduler accounting. Full native bytes and errors retained. |
| iOS resource configuration and counter health | CPU capability/cache topology, logging queue/drop counts, I/O throttle policy, compressor/wiring/reclaim policy, memory-reporting flags and monotonic counter support/PMI/retrograde-update counts. Native kernel context; no policy changes or tracing enablement. |

| Additional native source | Retained observations |
|---|---|
| Android GLES performance monitor | Every enumerated eligible counter sampled separately around 64 owned one-pixel draws; exact native integer/float types, raw result bytes, availability and errors. Ten-second between-call budget, 250 ms result wait per counter. Counter observations are not simultaneous; QCOM global mode stays disabled. |
| Android KGSL device properties | On-chip GMEM capacity, chip/MMU context, address bitness, memory-access/UBWC policy, speed bin, LPAC flag and PFP/PM4 firmware versions. Capacity is not current allocation; existing configured counter reads remain a separate operation. |
| iOS resource limits and tracing context | System V semaphore/shared-memory limits, AIO request/worker limits, socket/network queue and tunnel ring limits, fragment/retransmit/ECN policy, DTrace capacity, ktrace state/mask and kperf minimum sampling periods; no tracing enablement or policy changes. Native getter quirks are annotated in records. |

| Final resource-source additions | Retained observations |
|---|---|
| Both platforms: full TCP records | Complete returned `TCP_INFO` / `TCP_CONNECTION_INFO` bytes, including fields beyond SDK headers; iOS additionally reads the richer native TCP_INFO record. Owned descriptors and verified loopback transfer only; no global socket addresses. |
| Both platforms: POSIX limits | Native system/process limits for threads, queues, timers, asynchronous I/O and memory pages; filesystem allocation/transfer alignment, size and object-name limits. Indeterminate/unsupported returns stay distinct from zero. |
| iOS power-state history | Complete AOT sleep/wake accounting, native wake reasons and transition timestamps; boot/shutdown/wake reason text and Skywalk capability bits. OS reset boundaries and native time formats retained. |
| iOS IPC configuration | Complete read-only semaphore and message-queue configuration records; limits are not active-object counts. No shared-memory initialization or global object enumeration. |
| iOS volume resources | Eighteen native volume attributes: total/free/available/used/quota/reserved bytes, minimum allocation/clump/I/O block sizes, object/file/directory/maximum counts, mount/type context, capability and supported-attribute validity masks. |
| Mounted-filesystem resources | Android captures native `statfs` counters for every visible mount with bounded child execution and timeout continuation; iOS captures all cached `getfsstat(MNT_NOWAIT)` records. Blocks/free/available, inodes/free, allocation/I/O sizes, type and flags remain per mount; shared/bind/snapshot capacities must not be summed. |

## Extended resource pass

| Platform / source | Additional native observations |
|---|---|
| Android `statx` | Full 256-byte records for existing regular files; mount identity, direct-I/O memory/offset/read alignment, subvolume identity and atomic-write geometry when returned masks mark them valid. `AT_STATX_DONT_SYNC`; no file-data reads. |
| Android `cachestat` | Whole-file cached, dirty, writeback, evicted-shadow and recently evicted-shadow pages. Eviction fields describe retained cache state, not lifetime event counts. Kernel support, file permissions and app seccomp apply independently; isolated failures are retained. |
| Both socket policies | Receive/send timeouts, linger, reuse-port and OS-specific traffic class/service, pacing, priority, CPU/NAPI, busy-poll and buffer policies; complete returned bytes and errors. Policy is not measured traffic performance. |
| Both TCP policies | Congestion algorithm and supported keepalive, timeout, segment/window, cork/NODELAY/QUICKACK and not-sent controls; Linux congestion-control-specific `TCP_CC_INFO` where supplied. Read-only getters, no socket reconfiguration. |
| iOS allocator zones | Registered zone count/version/type; per-zone blocks, used/reserved/touched accounting through reviewed XZONE/PGM introspection. Legacy/custom/unsupported callbacks remain unavailable; copied Mach reads are bounded and transiently consume memory; copy-limit failures retain their original attempt and are cached until process restart. |
| iOS thermal notifications | Native pressure/status, torch/backlight/termination/restart mitigation thresholds, table readiness and current-level getter. Preserve raw notification states: registration/read success alone does not prove a publisher or freshness. iPhone enum differs from macOS. |
| iOS power management | Native CPU power-limit dictionary, thermal/performance warning records and detailed system-load advisory through IOPM getters, with symbol availability and return codes. No Celsius, utilization or battery-percentage interpretation. |

Contracts: [Linux statx](https://man7.org/linux/man-pages/man2/statx.2.html),
[Linux cachestat](https://man7.org/linux/man-pages/man2/cachestat.2.html),
[Apple allocator implementations](https://github.com/apple-oss-distributions/libmalloc),
[Apple native thermal states](https://github.com/apple-oss-distributions/Libc/blob/main/sys/OSThermalNotification.c),
[Apple power getters](https://github.com/apple-oss-distributions/IOKitUser/blob/main/pwr_mgt.subproj/IOPMPowerNotifications.c).

### Presentation and clock-source review

| Platform/source | Retained observations |
|---|---|
| Android native EGL fence (explicit GPU probe) | Owned fence status, component/timeline/driver names, exact kernel signaling timestamps and native records before/after a bounded wait. Richer completion evidence, not a new GPU-duration metric; status queries may recognize completion. |
| Android compositor (explicit frame probe, API35+) | Owned 2×2 buffer render/acquire fence, transaction latch time, present-fence raw times/sentinels and bounded wait result. Actual OS presentation observations, distinct from Choreographer expected timing. |
| iOS Metal drawable (explicit frame probe) | Owned Metal-backed view: drawable ID, OS presented host time at callback and afterward, submission and command completion/error context, view attachment and dimensions. Zero presented time means unpresented or dropped; not panel-photon timing. Tested farm iPhones on iOS18.6.2/26.5 returned zero, so numeric presentation timing remains unvalidated there. |
| Android/iOS kernel clock discipline | Complete read-only timex fields/native bytes, state and errno. Android ordinary-app seccomp denies adjtimex; alternate clock_adjtime is also explicitly blocked. iOS ntp_adjtime modes=0 and ntp_gettime retain native error/TAI context and the latter's post-call buffer even on failure. Kernel estimates/unsynchronized flags do not establish actual clock accuracy. |

These add raw capture observations, without new dashboard cards or SDK instrumentation.
Android callback/latch timing uses the monotonic domain (`System.nanoTime`); the
capture envelope uses elapsed realtime, which includes suspend. Kernel fence times
remain native driver/kernel signaling timestamps. iOS presentation uses native host
seconds. Do not subtract different domains without establishing their relationship.
Sources: [Android transaction statistics](https://developer.android.com/reference/android/view/SurfaceControl.TransactionStats),
[Apple drawable presentation](https://developer.apple.com/documentation/metal/mtldrawable/presentedtime),
[Linux sync-file implementation](https://github.com/torvalds/linux/blob/master/drivers/dma-buf/sync_file.c),
[XNU clock queries](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_ntptime.c),
[AOSP app syscall blocklist](https://android.googlesource.com/platform/bionic/+/main/libc/SECCOMP_BLOCKLIST_APP.TXT).
