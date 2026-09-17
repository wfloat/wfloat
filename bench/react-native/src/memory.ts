export type ArtFreedBytesCounter = {
  bytes: number | null;
  rawBytes: string | null;
  error: string | null;
  source: 'Debug.getRuntimeStat("art.gc.bytes-freed")';
  statistic: "art.gc.bytes-freed";
  accounting: "art_managed_bytes_freed_net";
  runtime: "ART";
  unit: "bytes";
  signed: true;
  monotonic: false;
  scope: "process_lifetime";
  approximate: true;
};
export type ArtAllocatedBytesCounter = {
  bytes: number | null;
  rawBytes: string | null;
  error: string | null;
  source: 'Debug.getRuntimeStat("art.gc.bytes-allocated")';
  statistic: "art.gc.bytes-allocated";
  accounting: "art_managed_bytes_allocated_ever";
  runtime: "ART";
  unit: "bytes";
  scope: "process_lifetime";
  approximate: true;
};
export type ArtBlockingGcTimeCounter = {
  milliseconds: number | null;
  rawMilliseconds: string | null;
  error: string | null;
  source: 'Debug.getRuntimeStat("art.gc.blocking-gc-time")';
  statistic: "art.gc.blocking-gc-time";
  classification: "art_blocking_collection";
  accounting: "art_blocking_gc_run_duration";
  runtime: "ART";
  unit: "milliseconds";
  scope: "process_lifetime";
  approximate: true;
};
export type ArtBlockingGcCountCounter = {
  count: number | null;
  rawCount: string | null;
  error: string | null;
  source: 'Debug.getRuntimeStat("art.gc.blocking-gc-count")';
  statistic: "art.gc.blocking-gc-count";
  classification: "art_blocking_collection";
  runtime: "ART";
  unit: "collections";
  scope: "process_lifetime";
  approximate: true;
};
export type ArtGcTimeCounter = {
  milliseconds: number | null;
  rawMilliseconds: string | null;
  error: string | null;
  source: 'Debug.getRuntimeStat("art.gc.gc-time")';
  statistic: "art.gc.gc-time";
  accounting: "art_gc_run_duration";
  runtime: "ART";
  unit: "milliseconds";
  scope: "process_lifetime";
  approximate: true;
};
export type ArtGcCountCounter = {
  count: number | null;
  rawCount: string | null;
  error: string | null;
  source: 'Debug.getRuntimeStat("art.gc.gc-count")';
  statistic: "art.gc.gc-count";
  runtime: "ART";
  unit: "collections";
  scope: "process_lifetime";
  approximate: true;
};
export type MemoryCounter = {
  bytes: number | null;
  source: string;
  error: string | null;
};
export type MemoryHeadroom = MemoryCounter & {
  rawBytes: string;
  scope: "current_app_limit";
  environment: "simulator" | "device";
};
export type PeakRssCounter = MemoryCounter & { scope: "process_lifetime" };
export type ProcessMemoryGauge = MemoryCounter & {
  rawBytes: string | null;
  scope: "calling_process";
  unit: "bytes";
};

export type NativeHeapSizeCounter = ProcessMemoryGauge & { accounting: "native_allocator_size_bytes" };
export type NativeHeapFreeCounter = ProcessMemoryGauge & { accounting: "native_allocator_free_bytes" };
export type NativeHeapAllocatedCounter = ProcessMemoryGauge & { accounting: "native_allocator_bytes" };
export type IosNativeHeapAllocatedCounter = ProcessMemoryGauge & {
  accounting: "malloc_zone_size_in_use_bytes";
  zones: "registered_malloc_zones";
  environment: "simulator" | "device";
};
export type IosNativeHeapReservedCounter = Omit<IosNativeHeapAllocatedCounter, "accounting"> & {
  accounting: "malloc_zone_reserved_bytes";
};
export type JavaHeapUsedCounter = ProcessMemoryGauge & {
  accounting: "managed_heap_used_bytes";
  consistency: "total_before_equals_total_after";
  rawTotalBeforeBytes: string | null;
  rawFreeBytes: string | null;
  rawTotalAfterBytes: string | null;
};
export type JavaHeapFreeCounter = ProcessMemoryGauge & {
  accounting: "managed_heap_free_bytes";
  input: "javaHeapUsed.rawFreeBytes";
};
export type JavaHeapCapacityCounter = ProcessMemoryGauge & {
  accounting: "managed_heap_current_capacity_bytes";
  input: "javaHeapUsed.rawTotalAfterBytes";
};
export type JavaHeapLimitCounter = ProcessMemoryGauge & {
  accounting: "managed_heap_limit_bytes";
  limitKind: "finite" | "no_inherent_limit" | "unavailable";
};
export type AndroidMemoryCounter = ProcessMemoryGauge;
export type VirtualMemoryCounter = ProcessMemoryGauge;
export type PeakVirtualMemoryCounter = Omit<ProcessMemoryGauge, "scope"> & { scope: "process_lifetime" };
export type PeakPhysicalFootprintCounter = PeakVirtualMemoryCounter & { environment: "simulator" | "device" };
export type SmapsMemoryCounter = AndroidMemoryCounter;
export type LockedMemoryCounter = AndroidMemoryCounter;
export type PageTableMemoryCounter = AndroidMemoryCounter;
export type SmapsResidentCounter = SmapsMemoryCounter;
export type AnonymousMemoryCounter = SmapsMemoryCounter;
export type AnonymousPssCounter = AndroidMemoryCounter;
export type FilePssCounter = AndroidMemoryCounter;
export type ShmemPssCounter = AndroidMemoryCounter;
export type DirtyPssCounter = AndroidMemoryCounter;
export type AnonHugePagesCounter = AndroidMemoryCounter;
export type FilePmdMappedCounter = AndroidMemoryCounter;
export type ShmemPmdMappedCounter = AndroidMemoryCounter;
export type PrivateHugetlbCounter = AndroidMemoryCounter;
export type SharedHugetlbCounter = AndroidMemoryCounter;
export type LockedResidentCounter = AndroidMemoryCounter;
export type KsmCounter = AndroidMemoryCounter;
export type LazyFreeMemoryCounter = AndroidMemoryCounter;
export type SwappedMemoryCounter = AndroidMemoryCounter;
export type ReferencedMemoryCounter = AndroidMemoryCounter;
export type CleanPssCounter = MemoryCounter & {
  scope: "calling_process";
  unit: "bytes";
  derivation: "total_pss_minus_dirty_pss";
};
export type SwapPssCounter = SmapsMemoryCounter;
export type PrivateResidentCounter = SmapsResidentCounter;
export type SharedCleanCounter = SmapsResidentCounter;
export type SharedDirtyCounter = SmapsResidentCounter;
export type CompressedMemoryCounter = MemoryCounter & {
  rawBytes: string | null;
  scope: "calling_process";
  unit: "bytes";
  accounting: "original_page_bytes";
  environment: "simulator" | "device";
};
export type PeakCompressedMemoryCounter = Omit<CompressedMemoryCounter, "scope"> & { scope: "process_lifetime" };
export type CumulativeCompressedMemoryCounter = Omit<CompressedMemoryCounter, "scope" | "accounting"> & {
  scope: "process_lifetime";
  accounting: "internal_compressed_ledger_credit_bytes";
};
export type ReusableMemoryCounter = MemoryCounter & {
  rawBytes: string | null;
  scope: "calling_process";
  unit: "bytes";
  accounting: "reusable_page_bytes";
  environment: "simulator" | "device";
};
export type PeakReusableMemoryCounter = Omit<ReusableMemoryCounter, "scope"> & { scope: "process_lifetime" };
export type PeakInternalMemoryCounter = Omit<InternalMemoryCounter, "scope"> & { scope: "process_lifetime" };
export type PeakExternalMemoryCounter = Omit<ExternalMemoryCounter, "scope"> & { scope: "process_lifetime" };
export type MetalAllocationCounter = MemoryCounter & {
  rawBytes: string | null;
  scope: "calling_process_default_mtl_device";
  unit: "bytes";
  accounting: "metal_resource_allocation_bytes";
  environment: "simulator" | "device";
  deviceName: string | null;
  queryStartedUptimeMs: number;
  queryFinishedUptimeMs: number;
  initializationAttemptedThisSample: boolean;
  initializationDurationMs: number;
};
export type MetalWorkingSetCounter = Omit<MetalAllocationCounter, "accounting" | "initializationAttemptedThisSample" | "initializationDurationMs"> & {
  accounting: "metal_recommended_working_set_bytes";
};
export type GraphicsFootprintCounter = Omit<ReusableMemoryCounter, "accounting"> & {
  accounting: "graphics_footprint_uncompressed_ledger_bytes";
};
export type PurgeableNonvolatileCounter = Omit<ReusableMemoryCounter, "accounting"> & {
  accounting: "purgeable_nonvolatile_resident_ledger_bytes";
};
export type PurgeableNonvolatileCompressedCounter = Omit<ReusableMemoryCounter, "accounting"> & {
  accounting: "purgeable_nonvolatile_compressed_original_page_bytes";
};
export type PurgeableVolatileCompressedCounter = Omit<ReusableMemoryCounter, "accounting"> & {
  accounting: "purgeable_volatile_compressed_original_page_bytes";
};
export type PurgeableVolatileCounter = Omit<ReusableMemoryCounter, "accounting"> & {
  accounting: "purgeable_volatile_resident_ledger_bytes";
};
export type InternalMemoryCounter = MemoryCounter & {
  rawBytes: string | null;
  scope: "calling_process";
  unit: "bytes";
  accounting: "internal_ledger_bytes";
  environment: "simulator" | "device";
};
export type ExternalMemoryCounter = MemoryCounter & {
  rawBytes: string | null;
  scope: "calling_process";
  unit: "bytes";
  accounting: "external_ledger_bytes";
  environment: "simulator" | "device";
};
export type MemoryRegionCounter = {
  count: number | null;
  rawCount: string | null;
  source: string;
  error: string | null;
  scope: "calling_process";
  unit: "regions";
  aggregation: "gauge";
  environment: "simulator" | "device";
};
export type IosNativeHeapBlocksCounter = Omit<MemoryRegionCounter, "unit"> & {
  unit: "blocks";
  accounting: "malloc_zone_blocks_in_use";
  zones: "registered_malloc_zones";
  nativeWidthBits: 32;
};
export type AndroidVmaCounter = Omit<MemoryRegionCounter, "environment">;
export type DecompressionCounter = {
  count: number | null;
  rawCount: string | null;
  source: string;
  error: string | null;
  scope: "calling_process";
  unit: "events";
  aggregation: "cumulative";
  saturated: boolean;
  environment: "simulator" | "device";
};
export type PrivateDirtyCounter = SmapsResidentCounter;
export type PrivateCleanCounter = PrivateResidentCounter;

