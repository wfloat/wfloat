import { validateNativeMallocCheck, type NativeMallocCheck } from "./memory";
import { validateArtFreedBytes, formatArtFreedBytes, type ArtFreedBytesCounter } from "./memory";
import { validateArtAllocatedBytes, type ArtAllocatedBytesCounter } from "./memory";
import { validateArtBlockingGcTime, type ArtBlockingGcTimeCounter } from "./memory";
import { validateArtBlockingGcCount, type ArtBlockingGcCountCounter } from "./memory";
import { validateArtGcTime, type ArtGcTimeCounter } from "./memory";
import { validateArtGcCount, type ArtGcCountCounter } from "./memory";
import { validateIosNativeHeapBlocks, type IosNativeHeapBlocksCounter } from "./memory";
import { validateIosNativeHeapReserved, type IosNativeHeapReservedCounter } from "./memory";
import { validateMetalWorkingSet, type MetalWorkingSetCounter } from "./memory";
import { validateMetalAllocation, type MetalAllocationCounter } from "./memory";
import { validateGraphicsFootprint, type GraphicsFootprintCounter } from "./memory";
import { useMetricState } from "./useMetricState";
import { useEffect, useRef } from "react";
import { AppState, NativeModules, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { mebibytes, validateMemoryHeadroom, type MemoryHeadroom, PeakRssTracker, validateMemoryCounter, validateMemorySample, type MemoryCounter, type MemorySample, type PeakRssCounter } from "./memory";
import { validatePurgeableVolatileCompressed, type PurgeableVolatileCompressedCounter, validatePurgeableNonvolatileCompressed, type PurgeableNonvolatileCompressedCounter, validatePurgeableVolatile, type PurgeableVolatileCounter, validatePurgeableNonvolatile, type PurgeableNonvolatileCounter, validatePeakReusableMemory, type PeakReusableMemoryCounter, validatePeakInternalMemory, type PeakInternalMemoryCounter, validatePeakExternalMemory, type PeakExternalMemoryCounter, validatePeakCompressedMemory, type PeakCompressedMemoryCounter, validateCumulativeCompressedMemory, type CumulativeCompressedMemoryCounter, validateExternalMemory, type ExternalMemoryCounter, validateInternalMemory, type InternalMemoryCounter, validateReusableMemory, type ReusableMemoryCounter, validateLockedResident, type LockedResidentCounter, validateKsm, type KsmCounter, validateSharedHugetlb, type SharedHugetlbCounter, validatePrivateHugetlb, type PrivateHugetlbCounter, validateShmemPmdMapped, type ShmemPmdMappedCounter, validateFilePmdMapped, type FilePmdMappedCounter, validateAnonHugePages, type AnonHugePagesCounter, validateLazyFreeMemory, type LazyFreeMemoryCounter, validateSwappedMemory, type SwappedMemoryCounter, validateReferencedMemory, type ReferencedMemoryCounter, deriveCleanPss, type CleanPssCounter, validateDirtyPss, type DirtyPssCounter, validateShmemPss, type ShmemPssCounter, validateFilePss, type FilePssCounter, validateAnonymousPss, type AnonymousPssCounter, validateAndroidVmas, type AndroidVmaCounter, validateMemoryRegions, type MemoryRegionCounter, validatePeakPhysicalFootprint, type PeakPhysicalFootprintCounter, validatePeakVirtualMemory, type PeakVirtualMemoryCounter, validateLockedMemory, type LockedMemoryCounter, validateVirtualMemory, type VirtualMemoryCounter, validatePageTableMemory, type PageTableMemoryCounter, validateAnonymousMemory, type AnonymousMemoryCounter, validateSwapPss, type SwapPssCounter, validateCompressedMemory, type CompressedMemoryCounter, validateSharedDirty, type SharedDirtyCounter, validateSharedClean, type SharedCleanCounter, validatePrivateClean, type PrivateCleanCounter, validatePrivateDirty, type PrivateDirtyCounter } from "./memory";
import { deriveJavaHeapFree, type JavaHeapFreeCounter, deriveJavaHeapCapacity, type JavaHeapCapacityCounter, validateNativeHeapSize, type NativeHeapSizeCounter, validateNativeHeapFree, type NativeHeapFreeCounter, validateJavaHeapLimit, type JavaHeapLimitCounter, validateJavaHeapUsed, type JavaHeapUsedCounter, validateNativeHeapAllocated, type NativeHeapAllocatedCounter, validateIosNativeHeapAllocated, type IosNativeHeapAllocatedCounter } from "./memory";
import { DecompressionTracker, type DecompressionRate } from "./decompressions";
import { CompressionRateTracker, type CompressionRateReading } from "./compressionRate";
import type { DecompressionCounter } from "./memory";

// React Native provides this monotonic clock but omits its global TS type.
declare const performance: { now(): number };

export function MemoryUsageCard({ workloadRunning }: { workloadRunning: boolean }) {
  const [reading, setReading] = useMetricState<MemorySample | null>("MemoryUsageCard.reading", null);
  const [error, setError] = useMetricState<string | null>("MemoryUsageCard.error", null);
  const [pendingAction, setPendingAction] = useMetricState("MemoryUsageCard.pendingAction", false);
  const [active, setActive] = useMetricState("MemoryUsageCard.active", AppState.currentState === "active");
  const peakTracker = useRef(new PeakRssTracker());
  const [peak, setPeak] = useMetricState<PeakRssCounter | null>("MemoryUsageCard.peak", null);
  const [peakError, setPeakError] = useMetricState<string | null>("MemoryUsageCard.peakError", null);
  const decompressionTracker = useRef(new DecompressionTracker());
  const [decompressions, setDecompressions] = useMetricState<DecompressionCounter | null>("MemoryUsageCard.decompressions", null);
  const [decompressionRate, setDecompressionRate] = useMetricState<DecompressionRate | null>("MemoryUsageCard.decompressionRate", null);
  const [decompressionError, setDecompressionError] = useMetricState<string | null>("MemoryUsageCard.decompressionError", null);
  const compressionTracker = useRef(new CompressionRateTracker());
  const [compressionRate, setCompressionRate] = useMetricState<CompressionRateReading | null>("MemoryUsageCard.compressionRate", null);
  const [compressionRateError, setCompressionRateError] = useMetricState<string | null>("MemoryUsageCard.compressionRateError", null);
  const samples = useRef<MemorySample[]>([]);
  const perform = useRef<(action: "read" | "hold" | "holdClean" | "holdSharedClean" | "holdSharedDirty" | "releaseSecondMapping" | "purgeableCheck" | "graphicsCheck" | "metalCheck" | "mallocCheck" | "nativeMallocCheck" | "release") => Promise<void>>(async () => {});

  useEffect(() => {
    let mounted = true;
    let foreground = AppState.currentState === "active";
    // AppState can resolve between the initial render and this effect. Keep the
    // displayed state aligned with the foreground state used by the collector.
    setActive(foreground);
    let epoch = 0;
    let pending: Promise<void> | null = null;
    let actionPending = false;
    // Opt-in simulator diagnostic. Buffer JS timestamps so trace calls cannot
    // compete with the first eight reads on the native bridge.
    const startupTracing = NativeModules.BenchMemory?.startupTraceEnabled === true;
    const startupRunId = startupTracing ? `memory-startup-${Date.now()}` : "";
    let startupReads = 0;
    let startupEvents: object[] = [];
    const traceStartup = (event: string, fields: object = {}) => {
      if (startupTracing && startupReads <= 8 && startupEvents.length < 160)
        startupEvents.push({ event, jsMs: performance.now(), epochMs: Date.now(), ...fields });
    };
    const flushStartup = () => {
      if (!startupTracing || startupEvents.length === 0) return;
      const events = startupEvents; startupEvents = [];
      for (let offset = 0; offset < events.length; offset += 2)
        void NativeModules.BenchProcessCpu?.recordOverhead?.(JSON.stringify({
          event: "memory_startup_trace", runId: startupRunId, offset, total: events.length,
          events: events.slice(offset, offset + 2),
        })).catch(() => {});
    };
    if (startupTracing) traceStartup("effect_started");


    function sample(action: "read" | "hold" | "holdClean" | "holdSharedClean" | "holdSharedDirty" | "releaseSecondMapping" | "purgeableCheck" | "graphicsCheck" | "metalCheck" | "mallocCheck" | "nativeMallocCheck" | "release"): Promise<void> {
      if (!mounted || !foreground) return Promise.resolve();
      if (action === "read" && pending) {
        if (startupTracing) traceStartup("poll_coalesced");
        return pending;
      }
      if (action !== "read") {
        if (actionPending) return Promise.resolve();
        actionPending = true;
        setPendingAction(true);
      }
      const generation = epoch;
      // A tap waits for an in-flight poll instead of being silently dropped.
      const request = (pending ?? Promise.resolve()).then(async () => {
        if (!mounted || !foreground || generation !== epoch) return;
        try {
          if (!NativeModules.BenchMemory?.[action]) throw new Error("Native memory collector is missing. Rebuild the app.");
          const startupRead = startupTracing && action === "read" ? ++startupReads : 0;
          if (startupTracing) traceStartup("native_call", { read: startupRead, action });
          const result = await NativeModules.BenchMemory[action]();
          if (startupTracing) traceStartup("promise_resolved", { read: startupRead, sequence: result.sequence });
          if (!mounted || generation !== epoch) return;
          const next = validateMemorySample(result);
          samples.current.push(next);
          if (samples.current.length > 120) samples.current.shift();
          setReading(next);
          setError(null);
          if (Platform.OS === "ios") {
            try {
              setCompressionRate(compressionTracker.current.record(next)); setCompressionRateError(null);
            } catch (cause) {
              setCompressionRate(null);
              setCompressionRateError(cause instanceof Error ? cause.message : String(cause));
            }
            try {
              const result = decompressionTracker.current.record(next);
              setDecompressions(result.counter); setDecompressionRate(result.rate); setDecompressionError(result.counter.error);
            } catch (cause) {
              setDecompressions(null); setDecompressionRate(null);
              setDecompressionError(cause instanceof Error ? cause.message : String(cause));
            }
          }
          try {
            const counter = peakTracker.current.record(next, Platform.OS);
            setPeak(counter); setPeakError(counter.error);
          } catch (cause) {
            setPeak(null); setPeakError(cause instanceof Error ? cause.message : String(cause));
          }
        } catch (cause) {
          if (!mounted || generation !== epoch) return;
          setReading(null);
          setError(cause instanceof Error ? cause.message : String(cause));
          setPeak(null); setPeakError(cause instanceof Error ? cause.message : String(cause));
          compressionTracker.current.resetWindow(); setCompressionRate(null);
          setCompressionRateError(cause instanceof Error ? cause.message : String(cause));
          decompressionTracker.current.resetWindow(); setDecompressions(null); setDecompressionRate(null);
          setDecompressionError(cause instanceof Error ? cause.message : String(cause));
        }
      }).finally(() => {
        if (pending === request) pending = null;
        if (startupTracing) {
          traceStartup("sample_finished", { read: startupReads });
          if (startupReads === 8) flushStartup();
        }
        if (action !== "read") {
          actionPending = false;
          if (mounted) setPendingAction(false);
        }
      });
      pending = request;
      return request;
    }
    perform.current = sample;
    void sample("read");
    const timer = setInterval(() => {
      if (startupTracing) traceStartup("timer_tick", { pending: pending !== null });
      void sample("read");
    }, 2000);
    const subscription = AppState.addEventListener("change", (state) => {
      ++epoch;
      foreground = state === "active";
      if (startupTracing) traceStartup("app_state", { state });
      setActive(foreground);
      setReading(null);
      setError(null);
      setPeak(null); setPeakError(null);
      compressionTracker.current.resetWindow(); setCompressionRate(null); setCompressionRateError(null);
      decompressionTracker.current.resetWindow(); setDecompressions(null); setDecompressionRate(null); setDecompressionError(null);
      if (foreground) void sample("read");
    });
    return () => {
      mounted = false;
      flushStartup();
      ++epoch;
      clearInterval(timer);
      subscription.remove();
      compressionTracker.current.resetWindow();
      decompressionTracker.current.resetWindow();
      void NativeModules.BenchMemory?.release?.().catch(() => {});
    };
  }, []);

  const holding = (reading?.heldBytes ?? 0) > 0;
  const purgeableRunning = reading?.purgeableCheck?.running ?? false;
  const disabled = purgeableRunning || !active || pendingAction || (workloadRunning && !holding && !error) || (!reading && !error);
  const cleanDisabled = disabled || Boolean(error);
  const value = error ? "Read failed" : !active ? "Paused" : reading ? `${mebibytes(reading.rssBytes)} MiB` : "Reading…";
  const isAndroid = Platform.OS === "android";
  let nativeMalloc: NativeMallocCheck | null = null;
  let nativeMallocError: string | null = null;
  if (isAndroid && reading?.nativeMallocCheck) {
    try { nativeMalloc = validateNativeMallocCheck(reading); }
    catch (cause) { nativeMallocError = cause instanceof Error ? cause.message : String(cause); }
  }
  const nativeMallocLabels = { baseline: "Baseline", small_held: "Small blocks held", small_released: "Small blocks freed",
    small_reused: "Small blocks allocated again", small_half_released: "Half freed", small_released_again: "All small blocks freed",
    large_held: "Large blocks held", large_released: "Large blocks freed", mmap_held: "Direct mapping held", mmap_released: "Mapping released" };

  let artGcCount: ArtGcCountCounter | null = null;
  let artGcCountError = error;
  if (reading && isAndroid) {
    try { artGcCount = validateArtGcCount(reading); artGcCountError = artGcCount.error; }
    catch (cause) { artGcCountError = cause instanceof Error ? cause.message : String(cause); }
  }
  const artGcCountValue = !active ? "Paused" : artGcCountError ? "Unavailable" :
    artGcCount?.count != null ? `${artGcCount.count.toLocaleString()} collections` : "Reading…";
  let artBlockingGcCount: ArtBlockingGcCountCounter | null = null;
  let artBlockingGcCountError = error;
  if (reading && isAndroid) {
    try { artBlockingGcCount = validateArtBlockingGcCount(reading); artBlockingGcCountError = artBlockingGcCount.error; }
    catch (cause) { artBlockingGcCountError = cause instanceof Error ? cause.message : String(cause); }
  }
  const artBlockingGcCountValue = !active ? "Paused" : artBlockingGcCountError ? "Unavailable" :
    artBlockingGcCount?.count != null ? `${artBlockingGcCount.count.toLocaleString()} ${artBlockingGcCount.count === 1 ? "collection" : "collections"}` : "Reading…";
  let artGcTime: ArtGcTimeCounter | null = null;
  let artGcTimeError = error;
  if (reading && isAndroid) {
    try { artGcTime = validateArtGcTime(reading); artGcTimeError = artGcTime.error; }
    catch (cause) { artGcTimeError = cause instanceof Error ? cause.message : String(cause); }
  }
  const artGcTimeValue = !active ? "Paused" : artGcTimeError ? "Unavailable" :
    artGcTime?.milliseconds != null ? `${artGcTime.milliseconds.toLocaleString()} ms` : "Reading…";
  let artAllocatedBytes: ArtAllocatedBytesCounter | null = null;
  let artAllocatedBytesError = error;
  if (reading && isAndroid) {
    try { artAllocatedBytes = validateArtAllocatedBytes(reading); artAllocatedBytesError = artAllocatedBytes.error; }
    catch (cause) { artAllocatedBytesError = cause instanceof Error ? cause.message : String(cause); }
  }
  const artAllocatedBytesValue = !active ? "Paused" : artAllocatedBytesError ? "Unavailable" :
    artAllocatedBytes?.bytes != null ? `${mebibytes(artAllocatedBytes.bytes)} MiB` : "Reading…";
  let artFreedBytes: ArtFreedBytesCounter | null = null;
  let artFreedBytesError = error;
  if (reading && isAndroid) {
    try { artFreedBytes = validateArtFreedBytes(reading); artFreedBytesError = artFreedBytes.error; }
    catch (cause) { artFreedBytesError = cause instanceof Error ? cause.message : String(cause); }
  }
  const artFreedBytesValue = !active ? "Paused" : artFreedBytesError ? "Unavailable" :
    artFreedBytes?.bytes != null ? formatArtFreedBytes(artFreedBytes.bytes) : "Reading…";
  let artBlockingGcTime: ArtBlockingGcTimeCounter | null = null;
  let artBlockingGcTimeError = error;
  if (reading && isAndroid) {
    try { artBlockingGcTime = validateArtBlockingGcTime(reading); artBlockingGcTimeError = artBlockingGcTime.error; }
    catch (cause) { artBlockingGcTimeError = cause instanceof Error ? cause.message : String(cause); }
  }
  const artBlockingGcTimeValue = !active ? "Paused" : artBlockingGcTimeError ? "Unavailable" :
    artBlockingGcTime?.milliseconds != null ? `${artBlockingGcTime.milliseconds.toLocaleString()} ms` : "Reading…";
  let nativeHeapSize: NativeHeapSizeCounter | null = null;
  let nativeHeapSizeError = error;
  if (reading && isAndroid) {
    try { nativeHeapSize = validateNativeHeapSize(reading); nativeHeapSizeError = nativeHeapSize.error; }
    catch (cause) { nativeHeapSizeError = cause instanceof Error ? cause.message : String(cause); }
  }
  const nativeHeapSizeValue = !active ? "Paused" : nativeHeapSizeError ? "Unavailable" :
    nativeHeapSize?.bytes != null ? `${mebibytes(nativeHeapSize.bytes)} MiB` : "Reading…";
  let nativeHeapFree: NativeHeapFreeCounter | null = null;
  let nativeHeapFreeError = error;
  if (reading && isAndroid) {
    try { nativeHeapFree = validateNativeHeapFree(reading); nativeHeapFreeError = nativeHeapFree.error; }
    catch (cause) { nativeHeapFreeError = cause instanceof Error ? cause.message : String(cause); }
  }
  const nativeHeapFreeValue = !active ? "Paused" : nativeHeapFreeError ? "Unavailable" :
    nativeHeapFree?.bytes != null ? `${mebibytes(nativeHeapFree.bytes)} MiB` : "Reading…";
  let nativeHeapBlocks: IosNativeHeapBlocksCounter | null = null;
  let nativeHeapBlocksError = error;
  if (reading && !isAndroid) {
    try { nativeHeapBlocks = validateIosNativeHeapBlocks(reading); nativeHeapBlocksError = nativeHeapBlocks.error; }
    catch (cause) { nativeHeapBlocksError = cause instanceof Error ? cause.message : String(cause); }
  }
  const nativeHeapBlocksValue = !active ? "Paused" : nativeHeapBlocksError ? "Unavailable" :
    nativeHeapBlocks?.count != null ? `${nativeHeapBlocks.count.toLocaleString()} blocks` : "Reading…";
  let nativeHeapReserved: IosNativeHeapReservedCounter | null = null;
  let nativeHeapReservedError = error;
  if (reading && !isAndroid) {
    try { nativeHeapReserved = validateIosNativeHeapReserved(reading); nativeHeapReservedError = nativeHeapReserved.error; }
    catch (cause) { nativeHeapReservedError = cause instanceof Error ? cause.message : String(cause); }
  }
  const nativeHeapReservedValue = !active ? "Paused" : nativeHeapReservedError ? "Unavailable" :
    nativeHeapReserved?.bytes != null ? `${mebibytes(nativeHeapReserved.bytes)} MiB` : "Reading…";
  let nativeHeap: NativeHeapAllocatedCounter | IosNativeHeapAllocatedCounter | null = null;
  let nativeHeapError = error;
  if (reading) {
    try { nativeHeap = isAndroid ? validateNativeHeapAllocated(reading) : validateIosNativeHeapAllocated(reading); nativeHeapError = nativeHeap.error; }
    catch (cause) { nativeHeapError = cause instanceof Error ? cause.message : String(cause); }
  }
  const nativeHeapValue = !active ? "Paused" : nativeHeapError ? "Unavailable" :
    nativeHeap?.bytes != null ? `${mebibytes(nativeHeap.bytes)} MiB` : "Reading…";
  let javaHeap: JavaHeapUsedCounter | null = null;
  let javaHeapError = error;
  if (isAndroid && reading) {
    try { javaHeap = validateJavaHeapUsed(reading); javaHeapError = javaHeap.error; }
    catch (cause) { javaHeapError = cause instanceof Error ? cause.message : String(cause); }
  }
  const javaHeapValue = !active ? "Paused" : javaHeapError ? "Unavailable" :
    javaHeap?.bytes != null ? `${mebibytes(javaHeap.bytes)} MiB` : "Reading…";
  let javaHeapCapacity: JavaHeapCapacityCounter | null = null;
  let javaHeapCapacityError = error;
  if (isAndroid && reading) {
    try { javaHeapCapacity = deriveJavaHeapCapacity(reading); javaHeapCapacityError = javaHeapCapacity.error; }
    catch (cause) { javaHeapCapacityError = cause instanceof Error ? cause.message : String(cause); }
  }
  const javaHeapCapacityValue = !active ? "Paused" : javaHeapCapacityError ? "Unavailable" :
    javaHeapCapacity?.bytes != null ? `${mebibytes(javaHeapCapacity.bytes)} MiB` : "Reading…";
  let javaHeapFree: JavaHeapFreeCounter | null = null;
  let javaHeapFreeError = error;
  if (isAndroid && reading) {
    try { javaHeapFree = deriveJavaHeapFree(reading); javaHeapFreeError = javaHeapFree.error; }
    catch (cause) { javaHeapFreeError = cause instanceof Error ? cause.message : String(cause); }
  }
  const javaHeapFreeValue = !active ? "Paused" : javaHeapFreeError ? "Unavailable" :
    javaHeapFree?.bytes != null ? `${mebibytes(javaHeapFree.bytes)} MiB` : "Reading…";
  let javaHeapLimit: JavaHeapLimitCounter | null = null;
  let javaHeapLimitError = error;
  if (isAndroid && reading) {
    try { javaHeapLimit = validateJavaHeapLimit(reading); javaHeapLimitError = javaHeapLimit.error; }
    catch (cause) { javaHeapLimitError = cause instanceof Error ? cause.message : String(cause); }
  }
  const javaHeapLimitValue = !active ? "Paused" : javaHeapLimitError ? "Unavailable" :
    javaHeapLimit?.limitKind === "no_inherent_limit" ? "No inherent limit reported" :
    javaHeapLimit?.bytes != null ? `${mebibytes(javaHeapLimit.bytes)} MiB` : "Reading…";
  const counterName = isAndroid ? "PSS" : "physical footprint";
  let counter: MemoryCounter | null = null;
  let counterError = error;
  if (reading) {
    try {
      counter = validateMemoryCounter(isAndroid ? reading.pss : reading.physicalFootprint, counterName);
      counterError = counter.error;
    } catch (cause) {
      counterError = cause instanceof Error ? cause.message : String(cause);
    }
  }
  const counterValue = !active ? "Paused" : counterError ? "Unavailable" :
    counter?.bytes != null ? `${mebibytes(counter.bytes)} MiB` : "Reading…";
  const peakValue = !active ? "Paused" : peakError ? "Unavailable" :
    peak?.bytes != null ? `${mebibytes(peak.bytes)} MiB` : "Reading…";
  let virtualSize: VirtualMemoryCounter | null = null;
  let virtualError = error;
  if (reading) {
    try { virtualSize = validateVirtualMemory(reading); virtualError = virtualSize.error; }
    catch (cause) { virtualError = cause instanceof Error ? cause.message : String(cause); }
  }
  const virtualValue = !active ? "Paused" : virtualError ? "Unavailable" :
    virtualSize?.bytes != null ? `${mebibytes(virtualSize.bytes)} MiB` : "Reading…";
  let privateDirty: PrivateDirtyCounter | null = null;
  let privateDirtyError = error;
  if (isAndroid && reading) {
    try { privateDirty = validatePrivateDirty(reading); privateDirtyError = privateDirty.error; }
    catch (cause) { privateDirtyError = cause instanceof Error ? cause.message : String(cause); }
  }
  const privateDirtyValue = !active ? "Paused" : privateDirtyError ? "Unavailable" :
    privateDirty?.bytes != null ? `${mebibytes(privateDirty.bytes)} MiB` : "Reading…";
  let privateClean: PrivateCleanCounter | null = null;
  let privateCleanError = error;
  if (isAndroid && reading) {
    try { privateClean = validatePrivateClean(reading); privateCleanError = privateClean.error; }
    catch (cause) { privateCleanError = cause instanceof Error ? cause.message : String(cause); }
  }
  const privateCleanValue = !active ? "Paused" : privateCleanError ? "Unavailable" :
    privateClean?.bytes != null ? `${mebibytes(privateClean.bytes)} MiB` : "Reading…";
  let sharedClean: SharedCleanCounter | null = null;
  let sharedCleanError = error;
  if (isAndroid && reading) {
    try { sharedClean = validateSharedClean(reading); sharedCleanError = sharedClean.error; }
    catch (cause) { sharedCleanError = cause instanceof Error ? cause.message : String(cause); }
  }
  const sharedCleanValue = !active ? "Paused" : sharedCleanError ? "Unavailable" :
    sharedClean?.bytes != null ? `${mebibytes(sharedClean.bytes)} MiB` : "Reading…";
  let sharedDirty: SharedDirtyCounter | null = null;
  let sharedDirtyError = error;
  if (isAndroid && reading) {
    try { sharedDirty = validateSharedDirty(reading); sharedDirtyError = sharedDirty.error; }
    catch (cause) { sharedDirtyError = cause instanceof Error ? cause.message : String(cause); }
  }
  const sharedDirtyValue = !active ? "Paused" : sharedDirtyError ? "Unavailable" :
    sharedDirty?.bytes != null ? `${mebibytes(sharedDirty.bytes)} MiB` : "Reading…";
  let peakVirtual: PeakVirtualMemoryCounter | null = null;
  let peakVirtualError = error;
  if (isAndroid && reading) {
    try { peakVirtual = validatePeakVirtualMemory(reading); peakVirtualError = peakVirtual.error; }
    catch (cause) { peakVirtualError = cause instanceof Error ? cause.message : String(cause); }
  }
  const peakVirtualValue = !active ? "Paused" : peakVirtualError ? "Unavailable" :
    peakVirtual?.bytes != null ? `${mebibytes(peakVirtual.bytes)} MiB` : "Reading…";
  let locked: LockedMemoryCounter | null = null;
  let lockedError = error;
  if (isAndroid && reading) {
    try { locked = validateLockedMemory(reading); lockedError = locked.error; }
    catch (cause) { lockedError = cause instanceof Error ? cause.message : String(cause); }
  }
  const lockedValue = !active ? "Paused" : lockedError ? "Unavailable" :
    locked?.bytes != null ? `${(locked.bytes / 1024).toFixed(1)} KiB` : "Reading…";
  let pageTables: PageTableMemoryCounter | null = null;
  let pageTablesError = error;
  if (isAndroid && reading) {
    try { pageTables = validatePageTableMemory(reading); pageTablesError = pageTables.error; }
    catch (cause) { pageTablesError = cause instanceof Error ? cause.message : String(cause); }
  }
  const pageTablesValue = !active ? "Paused" : pageTablesError ? "Unavailable" :
    pageTables?.bytes != null ? `${(pageTables.bytes / 1024).toFixed(1)} KiB` : "Reading…";
  let anonymousPss: AnonymousPssCounter | null = null;
  let anonymousPssError = error;
  if (isAndroid && reading) {
    try { anonymousPss = validateAnonymousPss(reading); anonymousPssError = anonymousPss.error; }
    catch (cause) { anonymousPssError = cause instanceof Error ? cause.message : String(cause); }
  }
  const anonymousPssValue = !active ? "Paused" : anonymousPssError ? "Unavailable" :
    anonymousPss?.bytes != null ? `${mebibytes(anonymousPss.bytes)} MiB` : "Reading…";
  let filePss: FilePssCounter | null = null;
  let filePssError = error;
  if (isAndroid && reading) {
    try { filePss = validateFilePss(reading); filePssError = filePss.error; }
    catch (cause) { filePssError = cause instanceof Error ? cause.message : String(cause); }
  }
  const filePssValue = !active ? "Paused" : filePssError ? "Unavailable" :
    filePss?.bytes != null ? `${mebibytes(filePss.bytes)} MiB` : "Reading…";
  let shmemPss: ShmemPssCounter | null = null;
  let shmemPssError = error;
  if (isAndroid && reading) {
    try { shmemPss = validateShmemPss(reading); shmemPssError = shmemPss.error; }
    catch (cause) { shmemPssError = cause instanceof Error ? cause.message : String(cause); }
  }
  const shmemPssValue = !active ? "Paused" : shmemPssError ? "Unavailable" :
    shmemPss?.bytes != null ? `${mebibytes(shmemPss.bytes)} MiB` : "Reading…";
  let dirtyPss: DirtyPssCounter | null = null;
  let dirtyPssError = error;
  if (isAndroid && reading) {
    try { dirtyPss = validateDirtyPss(reading); dirtyPssError = dirtyPss.error; }
    catch (cause) { dirtyPssError = cause instanceof Error ? cause.message : String(cause); }
  }
  const dirtyPssValue = !active ? "Paused" : dirtyPssError ? "Unavailable" :
    dirtyPss?.bytes != null ? `${mebibytes(dirtyPss.bytes)} MiB` : "Reading…";
  let referenced: ReferencedMemoryCounter | null = null;
  let referencedError = error;
  if (isAndroid && reading) {
    try { referenced = validateReferencedMemory(reading); referencedError = referenced.error; }
    catch (cause) { referencedError = cause instanceof Error ? cause.message : String(cause); }
  }
  const referencedValue = !active ? "Paused" : referencedError ? "Unavailable" :
    referenced?.bytes != null ? `${mebibytes(referenced.bytes)} MiB` : "Reading…";
  let swap: SwappedMemoryCounter | null = null;
  let swapError = error;
  if (isAndroid && reading) {
    try { swap = validateSwappedMemory(reading); swapError = swap.error; }
    catch (cause) { swapError = cause instanceof Error ? cause.message : String(cause); }
  }
  const swapValue = !active ? "Paused" : swapError ? "Unavailable" :
    swap?.bytes != null ? `${mebibytes(swap.bytes)} MiB` : "Reading…";
  let lazyFree: LazyFreeMemoryCounter | null = null;
  let lazyFreeError = error;
  if (isAndroid && reading) {
    try { lazyFree = validateLazyFreeMemory(reading); lazyFreeError = lazyFree.error; }
    catch (cause) { lazyFreeError = cause instanceof Error ? cause.message : String(cause); }
  }
  const lazyFreeValue = !active ? "Paused" : lazyFreeError ? "Unavailable" :
    lazyFree?.bytes != null ? `${mebibytes(lazyFree.bytes)} MiB` : "Reading…";
  let anonHugePages: AnonHugePagesCounter | null = null;
  let anonHugePagesError = error;
  if (isAndroid && reading) {
    try { anonHugePages = validateAnonHugePages(reading); anonHugePagesError = anonHugePages.error; }
    catch (cause) { anonHugePagesError = cause instanceof Error ? cause.message : String(cause); }
  }
  const anonHugePagesValue = !active ? "Paused" : anonHugePagesError ? "Unavailable" :
    anonHugePages?.bytes != null ? `${mebibytes(anonHugePages.bytes)} MiB` : "Reading…";
  let filePmdMapped: FilePmdMappedCounter | null = null;
  let filePmdMappedError = error;
  if (isAndroid && reading) {
    try { filePmdMapped = validateFilePmdMapped(reading); filePmdMappedError = filePmdMapped.error; }
    catch (cause) { filePmdMappedError = cause instanceof Error ? cause.message : String(cause); }
  }
  const filePmdMappedValue = !active ? "Paused" : filePmdMappedError ? "Unavailable" :
    filePmdMapped?.bytes != null ? `${mebibytes(filePmdMapped.bytes)} MiB` : "Reading…";
  let shmemPmdMapped: ShmemPmdMappedCounter | null = null;
  let shmemPmdMappedError = error;
  if (isAndroid && reading) {
    try { shmemPmdMapped = validateShmemPmdMapped(reading); shmemPmdMappedError = shmemPmdMapped.error; }
    catch (cause) { shmemPmdMappedError = cause instanceof Error ? cause.message : String(cause); }
  }
  const shmemPmdMappedValue = !active ? "Paused" : shmemPmdMappedError ? "Unavailable" :
    shmemPmdMapped?.bytes != null ? `${mebibytes(shmemPmdMapped.bytes)} MiB` : "Reading…";
  let privateHugetlb: PrivateHugetlbCounter | null = null;
  let privateHugetlbError = error;
  if (isAndroid && reading) {
    try { privateHugetlb = validatePrivateHugetlb(reading); privateHugetlbError = privateHugetlb.error; }
    catch (cause) { privateHugetlbError = cause instanceof Error ? cause.message : String(cause); }
  }
  const privateHugetlbValue = !active ? "Paused" : privateHugetlbError ? "Unavailable" :
    privateHugetlb?.bytes != null ? `${mebibytes(privateHugetlb.bytes)} MiB` : "Reading…";
  let sharedHugetlb: SharedHugetlbCounter | null = null;
  let sharedHugetlbError = error;
  if (isAndroid && reading) {
    try { sharedHugetlb = validateSharedHugetlb(reading); sharedHugetlbError = sharedHugetlb.error; }
    catch (cause) { sharedHugetlbError = cause instanceof Error ? cause.message : String(cause); }
  }
  const sharedHugetlbValue = !active ? "Paused" : sharedHugetlbError ? "Unavailable" :
    sharedHugetlb?.bytes != null ? `${mebibytes(sharedHugetlb.bytes)} MiB` : "Reading…";
  let lockedResident: LockedResidentCounter | null = null;
  let lockedResidentError = error;
  if (isAndroid && reading) {
    try { lockedResident = validateLockedResident(reading); lockedResidentError = lockedResident.error; }
    catch (cause) { lockedResidentError = cause instanceof Error ? cause.message : String(cause); }
  }
  const lockedResidentValue = !active ? "Paused" : lockedResidentError ? "Unavailable" :
    lockedResident?.bytes != null ? `${(lockedResident.bytes / 1024).toFixed(1)} KiB` : "Reading…";
  let ksm: KsmCounter | null = null;
  let ksmError = error;
  if (isAndroid && reading) {
    try { ksm = validateKsm(reading); ksmError = ksm.error; }
    catch (cause) { ksmError = cause instanceof Error ? cause.message : String(cause); }
  }
  const ksmValue = !active ? "Paused" : ksmError ? "Unavailable" :
    ksm?.bytes != null ? `${mebibytes(ksm.bytes)} MiB` : "Reading…";
  let cleanPss: CleanPssCounter | null = null;
  let cleanPssError = error;
  if (isAndroid && reading) {
    try { cleanPss = deriveCleanPss(reading); cleanPssError = cleanPss.error; }
    catch (cause) { cleanPssError = cause instanceof Error ? cause.message : String(cause); }
  }
  const cleanPssValue = !active ? "Paused" : cleanPssError ? "Unavailable" :
    cleanPss?.bytes != null ? `${mebibytes(cleanPss.bytes)} MiB` : "Reading…";
  let anonymous: AnonymousMemoryCounter | null = null;
  let anonymousError = error;
  if (isAndroid && reading) {
    try { anonymous = validateAnonymousMemory(reading); anonymousError = anonymous.error; }
    catch (cause) { anonymousError = cause instanceof Error ? cause.message : String(cause); }
  }
  const anonymousValue = !active ? "Paused" : anonymousError ? "Unavailable" :
    anonymous?.bytes != null ? `${mebibytes(anonymous.bytes)} MiB` : "Reading…";
  let swapPss: SwapPssCounter | null = null;
  let swapPssError = error;
  if (isAndroid && reading) {
    try { swapPss = validateSwapPss(reading); swapPssError = swapPss.error; }
    catch (cause) { swapPssError = cause instanceof Error ? cause.message : String(cause); }
  }
  const swapPssValue = !active ? "Paused" : swapPssError ? "Unavailable" :
    swapPss?.bytes != null ? `${mebibytes(swapPss.bytes)} MiB` : "Reading…";
  let vmas: AndroidVmaCounter | null = null;
  let vmasError = error;
  if (isAndroid && reading) {
    try { vmas = validateAndroidVmas(reading); vmasError = vmas.error; }
    catch (cause) { vmasError = cause instanceof Error ? cause.message : String(cause); }
  }
  const vmasValue = !active ? "Paused" : vmasError ? "Unavailable" :
    vmas?.count != null ? vmas.count.toLocaleString("en-US") : "Reading…";
  let regions: MemoryRegionCounter | null = null;
  let regionsError = error;
  if (!isAndroid && reading) {
    try { regions = validateMemoryRegions(reading); regionsError = regions.error; }
    catch (cause) { regionsError = cause instanceof Error ? cause.message : String(cause); }
  }
  const regionsValue = !active ? "Paused" : regionsError ? "Unavailable" :
    regions?.count != null ? regions.count.toLocaleString("en-US") : "Reading…";
  let peakFootprint: PeakPhysicalFootprintCounter | null = null;
  let peakFootprintError = error;
  if (!isAndroid && reading) {
    try { peakFootprint = validatePeakPhysicalFootprint(reading); peakFootprintError = peakFootprint.error; }
    catch (cause) { peakFootprintError = cause instanceof Error ? cause.message : String(cause); }
  }
  const peakFootprintValue = !active ? "Paused" : peakFootprintError ? "Unavailable" :
    peakFootprint?.bytes != null ? `${mebibytes(peakFootprint.bytes)} MiB` : "Reading…";
  let compressed: CompressedMemoryCounter | null = null;
  let compressedError = error;
  if (!isAndroid && reading) {
    try { compressed = validateCompressedMemory(reading); compressedError = compressed.error; }
    catch (cause) { compressedError = cause instanceof Error ? cause.message : String(cause); }
  }
  const compressedValue = !active ? "Paused" : compressedError ? "Unavailable" :
    compressed?.bytes != null ? `${mebibytes(compressed.bytes)} MiB` : "Reading…";
  let peakCompressed: PeakCompressedMemoryCounter | null = null;
  let peakCompressedError = error;
  if (!isAndroid && reading) {
    try { peakCompressed = validatePeakCompressedMemory(reading); peakCompressedError = peakCompressed.error; }
    catch (cause) { peakCompressedError = cause instanceof Error ? cause.message : String(cause); }
  }
  const peakCompressedValue = !active ? "Paused" : peakCompressedError ? "Unavailable" :
    peakCompressed?.bytes != null ? `${mebibytes(peakCompressed.bytes)} MiB` : "Reading…";
  let cumulativeCompressed: CumulativeCompressedMemoryCounter | null = null;
  let cumulativeCompressedError = error;
  if (!isAndroid && reading) {
    try { cumulativeCompressed = validateCumulativeCompressedMemory(reading); cumulativeCompressedError = cumulativeCompressed.error; }
    catch (cause) { cumulativeCompressedError = cause instanceof Error ? cause.message : String(cause); }
  }
  const cumulativeCompressedValue = !active ? "Paused" : cumulativeCompressedError ? "Unavailable" :
    cumulativeCompressed?.bytes != null ? `${mebibytes(cumulativeCompressed.bytes)} MiB` : "Reading…";
  const compressionMiBPerSecond = compressionRate?.rate ? compressionRate.rate.bytesPerSecond / 1048576 : null;
  const compressionRateValue = !active ? "Paused" : compressionRateError || compressionRate?.status === "unavailable" ? "Unavailable" :
    compressionMiBPerSecond === null ? "Measuring…" : compressionMiBPerSecond > 0 && compressionMiBPerSecond < 0.01 ? "<0.01 MiB/s" : `${compressionMiBPerSecond.toFixed(2)} MiB/s`;
  let peakReusable: PeakReusableMemoryCounter | null = null;
  let peakReusableError = error;
  if (!isAndroid && reading) {
    try { peakReusable = validatePeakReusableMemory(reading); peakReusableError = peakReusable.error; }
    catch (cause) { peakReusableError = cause instanceof Error ? cause.message : String(cause); }
  }
  const peakReusableValue = !active ? "Paused" : peakReusableError ? "Unavailable" :
    peakReusable?.bytes != null ? `${mebibytes(peakReusable.bytes)} MiB` : "Reading…";
  let peakInternal: PeakInternalMemoryCounter | null = null;
  let peakInternalError = error;
  if (!isAndroid && reading) {
    try { peakInternal = validatePeakInternalMemory(reading); peakInternalError = peakInternal.error; }
    catch (cause) { peakInternalError = cause instanceof Error ? cause.message : String(cause); }
  }
  const peakInternalValue = !active ? "Paused" : peakInternalError ? "Unavailable" :
    peakInternal?.bytes != null ? `${mebibytes(peakInternal.bytes)} MiB` : "Reading…";
  let peakExternal: PeakExternalMemoryCounter | null = null;
  let peakExternalError = error;
  if (!isAndroid && reading) {
    try { peakExternal = validatePeakExternalMemory(reading); peakExternalError = peakExternal.error; }
    catch (cause) { peakExternalError = cause instanceof Error ? cause.message : String(cause); }
  }
  const peakExternalValue = !active ? "Paused" : peakExternalError ? "Unavailable" :
    peakExternal?.bytes != null ? `${mebibytes(peakExternal.bytes)} MiB` : "Reading…";
  let metalWorkingSet: MetalWorkingSetCounter | null = null;
  let metalWorkingSetError = error;
  if (reading && Platform.OS === "ios") {
    try { metalWorkingSet = validateMetalWorkingSet(reading); metalWorkingSetError = metalWorkingSet.error; }
    catch (cause) { metalWorkingSetError = cause instanceof Error ? cause.message : String(cause); }
  }
  const metalWorkingSetValue = !active ? "Paused" : metalWorkingSetError ? "Unavailable" :
    metalWorkingSet?.bytes != null ? `${mebibytes(metalWorkingSet.bytes)} MiB` : "Reading…";
  let metalAllocation: MetalAllocationCounter | null = null;
  let metalAllocationError = error;
  if (reading && Platform.OS === "ios") {
    try { metalAllocation = validateMetalAllocation(reading); metalAllocationError = metalAllocation.error; }
    catch (cause) { metalAllocationError = cause instanceof Error ? cause.message : String(cause); }
  }
  const metalAllocationValue = !active ? "Paused" : metalAllocationError ? "Unavailable" :
    metalAllocation?.bytes != null ? `${mebibytes(metalAllocation.bytes)} MiB` : "Reading…";
  let graphicsFootprint: GraphicsFootprintCounter | null = null;
  let graphicsFootprintError = error;
  if (!isAndroid && reading) {
    try { graphicsFootprint = validateGraphicsFootprint(reading); graphicsFootprintError = graphicsFootprint.error; }
    catch (cause) { graphicsFootprintError = cause instanceof Error ? cause.message : String(cause); }
  }
  const graphicsFootprintValue = !active ? "Paused" : graphicsFootprintError ? "Unavailable" :
    graphicsFootprint?.bytes != null ? `${mebibytes(graphicsFootprint.bytes)} MiB` : "Reading…";
  let purgeableNonvolatile: PurgeableNonvolatileCounter | null = null;
  let purgeableNonvolatileError = error;
  if (!isAndroid && reading) {
    try { purgeableNonvolatile = validatePurgeableNonvolatile(reading); purgeableNonvolatileError = purgeableNonvolatile.error; }
    catch (cause) { purgeableNonvolatileError = cause instanceof Error ? cause.message : String(cause); }
  }
  const purgeableNonvolatileValue = !active ? "Paused" : purgeableNonvolatileError ? "Unavailable" :
    purgeableNonvolatile?.bytes != null ? `${mebibytes(purgeableNonvolatile.bytes)} MiB` : "Reading…";
  let purgeableNonvolatileCompressed: PurgeableNonvolatileCompressedCounter | null = null;
  let purgeableNonvolatileCompressedError = error;
  if (!isAndroid && reading) {
    try { purgeableNonvolatileCompressed = validatePurgeableNonvolatileCompressed(reading); purgeableNonvolatileCompressedError = purgeableNonvolatileCompressed.error; }
    catch (cause) { purgeableNonvolatileCompressedError = cause instanceof Error ? cause.message : String(cause); }
  }
  const purgeableNonvolatileCompressedValue = !active ? "Paused" : purgeableNonvolatileCompressedError ? "Unavailable" :
    purgeableNonvolatileCompressed?.bytes != null ? `${mebibytes(purgeableNonvolatileCompressed.bytes)} MiB` : "Reading…";
  let purgeableVolatileCompressed: PurgeableVolatileCompressedCounter | null = null;
  let purgeableVolatileCompressedError = error;
  if (!isAndroid && reading) {
    try { purgeableVolatileCompressed = validatePurgeableVolatileCompressed(reading); purgeableVolatileCompressedError = purgeableVolatileCompressed.error; }
    catch (cause) { purgeableVolatileCompressedError = cause instanceof Error ? cause.message : String(cause); }
  }
  const purgeableVolatileCompressedValue = !active ? "Paused" : purgeableVolatileCompressedError ? "Unavailable" :
    purgeableVolatileCompressed?.bytes != null ? `${mebibytes(purgeableVolatileCompressed.bytes)} MiB` : "Reading…";
  let purgeableVolatile: PurgeableVolatileCounter | null = null;
  let purgeableVolatileError = error;
  if (!isAndroid && reading) {
    try { purgeableVolatile = validatePurgeableVolatile(reading); purgeableVolatileError = purgeableVolatile.error; }
    catch (cause) { purgeableVolatileError = cause instanceof Error ? cause.message : String(cause); }
  }
  const purgeableVolatileValue = !active ? "Paused" : purgeableVolatileError ? "Unavailable" :
    purgeableVolatile?.bytes != null ? `${mebibytes(purgeableVolatile.bytes)} MiB` : "Reading…";
  let reusable: ReusableMemoryCounter | null = null;
  let reusableError = error;
  if (!isAndroid && reading) {
    try { reusable = validateReusableMemory(reading); reusableError = reusable.error; }
    catch (cause) { reusableError = cause instanceof Error ? cause.message : String(cause); }
  }
  const reusableValue = !active ? "Paused" : reusableError ? "Unavailable" :
    reusable?.bytes != null ? `${mebibytes(reusable.bytes)} MiB` : "Reading…";
  let internal: InternalMemoryCounter | null = null;
  let internalError = error;
  if (!isAndroid && reading) {
    try { internal = validateInternalMemory(reading); internalError = internal.error; }
    catch (cause) { internalError = cause instanceof Error ? cause.message : String(cause); }
  }
  const internalValue = !active ? "Paused" : internalError ? "Unavailable" :
    internal?.bytes != null ? `${mebibytes(internal.bytes)} MiB` : "Reading…";
  let external: ExternalMemoryCounter | null = null;
  let externalError = error;
  if (!isAndroid && reading) {
    try { external = validateExternalMemory(reading); externalError = external.error; }
    catch (cause) { externalError = cause instanceof Error ? cause.message : String(cause); }
  }
  const externalValue = !active ? "Paused" : externalError ? "Unavailable" :
    external?.bytes != null ? `${mebibytes(external.bytes)} MiB` : "Reading…";
  const decompressionValue = !active ? "Paused" : decompressionError ? "Unavailable" :
    decompressions?.saturated ? "Counter limit reached" : decompressionRate ? `${decompressionRate.perSecond.toFixed(1)} /s` : "Sampling…";
  let headroom: MemoryHeadroom | null = null;
  let headroomError = error;
  if (!isAndroid && reading) {
    try { headroom = validateMemoryHeadroom(reading); headroomError = headroom.error; }
    catch (cause) { headroomError = cause instanceof Error ? cause.message : String(cause); }
  }
  const headroomValue = !active ? "Paused" : headroomError ? "Unavailable" : headroom?.bytes === 0
    ? "Unresolved · API returned 0" : headroom?.bytes != null ? `${mebibytes(headroom.bytes)} MiB` : "Reading…";
  return (
    <View style={styles.card}>
      <Text style={styles.label}>APP RESIDENT MEMORY · RSS</Text>
      <Text testID="process-rss" accessibilityLabel={`App resident memory: ${value}`} style={styles.value}>{value}</Text>
      <Text style={styles.body}>Resident RAM pages, including shared pages.</Text>
      <View style={styles.additional}>
        <Text style={styles.label}>NATIVE HEAP ALLOCATED · {isAndroid ? "Android" : "iOS"}</Text>
        <Text testID="process-native-heap-allocated" accessibilityLabel={`Native heap allocated: ${nativeHeapValue}`}
          style={styles.value}>{nativeHeapValue}</Text>
        <Text style={styles.body}>Bytes reported as allocated by this process’s native heap allocator.</Text>
        <Text style={styles.note}>Allocator accounting includes rounding and overhead. This is not RSS{isAndroid ? ", Java heap" : ""} or exact model memory. Direct mmap and allocations outside this allocator are not covered.</Text>
        {!isAndroid && <Text style={styles.note}>Sums size in use across registered malloc zones. Freed blocks can remain counted in allocator caches. Separate from reserved space and iOS internal memory.</Text>}
        {nativeHeap && "environment" in nativeHeap && nativeHeap.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects this app’s allocator on the Mac.</Text>}
        <Text style={styles.note}>Freeing allocations need not immediately reduce RSS. The existing memory test buttons use mmap, not malloc.</Text>
        {nativeHeapError && <Text testID="process-native-heap-allocated-error" style={styles.note}>{nativeHeapError}</Text>}
      </View>
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>NATIVE HEAP RESERVED · iOS</Text>
        <Text testID="process-native-heap-reserved" accessibilityLabel={`Native heap reserved: ${nativeHeapReservedValue}`} style={styles.value}>{nativeHeapReservedValue}</Text>
        <Text style={styles.body}>Memory reserved by this app’s registered malloc zones, including unused capacity and allocator overhead.</Text>
        <Text style={styles.note}>Reservations can remain after allocations are freed. This is not resident RAM, total process memory or guaranteed free space.</Text>
        {nativeHeapReserved?.environment === "simulator" && <Text style={styles.note}>Simulator heap reservation · reflects this app’s allocator on the Mac.</Text>}
        {nativeHeapReservedError && <Text testID="process-native-heap-reserved-error" style={styles.note}>{nativeHeapReservedError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>NATIVE HEAP BLOCKS IN USE · iOS</Text>
        <Text testID="process-native-heap-blocks" accessibilityLabel={`Native heap blocks in use: ${nativeHeapBlocksValue}`} style={styles.value}>{nativeHeapBlocksValue}</Text>
        <Text style={styles.body}>Allocation blocks reported in use across this app’s registered malloc zones. Not a JavaScript object count or lifetime allocation total.</Text>
        <Text style={styles.note}>Count can overstate blocks still in use: freed small allocations remained counted in local Apple-runtime tests. Raw OS reading; no correction applied.</Text>
        {nativeHeapBlocks?.environment === "simulator" && <Text style={styles.note}>Simulator heap block count · reflects this app’s allocator on the Mac.</Text>}
        <Pressable testID="malloc-memory-check" disabled={!active || pendingAction || workloadRunning}
          onPress={() => void perform.current("mallocCheck")} style={styles.button}>
          <Text style={styles.buttonText}>Run malloc accounting check</Text>
        </Pressable>
        <Text testID="malloc-memory-check-status" style={styles.note}>{reading?.mallocCheck?.stage ?? "idle"} · Bounded small-block reuse and 32 MiB allocation check. Releases its allocations before returning.</Text>
        {nativeHeapBlocksError && <Text testID="process-native-heap-blocks-error" style={styles.note}>{nativeHeapBlocksError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>NATIVE HEAP SIZE · Android</Text>
        <Text testID="process-native-heap-size" accessibilityLabel={`Native heap size: ${nativeHeapSizeValue}`} style={styles.value}>{nativeHeapSizeValue}</Text>
        <Text style={styles.body}>Heap size reported by this process’s native allocator.</Text>
        <Text style={styles.note}>Scudo reports allocator-mapped space here. It can include unused capacity and overhead, and can remain after allocations are freed. Coverage depends on the allocator.</Text>
        <Text style={styles.note}>Not RSS, total process memory, a lifetime peak or an allocation limit. Queried separately from allocated and free bytes; the readings are not an atomic snapshot.</Text>
        {nativeHeapSizeError && <Text testID="process-native-heap-size-error" style={styles.note}>{nativeHeapSizeError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>NATIVE HEAP FREE · Android</Text>
        <Text testID="process-native-heap-free" accessibilityLabel={`Native heap free: ${nativeHeapFreeValue}`} style={styles.value}>{nativeHeapFreeValue}</Text>
        <Text style={styles.body}>Space reported as free inside this process’s native allocator.</Text>
        <Text style={styles.note}>Allocator accounting, not free device RAM or a guaranteed allocation budget. Coverage depends on the allocator; freeing a large block need not increase this value.</Text>
        <Text style={styles.note}>Separate from Java heap and RSS. The existing mmap test buttons do not exercise this allocator.</Text>
        {nativeHeapFreeError && <Text testID="process-native-heap-free-error" style={styles.note}>{nativeHeapFreeError}</Text>}
        <Pressable testID="android-native-malloc-check" disabled={!active || pendingAction || workloadRunning}
          onPress={() => void perform.current("nativeMallocCheck")} style={styles.button}>
          <Text style={styles.buttonText}>Run native allocation check</Text>
        </Pressable>
        <Text testID="android-native-malloc-check-status" style={styles.note}>{pendingAction ? "Working…" : nativeMalloc?.stage ?? "idle"} · Holds at most 16 MiB. Frees, reallocates and releases small/large blocks, then checks direct mapping. Stops on interruption or a 10-second budget.</Text>
        {nativeMalloc && <View testID="android-native-malloc-check-result">
          <Text style={styles.body}>App heap: allocated / free / size · MiB</Text>
          {nativeMalloc.phases.map(phase => <Text key={phase.stage} testID={`android-malloc-phase-${phase.stage}`} style={styles.note}>
            {nativeMallocLabels[phase.stage]}: {[phase.allocated, phase.free, phase.size].map(c => c.bytes === null ? "unavailable" : mebibytes(c.bytes)).join(" / ")}
            {[phase.allocated, phase.free, phase.size].some(c => c.error) ? " · " + [phase.allocated, phase.free, phase.size].filter(c => c.error).map(c => c.error).join("; ") : ""}
          </Text>)}
          <Text style={styles.note}>Check {nativeMalloc.run} · {nativeMalloc.phases.length}/10 phases · {(nativeMalloc.queryFinishedUptimeMs-nativeMalloc.queryStartedUptimeMs).toFixed(1)} ms · All test allocations released. Completion describes the workload; counter changes depend on the allocator and other app activity.</Text>
          <Text style={styles.note}>Rows use separate public API queries. Includes the app and diagnostic bookkeeping; not isolated model memory or an atomic snapshot. Direct mapping is outside native malloc accounting.</Text>
        </View>}
        {(nativeMallocError || nativeMalloc?.error) && <Text testID="android-native-malloc-check-error" style={styles.note}>{nativeMallocError ?? nativeMalloc?.error}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>GARBAGE COLLECTIONS · Android ART</Text>
        <Text testID="process-art-gc-count" accessibilityLabel={`ART garbage collections: ${artGcCountValue}`} style={styles.value}>{artGcCountValue}</Text>
        <Text style={styles.body}>Approximate cumulative number of garbage collections reported by this process’s Java/Kotlin runtime.</Text>
        <Text style={styles.note}>Separate from Hermes/JavaScript garbage collection. Counts collections, not objects, reclaimed bytes or pause duration. A new process starts a separate counter history.</Text>
        <Text style={styles.note}>Sampling does not request garbage collection. Android can report this statistic as unavailable.</Text>
        {artGcCountError && <Text testID="process-art-gc-count-error" style={styles.note}>{artGcCountError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>CUMULATIVE GC TIME · Android ART</Text>
        <Text testID="process-art-gc-time" accessibilityLabel={`ART cumulative GC time: ${artGcTimeValue}`} style={styles.value}>{artGcTimeValue}</Text>
        <Text style={styles.body}>Approximate cumulative duration of garbage-collection runs reported by this process’s Java/Kotlin runtime.</Text>
        <Text style={styles.note}>Includes concurrent collection work while the app can run. This is not app pause time, CPU time or Hermes/JavaScript GC time.</Text>
        <Text style={styles.note}>Reported in whole milliseconds. Short collections may not change the reading. Queried separately from GC count; the pair is not an atomic snapshot.</Text>
        <Text style={styles.note}>Sampling does not request garbage collection. A new process starts a separate counter history.</Text>
        {artGcTimeError && <Text testID="process-art-gc-time-error" style={styles.note}>{artGcTimeError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>BLOCKING GC COLLECTIONS · Android ART</Text>
        <Text testID="process-art-blocking-gc-count" accessibilityLabel={`ART blocking GC count: ${artBlockingGcCountValue}`} style={styles.value}>{artBlockingGcCountValue}</Text>
        <Text style={styles.body}>Approximate cumulative number of collections this process’s Java/Kotlin runtime classifies as blocking.</Text>
        <Text style={styles.note}>ART counts a collection when a thread outside its heap task daemon runs it or waits for it to finish. A background app thread can qualify; this does not specifically mean the UI froze.</Text>
        <Text style={styles.note}>Counts collections, not blocked threads or all stop-the-world pauses. It does not measure pause duration or Hermes/JavaScript GC.</Text>
        <Text style={styles.note}>Queried separately from total GC count and time. Sampling does not request collection. Zero is valid; unavailable readings are reported separately. A new process starts a separate counter history.</Text>
        {artBlockingGcCountError && <Text testID="process-art-blocking-gc-count-error" style={styles.note}>{artBlockingGcCountError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>BLOCKING GC TIME · Android ART</Text>
        <Text testID="process-art-blocking-gc-time" accessibilityLabel={`ART blocking GC time: ${artBlockingGcTimeValue}`} style={styles.value}>{artBlockingGcTimeValue}</Text>
        <Text style={styles.body}>Approximate cumulative duration of collections this process’s Java/Kotlin runtime classifies as blocking.</Text>
        <Text style={styles.note}>ART includes the full duration of each qualifying collection, even if an app thread waits for only part of it. This does not measure UI freeze duration, individual thread waiting time or CPU time.</Text>
        <Text style={styles.note}>Reported in whole milliseconds, separately from GC counts and total GC time. Short collections may not change this reading. These queries are not an atomic snapshot.</Text>
        <Text style={styles.note}>Separate from Hermes/JavaScript GC. Sampling does not request collection. Zero is valid; unavailable readings are reported separately. A new process starts a separate counter history.</Text>
        {artBlockingGcTimeError && <Text testID="process-art-blocking-gc-time-error" style={styles.note}>{artBlockingGcTimeError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>CUMULATIVE ALLOCATED · Android ART</Text>
        <Text testID="process-art-allocated-bytes" accessibilityLabel={`ART cumulative allocated bytes: ${artAllocatedBytesValue}`} style={styles.value}>{artAllocatedBytesValue}</Text>
        {active && !artAllocatedBytesError && artAllocatedBytes?.bytes != null && <Text style={styles.note}>{artAllocatedBytes.bytes.toLocaleString()} bytes · cumulative</Text>}
        <Text style={styles.body}>Approximate total bytes allocated in this process’s Java/Kotlin managed heap, including allocations later reclaimed by GC.</Text>
        <Text style={styles.note}>This tracks allocation activity, not current heap usage, RSS or a memory limit. It can keep increasing while current heap usage stays steady.</Text>
        <Text style={styles.note}>Includes framework, dashboard and measurement activity. Separate from native malloc, direct mmap and Hermes/JavaScript allocations. ART accounting is not an exact sum of object payload sizes; updates may be delayed.</Text>
        <Text style={styles.note}>Sampling does not request GC. Zero is valid; unavailable readings are reported separately. A new process starts a separate counter history.</Text>
        {artAllocatedBytesError && <Text testID="process-art-allocated-bytes-error" style={styles.note}>{artAllocatedBytesError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>GC RECLAIMED BYTES · Android ART</Text>
        <Text testID="process-art-freed-bytes" accessibilityLabel={`ART reclaimed-byte accounting: ${artFreedBytesValue}`} style={styles.value}>{artFreedBytesValue}</Text>
        {active && !artFreedBytesError && artFreedBytes?.bytes != null && <Text style={styles.note}>{artFreedBytes.bytes.toLocaleString()} bytes · signed runtime accounting</Text>}
        <Text style={styles.body}>Approximate running total of managed-heap bytes ART accounts as reclaimed by garbage collection in this process.</Text>
        <Text style={styles.note}>Moving objects between memory spaces can adjust this total downward or make it negative. The app preserves those values; this is not a strictly increasing counter of deleted object payloads.</Text>
        <Text style={styles.note}>Reclamation inside the Java/Kotlin heap does not imply RAM returned to the OS or a matching RSS drop. Separate from native malloc and Hermes/JavaScript GC.</Text>
        <Text style={styles.note}>Queried separately from allocated bytes and heap usage. Includes framework, dashboard and measurement activity. Sampling does not request GC. Zero and unavailable are distinct; a new process starts a separate history.</Text>
        {artFreedBytesError && <Text testID="process-art-freed-bytes-error" style={styles.note}>{artFreedBytesError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>JAVA HEAP USED · Android</Text>
        <Text testID="process-java-heap-used" accessibilityLabel={`Java heap used: ${javaHeapValue}`} style={styles.value}>{javaHeapValue}</Text>
        <Text style={styles.body}>Estimated used space in this process’s managed Java/Kotlin heap.</Text>
        <Text style={styles.note}>Runtime total heap minus free heap space. Includes objects awaiting garbage collection; not exact live objects, native heap, JavaScript heap or RSS.</Text>
        <Text style={styles.note}>The runtime can resize its heap. Reads are not atomic; a detected size change makes that sample unavailable. Sampling does not request garbage collection.</Text>
        {javaHeapError && <Text testID="process-java-heap-used-error" style={styles.note}>{javaHeapError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>JAVA HEAP CAPACITY · Android</Text>
        <Text testID="process-java-heap-capacity" accessibilityLabel={`Java heap capacity: ${javaHeapCapacityValue}`} style={styles.value}>{javaHeapCapacityValue}</Text>
        <Text style={styles.body}>Current managed-heap size, including used and free space for Java/Kotlin objects.</Text>
        <Text style={styles.note}>The runtime can grow or shrink this capacity. The maximum heap limit is shown separately; neither value measures resident RAM or guarantees an allocation will succeed.</Text>
        {javaHeapCapacityError && <Text testID="process-java-heap-capacity-error" style={styles.note}>{javaHeapCapacityError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>JAVA HEAP FREE · Android</Text>
        <Text testID="process-java-heap-free" accessibilityLabel={`Java heap free space: ${javaHeapFreeValue}`} style={styles.value}>{javaHeapFreeValue}</Text>
        <Text style={styles.body}>Estimated free space inside the current Java/Kotlin managed heap.</Text>
        <Text style={styles.note}>This is not free device RAM or the gap between used heap and its maximum limit. The runtime can resize the heap; this reading does not guarantee an allocation will succeed.</Text>
        <Text style={styles.note}>Objects awaiting garbage collection can still occupy space. These readings are not atomic, and sampling does not request collection.</Text>
        {javaHeapFreeError && <Text testID="process-java-heap-free-error" style={styles.note}>{javaHeapFreeError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>JAVA HEAP LIMIT · Android</Text>
        <Text testID="process-java-heap-limit" accessibilityLabel={`Java heap limit: ${javaHeapLimitValue}`} style={styles.value}>{javaHeapLimitValue}</Text>
        <Text style={styles.body}>Maximum managed-heap size the runtime will attempt to use.</Text>
        <Text style={styles.note}>Separate from current heap capacity, free device RAM, native memory and the app’s overall memory budget. The gap above used heap is not a guarantee that an allocation will succeed.</Text>
        {javaHeapLimit?.limitKind === "no_inherent_limit" && <Text style={styles.note}>The API supplied its no-inherent-limit marker. This does not mean unlimited physical memory.</Text>}
        {javaHeapLimitError && <Text testID="process-java-heap-limit-error" style={styles.note}>{javaHeapLimitError}</Text>}
      </View>}
      <View style={styles.additional}>
        <Text style={styles.label}>APP VIRTUAL MEMORY SIZE</Text>
        <Text testID="process-virtual-memory" accessibilityLabel={`App virtual memory size: ${virtualValue}`}
          style={styles.value}>{virtualValue}</Text>
        <Text style={styles.body}>Address space mapped or reserved by the app, including pages that are not resident in RAM.</Text>
        <Text style={styles.note}>Can be much larger than device RAM. This is not physical memory use, free memory or a model-allocation total.</Text>
        {virtualError && <Text testID="process-virtual-memory-error" style={styles.note}>{virtualError}</Text>}
      </View>
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP VIRTUAL MEMORY AREAS · Android</Text>
        <Text testID="process-vmas" accessibilityLabel={`App virtual memory areas: ${vmasValue}`}
          style={styles.value}>{vmasValue}</Text>
        <Text style={styles.body}>Virtual memory areas listed in this process’s memory map.</Text>
        <Text style={styles.note}>Can rise or fall as mappings are created, split, merged or removed. Counts areas, not bytes, allocation calls or leaks.</Text>
        <Text style={styles.note}>The map can change during the scan. Android VMAs and iOS map entries use different OS accounting.</Text>
        {vmasError && <Text testID="process-vmas-error" style={styles.note}>{vmasError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP MEMORY REGIONS · iOS</Text>
        <Text testID="process-memory-regions" accessibilityLabel={`App memory regions: ${regionsValue}`}
          style={styles.value}>{regionsValue}</Text>
        <Text style={styles.body}>Entries in this process’s top-level virtual memory map.</Text>
        <Text style={styles.note}>Can rise or fall as mappings are created, split, merged or removed. Counts regions, not bytes, allocations or leaks.</Text>
        {regions?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects this app process on the Mac.</Text>}
        {regionsError && <Text testID="process-memory-regions-error" style={styles.note}>{regionsError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>PEAK VIRTUAL MEMORY · VmPeak</Text>
        <Text testID="process-peak-virtual-memory" accessibilityLabel={`Peak virtual memory: ${peakVirtualValue}`}
          style={styles.value}>{peakVirtualValue}</Text>
        <Text style={styles.body}>Largest virtual address-space size recorded by the OS for this app process.</Text>
        <Text style={styles.note}>Retains earlier reservation peaks after release, including between polls. Survives background/resume; a new process starts a new peak. This is not peak RAM use.</Text>
        {peakVirtualError && <Text testID="process-peak-virtual-memory-error" style={styles.note}>{peakVirtualError}</Text>}
      </View>}
      <View style={styles.additional}>
        <Text style={styles.label}>PEAK RSS SINCE PROCESS START</Text>
        <Text testID="process-peak-rss" accessibilityLabel={`Peak RSS since process start: ${peakValue}`} style={styles.value}>{peakValue}</Text>
        <Text style={styles.body}>Highest resident memory recorded by the OS.</Text>
        <Text style={styles.note}>Persists after release. Includes earlier activity in this process.</Text>
        {peakError && <Text testID="process-peak-rss-error" style={styles.note}>{peakError}</Text>}
      </View>
      <View style={styles.additional}>
        <Text style={styles.label}>{isAndroid ? "APP PROPORTIONAL MEMORY · PSS" : "APP PHYSICAL FOOTPRINT"}</Text>
        <Text testID={isAndroid ? "process-pss" : "process-physical-footprint"}
          accessibilityLabel={`App ${counterName}: ${counterValue}`} style={styles.value}>{counterValue}</Text>
        <Text style={styles.body}>{isAndroid
          ? "Private resident pages + a proportional share of shared pages."
          : "Memory charged to the app, including compressed memory."}</Text>
        {counterError && <Text style={styles.note}>{counterError}</Text>}
      </View>
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>PEAK PHYSICAL FOOTPRINT</Text>
        <Text testID="process-peak-physical-footprint" accessibilityLabel={`Peak physical footprint: ${peakFootprintValue}`}
          style={styles.value}>{peakFootprintValue}</Text>
        <Text style={styles.body}>Highest memory footprint charged to this app process by the OS, including compressed memory.</Text>
        <Text style={styles.note}>Retains earlier peaks after release, including between polls. Survives background/resume; a new process starts a new peak. Separate from peak RSS and virtual address space.</Text>
        {peakFootprint?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
        {peakFootprintError && <Text testID="process-peak-physical-footprint-error" style={styles.note}>{peakFootprintError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP PRIVATE DIRTY MEMORY</Text>
        <Text testID="process-private-dirty" accessibilityLabel={`App private dirty memory: ${privateDirtyValue}`}
          style={styles.value}>{privateDirtyValue}</Text>
        <Text style={styles.body}>Resident pages the OS classifies as private and modified.</Text>
        <Text style={styles.note}>Already included in RSS and PSS. Covers this process, not just model allocations.</Text>
        {privateDirtyError && <Text testID="process-private-dirty-error" style={styles.note}>{privateDirtyError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP PRIVATE CLEAN MEMORY</Text>
        <Text testID="process-private-clean" accessibilityLabel={`App private clean memory: ${privateCleanValue}`}
          style={styles.value}>{privateCleanValue}</Text>
        <Text style={styles.body}>Resident pages the OS classifies as private and clean.</Text>
        <Text style={styles.note}>Includes some mapped file pages. Already included in RSS and PSS.</Text>
        {privateCleanError && <Text testID="process-private-clean-error" style={styles.note}>{privateCleanError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP SHARED CLEAN MEMORY</Text>
        <Text testID="process-shared-clean" accessibilityLabel={`App shared clean memory: ${sharedCleanValue}`}
          style={styles.value}>{sharedCleanValue}</Text>
        <Text style={styles.body}>Resident pages the OS classifies as shared and clean.</Text>
        <Text style={styles.note}>Counts each mapping, including repeats within this app. Included fully in RSS; PSS apportions shared pages.</Text>
        {sharedCleanError && <Text testID="process-shared-clean-error" style={styles.note}>{sharedCleanError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP SHARED DIRTY MEMORY</Text>
        <Text testID="process-shared-dirty" accessibilityLabel={`App shared dirty memory: ${sharedDirtyValue}`}
          style={styles.value}>{sharedDirtyValue}</Text>
        <Text style={styles.body}>Resident pages the OS classifies as shared and modified.</Text>
        <Text style={styles.note}>Includes shared-memory pages. Counts repeated mappings too; already included fully in RSS and proportionally in PSS.</Text>
        {sharedDirtyError && <Text testID="process-shared-dirty-error" style={styles.note}>{sharedDirtyError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP LOCKED MEMORY · VmLck</Text>
        <Text testID="process-locked-memory" accessibilityLabel={`App locked memory: ${lockedValue}`}
          style={styles.value}>{lockedValue}</Text>
        <Text style={styles.body}>Memory ranges marked to keep their pages out of swap.</Text>
        <Text style={styles.note}>Deferred locking can include pages not yet resident. This is not extra memory to add to RSS, all pinned memory or the amount the app is allowed to lock. 1 KiB = 1,024 bytes.</Text>
        {lockedError && <Text testID="process-locked-memory-error" style={styles.note}>{lockedError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP PAGE-TABLE MEMORY · VmPTE</Text>
        <Text testID="process-page-table-memory" accessibilityLabel={`App page-table memory: ${pageTablesValue}`}
          style={styles.value}>{pageTablesValue}</Text>
        <Text style={styles.body}>Kernel memory used for the app’s page tables, which track virtual-to-physical address mappings.</Text>
        <Text style={styles.note}>Separate from RSS. This is OS page-table accounting, not all kernel overhead or the amount of app data. 1 KiB = 1,024 bytes.</Text>
        {pageTablesError && <Text testID="process-page-table-memory-error" style={styles.note}>{pageTablesError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP ANONYMOUS RESIDENT MEMORY</Text>
        <Text testID="process-anonymous-memory" accessibilityLabel={`App anonymous resident memory: ${anonymousValue}`}
          style={styles.value}>{anonymousValue}</Text>
        <Text style={styles.body}>Resident pages the OS classifies as anonymous, including heap and stack memory.</Text>
        <Text style={styles.note}>Also includes private copies of modified file pages. Already included in RSS; this is not a proportional share or a model-allocation total.</Text>
        {anonymousError && <Text testID="process-anonymous-memory-error" style={styles.note}>{anonymousError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP ANONYMOUS PSS</Text>
        <Text testID="process-anonymous-pss" accessibilityLabel={`App anonymous PSS: ${anonymousPssValue}`}
          style={styles.value}>{anonymousPssValue}</Text>
        <Text style={styles.body}>This process’s proportional share of resident anonymous memory, including heap, stack and private copies of modified file pages.</Text>
        <Text style={styles.note}>Shared pages are apportioned by their mappings. Already included in total PSS; separate from anonymous RSS, swapped memory and model-allocation totals.</Text>
        {anonymousPssError && <Text testID="process-anonymous-pss-error" style={styles.note}>{anonymousPssError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP FILE-BACKED PSS</Text>
        <Text testID="process-file-pss" accessibilityLabel={`App file-backed PSS: ${filePssValue}`}
          style={styles.value}>{filePssValue}</Text>
        <Text style={styles.body}>This process’s proportional share of resident file pages, such as mapped libraries and model files.</Text>
        <Text style={styles.note}>Already included in total PSS. Excludes shared-memory pages and private copies of modified file pages. This is not file size, storage I/O or all model memory.</Text>
        {filePssError && <Text testID="process-file-pss-error" style={styles.note}>{filePssError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP SHARED-MEMORY PSS</Text>
        <Text testID="process-shmem-pss" accessibilityLabel={`App shared-memory PSS: ${shmemPssValue}`}
          style={styles.value}>{shmemPssValue}</Text>
        <Text style={styles.body}>This process’s proportional share of resident pages in the OS’s shmem category, such as Android shared-memory regions.</Text>
        <Text style={styles.note}>Already included in total PSS. This is a backing-memory category, not every page shared between processes. Shared file pages remain file-backed; shared anonymous pages remain anonymous.</Text>
        {shmemPssError && <Text testID="process-shmem-pss-error" style={styles.note}>{shmemPssError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP DIRTY-PAGE PSS</Text>
        <Text testID="process-dirty-pss" accessibilityLabel={`App dirty-page PSS: ${dirtyPssValue}`}
          style={styles.value}>{dirtyPssValue}</Text>
        <Text style={styles.body}>The portion of this process’s PSS that the OS accounts as dirty resident pages, with shared pages apportioned.</Text>
        <Text style={styles.note}>Already included in total PSS and overlaps the anonymous, file and shmem categories. This is a current memory value, not bytes written, write speed or pending disk writes.</Text>
        {dirtyPssError && <Text testID="process-dirty-pss-error" style={styles.note}>{dirtyPssError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP CLEAN-PAGE PSS · CALCULATED</Text>
        <Text testID="process-clean-pss" accessibilityLabel={`App calculated clean-page PSS: ${cleanPssValue}`}
          style={styles.value}>{cleanPssValue}</Text>
        <Text style={styles.body}>Calculated as total PSS minus dirty-page PSS from the same memory sample. Shared pages are apportioned.</Text>
        <Text style={styles.note}>Already included in total PSS. This is not free memory, file size or a guarantee that these pages can be reclaimed immediately. The result retains the inputs’ OS rounding.</Text>
        {cleanPssError && <Text testID="process-clean-pss-error" style={styles.note}>{cleanPssError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP REFERENCED RESIDENT MEMORY</Text>
        <Text testID="process-referenced-memory" accessibilityLabel={`App referenced resident memory: ${referencedValue}`}
          style={styles.value}>{referencedValue}</Text>
        <Text style={styles.body}>Resident memory the kernel currently marks as referenced or accessed.</Text>
        <Text style={styles.note}>Already included in RSS; shared pages are not apportioned. The OS manages these markers. This is not bytes accessed since the last poll or a working-set measurement over a fixed interval.</Text>
        {referencedError && <Text testID="process-referenced-memory-error" style={styles.note}>{referencedError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP ANONYMOUS HUGE PAGES · AnonHugePages</Text>
        <Text testID="process-anon-huge-pages" accessibilityLabel={`App anonymous huge pages: ${anonHugePagesValue}`}
          style={styles.value}>{anonHugePagesValue}</Text>
        <Text style={styles.body}>Anonymous resident memory using transparent huge-page mappings at the PMD page-table level.</Text>
        <Text style={styles.note}>Already included in RSS; shared pages are not apportioned. This does not cover smaller transparent huge pages, file-backed huge pages or explicit HugeTLB allocations.</Text>
        <Text style={styles.note}>Zero means none reported in this category, not that the device lacks huge-page support. This is not a performance score.</Text>
        {anonHugePagesError && <Text testID="process-anon-huge-pages-error" style={styles.note}>{anonHugePagesError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP FILE HUGE PAGES · FilePmdMapped</Text>
        <Text testID="process-file-pmd-mapped" accessibilityLabel={`App file huge pages: ${filePmdMappedValue}`}
          style={styles.value}>{filePmdMappedValue}</Text>
        <Text style={styles.body}>File-backed resident memory using transparent huge-page mappings at the PMD page-table level.</Text>
        <Text style={styles.note}>Already included in RSS; shared pages are not apportioned. Excludes shared-memory/tmpfs, anonymous memory, smaller transparent huge pages and explicit HugeTLB allocations.</Text>
        <Text style={styles.note}>This measures mapped memory, not file size, the whole page cache or a performance gain. Zero does not establish lack of device support.</Text>
        {filePmdMappedError && <Text testID="process-file-pmd-mapped-error" style={styles.note}>{filePmdMappedError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP SHARED-MEMORY HUGE PAGES · ShmemPmdMapped</Text>
        <Text testID="process-shmem-pmd-mapped" accessibilityLabel={`App shared-memory huge pages: ${shmemPmdMappedValue}`}
          style={styles.value}>{shmemPmdMappedValue}</Text>
        <Text style={styles.body}>Shared-memory and tmpfs resident bytes using transparent huge-page mappings at the PMD page-table level.</Text>
        <Text style={styles.note}>Already included in RSS; shared pages are not apportioned. Mapping the same object twice can count it twice.</Text>
        <Text style={styles.note}>Excludes ordinary file-backed and private anonymous huge pages. This is not total shared-memory size, smaller huge-page usage or a performance score.</Text>
        {shmemPmdMappedError && <Text testID="process-shmem-pmd-mapped-error" style={styles.note}>{shmemPmdMappedError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP PRIVATE HUGETLB MEMORY · Private_Hugetlb</Text>
        <Text testID="process-private-hugetlb" accessibilityLabel={`App private HugeTLB memory: ${privateHugetlbValue}`}
          style={styles.value}>{privateHugetlbValue}</Text>
        <Text style={styles.body}>Explicit HugeTLB-backed memory that the kernel accounts as private to this app.</Text>
        <Text style={styles.note}>Excluded from Linux smaps RSS, PSS and private clean/dirty counters. Separate from transparent huge pages and shared HugeTLB memory.</Text>
        <Text style={styles.note}>This is mapped memory, not reserved pool capacity. Zero means none reported; it does not prove HugeTLB allocation is supported.</Text>
        {privateHugetlbError && <Text testID="process-private-hugetlb-error" style={styles.note}>{privateHugetlbError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP SHARED HUGETLB MEMORY · Shared_Hugetlb</Text>
        <Text testID="process-shared-hugetlb" accessibilityLabel={`App shared HugeTLB memory: ${sharedHugetlbValue}`}
          style={styles.value}>{sharedHugetlbValue}</Text>
        <Text style={styles.body}>Explicit HugeTLB-backed memory that the kernel accounts as shared in this app’s mappings.</Text>
        <Text style={styles.note}>Shared pages are not apportioned. Excluded from Linux smaps RSS, PSS and shared clean/dirty counters. Separate from transparent huge pages and private HugeTLB memory.</Text>
        <Text style={styles.note}>This is mapped memory, not reserved pool capacity or unique device-wide usage. Zero does not prove HugeTLB allocation is supported.</Text>
        {sharedHugetlbError && <Text testID="process-shared-hugetlb-error" style={styles.note}>{sharedHugetlbError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP MERGED MEMORY · KSM</Text>
        <Text testID="process-ksm" accessibilityLabel={`App KSM memory: ${ksmValue}`} style={styles.value}>{ksmValue}</Text>
        <Text style={styles.body}>Resident memory backed by pages deduplicated through Kernel Samepage Merging.</Text>
        <Text style={styles.note}>Already included in RSS; not apportioned and not bytes saved. Excludes KSM zero pages. Zero does not establish whether merging is supported or enabled.</Text>
        {ksmError && <Text style={styles.note}>{ksmError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP LOCKED RESIDENT MEMORY · smaps Locked</Text>
        <Text testID="process-lockedResident" accessibilityLabel={`App locked resident memory: ${lockedResidentValue}`} style={styles.value}>{lockedResidentValue}</Text>
        <Text style={styles.body}>The proportional resident-memory share accounted to locked mappings.</Text>
        <Text style={styles.note}>Already included in PSS. Unlike VmLck, this does not count untouched pages in ranges marked for deferred locking. Not all pinned memory or remaining lock allowance.</Text>
        {lockedResidentError && <Text style={styles.note}>{lockedResidentError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP LAZILY FREEABLE MEMORY · LazyFree</Text>
        <Text testID="process-lazy-free-memory" accessibilityLabel={`App lazily freeable memory: ${lazyFreeValue}`}
          style={styles.value}>{lazyFreeValue}</Text>
        <Text style={styles.body}>Memory marked for lazy reclamation, still resident until the OS reclaims it.</Text>
        <Text style={styles.note}>Already included in RSS. This is not free RAM or all reclaimable memory. Writing a marked page cancels its pending reclamation.</Text>
        <Text style={styles.note}>The kernel may underreport this value because of accounting optimizations.</Text>
        {lazyFreeError && <Text testID="process-lazy-free-memory-error" style={styles.note}>{lazyFreeError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP SWAPPED MEMORY · Swap</Text>
        <Text testID="process-swapped-memory" accessibilityLabel={`App swapped memory: ${swapValue}`}
          style={styles.value}>{swapValue}</Text>
        <Text style={styles.body}>Memory accounted to swap, without dividing shared pages proportionally.</Text>
        <Text style={styles.note}>Includes swapped pages in mapped shared-memory objects that SwapPss excludes. Separate from resident memory; do not add it to SwapPss.</Text>
        <Text style={styles.note}>Not compressed storage size, disk usage or swap read/write activity.</Text>
        {swapError && <Text testID="process-swapped-memory-error" style={styles.note}>{swapError}</Text>}
      </View>}
      {isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP PROPORTIONAL SWAP · SwapPss</Text>
        <Text testID="process-swap-pss" accessibilityLabel={`App proportional swap: ${swapPssValue}`}
          style={styles.value}>{swapPssValue}</Text>
        <Text style={styles.body}>The app’s proportional share of memory accounted to swap.</Text>
        <Text style={styles.note}>Separate from resident memory. Does not measure compressed storage size or read/write activity.</Text>
        <Text style={styles.note}>Excludes swapped pages in underlying shared-memory objects.</Text>
        {swapPssError && <Text testID="process-swap-pss-error" style={styles.note}>{swapPssError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP INTERNAL MEMORY · iOS</Text>
        <Text testID="process-internal-memory" accessibilityLabel={`App internal memory: ${internalValue}`}
          style={styles.value}>{internalValue}</Text>
        <Text style={styles.body}>Memory in the OS's internal accounting category, including resident anonymous allocations such as heap and stack pages.</Text>
        <Text style={styles.note}>Compressed and reusable pages have separate accounting. This is not total RSS, physical footprint or a count of live heap objects.</Text>
        {internal?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
        {internalError && <Text testID="process-internal-memory-error" style={styles.note}>{internalError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>PEAK INTERNAL MEMORY · iOS</Text>
        <Text testID="process-peak-internal-memory" accessibilityLabel={`Peak internal memory: ${peakInternalValue}`} style={styles.value}>{peakInternalValue}</Text>
        <Text style={styles.body}>Highest internal-memory accounting reported by the OS during this app process’s lifetime.</Text>
        <Text style={styles.note}>Retains earlier peaks after memory is released, including peaks between polls. Compressed and reusable pages have separate accounting. This is not peak RSS, physical footprint or a total of all allocations. A new process starts a new lifetime.</Text>
        {peakInternal?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
        {peakInternalError && <Text testID="process-peak-internal-memory-error" style={styles.note}>{peakInternalError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP EXTERNAL MEMORY · iOS</Text>
        <Text testID="process-external-memory" accessibilityLabel={`App external memory: ${externalValue}`}
          style={styles.value}>{externalValue}</Text>
        <Text style={styles.body}>Memory in the OS's external accounting category, including resident file-backed pages such as mapped files and executable code.</Text>
        <Text style={styles.note}>Not external storage, file sizes or bytes read from disk. Private copies made by writing a file mapping can move into internal accounting. Shared pages are not proportionally divided.</Text>
        {external?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
        {externalError && <Text testID="process-external-memory-error" style={styles.note}>{externalError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>PEAK EXTERNAL MEMORY · iOS</Text>
        <Text testID="process-peak-external-memory" accessibilityLabel={`Peak external memory: ${peakExternalValue}`} style={styles.value}>{peakExternalValue}</Text>
        <Text style={styles.body}>Highest external-memory accounting reported by the OS during this app process’s lifetime.</Text>
        <Text style={styles.note}>Retains earlier peaks after memory is released, including peaks between polls. Includes resident file-backed mappings such as code and mapped files. This is not disk usage or peak RSS. Peaks from separate categories must not be added together. A new process starts a new lifetime.</Text>
        {peakExternal?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
        {peakExternalError && <Text testID="process-peak-external-memory-error" style={styles.note}>{peakExternalError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP REUSABLE MEMORY</Text>
        <Text testID="process-reusable-memory" accessibilityLabel={`App reusable memory: ${reusableValue}`}
          style={styles.value}>{reusableValue}</Text>
        <Text style={styles.body}>Memory the OS accounts as reusable after the app or its allocator makes the contents discardable.</Text>
        <Text style={styles.note}>A current accounting value, not free RAM, heap free space or memory headroom. Reusable contents may be discarded. Separate from purgeable-memory accounting.</Text>
        {reusable?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
        {reusableError && <Text testID="process-reusable-memory-error" style={styles.note}>{reusableError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>PEAK REUSABLE MEMORY · iOS</Text>
        <Text testID="process-peak-reusable-memory" accessibilityLabel={`Peak reusable memory: ${peakReusableValue}`} style={styles.value}>{peakReusableValue}</Text>
        <Text style={styles.body}>Highest reusable-memory accounting reported by the OS during this app process’s lifetime.</Text>
        <Text style={styles.note}>Retains the earlier peak after pages are reused or released. This is not current free RAM, allocation headroom or a total of every byte ever made reusable. A new process starts a new lifetime.</Text>
        {peakReusable?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
        {peakReusableError && <Text testID="process-peak-reusable-memory-error" style={styles.note}>{peakReusableError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>METAL RESOURCE ALLOCATION · iOS</Text>
        <Text testID="process-metal-allocation-memory" accessibilityLabel={`Metal resource allocation: ${metalAllocationValue}`} style={styles.value}>{metalAllocationValue}</Text>
        <Text style={styles.body}>Memory allocated for Metal resources, reported by this app’s default GPU device.</Text>
        <Text style={styles.note}>Allocation can rise before pages become resident. This is not total device GPU memory or an extra amount to add to RSS or physical footprint.</Text>
        {metalAllocation?.deviceName && <Text style={styles.note}>{metalAllocation.deviceName}</Text>}
        {metalAllocation?.environment === "simulator" && <Text style={styles.note}>Simulator reading · may remain zero despite successful allocations.</Text>}
        {metalAllocationError && <Text testID="process-metal-allocation-memory-error" style={styles.note}>{metalAllocationError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>METAL RECOMMENDED WORKING SET · iOS</Text>
        <Text testID="process-metal-working-set" accessibilityLabel={`Metal recommended working-set size: ${metalWorkingSetValue}`} style={styles.value}>{metalWorkingSetValue}</Text>
        <Text style={styles.body}>Approximate resource-and-heap memory threshold recommended for good GPU performance.</Text>
        <Text style={styles.note}>An advisory threshold, not free memory, remaining headroom or a hard allocation limit. Subtracting current allocation does not give guaranteed available memory.</Text>
        {metalWorkingSet?.deviceName && <Text style={styles.note}>{metalWorkingSet.deviceName}</Text>}
        {metalWorkingSet?.environment === "simulator" && <Text style={styles.note}>Simulator recommendation · does not describe a physical iPhone’s memory budget.</Text>}
        {metalWorkingSetError && <Text testID="process-metal-working-set-error" style={styles.note}>{metalWorkingSetError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>GRAPHICS FOOTPRINT MEMORY · iOS</Text>
        <Text testID="process-graphics-footprint-memory" accessibilityLabel={`Graphics footprint memory: ${graphicsFootprintValue}`} style={styles.value}>{graphicsFootprintValue}</Text>
        <Text style={styles.body}>Uncompressed graphics-tagged memory charged to this app’s physical footprint.</Text>
        <Text style={styles.note}>Coverage depends on OS tagging and ownership. Compressed graphics and charges excluded from footprint are separate. This is a component of footprint, not total GPU memory; do not add it to the footprint total.</Text>
        {graphicsFootprint?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
        {graphicsFootprintError && <Text testID="process-graphics-footprint-memory-error" style={styles.note}>{graphicsFootprintError}</Text>}
        <Pressable accessibilityRole="button" accessibilityLabel={reading?.graphicsCheck?.running ? "Stop graphics memory check" : "Run graphics memory check"}
          testID="graphics-memory-check" disabled={!active || pendingAction || workloadRunning}
          onPress={() => void perform.current(reading?.graphicsCheck?.running ? "release" : "graphicsCheck")}
          style={({ pressed }) => [styles.button, (pressed || !active || pendingAction || workloadRunning) && styles.dim]}>
          <Text style={styles.buttonText}>{reading?.graphicsCheck?.running ? "Stop graphics memory check" : "Run graphics memory check"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={reading?.graphicsCheck?.running ? "Stop graphics memory check" : "Run Metal buffer check"}
          testID="metal-memory-check" disabled={!active || pendingAction || workloadRunning}
          onPress={() => void perform.current(reading?.graphicsCheck?.running ? "release" : "metalCheck")}
          style={({ pressed }) => [styles.button, (pressed || !active || pendingAction || workloadRunning) && styles.dim]}>
          <Text style={styles.buttonText}>{reading?.graphicsCheck?.running ? "Stop graphics memory check" : "Run Metal buffer check"}</Text>
        </Pressable>
        <Text style={styles.note} testID="graphics-memory-check-status">{reading?.graphicsCheck?.error ?? reading?.graphicsCheck?.stage ?? "idle"} · {reading?.graphicsCheck?.allocationKind === "metal_shared_buffer" ? "Metal shared buffer" : "IOSurface"}. Each check holds 16 MiB for ten seconds and releases on completion or backgrounding. The OS decides which ledger receives the charge.</Text>
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>NONVOLATILE PURGEABLE MEMORY · iOS</Text>
        <Text testID="process-purgeable-nonvolatile-memory" accessibilityLabel={`Nonvolatile purgeable memory: ${purgeableNonvolatileValue}`} style={styles.value}>{purgeableNonvolatileValue}</Text>
        <Text style={styles.body}>Resident bytes charged to the app’s nonvolatile purgeable-memory ledger. These contents are protected from being discarded as purgeable data.</Text>
        <Text style={styles.note}>Compressed pages are counted separately. Wired purgeable pages stay in this category even when their object is marked volatile. This is not free RAM, permanent storage or all cache memory.</Text>
        {purgeableNonvolatile?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
        {purgeableNonvolatileError && <Text testID="process-purgeable-nonvolatile-memory-error" style={styles.note}>{purgeableNonvolatileError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>COMPRESSED NONVOLATILE PURGEABLE MEMORY · iOS</Text>
        <Text testID="process-purgeable-nonvolatile-compressed-memory" accessibilityLabel={`Compressed nonvolatile purgeable memory: ${purgeableNonvolatileCompressedValue}`} style={styles.value}>{purgeableNonvolatileCompressedValue}</Text>
        <Text style={styles.body}>Nonvolatile purgeable pages held in compressed form, charged to the app in their original page bytes.</Text>
        <Text style={styles.note}>This is their size before compression, not the compressor’s storage size or a compression ratio. Resident and volatile purgeable pages have separate accounting. Zero is valid; iOS decides when to compress or restore pages.</Text>
        {purgeableNonvolatileCompressed?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
        {purgeableNonvolatileCompressedError && <Text testID="process-purgeable-nonvolatile-compressed-memory-error" style={styles.note}>{purgeableNonvolatileCompressedError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>VOLATILE PURGEABLE MEMORY · iOS</Text>
        <Text testID="process-purgeable-volatile-memory" accessibilityLabel={`Volatile purgeable memory: ${purgeableVolatileValue}`} style={styles.value}>{purgeableVolatileValue}</Text>
        <Text style={styles.body}>Resident bytes charged to the app’s volatile purgeable-memory ledger. Their contents are eligible for discard and may disappear between readings.</Text>
        <Text style={styles.note}>Compressed pages use a separate ledger. Wired pages remain in nonvolatile accounting. A zero reading is valid. This is not free RAM, all cache memory or a count of bytes already discarded.</Text>
        {purgeableVolatile?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
        {purgeableVolatileError && <Text testID="process-purgeable-volatile-memory-error" style={styles.note}>{purgeableVolatileError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>COMPRESSED VOLATILE PURGEABLE MEMORY · iOS</Text>
        <Text testID="process-purgeable-volatile-compressed-memory" accessibilityLabel={`Compressed volatile purgeable memory: ${purgeableVolatileCompressedValue}`} style={styles.value}>{purgeableVolatileCompressedValue}</Text>
        <Text style={styles.body}>Volatile purgeable pages held in compressed form, charged to the app in their original page bytes. Their contents remain eligible for discard.</Text>
        <Text style={styles.note}>This is their size before compression, not compressed storage size or bytes already discarded. Resident and nonvolatile purgeable pages use separate accounting. Zero is valid; these contents may disappear between readings.</Text>
        {purgeableVolatileCompressed?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
        {purgeableVolatileCompressedError && <Text testID="process-purgeable-volatile-compressed-memory-error" style={styles.note}>{purgeableVolatileCompressedError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP COMPRESSED MEMORY · iOS</Text>
        <Text testID="process-compressed-memory" accessibilityLabel={`App compressed memory: ${compressedValue}`}
          style={styles.value}>{compressedValue}</Text>
        <Text style={styles.body}>App memory held by the OS compressor, measured at its original page size.</Text>
        <Text style={styles.note}>This is the size before compression. The OS decides when to compress or restore pages.</Text>
        {compressed?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
        {compressedError && <Text testID="process-compressed-memory-error" style={styles.note}>{compressedError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>PEAK COMPRESSED MEMORY · iOS</Text>
        <Text testID="process-peak-compressed-memory" accessibilityLabel={`Peak compressed memory: ${peakCompressedValue}`} style={styles.value}>{peakCompressedValue}</Text>
        <Text style={styles.body}>Highest compressed-memory accounting reported by the OS during this app process’s lifetime.</Text>
        <Text style={styles.note}>Measured in original page bytes, not compressed storage size or cumulative compression traffic. The peak can remain after current compressed memory falls; a new app process starts a new lifetime.</Text>
        {peakCompressed?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
        {peakCompressedError && <Text testID="process-peak-compressed-memory-error" style={styles.note}>{peakCompressedError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>CUMULATIVE COMPRESSION · iOS</Text>
        <Text testID="process-cumulative-compressed-memory" accessibilityLabel={`Cumulative compression: ${cumulativeCompressedValue}`} style={styles.value}>{cumulativeCompressedValue}</Text>
        <Text style={styles.body}>Original page bytes cumulatively charged to this process’s compressed-memory accounting.</Text>
        <Text style={styles.note}>Does not decrease when pages are restored or released. Compressing the same pages again can count them again. This is not unique memory, compressed storage size or compression CPU time. A new process starts a new lifetime.</Text>
        {cumulativeCompressed?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
        {cumulativeCompressedError && <Text testID="process-cumulative-compressed-memory-error" style={styles.note}>{cumulativeCompressedError}</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>COMPRESSION ACCOUNTING RATE · iOS</Text>
        <Text testID="process-compression-rate" accessibilityLabel={`Compression accounting rate: ${compressionRateValue}`} style={styles.value}>
          {compressionRateValue}
        </Text>
        <Text style={styles.body}>Original page bytes newly charged to compressed-memory accounting per second, averaged over this interval.</Text>
        <Text testID="process-compression-window" style={styles.note}>{!active ? "Sampling resumes with a fresh interval when the app is active." : compressionRateError ?? (compressionRate?.rate
          ? `${compressionRate.rate.deltaBytes.toLocaleString()} bytes / ${(compressionRate.rate.elapsedMs / 1000).toFixed(2)} s · samples ${compressionRate.rate.fromSequence}–${compressionRate.rate.toSequence}`
          : compressionRate?.reason ?? "Waiting for two valid consecutive readings.")}</Text>
        <Text style={styles.note}>Derived from the cumulative counter using actual query times. Repeated compression can count the same pages again. This measures accounting activity, not compression CPU cost, bytes saved or compressed output speed. Gaps over 5 seconds start a fresh interval.</Text>
        {reading?.cumulativeCompressed?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP DECOMPRESSION ACTIVITY · iOS</Text>
        <Text testID="process-decompression-rate" accessibilityLabel={`App decompressions: ${decompressionValue}`}
          style={[styles.value, decompressions?.saturated && { fontSize: 23 }]}>{decompressionValue}</Text>
        <Text style={styles.body}>Page decompression events across the app’s threads.</Text>
        <Text testID="process-decompression-total" style={styles.note}>{decompressions?.count != null
          ? `${decompressions.saturated ? "At least " : ""}${decompressions.count.toLocaleString()} events · OS cumulative count`
          : "Waiting for a native counter."}</Text>
        <Text style={styles.note}>Repeated decompression of a page counts again. This does not measure bytes or time spent waiting.</Text>
        <Text testID="process-decompression-window" style={styles.note}>{decompressionError ?? (!active
          ? "Sampling resumes when the app is active." : decompressions?.saturated
            ? "The OS counter has reached its limit. A rate can no longer be calculated."
            : decompressionRate ? `${decompressionRate.delta.toLocaleString()} events / ${(decompressionRate.elapsedMs / 1000).toFixed(2)} s`
              : "Waiting for two consecutive foreground readings.")}</Text>
        {decompressions?.environment === "simulator" && <Text style={styles.note}>Simulator reading · reflects memory management on this Mac.</Text>}
      </View>}
      {!isAndroid && <View style={styles.additional}>
        <Text style={styles.label}>APP MEMORY HEADROOM · iOS</Text>
        <Text testID="process-memory-headroom" accessibilityLabel={`App memory headroom: ${headroomValue}`}
          style={[styles.value, headroom?.bytes === 0 && { fontSize: 23 }]}>{headroomValue}</Text>
        <Text style={styles.body}>OS estimate of memory remaining before the app’s current limit.</Text>
        <Text style={styles.note}>The allowance can change. This is not a guarantee that an allocation will succeed.</Text>
        {headroom?.environment === "simulator" && <Text style={styles.note}>Simulator reading · does not establish a physical iPhone’s memory allowance.</Text>}
        {headroom?.bytes === 0 && <Text style={styles.note}>Zero can mean the app limit is exceeded or no app budget is supplied. This API does not distinguish the cause.</Text>}
        {headroomError && <Text style={styles.note}>{headroomError}</Text>}
      </View>}
      <Text style={styles.note}>Current process memory · 1 MiB = 1,048,576 bytes</Text>
      <Text style={styles.note} testID="process-rss-time">
        {error ?? (reading ? `Read at ${new Date(reading.sampledAtMs).toLocaleTimeString([], { hour12: false })} · refreshes every 2 seconds` : "Waiting for the native collector.")}
      </Text>
      {!isAndroid && <>
        <Pressable accessibilityRole="button" accessibilityLabel={purgeableRunning ? "Stop purgeable memory check" : "Run purgeable memory check"}
          testID="purgeable-memory-check" disabled={!active || pendingAction || workloadRunning}
          onPress={() => void perform.current(purgeableRunning ? "release" : "purgeableCheck")}
          style={({ pressed }) => [styles.button, (pressed || !active || pendingAction || workloadRunning) && styles.dim]}>
          <Text style={styles.buttonText}>{purgeableRunning ? "Stop purgeable memory check" : "Run purgeable memory check"}</Text>
        </Pressable>
        <Text style={styles.note} testID="purgeable-memory-check-status">{reading?.purgeableCheck?.error ?? reading?.purgeableCheck?.stage ?? "idle"} · Uses 16 MiB for about 31 seconds. Releases on completion or backgrounding. Compression may not occur.</Text>
      </>}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={error ? "Release memory check and retry reading" : holding ? "Release memory check" : "Hold 64 MiB memory check"}
        testID="memory-check"
        disabled={disabled}
        onPress={() => void perform.current(error || holding ? "release" : "hold")}
        style={({ pressed }) => [styles.button, (pressed || disabled) && styles.dim]}
      >
        <Text style={styles.buttonText}>{pendingAction ? "Working…" : error ? "Release / retry" : holding ? "Release memory check" : isAndroid ? "Hold 64 MiB dirty pages" : "Hold 64 MiB to check"}</Text>
      </Pressable>
      {isAndroid && !holding && <Pressable
        accessibilityRole="button"
        accessibilityLabel="Hold 64 MiB clean file pages"
        testID="memory-clean-check"
        disabled={cleanDisabled}
        onPress={() => void perform.current("holdClean")}
        style={({ pressed }) => [styles.button, (pressed || cleanDisabled) && styles.dim]}
      >
        <Text style={styles.buttonText}>{pendingAction ? "Working…" : "Hold 64 MiB clean file pages"}</Text>
      </Pressable>}
      {isAndroid && !holding && <Pressable
        accessibilityRole="button" accessibilityLabel="Map one 64 MiB clean file twice"
        testID="memory-shared-clean-check" disabled={cleanDisabled}
        onPress={() => void perform.current("holdSharedClean")}
        style={({ pressed }) => [styles.button, (pressed || cleanDisabled) && styles.dim]}
      >
        <Text style={styles.buttonText}>{pendingAction ? "Working…" : "Map 64 MiB clean file twice"}</Text>
      </Pressable>}
      {isAndroid && !holding && <Pressable
        accessibilityRole="button" accessibilityLabel="Map and write one 64 MiB shared region twice"
        testID="memory-shared-dirty-check" disabled={cleanDisabled || (reading?.apiLevel ?? 0) < 26}
        onPress={() => void perform.current("holdSharedDirty")}
        style={({ pressed }) => [styles.button, (pressed || cleanDisabled || (reading?.apiLevel ?? 0) < 26) && styles.dim]}
      >
        <Text style={styles.buttonText}>{pendingAction ? "Working…" : "Map 64 MiB dirty region twice"}</Text>
      </Pressable>}
      {isAndroid && (reading?.apiLevel ?? 26) < 26 && <Text style={styles.note}>Shared dirty check requires Android 8 / API 26. The metric can still be read.</Text>}
      {isAndroid && (reading?.heldKind === "file_clean_twice" || reading?.heldKind === "shared_dirty_twice") && <Pressable
        accessibilityRole="button" accessibilityLabel="Remove second memory mapping"
        testID="memory-remove-second-mapping" disabled={cleanDisabled}
        onPress={() => void perform.current("releaseSecondMapping")}
        style={({ pressed }) => [styles.button, (pressed || cleanDisabled) && styles.dim]}
      >
        <Text style={styles.buttonText}>{pendingAction ? "Working…" : "Remove second mapping"}</Text>
      </Pressable>}
      {isAndroid && <Text style={styles.note}>Clean check: creates a temporary file, syncs it, then reads and holds its mapped pages. Mapping twice uses the same file pages.</Text>}
      {isAndroid && <Text style={styles.note}>Shared dirty check: maps one shared-memory region twice, writes through one mapping and verifies through the other.</Text>}
      <Text style={styles.note} testID="memory-check-status">
        {!reading ? "Allocation state unavailable. " : holding ? (reading?.heldKind === "shared_dirty_twice" ? "One 64 MiB shared region held in two mappings (128 MiB mapped). " : reading?.heldKind === "shared_dirty_once" ? "One 64 MiB shared region held in one mapping. " : reading?.heldKind === "file_clean_twice" ? "One 64 MiB file held in two mappings (128 MiB mapped). " : reading?.heldKind === "file_clean" ? "64 MiB file mapping held. " : "64 MiB test allocation held. ") : "No test allocation held. "}
        Automatically releases after 60 seconds or when backgrounded.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#e8ecec", borderRadius: 20, padding: 20, marginTop: 12 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2, color: "#496359" },
  value: { fontSize: 38, fontWeight: "600", letterSpacing: -1, color: "#143f32", marginVertical: 10 },
  additional: { borderTopWidth: 1, borderTopColor: "#cbd7d2", marginTop: 16, paddingTop: 16, marginBottom: 10 },
  body: { fontSize: 13, lineHeight: 20, color: "#52665c" },
  note: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 6 },
  button: { borderWidth: 1, borderColor: "#86a698", borderRadius: 10, alignItems: "center", padding: 12, marginTop: 14 },
  buttonText: { fontSize: 13, fontWeight: "600", color: "#24533f" },
  dim: { opacity: 0.5 },
});
