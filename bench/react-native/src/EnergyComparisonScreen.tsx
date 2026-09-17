import { useEffect, useRef, useState } from 'react';
import { AppState, NativeModules, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { readCpuStress, stopCpuStress, type CpuStatus } from './cpu';
import { readThermalState } from './thermal';
import { ProcessCpuTracker, validateProcessCpuSample } from './processCpu';
import { energyReadNote, validateEnergyRead, type EnergyRead } from './powerMonitors';
import { ENERGY_SETTLE_MS, ENERGY_WINDOW_MS, compareEnergyWindows, energyWindow, type EnergyComparisonRow, type EnergyMode, type EnergyWindow } from './energyComparison';

declare const performance: { now(): number };

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Comparison cancelled')); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Comparison cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort);
  });
}
const reference = (r: EnergyRead) => ({ inventoryId: r.inventoryId, pid: r.pid, sequence: r.sequence });

export function EnergyComparisonScreen({ onClose }: { onClose: () => void }) {
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState('Ready · approximately 2½ minutes');
  const [result, setResult] = useState<EnergyComparisonRow[] | null>(null);
  const [cpuRates, setCpuRates] = useState<number[]>([]);
  const [emulated, setEmulated] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const control = useRef<AbortController | null>(null), alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const listener = AppState.addEventListener('change', state => { if (state !== 'active') control.current?.abort(); });
    return () => { alive.current = false; control.current?.abort(); void stopCpuStress().catch(() => {}); listener.remove(); };
  }, []);

  async function run() {
    if (control.current || AppState.currentState !== 'active') return;
    const controller = new AbortController(); control.current = controller;
    const signal = controller.signal, runId = `energy-${Date.now()}`;
    const windows: EnergyWindow[] = [], rates: number[] = [];
    let ownsCpu = false;
    const stopImmediately = () => { if (ownsCpu) void stopCpuStress().catch(() => {}); };
    signal.addEventListener('abort', stopImmediately);
    const drainCpu = async () => {
      if (!ownsCpu) return;
      await stopCpuStress();
      for (let attempt = 0; (await readCpuStress()).running; attempt++) {
        if (attempt >= 25) throw new Error('CPU workers are still stopping; relaunch before another check');
        await new Promise<void>(resolve => setTimeout(resolve, 200));
      }
      ownsCpu = false;
    };
    const ensureActive = () => {
      if (signal.aborted || !alive.current || AppState.currentState !== 'active') throw new Error('Comparison cancelled');
    };
    const log = async (event: object) => NativeModules.BenchPowerMonitors.recordComparison(JSON.stringify({ source: 'wfloat.energyComparison', runId, ...event }));
    const thermal = async () => {
      const t = await readThermalState(); ensureActive();
      if (t.availability !== 'available' || t.rawValue !== 0) throw new Error(`Thermal guard: ${t.state ?? 'unavailable'}`);
      return t;
    };
    const energy = async () => {
      const r = validateEnergyRead(await NativeModules.BenchPowerMonitors.readComparison()); ensureActive();
      if (r.status !== 'ready') throw new Error(energyReadNote(r));
      return r;
    };
    const cpuSample = async () => {
      const s = validateProcessCpuSample(await NativeModules.BenchProcessCpu.read()); ensureActive(); return s;
    };
    const guard = async (mode: EnergyMode) => {
      const t = await thermal(), cpu: CpuStatus = await readCpuStress(); ensureActive();
      if (mode === 'idle' ? cpu.running : !cpu.running || cpu.stopping || cpu.gpuEnabled)
        throw new Error(mode === 'idle' ? 'A workload appeared during idle' : `CPU workload ended early: ${cpu.reason}`);
      return { thermal: t, cpu };
    };
    const observeFor = async (ms: number, mode: EnergyMode) => {
      const end = performance.now() + ms;
      while (performance.now() < end) { await wait(Math.min(1000, end - performance.now()), signal); await guard(mode); }
    };
    try {
      setRunning(true); setResult(null); setCpuRates([]); setExpanded(false); setMessage('Preparing…');
      if (!NativeModules.BenchCpu?.startEnergyProbe || !NativeModules.BenchPowerMonitors?.readComparison)
        throw new Error('Rebuild the Android app for the energy comparison');
      // The dashboard is unmounted. Lifetime native observers remain in both phases.
      if ((await readCpuStress()).running) throw new Error('Stop the existing CPU workload first');
      await Promise.all([
        NativeModules.BenchMemory.release(), NativeModules.BenchContextSwitches.stopProbe(),
        NativeModules.BenchBattery.stopRefreshProbe(),
      ]);
      await NativeModules.BenchProcessCpu.setOverheadActive(true);
      const initialThermal = await thermal(); setEmulated(initialThermal.environment === 'emulator');
      const initial = await energy();
      await log({ event: 'begin', order: ['idle', 'cpu'], settleMs: ENERGY_SETTLE_MS, windowMs: ENERGY_WINDOW_MS,
        cpuNativeLimitMs: 120000, dashboard: 'unmounted', debug: __DEV__, environment: initialThermal.environment,
        preflight: reference(initial), scope: 'device_subsystems', note: 'Single ordered pair; no calibrated app attribution' });
      for (const mode of ['idle', 'cpu'] as const) {
        ensureActive();
        if (mode === 'cpu') { ownsCpu = true; await NativeModules.BenchCpu.startEnergyProbe(); ensureActive(); }
        const phaseStart = await cpuSample();
        await log({ event: 'phase', mode, startedUptimeMs: phaseStart.queryFinishedUptimeMs });
        setMessage(`${mode === 'idle' ? 'Idle' : 'CPU load'} · settling 35 s`);
        await observeFor(ENERGY_SETTLE_MS, mode);
        const before = await guard(mode);
        if (mode === 'cpu' && before.cpu.workers !== before.cpu.targetWorkers) throw new Error('CPU workers did not finish ramping');
        const start = await energy(), cpuStart = await cpuSample();
        setMessage(`${mode === 'idle' ? 'Idle' : 'CPU load'} · measuring 35 s`);
        await observeFor(ENERGY_WINDOW_MS, mode);
        const end = await energy(), cpuEnd = await cpuSample(), after = await guard(mode);
        if (mode === 'cpu' && (after.cpu.workers !== after.cpu.targetWorkers || after.cpu.blocks <= before.cpu.blocks))
          throw new Error('CPU work was not sustained through the interval');
        // Keep CPU running through all endpoint reads; cleanup below confirms it drained.
        if (mode === 'cpu') await drainCpu();
        const row = energyWindow(mode, start, end, phaseStart.queryFinishedUptimeMs + (mode === 'cpu' ? 20000 : 0));
        const tracker = new ProcessCpuTracker(); tracker.record(cpuStart); const usage = tracker.record(cpuEnd);
        if (!usage) throw new Error('Process CPU interval unavailable');
        windows.push(row); rates.push(usage.percent);
        await log({ event: 'boundary', mode, edge: 'start', energy: reference(start), cpu: cpuStart,
          thermal: before.thermal, workload: before.cpu, eligibleAfterUptimeMs: row.eligibleAfterUptimeMs });
        await log({ event: 'boundary', mode, edge: 'end', energy: reference(end), cpu: cpuEnd,
          thermal: after.thermal, workload: after.cpu });
        await log({ event: 'window', mode, cpuPercent: usage.percent, cpuElapsedMs: usage.elapsedMs,
          validMonitors: row.intervals.filter(m => m.reason === null).length });
      }
      ensureActive();
      const rows = compareEnergyWindows(windows[0], windows[1]);
      for (const row of rows) await log({ event: 'monitor', ...row });
      const valid = rows.filter(r => r.differenceWatts !== null).length;
      await log({ event: 'complete', monitors: rows.length, comparable: valid });
      ensureActive(); setResult(rows); setCpuRates(rates);
      setMessage(`Complete · ${valid}/${rows.length} monitors comparable`);
    } catch (cause) {
      const reason = signal.aborted ? 'Cancelled · incomplete comparison discarded' : String(cause);
      try { await log({ event: 'cancelled', reason, completedWindows: windows.length }); } catch { /* Preserve the original error. */ }
      if (alive.current) { setResult(null); setMessage(reason); }
    } finally {
      controller.abort();
      signal.removeEventListener('abort', stopImmediately);
      try { await drainCpu(); }
      catch (cause) { if (alive.current) { setResult(null); setMessage(`Cleanup failed: ${String(cause)}`); } }
      try { await NativeModules.BenchProcessCpu.setOverheadActive(false); }
      catch (cause) { if (alive.current) { setResult(null); setMessage(`Screen policy restore failed: ${String(cause)}`); } }
      control.current = null;
      if (alive.current) setRunning(false);
    }
  }

  const sorted = [...(result ?? [])].sort((a, b) => Number(b.type === 'rail' && /CPU/.test(b.name)) - Number(a.type === 'rail' && /CPU/.test(a.name)));
  return <SafeAreaView style={styles.safe}><ScrollView contentContainerStyle={styles.page}>
    <Text style={styles.title}>Energy · idle vs CPU</Text>
    <Text testID="energy-comparison-status" style={styles.body}>{message}</Text>
    <Text style={styles.note}>35 s settling + 35 s measuring per phase. The CPU phase ramps to all cores. Stops on cancellation, backgrounding or a nonzero thermal state.</Text>
    <Text style={styles.note}>Leave the screen untouched during the check. Dashboard polling is paused; native observers and farm instrumentation remain.</Text>
    {emulated && <Text style={styles.note}>Emulator · values do not measure physical phone energy.</Text>}
    <View style={styles.buttons}>
      <Pressable accessibilityRole="button" accessibilityLabel={running ? 'Cancel energy comparison' : 'Start energy comparison'}
        onPress={() => running ? control.current?.abort() : void run()} style={styles.button}>
        <Text style={styles.buttonText}>{running ? 'Cancel' : 'Start comparison'}</Text>
      </Pressable>
      {!running && <Pressable accessibilityRole="button" accessibilityLabel="Return to device readings" onPress={onClose} style={styles.back}><Text style={styles.body}>Back</Text></Pressable>}
    </View>
    {!!cpuRates.length && <Text style={styles.body}>App CPU: idle {cpuRates[0].toFixed(1)}% · load {cpuRates[1].toFixed(1)}%{ '\n' }100% = one core; CPU timing is adjacent to the energy reads.</Text>}
    <Text style={styles.note}>Average watts = energy change ÷ snapshot interval. Device subsystems include other apps and OS work. Android may cache or perturb values. One ordered pair cannot separate workload effects from drift.</Text>
    {(expanded ? sorted : sorted.slice(0, 6)).map(row => <View style={styles.card} key={row.id}>
      <Text style={styles.name}>{row.name}</Text><Text style={styles.note}>{row.type === 'rail' ? 'Measured rail · API may add noise' : row.type === 'consumer' ? 'Subsystem consumer · may combine rails or use a model' : 'Unknown monitor type'}</Text>
      {(['idle', 'cpu'] as const).map(mode => <Text style={styles.body} key={mode}>{mode === 'idle' ? 'Idle' : 'CPU'}: {row[mode].reason ?? `${row[mode].averageWatts!.toFixed(3)} W · ${row[mode].joules!.toFixed(3)} J over ${(row[mode].elapsedMs! / 1000).toFixed(2)} s`}</Text>)}
      {row.differenceWatts !== null && <Text style={styles.value}>Difference {row.differenceWatts >= 0 ? '+' : ''}{row.differenceWatts.toFixed(3)} W</Text>}
    </View>)}
    {sorted.length > 6 && <Pressable accessibilityRole="button" accessibilityLabel="Toggle energy comparison monitors" onPress={() => setExpanded(!expanded)} style={styles.back}>
      <Text style={styles.body}>{expanded ? 'Show first 6' : `Show all ${sorted.length} monitors`}</Text></Pressable>}
    <Text style={styles.note}>Do not sum monitors: their coverage can overlap. Negative differences remain visible as noise, drift or subsystem changes; they are not proof of energy savings.</Text>
  </ScrollView></SafeAreaView>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f5f6f2' }, page: { padding: 24, gap: 12 },
  title: { fontSize: 28, fontWeight: '700', color: '#143f32' }, body: { fontSize: 14, lineHeight: 22, color: '#24533f' },
  note: { fontSize: 12, lineHeight: 18, color: '#52665c' }, name: { fontSize: 14, fontWeight: '600', color: '#143f32' },
  buttons: { flexDirection: 'row', gap: 16 }, button: { backgroundColor: '#1c5141', padding: 14, borderRadius: 10 },
  buttonText: { color: 'white', fontWeight: '600' }, back: { padding: 14 },
  card: { padding: 16, borderRadius: 16, backgroundColor: '#e9eee8', gap: 8 }, value: { fontSize: 22, color: '#143f32' },
});