export type MemorySample = {
  rssBytes: number;
  heldBytes: number;
  heldKind?: "none" | "anonymous_dirty" | "file_clean" | "file_clean_twice" | "shared_dirty_twice" | "shared_dirty_once";
  heldFileBytes?: number;
  heldSharedRegionBytes?: number;
  source: string;
  processId: number;
  sampledAtMs: number;
  monotonicMs: number;
  readDurationMs: number;
  javaHeapLimit?: JavaHeapLimitCounter;
  javaHeapUsed?: JavaHeapUsedCounter;
  nativeMallocCheck?: NativeMallocCheck;
  mallocCheck?: { run: number; stage: string; phases: unknown[]; error: string | null };
  nativeHeapBlocks?: IosNativeHeapBlocksCounter;
  nativeHeapReserved?: IosNativeHeapReservedCounter;
  artGcTime?: ArtGcTimeCounter;
  artAllocatedBytes?: ArtAllocatedBytesCounter;
  artFreedBytes?: ArtFreedBytesCounter;
  artBlockingGcTime?: ArtBlockingGcTimeCounter;
  artGcCount?: ArtGcCountCounter;
  artBlockingGcCount?: ArtBlockingGcCountCounter;
  nativeHeapSize?: NativeHeapSizeCounter;
  nativeHeapFree?: NativeHeapFreeCounter;
  nativeHeapAllocated?: NativeHeapAllocatedCounter | IosNativeHeapAllocatedCounter;
  pss?: MemoryCounter;
  privateDirty?: PrivateDirtyCounter;
  privateClean?: PrivateCleanCounter;
  sharedClean?: SharedCleanCounter;
  sharedDirty?: SharedDirtyCounter;
  swapPss?: SwapPssCounter;
  anonymous?: AnonymousMemoryCounter;
  anonymousPss?: AnonymousPssCounter;
  filePss?: FilePssCounter;
  shmemPss?: ShmemPssCounter;
  dirtyPss?: DirtyPssCounter;
  referenced?: ReferencedMemoryCounter;
  swap?: SwappedMemoryCounter;
  lazyFree?: LazyFreeMemoryCounter;
  anonHugePages?: AnonHugePagesCounter;
  filePmdMapped?: FilePmdMappedCounter;
  shmemPmdMapped?: ShmemPmdMappedCounter;
  privateHugetlb?: PrivateHugetlbCounter;
  sharedHugetlb?: SharedHugetlbCounter;
  lockedResident?: LockedResidentCounter;
  ksm?: KsmCounter;
  pageTables?: PageTableMemoryCounter;
  virtualSize?: VirtualMemoryCounter;
  locked?: LockedMemoryCounter;
  peakVirtual?: PeakVirtualMemoryCounter;
  compressed?: CompressedMemoryCounter;
  peakCompressed?: PeakCompressedMemoryCounter;
  cumulativeCompressed?: CumulativeCompressedMemoryCounter;
  peakReusable?: PeakReusableMemoryCounter;
  peakInternal?: PeakInternalMemoryCounter;
  peakExternal?: PeakExternalMemoryCounter;
  graphicsFootprint?: GraphicsFootprintCounter;
  metalAllocation?: MetalAllocationCounter;
  metalWorkingSet?: MetalWorkingSetCounter;
  purgeableNonvolatile?: PurgeableNonvolatileCounter;
  purgeableNonvolatileCompressed?: PurgeableNonvolatileCompressedCounter;
  purgeableVolatileCompressed?: PurgeableVolatileCompressedCounter;
  graphicsCheck?: { allocationKind?: "iosurface" | "metal_shared_buffer"; run: number; running: boolean; stage: string; heldBytes: number; error: string | null };
  purgeableCheck?: { run: number; running: boolean; stage: string; heldBytes: number; error: string | null };
  purgeableVolatile?: PurgeableVolatileCounter;
  reusable?: ReusableMemoryCounter;
  internal?: InternalMemoryCounter;
  external?: ExternalMemoryCounter;
  decompressions?: DecompressionCounter;
  regions?: MemoryRegionCounter;
  vmas?: AndroidVmaCounter;
  physicalFootprint?: MemoryCounter;
  peakPhysicalFootprint?: PeakPhysicalFootprintCounter;
  peakRss?: PeakRssCounter;
  headroom?: MemoryHeadroom;
  platform?: string;
  osVersion?: string;
  apiLevel?: number;
  clockSource?: string;
  sequence?: number;
  queryStartedUptimeMs?: number;
  queryFinishedUptimeMs?: number;
};

// Validate the additional counter separately so RSS survives its failure.
export function validateMemoryCounter(counter: MemoryCounter | undefined, name: string): MemoryCounter {
  if (!counter || typeof counter.source !== "string" || !counter.source.trim() ||
      (counter.bytes === null
        ? typeof counter.error !== "string" || !counter.error.trim()
        : !Number.isSafeInteger(counter.bytes) || counter.bytes < 0 || counter.error !== null))
    throw new Error(`Invalid native ${name} reading. Rebuild the app if its native collector is missing.`);
  return counter;
}

export function validateMemorySample(sample: MemorySample): MemorySample {
  if (!sample || ![sample.rssBytes, sample.heldBytes].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      ![sample.sampledAtMs, sample.monotonicMs, sample.readDurationMs].every((n) => Number.isFinite(n) && n >= 0) ||
      !Number.isInteger(sample.processId) || sample.processId <= 0 ||
      typeof sample.source !== "string" || !sample.source.trim())
    throw new Error("Invalid native RSS reading");
  return sample;
}

export const mebibytes = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

