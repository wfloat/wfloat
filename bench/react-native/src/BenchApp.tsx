import { useSignalsSource } from "./signalsSource";
import { useThreadSources } from "./threadSources";
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AppState, NativeModules, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import Dashboard from './App';
import { EnergyComparisonScreen } from './EnergyComparisonScreen';
import { MetricPublication } from './metricPublication';
import { MetricPublicationContext } from './useMetricState';
import { MODE_LABELS, OVERHEAD_ORDER, WARMUP_MS, WINDOW_MS, overheadSummary, overheadWindow, type OverheadMode, type OverheadWindow } from './overhead';
import { validateProcessCpuSample } from './processCpu';

const QuietDashboard = memo(Dashboard);
type Phase = { index: number; mode: OverheadMode; meter: MetricPublication; measuring: boolean };
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new Error('Check cancelled')); return; }
  const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Check cancelled')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort);
});

function OverheadCheck({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ReturnType<typeof overheadSummary> | null>(null);
  const [message, setMessage] = useState('Ready · approximately 4½ minutes');
  const control = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const phaseMounted = useRef<(() => void) | null>(null);
  const acknowledgeMount = useCallback(() => { phaseMounted.current?.(); phaseMounted.current = null; }, []);
  useEffect(() => {
    alive.current = true;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') control.current?.abort();
    });
    return () => { alive.current = false; control.current?.abort(); subscription.remove(); };
  }, []);

  async function run() {
    if (control.current || AppState.currentState !== 'active') return;
    const controller = new AbortController(); control.current = controller;
    const signal = controller.signal;
    const runId = `${Platform.OS}-${Date.now()}`;
    const windows: OverheadWindow[] = [];
    const ensureActive = () => {
      if (signal.aborted || !alive.current || AppState.currentState !== 'active') throw new Error('Check cancelled');
    };
    const log = async (event: object) => {
      await NativeModules.BenchProcessCpu.recordOverhead(JSON.stringify({ runId, ...event }));
    };
    try {
      setRunning(true); setResult(null); setMessage('Preparing comparison…');
      if (!NativeModules.BenchProcessCpu?.recordOverhead) throw new Error('Rebuild the app for the overhead check');
      await NativeModules.BenchProcessCpu.setOverheadActive(true);
      // Stop any diagnostic operation left by the previous dashboard before measuring.
      await Promise.all([
        NativeModules.BenchCpu?.stop?.(0),
        NativeModules.BenchMemory?.release?.(),
        NativeModules.BenchContextSwitches?.stopProbe?.(),
        NativeModules.BenchBattery?.stopRefreshProbe?.(),
      ]);
      ensureActive();
      await log({ event: 'begin', platform: Platform.OS, debug: __DEV__, order: OVERHEAD_ORDER,
        warmupMs: WARMUP_MS, windowMs: WINDOW_MS, workload: 'idle', viewport: 'dashboard-top',
        baseline: 'dashboard unmounted; native lifetime observers remain', logging: 'existing native logs retained' });
      for (const [index, mode] of OVERHEAD_ORDER.entries()) {
        ensureActive();
        const meter = new MetricPublication();
        // Wait for React to commit the new subtree before timing the warmup.
        const committed = new Promise<void>(resolve => { phaseMounted.current = resolve; });
        setPhase({ index, mode, meter, measuring: false });
        await Promise.race([committed, delay(5000, signal).then(() => { throw new Error('Dashboard mount timed out'); })]);
        await delay(WARMUP_MS - 1000, signal);
        meter.publish = mode !== 'collect';
        setPhase(previous => previous && { ...previous, measuring: true });
        // Drain display work queued before freezing; keep the measured interval quiet.
        await delay(1000, signal);
        ensureActive();
        meter.reset(); meter.recording = true;
        const start = validateProcessCpuSample(await NativeModules.BenchProcessCpu.read());
        await delay(WINDOW_MS, signal);
        const end = validateProcessCpuSample(await NativeModules.BenchProcessCpu.read());
        ensureActive(); meter.recording = false;
        const row = overheadWindow(index, mode, start, end, meter.snapshot());
        windows.push(row);
        // Emit only after the ending CPU sample. Each record fits a Logcat message.
        await log({ event: 'boundary', index, edge: 'start', sample: start });
        await log({ event: 'boundary', index, edge: 'end', sample: end });
        await log({ event: 'window', index, mode, percent: row.percent, userPercent: row.userPercent,
          systemPercent: row.systemPercent, cpuDeltaMs: row.cpuDeltaMs, elapsedMs: row.elapsedMs, activity: row.activity });
      }
      const summary = overheadSummary(windows);
      await log({ event: 'complete', ...summary });
      ensureActive(); setResult(summary); setMessage('Complete · three intervals per mode');
    } catch (cause) {
      const reason = signal.aborted ? 'Cancelled · incomplete comparison discarded' : String(cause);
      try { await log({ event: 'cancelled', reason, completedWindows: windows.length }); } catch { /* Original failure remains visible. */ }
      if (alive.current) { setResult(null); setMessage(reason); }
    } finally {
      controller.abort(); phaseMounted.current = null;
      try { await NativeModules.BenchProcessCpu.setOverheadActive(false); }
      catch (cause) { if (alive.current) setMessage(`Check ended; could not restore screen idle policy: ${String(cause)}`); }
      control.current = null;
      if (alive.current) { setPhase(null); setRunning(false); }
    }
  }

  return <SafeAreaView style={styles.safe}>
    <View style={styles.panel}>
      <Text style={styles.title}>Instrumentation CPU cost</Text>
      <Text testID="overhead-status" style={styles.body}>{phase
        ? `${phase.index + 1}/9 · ${MODE_LABELS[phase.mode]} · ${phase.measuring ? 'measuring 20 s' : 'settling 10 s'}` : message}</Text>
      <Text style={styles.note}>100% = one occupied core. Keep the app foregrounded and leave it untouched during the check.</Text>
      <View style={styles.buttons}>
        <Pressable accessibilityRole="button" accessibilityLabel={running ? 'Cancel overhead check' : 'Start overhead check'}
          testID="overhead-run" onPress={() => running ? control.current?.abort() : void run()} style={styles.button}>
          <Text style={styles.buttonText}>{running ? 'Cancel' : 'Start comparison'}</Text>
        </Pressable>
        {!running && <Pressable accessibilityRole="button" accessibilityLabel="Return to device readings" onPress={onClose} style={styles.secondary}>
          <Text style={styles.body}>Back</Text>
        </Pressable>}
      </View>
    </View>
    {phase ? <PhaseDashboard key={phase.index} phase={phase} onMount={acknowledgeMount} /> : <ScrollView contentContainerStyle={styles.results}>
      {result ? <>
        {result.modes.map(row => <View key={row.mode} style={styles.result}>
          <Text style={styles.body}>{MODE_LABELS[row.mode]}</Text>
          <Text style={styles.value}>{row.median.toFixed(2)}%</Text>
          <Text style={styles.note}>Range {row.min.toFixed(2)}–{row.max.toFixed(2)}%</Text>
        </View>)}
        <Text testID="overhead-deltas" style={styles.body}>
          Added collection cost: {result.collectionPoints.toFixed(2)} percentage points{'\n'}
          Added live display cost: {result.displayPoints.toFixed(2)} percentage points{'\n'}
          Combined: {result.combinedPoints.toFixed(2)} percentage points
        </Text>
        <Text style={styles.note}>Differences between medians; negative values indicate noise or drift, not CPU savings. Small differences within the observed ranges are unresolved.</Text>
      </> : <Text style={styles.body}>Compares a quiet screen, the existing collectors with their display frozen, and normal live updates. Each mode runs three times in a rotated order, after settling.</Text>}
      <Text style={styles.note}>Measures CPU charged to this app, including its logging and bridge work. Native lifetime observers remain in every mode. It excludes CPU used by other processes, total energy, and GPU/display power.</Text>
      <Text style={styles.note}>Local simulators establish the method. Use a release build on a physical device for device-specific conclusions.</Text>
    </ScrollView>}
  </SafeAreaView>;
}