// An independent gauge, not an amount to add to RSS/PSS or a lifetime total.
function validateAndroidMemoryGauge(sample: MemorySample, key: "privateClean" | "privateDirty" | "sharedClean" | "sharedDirty" | "swapPss" | "anonymous" | "pageTables" | "locked" | "anonymousPss" | "filePss" | "shmemPss" | "dirtyPss" | "referenced" | "swap" | "lazyFree" | "anonHugePages" | "filePmdMapped" | "shmemPmdMapped" | "privateHugetlb" | "ksm" | "lockedResident" | "sharedHugetlb"): AndroidMemoryCounter {
  const definitions = {
    privateClean: { field: "Private_Clean", label: "private clean" },
    privateDirty: { field: "Private_Dirty", label: "private dirty" },
    sharedClean: { field: "Shared_Clean", label: "shared clean" },
    sharedDirty: { field: "Shared_Dirty", label: "shared dirty" },
    swapPss: { field: "SwapPss", label: "proportional swap" },
    anonymous: { field: "Anonymous", label: "anonymous resident" },
    anonymousPss: { field: "Pss_Anon", label: "anonymous PSS" },
    filePss: { field: "Pss_File", label: "file-backed PSS" },
    shmemPss: { field: "Pss_Shmem", label: "shared-memory PSS" },
    dirtyPss: { field: "Pss_Dirty", label: "dirty-page PSS" },
    ksm: { field: "KSM", label: "KSM" },
    lockedResident: { field: "Locked", label: "locked resident" },
    sharedHugetlb: { field: "Shared_Hugetlb", label: "shared HugeTLB" },
    privateHugetlb: { field: "Private_Hugetlb", label: "private HugeTLB" },
    shmemPmdMapped: { field: "ShmemPmdMapped", label: "shared-memory huge-page" },
    filePmdMapped: { field: "FilePmdMapped", label: "file huge-page" },
    anonHugePages: { field: "AnonHugePages", label: "anonymous huge-page" },
    lazyFree: { field: "LazyFree", label: "lazy-free" },
    swap: { field: "Swap", label: "swapped" },
    referenced: { field: "Referenced", label: "referenced resident" },
    pageTables: { field: "VmPTE", label: "page-table" },
    locked: { field: "VmLck", label: "locked" },
  };
  const { field, label } = definitions[key];
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample[key], `${label} memory`) as AndroidMemoryCounter;
  const sources: Record<string, string> = {
    "/proc/self/smaps_rollup:Rss": `/proc/self/smaps_rollup:${field}`,
    "/proc/self/smaps:sum(Rss)": `/proc/self/smaps:sum(${field})`,
  };
  if (sample.platform !== "android" || !Object.prototype.hasOwnProperty.call(sources, sample.source) || counter.source !== ((key === "anonymousPss" || key === "filePss" || key === "shmemPss") ? `/proc/self/smaps_rollup:${field}` : key === "pageTables" || key === "locked" ? `/proc/self/status:${field}` : sources[sample.source]) ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" ||
      sample.clockSource !== "SystemClock.elapsedRealtimeNanos" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.apiLevel) || sample.apiLevel! < 24 ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error(`Invalid ${label} memory source, scope or sample identity`);
  if ((key === "anonymousPss" || key === "filePss" || key === "shmemPss") && sample.source !== "/proc/self/smaps_rollup:Rss" &&
      (counter.bytes !== null || counter.rawBytes !== null))
    throw new Error(`${label} requires a rollup reading`);
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error(`Missing raw ${label} memory counter`);
  } else {
    if (typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
        BigInt(counter.rawBytes) > 18446744073709551615n ||
        (counter.bytes !== null ? BigInt(counter.rawBytes) !== BigInt(counter.bytes)
          : BigInt(counter.rawBytes) <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error(`Invalid raw ${label} memory counter`);
  }
  return counter;
}

export const validatePrivateDirty = (sample: MemorySample): PrivateDirtyCounter => validateAndroidMemoryGauge(sample, "privateDirty");
export const validatePrivateClean = (sample: MemorySample): PrivateCleanCounter => validateAndroidMemoryGauge(sample, "privateClean");

export const validateSharedClean = (sample: MemorySample): SharedCleanCounter => validateAndroidMemoryGauge(sample, "sharedClean");
export const validateLockedMemory = (sample: MemorySample): LockedMemoryCounter => validateAndroidMemoryGauge(sample, "locked");
export const validatePageTableMemory = (sample: MemorySample): PageTableMemoryCounter => validateAndroidMemoryGauge(sample, "pageTables");
// Both inputs come from this one native sample. Never mix polls or substitute
// RSS-based clean counters for the proportional calculation.
export function deriveCleanPss(sample: MemorySample): CleanPssCounter {
  const dirty = validateDirtyPss(sample);
  const total = validateMemoryCounter(sample.pss, "PSS");
  const expected = sample.source === "/proc/self/smaps_rollup:Rss"
    ? "/proc/self/smaps_rollup:Pss" : "/proc/self/smaps:sum(Pss)";
  if (total.source !== expected) throw new Error("Clean PSS requires matching total and dirty PSS sources");
  const metadata = {
    source: `derived(${total.source} - ${dirty.source})`,
    scope: "calling_process" as const,
    unit: "bytes" as const,
    derivation: "total_pss_minus_dirty_pss" as const,
  };
  if (total.bytes === null || dirty.bytes === null) {
    const reasons = [total.bytes === null ? `Total PSS: ${total.error}` : null,
      dirty.bytes === null ? `Dirty PSS: ${dirty.error}` : null].filter(Boolean);
    return { ...metadata, bytes: null, error: `Clean PSS unavailable. ${reasons.join("; ")}` };
  }
  if (dirty.bytes > total.bytes)
    return { ...metadata, bytes: null, error: "Clean PSS unavailable: dirty PSS exceeds total PSS" };
  return { ...metadata, bytes: total.bytes - dirty.bytes, error: null };
}

export const validatePrivateHugetlb = (sample: MemorySample): PrivateHugetlbCounter => validateAndroidMemoryGauge(sample, "privateHugetlb");
export const validateSharedHugetlb = (sample: MemorySample): SharedHugetlbCounter => validateAndroidMemoryGauge(sample, "sharedHugetlb");
export const validateLockedResident = (sample: MemorySample): LockedResidentCounter => validateAndroidMemoryGauge(sample, "lockedResident");
export const validateKsm = (sample: MemorySample): KsmCounter => validateAndroidMemoryGauge(sample, "ksm");
export const validateShmemPmdMapped = (sample: MemorySample): ShmemPmdMappedCounter => validateAndroidMemoryGauge(sample, "shmemPmdMapped");
export const validateFilePmdMapped = (sample: MemorySample): FilePmdMappedCounter => validateAndroidMemoryGauge(sample, "filePmdMapped");
export const validateAnonHugePages = (sample: MemorySample): AnonHugePagesCounter => validateAndroidMemoryGauge(sample, "anonHugePages");
export const validateLazyFreeMemory = (sample: MemorySample): LazyFreeMemoryCounter => validateAndroidMemoryGauge(sample, "lazyFree");
export const validateSwappedMemory = (sample: MemorySample): SwappedMemoryCounter => validateAndroidMemoryGauge(sample, "swap");
export const validateReferencedMemory = (sample: MemorySample): ReferencedMemoryCounter => validateAndroidMemoryGauge(sample, "referenced");
export const validateDirtyPss = (sample: MemorySample): DirtyPssCounter => validateAndroidMemoryGauge(sample, "dirtyPss");
export const validateShmemPss = (sample: MemorySample): ShmemPssCounter => validateAndroidMemoryGauge(sample, "shmemPss");
export const validateFilePss = (sample: MemorySample): FilePssCounter => validateAndroidMemoryGauge(sample, "filePss");
export const validateAnonymousPss = (sample: MemorySample): AnonymousPssCounter => validateAndroidMemoryGauge(sample, "anonymousPss");
export const validateAnonymousMemory = (sample: MemorySample): AnonymousMemoryCounter => validateAndroidMemoryGauge(sample, "anonymous");
export const validateSwapPss = (sample: MemorySample): SwapPssCounter => validateAndroidMemoryGauge(sample, "swapPss");
export const validateSharedDirty = (sample: MemorySample): SharedDirtyCounter => validateAndroidMemoryGauge(sample, "sharedDirty");

export function validateVirtualMemory(sample: MemorySample): VirtualMemoryCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.virtualSize, "virtual memory") as VirtualMemoryCounter;
  const android = sample.platform === "android";
  if ((!android && sample.platform !== "ios") ||
      counter.source !== (android ? "/proc/self/status:VmSize" : "task_info(MACH_TASK_BASIC_INFO).virtual_size") ||
      (android ? !["/proc/self/smaps_rollup:Rss", "/proc/self/smaps:sum(Rss)"].includes(sample.source)
        : sample.source !== "task_info(MACH_TASK_BASIC_INFO).resident_size") ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" ||
      sample.clockSource !== (android ? "SystemClock.elapsedRealtimeNanos" : "NSProcessInfo.systemUptime") ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      (android && (!Number.isSafeInteger(sample.apiLevel) || sample.apiLevel! < 24)) ||
      !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid virtual memory source, scope or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw virtual memory counter");
  } else if (typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
      BigInt(counter.rawBytes) > 18446744073709551615n ||
      (counter.bytes !== null ? BigInt(counter.rawBytes) !== BigInt(counter.bytes)
        : BigInt(counter.rawBytes) <= BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error("Invalid raw virtual memory counter");
  }
  return counter;
}

export function validatePeakVirtualMemory(sample: MemorySample): PeakVirtualMemoryCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.peakVirtual, "peak virtual memory") as PeakVirtualMemoryCounter;
  if (sample.platform !== "android" || counter.source !== "/proc/self/status:VmPeak" ||
      !["/proc/self/smaps_rollup:Rss", "/proc/self/smaps:sum(Rss)"].includes(sample.source) ||
      counter.scope !== "process_lifetime" || counter.unit !== "bytes" ||
      sample.clockSource !== "SystemClock.elapsedRealtimeNanos" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      (!Number.isSafeInteger(sample.apiLevel) || sample.apiLevel! < 24) ||
      !Number.isSafeInteger(sample.processId) ||
      !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid peak virtual memory source, scope or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw peak virtual memory counter");
  } else if (typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
      BigInt(counter.rawBytes) > 18446744073709551615n ||
      (counter.bytes !== null ? BigInt(counter.rawBytes) !== BigInt(counter.bytes)
        : BigInt(counter.rawBytes) <= BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error("Invalid raw peak virtual memory counter");
  }
  return counter;
}

export function validateMemoryRegions(sample: MemorySample): MemoryRegionCounter {
  validateMemorySample(sample);
  const counter = sample.regions;
  if (!counter || sample.platform !== "ios" ||
      sample.source !== "task_info(MACH_TASK_BASIC_INFO).resident_size" ||
      counter.source !== "task_info(TASK_VM_INFO).region_count" ||
      counter.scope !== "calling_process" || counter.unit !== "regions" || counter.aggregation !== "gauge" ||
      !["simulator", "device"].includes(counter.environment) ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid memory-region source, scope or sample identity");
  if (counter.count === null) {
    if (typeof counter.error !== "string" || !counter.error.trim()) throw new Error("Missing memory-region error");
  } else if (!Number.isInteger(counter.count) || counter.count < 0 || counter.count > 2147483647 || counter.error !== null)
    throw new Error("Invalid memory-region count");
  if (counter.rawCount === null) {
    if (counter.count !== null) throw new Error("Missing raw memory-region count");
  } else {
    if (typeof counter.rawCount !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(counter.rawCount))
      throw new Error("Invalid raw memory-region count");
    const raw = BigInt(counter.rawCount);
    if (raw < -2147483648n || raw > 2147483647n ||
        (counter.count !== null ? raw !== BigInt(counter.count) : raw >= 0n))
      throw new Error("Invalid raw memory-region count");
  }
  return counter;
}

export function validateAndroidVmas(sample: MemorySample): AndroidVmaCounter {
  validateMemorySample(sample);
  const counter = sample.vmas;
  if (!counter || sample.platform !== "android" ||
      !["/proc/self/smaps_rollup:Rss", "/proc/self/smaps:sum(Rss)"].includes(sample.source) ||
      counter.source !== "/proc/self/maps:count(VMA)" ||
      counter.scope !== "calling_process" || counter.unit !== "regions" || counter.aggregation !== "gauge" ||
      (!Number.isSafeInteger(sample.apiLevel) || sample.apiLevel! < 24) ||
      sample.clockSource !== "SystemClock.elapsedRealtimeNanos" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid VMA source, scope or sample identity");
  if (counter.count === null) {
    if (typeof counter.error !== "string" || !counter.error.trim()) throw new Error("Missing VMA error");
  } else if (!Number.isInteger(counter.count) || counter.count < 0 || counter.count > 2147483647 || counter.error !== null)
    throw new Error("Invalid VMA count");
  if (counter.rawCount === null) {
    if (counter.count !== null) throw new Error("Missing raw VMA count");
  } else {
    if (typeof counter.rawCount !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawCount))
      throw new Error("Invalid raw VMA count");
    const raw = BigInt(counter.rawCount);
    if (raw < 0n || raw > 2147483647n ||
        (counter.count !== null ? raw !== BigInt(counter.count) : raw >= 0n))
      throw new Error("Invalid raw VMA count");
  }
  return counter;
}

export function validatePeakPhysicalFootprint(sample: MemorySample): PeakPhysicalFootprintCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.peakPhysicalFootprint, "peak physical footprint") as PeakPhysicalFootprintCounter;
  if (sample.platform !== "ios" || counter.source !== "task_info(TASK_VM_INFO).ledger_phys_footprint_peak" ||
      sample.source !== "task_info(MACH_TASK_BASIC_INFO).resident_size" ||
      counter.scope !== "process_lifetime" || counter.unit !== "bytes" ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !["simulator", "device"].includes(counter.environment) ||
      !Number.isSafeInteger(sample.processId) ||
      !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid peak physical footprint source, scope or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw peak physical footprint counter");
  } else {
    if (typeof counter.rawBytes !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(counter.rawBytes))
      throw new Error("Invalid raw peak physical footprint");
    const raw = BigInt(counter.rawBytes);
    if (raw < -9223372036854775808n || raw > 9223372036854775807n ||
        (counter.bytes !== null ? raw !== BigInt(counter.bytes)
          : raw >= 0n && raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid raw peak physical footprint");
  }
  return counter;
}

export function validateMetalAllocation(sample: MemorySample): MetalAllocationCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.metalAllocation, "Metal resource allocation") as MetalAllocationCounter;
  if (sample.platform !== "ios" || sample.clockSource !== "NSProcessInfo.systemUptime" ||
      sample.source !== "task_info(MACH_TASK_BASIC_INFO).resident_size" ||
      !Number.isFinite(sample.queryStartedUptimeMs) || sample.queryStartedUptimeMs! < 0 ||
      sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs! ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || sample.processId! <= 0 ||
      !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      counter.source !== "MTLDevice.currentAllocatedSize" || counter.scope !== "calling_process_default_mtl_device" ||
      counter.unit !== "bytes" || counter.accounting !== "metal_resource_allocation_bytes" ||
      !["simulator", "device"].includes(counter.environment) ||
      !Number.isFinite(sample.queryFinishedUptimeMs) ||
      !Number.isFinite(counter.queryStartedUptimeMs) || !Number.isFinite(counter.queryFinishedUptimeMs) ||
      counter.queryStartedUptimeMs < sample.queryFinishedUptimeMs! ||
      counter.queryFinishedUptimeMs < counter.queryStartedUptimeMs ||
      typeof counter.initializationAttemptedThisSample !== "boolean" ||
      !Number.isFinite(counter.initializationDurationMs) || counter.initializationDurationMs < 0 ||
      (counter.initializationAttemptedThisSample && counter.initializationDurationMs > counter.queryFinishedUptimeMs - counter.queryStartedUptimeMs))
    throw new Error("Invalid Metal resource allocation source, scope or timing");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null || counter.deviceName !== null) throw new Error("Missing raw Metal resource allocation");
  } else {
    if (typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
        typeof counter.deviceName !== "string" || !counter.deviceName.trim())
      throw new Error("Invalid raw Metal resource allocation or device");
    const raw = BigInt(counter.rawBytes);
    if (raw > 18446744073709551615n ||
        (counter.bytes !== null ? raw !== BigInt(counter.bytes) : raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid raw Metal resource allocation");
  }
  return counter;
}

export function validateMetalWorkingSet(sample: MemorySample): MetalWorkingSetCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.metalWorkingSet, "Metal recommended working-set size") as MetalWorkingSetCounter;
  const osMajor = Number(sample.osVersion?.split(".")[0]);
  if (!Number.isSafeInteger(osMajor) || osMajor <= 0 || (counter.rawBytes !== null && osMajor < 16) ||
      sample.platform !== "ios" || sample.clockSource !== "NSProcessInfo.systemUptime" ||
      sample.source !== "task_info(MACH_TASK_BASIC_INFO).resident_size" ||
      !Number.isFinite(sample.queryStartedUptimeMs) || sample.queryStartedUptimeMs! < 0 ||
      sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs! ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || sample.processId! <= 0 ||
      !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      counter.source !== "MTLDevice.recommendedMaxWorkingSetSize" || counter.scope !== "calling_process_default_mtl_device" ||
      counter.unit !== "bytes" || counter.accounting !== "metal_recommended_working_set_bytes" ||
      !["simulator", "device"].includes(counter.environment) ||
      !Number.isFinite(sample.queryFinishedUptimeMs) ||
      !Number.isFinite(counter.queryStartedUptimeMs) || !Number.isFinite(counter.queryFinishedUptimeMs) ||
      counter.queryStartedUptimeMs < sample.queryFinishedUptimeMs! ||
      counter.queryFinishedUptimeMs < counter.queryStartedUptimeMs)
    throw new Error("Invalid Metal recommended working-set size source, scope or timing");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null || (counter.deviceName !== null && (typeof counter.deviceName !== "string" || !counter.deviceName.trim()))) throw new Error("Missing raw Metal recommended working-set size");
  } else {
    if (typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
        typeof counter.deviceName !== "string" || !counter.deviceName.trim())
      throw new Error("Invalid raw Metal recommended working-set size or device");
    const raw = BigInt(counter.rawBytes);
    if (raw > 18446744073709551615n ||
        (counter.bytes !== null ? raw !== BigInt(counter.bytes) : raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid raw Metal recommended working-set size");
  }
  return counter;
}

export function validateGraphicsFootprint(sample: MemorySample): GraphicsFootprintCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.graphicsFootprint, "graphics footprint memory") as GraphicsFootprintCounter;
  if (sample.platform !== "ios" || counter.source !== "task_info(TASK_VM_INFO).ledger_tag_graphics_footprint" ||
      sample.source !== "task_info(MACH_TASK_BASIC_INFO).resident_size" ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" || counter.accounting !== "graphics_footprint_uncompressed_ledger_bytes" ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !["simulator", "device"].includes(counter.environment) ||
      !Number.isSafeInteger(sample.processId) ||
      !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid graphics footprint memory source, scope or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw graphics footprint memory counter");
  } else {
    if (typeof counter.rawBytes !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(counter.rawBytes))
      throw new Error("Invalid raw graphics footprint memory");
    const raw = BigInt(counter.rawBytes);
    if (raw < -9223372036854775808n || raw > 9223372036854775807n ||
        (counter.bytes !== null ? raw !== BigInt(counter.bytes)
          : raw >= 0n && raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid raw graphics footprint memory");
  }
  return counter;
}

export function validatePurgeableNonvolatile(sample: MemorySample): PurgeableNonvolatileCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.purgeableNonvolatile, "nonvolatile purgeable memory") as PurgeableNonvolatileCounter;
  if (sample.platform !== "ios" || counter.source !== "task_info(TASK_VM_INFO).ledger_purgeable_nonvolatile" ||
      sample.source !== "task_info(MACH_TASK_BASIC_INFO).resident_size" ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" || counter.accounting !== "purgeable_nonvolatile_resident_ledger_bytes" ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !["simulator", "device"].includes(counter.environment) ||
      !Number.isSafeInteger(sample.processId) ||
      !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid nonvolatile purgeable memory source, scope or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw nonvolatile purgeable memory counter");
  } else {
    if (typeof counter.rawBytes !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(counter.rawBytes))
      throw new Error("Invalid raw nonvolatile purgeable memory");
    const raw = BigInt(counter.rawBytes);
    if (raw < -9223372036854775808n || raw > 9223372036854775807n ||
        (counter.bytes !== null ? raw !== BigInt(counter.bytes)
          : raw >= 0n && raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid raw nonvolatile purgeable memory");
  }
  return counter;
}

export function validatePurgeableNonvolatileCompressed(sample: MemorySample): PurgeableNonvolatileCompressedCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.purgeableNonvolatileCompressed, "compressed nonvolatile purgeable memory") as PurgeableNonvolatileCompressedCounter;
  if (sample.platform !== "ios" || counter.source !== "task_info(TASK_VM_INFO).ledger_purgeable_novolatile_compressed" ||
      sample.source !== "task_info(MACH_TASK_BASIC_INFO).resident_size" ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" || counter.accounting !== "purgeable_nonvolatile_compressed_original_page_bytes" ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !["simulator", "device"].includes(counter.environment) ||
      !Number.isSafeInteger(sample.processId) ||
      !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid compressed nonvolatile purgeable memory source, scope or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw compressed nonvolatile purgeable memory counter");
  } else {
    if (typeof counter.rawBytes !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(counter.rawBytes))
      throw new Error("Invalid raw compressed nonvolatile purgeable memory");
    const raw = BigInt(counter.rawBytes);
    if (raw < -9223372036854775808n || raw > 9223372036854775807n ||
        (counter.bytes !== null ? raw !== BigInt(counter.bytes)
          : raw >= 0n && raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid raw compressed nonvolatile purgeable memory");
  }
  return counter;
}

export function validatePurgeableVolatileCompressed(sample: MemorySample): PurgeableVolatileCompressedCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.purgeableVolatileCompressed, "compressed volatile purgeable memory") as PurgeableVolatileCompressedCounter;
  if (sample.platform !== "ios" || counter.source !== "task_info(TASK_VM_INFO).ledger_purgeable_volatile_compressed" ||
      sample.source !== "task_info(MACH_TASK_BASIC_INFO).resident_size" ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" || counter.accounting !== "purgeable_volatile_compressed_original_page_bytes" ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !["simulator", "device"].includes(counter.environment) ||
      !Number.isSafeInteger(sample.processId) ||
      !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid compressed volatile purgeable memory source, scope or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw compressed volatile purgeable memory counter");
  } else {
    if (typeof counter.rawBytes !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(counter.rawBytes))
      throw new Error("Invalid raw compressed volatile purgeable memory");
    const raw = BigInt(counter.rawBytes);
    if (raw < -9223372036854775808n || raw > 9223372036854775807n ||
        (counter.bytes !== null ? raw !== BigInt(counter.bytes)
          : raw >= 0n && raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid raw compressed volatile purgeable memory");
  }
  return counter;
}

export function validatePurgeableVolatile(sample: MemorySample): PurgeableVolatileCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.purgeableVolatile, "volatile purgeable memory") as PurgeableVolatileCounter;
  if (sample.platform !== "ios" || counter.source !== "task_info(TASK_VM_INFO).ledger_purgeable_volatile" ||
      sample.source !== "task_info(MACH_TASK_BASIC_INFO).resident_size" ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" || counter.accounting !== "purgeable_volatile_resident_ledger_bytes" ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !["simulator", "device"].includes(counter.environment) ||
      !Number.isSafeInteger(sample.processId) ||
      !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid volatile purgeable memory source, scope or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw volatile purgeable memory counter");
  } else {
    if (typeof counter.rawBytes !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(counter.rawBytes))
      throw new Error("Invalid raw volatile purgeable memory");
    const raw = BigInt(counter.rawBytes);
    if (raw < -9223372036854775808n || raw > 9223372036854775807n ||
        (counter.bytes !== null ? raw !== BigInt(counter.bytes)
          : raw >= 0n && raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid raw volatile purgeable memory");
  }
  return counter;
}

export function validateCompressedMemory(sample: MemorySample): CompressedMemoryCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.compressed, "compressed memory") as CompressedMemoryCounter;
  if (sample.platform !== "ios" || counter.source !== "task_info(TASK_VM_INFO).compressed" ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" || counter.accounting !== "original_page_bytes" ||
      !["simulator", "device"].includes(counter.environment) ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid compressed memory source, accounting or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw compressed memory counter");
  } else if (typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
      BigInt(counter.rawBytes) > 18446744073709551615n ||
      (counter.bytes !== null ? BigInt(counter.rawBytes) !== BigInt(counter.bytes)
        : BigInt(counter.rawBytes) <= BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error("Invalid raw compressed memory counter");
  }
  return counter;
}