function PhaseDashboard({ phase, onMount }: { phase: Phase; onMount: () => void }) {
  useThreadSources(phase.mode !== "paused");
  useSignalsSource(phase.mode !== "paused");
  useEffect(onMount, [onMount]);
  return <View style={{ flex: 1 }} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {phase.mode === 'paused' ? <View style={styles.results}><Text style={styles.body}>Dashboard polling paused</Text></View>
      : <MetricPublicationContext.Provider value={phase.meter}><QuietDashboard /></MetricPublicationContext.Provider>}
  </View>;
}

export default function BenchApp() {
  const [checking, setChecking] = useState<'overhead' | 'energy' | null>(null);
  useThreadSources(checking === null);
  useSignalsSource(checking === null);
  const open = useCallback(() => setChecking('overhead'), []);
  const energy = useCallback(() => setChecking('energy'), []);
  const close = useCallback(() => setChecking(null), []);
  return checking === 'overhead' ? <OverheadCheck onClose={close} />
    : checking === 'energy' ? <EnergyComparisonScreen onClose={close} />
    : <Dashboard onOpenOverhead={open} onOpenEnergy={energy} />;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f5f6f2' },
  panel: { padding: 20, borderBottomWidth: 1, borderBottomColor: '#cbd7d2' },
  title: { fontSize: 23, fontWeight: '700', color: '#143f32', marginBottom: 8 },
  body: { fontSize: 14, lineHeight: 21, color: '#24533f' },
  note: { fontSize: 12, lineHeight: 18, color: '#52665c', marginTop: 8 },
  buttons: { flexDirection: 'row', gap: 16, marginTop: 12, alignItems: 'center' },
  button: { backgroundColor: '#1c5141', padding: 12, borderRadius: 10 },
  buttonText: { color: 'white', fontSize: 14, fontWeight: '600' },
  secondary: { padding: 12 }, results: { padding: 20, gap: 16 },
  result: { padding: 16, borderRadius: 16, backgroundColor: '#e9eee8' },
  value: { fontSize: 30, fontWeight: '600', color: '#143f32', marginTop: 6 },
});