export function validatePeakCompressedMemory(sample: MemorySample): PeakCompressedMemoryCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.peakCompressed, "peak compressed memory") as PeakCompressedMemoryCounter;
  if (sample.platform !== "ios" || counter.source !== "task_info(TASK_VM_INFO).compressed_peak" ||
      counter.scope !== "process_lifetime" || counter.unit !== "bytes" || counter.accounting !== "original_page_bytes" ||
      !["simulator", "device"].includes(counter.environment) ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid peak compressed memory source, accounting or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw peak compressed memory counter");
  } else if (typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
      BigInt(counter.rawBytes) > 18446744073709551615n ||
      (counter.bytes !== null ? BigInt(counter.rawBytes) !== BigInt(counter.bytes)
        : BigInt(counter.rawBytes) <= BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error("Invalid raw peak compressed memory counter");
  }
  return counter;
}

export function validateCumulativeCompressedMemory(sample: MemorySample): CumulativeCompressedMemoryCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.cumulativeCompressed, "cumulative compressed memory") as CumulativeCompressedMemoryCounter;
  if (sample.platform !== "ios" || counter.source !== "task_info(TASK_VM_INFO).compressed_lifetime" ||
      counter.scope !== "process_lifetime" || counter.unit !== "bytes" || counter.accounting !== "internal_compressed_ledger_credit_bytes" ||
      !["simulator", "device"].includes(counter.environment) ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid cumulative compressed memory source, accounting or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw cumulative compressed memory counter");
  } else if (typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
      BigInt(counter.rawBytes) > 18446744073709551615n ||
      (counter.bytes !== null ? BigInt(counter.rawBytes) !== BigInt(counter.bytes)
        : BigInt(counter.rawBytes) <= BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error("Invalid raw cumulative compressed memory counter");
  }
  return counter;
}

export function validatePeakReusableMemory(sample: MemorySample): PeakReusableMemoryCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.peakReusable, "peak reusable memory") as PeakReusableMemoryCounter;
  if (sample.platform !== "ios" || counter.source !== "task_info(TASK_VM_INFO).reusable_peak" ||
      counter.scope !== "process_lifetime" || counter.unit !== "bytes" || counter.accounting !== "reusable_page_bytes" ||
      !["simulator", "device"].includes(counter.environment) ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid peak reusable memory source, accounting or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw peak reusable memory counter");
  } else if (typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
      BigInt(counter.rawBytes) > 18446744073709551615n ||
      (counter.bytes !== null ? BigInt(counter.rawBytes) !== BigInt(counter.bytes)
        : BigInt(counter.rawBytes) <= BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error("Invalid raw peak reusable memory counter");
  }
  return counter;
}

export function validatePeakInternalMemory(sample: MemorySample): PeakInternalMemoryCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.peakInternal, "peak internal memory") as PeakInternalMemoryCounter;
  if (sample.platform !== "ios" || counter.source !== "task_info(TASK_VM_INFO).internal_peak" ||
      counter.scope !== "process_lifetime" || counter.unit !== "bytes" || counter.accounting !== "internal_ledger_bytes" ||
      !["simulator", "device"].includes(counter.environment) ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid peak internal memory source, accounting or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw peak internal memory counter");
  } else if (typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
      BigInt(counter.rawBytes) > 18446744073709551615n ||
      (counter.bytes !== null ? BigInt(counter.rawBytes) !== BigInt(counter.bytes)
        : BigInt(counter.rawBytes) <= BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error("Invalid raw peak internal memory counter");
  }
  return counter;
}

export function validatePeakExternalMemory(sample: MemorySample): PeakExternalMemoryCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.peakExternal, "peak external memory") as PeakExternalMemoryCounter;
  if (sample.platform !== "ios" || counter.source !== "task_info(TASK_VM_INFO).external_peak" ||
      counter.scope !== "process_lifetime" || counter.unit !== "bytes" || counter.accounting !== "external_ledger_bytes" ||
      !["simulator", "device"].includes(counter.environment) ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid peak external memory source, accounting or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw peak external memory counter");
  } else if (typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
      BigInt(counter.rawBytes) > 18446744073709551615n ||
      (counter.bytes !== null ? BigInt(counter.rawBytes) !== BigInt(counter.bytes)
        : BigInt(counter.rawBytes) <= BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error("Invalid raw peak external memory counter");
  }
  return counter;
}

export function validateReusableMemory(sample: MemorySample): ReusableMemoryCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.reusable, "reusable memory") as ReusableMemoryCounter;
  if (sample.platform !== "ios" || counter.source !== "task_info(TASK_VM_INFO).reusable" ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" || counter.accounting !== "reusable_page_bytes" ||
      !["simulator", "device"].includes(counter.environment) ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid reusable memory source, accounting or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw reusable memory counter");
  } else if (typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
      BigInt(counter.rawBytes) > 18446744073709551615n ||
      (counter.bytes !== null ? BigInt(counter.rawBytes) !== BigInt(counter.bytes)
        : BigInt(counter.rawBytes) <= BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error("Invalid raw reusable memory counter");
  }
  return counter;
}

export function validateInternalMemory(sample: MemorySample): InternalMemoryCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.internal, "internal memory") as InternalMemoryCounter;
  if (sample.platform !== "ios" || counter.source !== "task_info(TASK_VM_INFO).internal" ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" || counter.accounting !== "internal_ledger_bytes" ||
      !["simulator", "device"].includes(counter.environment) ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid internal memory source, accounting or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw internal memory counter");
  } else if (typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
      BigInt(counter.rawBytes) > 18446744073709551615n ||
      (counter.bytes !== null ? BigInt(counter.rawBytes) !== BigInt(counter.bytes)
        : BigInt(counter.rawBytes) <= BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error("Invalid raw internal memory counter");
  }
  return counter;
}

export function validateExternalMemory(sample: MemorySample): ExternalMemoryCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.external, "external memory") as ExternalMemoryCounter;
  if (sample.platform !== "ios" || counter.source !== "task_info(TASK_VM_INFO).external" ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" || counter.accounting !== "external_ledger_bytes" ||
      !["simulator", "device"].includes(counter.environment) ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid external memory source, accounting or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw external memory counter");
  } else if (typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
      BigInt(counter.rawBytes) > 18446744073709551615n ||
      (counter.bytes !== null ? BigInt(counter.rawBytes) !== BigInt(counter.bytes)
        : BigInt(counter.rawBytes) <= BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error("Invalid raw external memory counter");
  }
  return counter;
}

// Preserve the OS high-water mark across foreground periods. Do not synthesize
// one from sampled RSS or clamp it to a separately queried current reading.
export class PeakRssTracker {
  private previous: MemorySample | null = null;
  record(sample: MemorySample, platform: string): PeakRssCounter {
    validateMemorySample(sample);
    const peak = validateMemoryCounter(sample.peakRss, "peak RSS") as PeakRssCounter;
    if ((platform !== "android" && platform !== "ios") || sample.platform !== platform ||
        peak.scope !== "process_lifetime" || peak.source !== (platform === "android"
          ? "getrusage(RUSAGE_SELF).ru_maxrss" : "task_info(TASK_VM_INFO).resident_size_peak") ||
        sample.clockSource !== (platform === "android" ? "SystemClock.elapsedRealtimeNanos" : "NSProcessInfo.systemUptime") ||
        typeof sample.osVersion !== "string" || !sample.osVersion ||
        !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
        !Number.isSafeInteger(sample.processId) ||
        !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
        sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
        sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs! ||
        (platform === "android" && (!Number.isSafeInteger(sample.apiLevel) || sample.apiLevel! <= 0)))
      throw new Error("Invalid native peak RSS source, scope or sample identity");
    const previous = this.previous;
    if (previous && previous.processId === sample.processId && previous.platform === sample.platform &&
        previous.osVersion === sample.osVersion && previous.apiLevel === sample.apiLevel) {
      if (sample.sequence! <= previous.sequence! || sample.queryStartedUptimeMs! < previous.queryFinishedUptimeMs!)
        throw new Error("Peak RSS samples are out of order");
      if (peak.bytes !== null && peak.bytes < previous.peakRss!.bytes!)
        throw new Error("OS peak RSS decreased within the same process");
    }
    // An unavailable reading does not erase the last trustworthy high-water mark.
    if (peak.bytes !== null) this.previous = sample;
    return peak;
  }
}

// Headroom may increase or decrease. Zero cannot distinguish an exceeded limit
// from a process for which the OS does not supply an app budget.
export function validateMemoryHeadroom(sample: MemorySample): MemoryHeadroom {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.headroom, "memory headroom") as MemoryHeadroom;
  if (sample.platform !== "ios" || counter.source !== "os_proc_available_memory()" ||
      counter.scope !== "current_app_limit" || !["simulator", "device"].includes(counter.environment) ||
      typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
      BigInt(counter.rawBytes) > 18446744073709551615n ||
      (counter.bytes !== null ? BigInt(counter.rawBytes) !== BigInt(counter.bytes)
        : BigInt(counter.rawBytes) <= BigInt(Number.MAX_SAFE_INTEGER)) ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid native memory headroom source, scope, bytes or sample identity");
  return counter;
}

// The Debug API is independent of /proc RSS/PSS accounting and can exceed RSS.
export function validateNativeHeapAllocated(sample: MemorySample): NativeHeapAllocatedCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.nativeHeapAllocated, "native heap allocated") as NativeHeapAllocatedCounter;
  if (sample.platform !== "android" || counter.source !== "Debug.getNativeHeapAllocatedSize()" ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" || counter.accounting !== "native_allocator_bytes" ||
      sample.clockSource !== "SystemClock.elapsedRealtimeNanos" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.apiLevel) || sample.apiLevel! < 24 ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid native heap source, scope or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw native heap bytes");
  } else {
    if (typeof counter.rawBytes !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(counter.rawBytes))
      throw new Error("Invalid raw native heap bytes");
    const raw = BigInt(counter.rawBytes);
    if (raw < -9223372036854775808n || raw > 9223372036854775807n ||
        (counter.bytes !== null ? raw !== BigInt(counter.bytes)
          : raw >= 0n && raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid raw native heap bytes");
  }
  return counter;
}

// Allocator free space is an independent gauge, not an allocation budget.
export function validateNativeHeapFree(sample: MemorySample): NativeHeapFreeCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.nativeHeapFree, "native heap free") as NativeHeapFreeCounter;
  if (sample.platform !== "android" || counter.source !== "Debug.getNativeHeapFreeSize()" ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" || counter.accounting !== "native_allocator_free_bytes" ||
      sample.clockSource !== "SystemClock.elapsedRealtimeNanos" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.apiLevel) || sample.apiLevel! < 24 ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid native heap free source, scope or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw native heap free bytes");
  } else {
    if (typeof counter.rawBytes !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(counter.rawBytes))
      throw new Error("Invalid raw native heap free bytes");
    const raw = BigInt(counter.rawBytes);
    if (raw < -9223372036854775808n || raw > 9223372036854775807n ||
        (counter.bytes !== null ? raw !== BigInt(counter.bytes)
          : raw >= 0n && raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid raw native heap free bytes");
  }
  return counter;
}

// Independent allocator-reported heap size; not a peak or process memory total.
export function validateNativeHeapSize(sample: MemorySample): NativeHeapSizeCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.nativeHeapSize, "native heap size") as NativeHeapSizeCounter;
  if (sample.platform !== "android" || counter.source !== "Debug.getNativeHeapSize()" ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" || counter.accounting !== "native_allocator_size_bytes" ||
      sample.clockSource !== "SystemClock.elapsedRealtimeNanos" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.apiLevel) || sample.apiLevel! < 24 ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid native heap size source, scope or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw native heap size bytes");
  } else {
    if (typeof counter.rawBytes !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(counter.rawBytes))
      throw new Error("Invalid raw native heap size bytes");
    const raw = BigInt(counter.rawBytes);
    if (raw < -9223372036854775808n || raw > 9223372036854775807n ||
        (counter.bytes !== null ? raw !== BigInt(counter.bytes)
          : raw >= 0n && raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid raw native heap size bytes");
  }
  return counter;
}

export function validateIosNativeHeapAllocated(sample: MemorySample): IosNativeHeapAllocatedCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.nativeHeapAllocated, "iOS native heap") as IosNativeHeapAllocatedCounter;
  if (sample.platform !== "ios" || counter.source !== "malloc_zone_statistics(NULL).size_in_use" ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" || counter.accounting !== "malloc_zone_size_in_use_bytes" || counter.zones !== "registered_malloc_zones" ||
      !["simulator", "device"].includes(counter.environment) ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid iOS native heap source, accounting or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw iOS native heap counter");
  } else if (typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
      BigInt(counter.rawBytes) > 18446744073709551615n ||
      (counter.bytes !== null ? BigInt(counter.rawBytes) !== BigInt(counter.bytes)
        : BigInt(counter.rawBytes) <= BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error("Invalid raw iOS native heap counter");
  }
  return counter;
}

export function validateIosNativeHeapReserved(sample: MemorySample): IosNativeHeapReservedCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.nativeHeapReserved, "iOS native heap reserved") as IosNativeHeapReservedCounter;
  if (sample.platform !== "ios" || counter.source !== "malloc_zone_statistics(NULL).size_allocated" ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" || counter.accounting !== "malloc_zone_reserved_bytes" || counter.zones !== "registered_malloc_zones" ||
      !["simulator", "device"].includes(counter.environment) ||
      sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid iOS native heap reserved source, accounting or sample identity");
  if (counter.rawBytes === null) {
    if (counter.bytes !== null) throw new Error("Missing raw iOS native heap reserved counter");
  } else if (typeof counter.rawBytes !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawBytes) ||
      BigInt(counter.rawBytes) > 18446744073709551615n ||
      (counter.bytes !== null ? BigInt(counter.rawBytes) !== BigInt(counter.bytes)
        : BigInt(counter.rawBytes) <= BigInt(Number.MAX_SAFE_INTEGER))) {
    throw new Error("Invalid raw iOS native heap reserved counter");
  }
  return counter;
}

export function validateIosNativeHeapBlocks(sample: MemorySample): IosNativeHeapBlocksCounter {
  validateMemorySample(sample);
  const counter = sample.nativeHeapBlocks;
  if (!counter || sample.platform !== "ios" || counter.source !== "malloc_zone_statistics(NULL).blocks_in_use" ||
      counter.scope !== "calling_process" || counter.unit !== "blocks" || counter.aggregation !== "gauge" ||
      counter.accounting !== "malloc_zone_blocks_in_use" || counter.zones !== "registered_malloc_zones" || counter.nativeWidthBits !== 32 ||
      !["simulator", "device"].includes(counter.environment) || sample.clockSource !== "NSProcessInfo.systemUptime" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.processId) || sample.processId <= 0 || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid iOS native heap block source, accounting or sample identity");
  if (counter.rawCount === null) {
    if (counter.count !== null || typeof counter.error !== "string" || !counter.error.trim())
      throw new Error("Missing raw iOS native heap block count");
  } else if (counter.error !== null || !Number.isSafeInteger(counter.count) || counter.count! < 0 || counter.count! > 4294967295 ||
      typeof counter.rawCount !== "string" || !/^(0|[1-9][0-9]*)$/.test(counter.rawCount) ||
      BigInt(counter.rawCount) !== BigInt(counter.count!)) {
    throw new Error("Invalid raw iOS native heap block count");
  }
  return counter;
}

export function validateJavaHeapUsed(sample: MemorySample): JavaHeapUsedCounter {
  validateMemorySample(sample);
  const counter = validateMemoryCounter(sample.javaHeapUsed, "Java heap used") as JavaHeapUsedCounter;
  if (sample.platform !== "android" || counter.source !== "Runtime.totalMemory() - Runtime.freeMemory()" ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" || counter.accounting !== "managed_heap_used_bytes" ||
      counter.consistency !== "total_before_equals_total_after" ||
      sample.clockSource !== "SystemClock.elapsedRealtimeNanos" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.apiLevel) || sample.apiLevel! < 24 ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid Java heap source, scope or sample identity");
  const signedRaw = (value: string | null): bigint | null => {
    if (value === null) return null;
    if (typeof value !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(value)) throw new Error("Invalid Java heap raw input");
    const n = BigInt(value);
    if (n < -9223372036854775808n || n > 9223372036854775807n) throw new Error("Java heap input outside signed Long range");
    return n;
  };
  const before = signedRaw(counter.rawTotalBeforeBytes), free = signedRaw(counter.rawFreeBytes), after = signedRaw(counter.rawTotalAfterBytes);
  const coherent = before !== null && free !== null && after !== null && before >= 0n && free >= 0n &&
    before === after && free <= before;
  if (!coherent) {
    if (counter.bytes !== null || counter.rawBytes !== null) throw new Error("Inconsistent Java heap inputs published as a value");
  } else {
    const used = before! - free!;
    if (counter.rawBytes !== used.toString() ||
        (used <= BigInt(Number.MAX_SAFE_INTEGER) ? counter.bytes !== Number(used) : counter.bytes !== null))
      throw new Error("Java heap derived bytes disagree with raw inputs");
  }
  return counter;
}

// Reuse the final totalMemory reading; this adds no OS query or native field.
export function deriveJavaHeapCapacity(sample: MemorySample): JavaHeapCapacityCounter {
  const used = validateJavaHeapUsed(sample);
  const rawBytes = used.rawTotalAfterBytes;
  const raw = rawBytes === null ? null : BigInt(rawBytes);
  const error = raw === null ? "Final Java heap capacity reading unavailable" : raw < 0n
    ? "Java heap capacity query returned negative bytes" : raw > BigInt(Number.MAX_SAFE_INTEGER)
    ? "Java heap capacity exceeds exact JavaScript integer range" : null;
  return {
    source: "Runtime.totalMemory()", scope: "calling_process", unit: "bytes",
    accounting: "managed_heap_current_capacity_bytes", input: "javaHeapUsed.rawTotalAfterBytes",
    rawBytes, bytes: error === null ? Number(raw) : null, error,
  };
}

// Reuse the existing freeMemory reading; this adds no OS query or native field.
export function deriveJavaHeapFree(sample: MemorySample): JavaHeapFreeCounter {
  const used = validateJavaHeapUsed(sample);
  const rawBytes = used.rawFreeBytes;
  const raw = rawBytes === null ? null : BigInt(rawBytes);
  const error = raw === null ? "Java heap free-space reading unavailable" : raw < 0n
    ? "Java heap free space query returned negative bytes" : raw > BigInt(Number.MAX_SAFE_INTEGER)
    ? "Java heap free space exceeds exact JavaScript integer range" : null;
  return {
    source: "Runtime.freeMemory()", scope: "calling_process", unit: "bytes",
    accounting: "managed_heap_free_bytes", input: "javaHeapUsed.rawFreeBytes",
    rawBytes, bytes: error === null ? Number(raw) : null, error,
  };
}

export function validateJavaHeapLimit(sample: MemorySample): JavaHeapLimitCounter {
  validateMemorySample(sample);
  const counter = sample.javaHeapLimit;
  if (!counter || (counter.error !== null && (typeof counter.error !== "string" || !counter.error.trim())))
    throw new Error("Invalid Java heap limit reading");
  if (sample.platform !== "android" || counter.source !== "Runtime.maxMemory()" ||
      counter.scope !== "calling_process" || counter.unit !== "bytes" || counter.accounting !== "managed_heap_limit_bytes" ||
      sample.clockSource !== "SystemClock.elapsedRealtimeNanos" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.apiLevel) || sample.apiLevel! < 24 ||
      !Number.isSafeInteger(sample.processId) || !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid Java heap limit source, scope or sample identity");
  let raw: bigint | null = null;
  if (counter.rawBytes !== null) {
    if (typeof counter.rawBytes !== "string" || !/^(0|-?[1-9][0-9]*)$/.test(counter.rawBytes))
      throw new Error("Invalid Java heap limit raw bytes");
    raw = BigInt(counter.rawBytes);
    if (raw < -9223372036854775808n || raw > 9223372036854775807n)
      throw new Error("Java heap limit outside signed Long range");
  }
  if (counter.limitKind === "no_inherent_limit") {
    if (raw !== 9223372036854775807n || counter.bytes !== null || counter.error !== null)
      throw new Error("Invalid unbounded Java heap limit state");
  } else if (counter.limitKind === "finite") {
    if (raw === null || raw < 0n || raw === 9223372036854775807n ||
        (raw <= BigInt(Number.MAX_SAFE_INTEGER)
          ? counter.bytes !== Number(raw) || counter.error !== null
          : counter.bytes !== null || counter.error === null))
      throw new Error("Invalid finite Java heap limit");
  } else if (counter.limitKind === "unavailable") {
    if ((raw !== null && raw >= 0n) || counter.bytes !== null || counter.error === null)
      throw new Error("Invalid unavailable Java heap limit state");
  } else throw new Error("Unknown Java heap limit kind");
  return counter;
}

// The runtime string is evidence even when it cannot be presented as a number.
export function validateArtGcCount(sample: MemorySample): ArtGcCountCounter {
  validateMemorySample(sample);
  const counter = sample.artGcCount;
  if (!counter || sample.platform !== "android" ||
      counter.source !== 'Debug.getRuntimeStat("art.gc.gc-count")' ||
      counter.statistic !== "art.gc.gc-count" || counter.runtime !== "ART" ||
      counter.scope !== "process_lifetime" || counter.unit !== "collections" || counter.approximate !== true ||
      sample.clockSource !== "SystemClock.elapsedRealtimeNanos" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.apiLevel) || sample.apiLevel! < 24 ||
      !Number.isSafeInteger(sample.processId) || sample.processId! <= 0 ||
      !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid ART GC count source, scope or sample identity");
  if (counter.rawCount !== null && typeof counter.rawCount !== "string")
    throw new Error("Invalid ART GC raw count type");
  const raw = typeof counter.rawCount === "string" && /^(0|[1-9][0-9]*)$/.test(counter.rawCount)
    ? BigInt(counter.rawCount) : null;
  if (counter.count === null) {
    if (typeof counter.error !== "string" || !counter.error.trim() ||
        (raw !== null && raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid unavailable ART GC count");
  } else if (!Number.isSafeInteger(counter.count) || counter.count < 0 ||
      counter.error !== null || raw !== BigInt(counter.count)) {
    throw new Error("Invalid ART GC count value");
  }
  return counter;
}

export function validateArtGcTime(sample: MemorySample): ArtGcTimeCounter {
  validateMemorySample(sample);
  const counter = sample.artGcTime;
  if (!counter || sample.platform !== "android" ||
      counter.source !== 'Debug.getRuntimeStat("art.gc.gc-time")' ||
      counter.statistic !== "art.gc.gc-time" || counter.runtime !== "ART" || counter.accounting !== "art_gc_run_duration" ||
      counter.scope !== "process_lifetime" || counter.unit !== "milliseconds" || counter.approximate !== true ||
      sample.clockSource !== "SystemClock.elapsedRealtimeNanos" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.apiLevel) || sample.apiLevel! < 24 ||
      !Number.isSafeInteger(sample.processId) || sample.processId! <= 0 ||
      !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid ART GC time source, scope or sample identity");
  if (counter.rawMilliseconds !== null && typeof counter.rawMilliseconds !== "string")
    throw new Error("Invalid ART GC raw milliseconds type");
  const raw = typeof counter.rawMilliseconds === "string" && /^(0|[1-9][0-9]*)(?![\s\S])/.test(counter.rawMilliseconds)
    ? BigInt(counter.rawMilliseconds) : null;
  if (counter.milliseconds === null) {
    if (typeof counter.error !== "string" || !counter.error.trim() ||
        (raw !== null && raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid unavailable ART GC time");
  } else if (!Number.isSafeInteger(counter.milliseconds) || counter.milliseconds < 0 ||
      counter.error !== null || raw !== BigInt(counter.milliseconds)) {
    throw new Error("Invalid ART GC time value");
  }
  return counter;
}

export function validateArtBlockingGcCount(sample: MemorySample): ArtBlockingGcCountCounter {
  validateMemorySample(sample);
  const counter = sample.artBlockingGcCount;
  if (!counter || sample.platform !== "android" ||
      counter.source !== 'Debug.getRuntimeStat("art.gc.blocking-gc-count")' ||
      counter.statistic !== "art.gc.blocking-gc-count" || counter.runtime !== "ART" || counter.classification !== "art_blocking_collection" ||
      counter.scope !== "process_lifetime" || counter.unit !== "collections" || counter.approximate !== true ||
      sample.clockSource !== "SystemClock.elapsedRealtimeNanos" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.apiLevel) || sample.apiLevel! < 24 ||
      !Number.isSafeInteger(sample.processId) || sample.processId! <= 0 ||
      !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid ART blocking GC count source, scope or sample identity");
  if (counter.rawCount !== null && typeof counter.rawCount !== "string")
    throw new Error("Invalid ART GC raw count type");
  const raw = typeof counter.rawCount === "string" && /^(0|[1-9][0-9]*)(?![\s\S])/.test(counter.rawCount)
    ? BigInt(counter.rawCount) : null;
  if (counter.count === null) {
    if (typeof counter.error !== "string" || !counter.error.trim() ||
        (raw !== null && raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid unavailable ART blocking GC count");
  } else if (!Number.isSafeInteger(counter.count) || counter.count < 0 ||
      counter.error !== null || raw !== BigInt(counter.count)) {
    throw new Error("Invalid ART blocking GC count value");
  }
  return counter;
}


export function validateArtBlockingGcTime(sample: MemorySample): ArtBlockingGcTimeCounter {
  validateMemorySample(sample);
  const counter = sample.artBlockingGcTime;
  if (!counter || sample.platform !== "android" ||
      counter.source !== 'Debug.getRuntimeStat("art.gc.blocking-gc-time")' ||
      counter.statistic !== "art.gc.blocking-gc-time" || counter.runtime !== "ART" || counter.classification !== "art_blocking_collection" || counter.accounting !== "art_blocking_gc_run_duration" ||
      counter.scope !== "process_lifetime" || counter.unit !== "milliseconds" || counter.approximate !== true ||
      sample.clockSource !== "SystemClock.elapsedRealtimeNanos" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.apiLevel) || sample.apiLevel! < 24 ||
      !Number.isSafeInteger(sample.processId) || sample.processId! <= 0 ||
      !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid ART blocking GC time source, scope or sample identity");
  if (counter.rawMilliseconds !== null && typeof counter.rawMilliseconds !== "string")
    throw new Error("Invalid ART GC raw milliseconds type");
  const raw = typeof counter.rawMilliseconds === "string" && /^(0|[1-9][0-9]*)(?![\s\S])/.test(counter.rawMilliseconds)
    ? BigInt(counter.rawMilliseconds) : null;
  if (counter.milliseconds === null) {
    if (typeof counter.error !== "string" || !counter.error.trim() ||
        (raw !== null && raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid unavailable ART blocking GC time");
  } else if (!Number.isSafeInteger(counter.milliseconds) || counter.milliseconds < 0 ||
      counter.error !== null || raw !== BigInt(counter.milliseconds)) {
    throw new Error("Invalid ART blocking GC time value");
  }
  return counter;
}


export function validateArtAllocatedBytes(sample: MemorySample): ArtAllocatedBytesCounter {
  validateMemorySample(sample);
  const counter = sample.artAllocatedBytes;
  if (!counter || sample.platform !== "android" ||
      counter.source !== 'Debug.getRuntimeStat("art.gc.bytes-allocated")' ||
      counter.statistic !== "art.gc.bytes-allocated" || counter.runtime !== "ART" || counter.accounting !== "art_managed_bytes_allocated_ever" ||
      counter.scope !== "process_lifetime" || counter.unit !== "bytes" || counter.approximate !== true ||
      sample.clockSource !== "SystemClock.elapsedRealtimeNanos" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.apiLevel) || sample.apiLevel! < 24 ||
      !Number.isSafeInteger(sample.processId) || sample.processId! <= 0 ||
      !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid ART cumulative allocated bytes source, scope or sample identity");
  if (counter.rawBytes !== null && typeof counter.rawBytes !== "string")
    throw new Error("Invalid ART GC raw bytes type");
  const raw = typeof counter.rawBytes === "string" && /^(0|[1-9][0-9]*)(?![\s\S])/.test(counter.rawBytes)
    ? BigInt(counter.rawBytes) : null;
  if (counter.bytes === null) {
    if (typeof counter.error !== "string" || !counter.error.trim() ||
        (raw !== null && raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid unavailable ART cumulative allocated bytes");
  } else if (!Number.isSafeInteger(counter.bytes) || counter.bytes < 0 ||
      counter.error !== null || raw !== BigInt(counter.bytes)) {
    throw new Error("Invalid ART cumulative allocated bytes value");
  }
  return counter;
}


export function validateArtFreedBytes(sample: MemorySample): ArtFreedBytesCounter {
  validateMemorySample(sample);
  const counter = sample.artFreedBytes;
  if (!counter || sample.platform !== "android" ||
      counter.source !== 'Debug.getRuntimeStat("art.gc.bytes-freed")' ||
      counter.statistic !== "art.gc.bytes-freed" || counter.runtime !== "ART" || counter.accounting !== "art_managed_bytes_freed_net" ||
      counter.scope !== "process_lifetime" || counter.unit !== "bytes" || counter.approximate !== true || counter.signed !== true || counter.monotonic !== false ||
      sample.clockSource !== "SystemClock.elapsedRealtimeNanos" ||
      typeof sample.osVersion !== "string" || !sample.osVersion.trim() ||
      !Number.isSafeInteger(sample.apiLevel) || sample.apiLevel! < 24 ||
      !Number.isSafeInteger(sample.processId) || sample.processId! <= 0 ||
      !Number.isSafeInteger(sample.sequence) || sample.sequence! <= 0 ||
      !Number.isFinite(sample.queryStartedUptimeMs) || !Number.isFinite(sample.queryFinishedUptimeMs) ||
      sample.queryStartedUptimeMs! < 0 || sample.queryFinishedUptimeMs! < sample.queryStartedUptimeMs! ||
      sample.monotonicMs < sample.queryStartedUptimeMs! || sample.monotonicMs > sample.queryFinishedUptimeMs!)
    throw new Error("Invalid ART reclaimed-byte accounting source, scope or sample identity");
  if (counter.rawBytes !== null && typeof counter.rawBytes !== "string")
    throw new Error("Invalid ART GC raw bytes type");
  const raw = typeof counter.rawBytes === "string" && /^(0|-?[1-9][0-9]*)(?![\s\S])/.test(counter.rawBytes)
    ? BigInt(counter.rawBytes) : null;
  if (counter.bytes === null) {
    if (typeof counter.error !== "string" || !counter.error.trim() ||
        (raw !== null && raw >= BigInt(Number.MIN_SAFE_INTEGER) && raw <= BigInt(Number.MAX_SAFE_INTEGER)))
      throw new Error("Invalid unavailable ART reclaimed-byte accounting");
  } else if (!Number.isSafeInteger(counter.bytes) || Object.is(counter.bytes, -0) ||
      counter.error !== null || raw !== BigInt(counter.bytes)) {
    throw new Error("Invalid ART reclaimed-byte accounting value");
  }
  return counter;
}


// Preserve the sign of small negative adjustments instead of rounding to -0.0 MiB.
export function formatArtFreedBytes(bytes: number): string {
  return Math.abs(bytes) < 1024 * 1024 ? `${bytes.toLocaleString()} B` : `${mebibytes(bytes)} MiB`;
}


export const nativeMallocStages = ["baseline", "small_held", "small_released", "small_reused",
  "small_half_released", "small_released_again", "large_held", "large_released", "mmap_held", "mmap_released"] as const;
export type NativeMallocPhase = {
  stage: typeof nativeMallocStages[number]; heldBytes: number;
  queryStartedUptimeMs: number; queryFinishedUptimeMs: number;
  allocated: NativeHeapAllocatedCounter; free: NativeHeapFreeCounter; size: NativeHeapSizeCounter;
};
export type NativeMallocCheck = {
  run: number; schemaVersion: 1; scope: "calling_process";
  stage: "completed" | "cancelled" | "failed"; error: string | null;
  maxHeldBytes: 16777216; heldBytes: 0; phases: NativeMallocPhase[];
  clockSource: "SystemClock.elapsedRealtimeNanos";
  queryStartedUptimeMs: number; queryFinishedUptimeMs: number;
};
export function validateNativeMallocCheck(sample: MemorySample): NativeMallocCheck {
  validateMemorySample(sample);
  const check = sample.nativeMallocCheck;
  if (!check || sample.platform !== "android" || check.schemaVersion !== 1 || check.scope !== "calling_process" ||
      !Number.isSafeInteger(check.run) || check.run <= 0 || check.maxHeldBytes !== 16777216 || check.heldBytes !== 0 ||
      check.clockSource !== "SystemClock.elapsedRealtimeNanos" || !["completed", "cancelled", "failed"].includes(check.stage) ||
      !Number.isFinite(check.queryStartedUptimeMs) || !Number.isFinite(check.queryFinishedUptimeMs) ||
      check.queryStartedUptimeMs < 0 || check.queryFinishedUptimeMs < check.queryStartedUptimeMs ||
      !Number.isFinite(sample.queryStartedUptimeMs) || check.queryFinishedUptimeMs > sample.queryStartedUptimeMs! ||
      !Array.isArray(check.phases) || check.phases.length > nativeMallocStages.length ||
      (check.stage === "completed" ? check.error !== null || check.phases.length !== nativeMallocStages.length
        : typeof check.error !== "string" || !check.error.trim()))
    throw new Error("Invalid native allocation check result, cleanup, or timing");
  const held = [0, 16777216, 0, 16777216, 8388608, 0, 16777216, 0, 16777216, 0];
  let previous = check.queryStartedUptimeMs;
  for (const [i, phase] of check.phases.entries()) {
    if (!phase || phase.stage !== nativeMallocStages[i] || phase.heldBytes !== held[i] ||
        !Number.isFinite(phase.queryStartedUptimeMs) || !Number.isFinite(phase.queryFinishedUptimeMs) ||
        phase.queryStartedUptimeMs < previous || phase.queryFinishedUptimeMs < phase.queryStartedUptimeMs ||
        phase.queryFinishedUptimeMs > check.queryFinishedUptimeMs)
      throw new Error("Invalid native allocation check phase order, holdings, or timing");
    validateNativeHeapAllocated({...sample, nativeHeapAllocated: phase.allocated});
    validateNativeHeapFree({...sample, nativeHeapFree: phase.free});
    validateNativeHeapSize({...sample, nativeHeapSize: phase.size});
    previous = phase.queryFinishedUptimeMs;
  }
  return check;
}
