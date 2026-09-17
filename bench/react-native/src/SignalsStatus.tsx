import { useEffect, useState } from 'react';
import { Text, View, Platform, NativeModules, Pressable } from 'react-native';
import { signalsSource, type SignalsSummary } from './signalsSource';
import { useMetricState } from './useMetricState';
export function SignalsStatus() {
  const [traceError, setTraceError] = useState<string | null>(null);
  const [value, setValue] = useMetricState<SignalsSummary | null>("signals", null);
  const [error, setError] = useMetricState<string | null>("signals-error", null);
  useEffect(() => signalsSource.subscribe(update => { setValue(update.value); setError(update.error); }), [setValue, setError]);
  return <View style={{padding:16}}>
    <Text style={{fontWeight:'600'}}>OS source capture</Text>
    <Text testID="signals-status">{error || (value ? `${value.sources} source records · ${value.unavailable} top-level errors · sample ${value.sequence} · ${value.state}` : 'Waiting for foreground capture')}</Text>
    <Pressable testID="page-state-check" accessibilityRole="button" accessibilityLabel="Capture owned mapping page states" onPress={() => {setTraceError(null);NativeModules.BenchSignals.runPageProbe().catch((e:Error)=>setTraceError(e.message));}}><Text style={{paddingVertical:8}}>Capture page states (16-page probe)</Text></Pressable>
    {<Pressable testID="gpu-source-check" accessibilityRole="button" accessibilityLabel="Capture GPU counters and timing" onPress={() => {setTraceError(null);NativeModules.BenchSignals.runGpuProbe().catch((e:Error)=>setTraceError(e.message));}}><Text style={{paddingVertical:8}}>{Platform.OS === 'ios' ? 'Capture GPU counters and timing' : 'Capture GPU sources'}</Text></Pressable>}
    <Pressable testID="socket-source-check" accessibilityRole="button" accessibilityLabel={Platform.OS === 'android' ? 'Capture network source probes' : 'Capture loopback TCP counters'} onPress={() => {setTraceError(null);NativeModules.BenchSignals.runSocketProbe().catch((e:Error)=>setTraceError(e.message));}}><Text style={{paddingVertical:8}}>{Platform.OS === 'android' ? 'Capture network source probes' : 'Capture loopback TCP counters'}</Text></Pressable>
    <Pressable testID="frame-source-check" accessibilityRole="button" accessibilityLabel="Capture frame timing callbacks" onPress={() => {setTraceError(null);NativeModules.BenchSignals.runFrameProbe().catch((e:Error)=>setTraceError(e.message));}}><Text style={{paddingVertical:8}}>Capture frame timing (3 seconds)</Text></Pressable>
    {Platform.OS === 'ios' && <Pressable testID="ipc-source-check" accessibilityRole="button" accessibilityLabel="Probe Mach message queue counters" onPress={() => {setTraceError(null);NativeModules.BenchSignals.runIpcProbe().catch((e:Error)=>setTraceError(e.message));}}><Text style={{paddingVertical:8}}>Probe Mach message queue counters</Text></Pressable>}
    {Platform.OS === 'android' && <>
      <Pressable testID="gpu-load-check" accessibilityRole="button" accessibilityLabel="Run 45 second CPU GPU source probe" onPress={() => {setTraceError(null);NativeModules.BenchCpu.startSourceLoad().catch((e:Error)=>setTraceError(e.message));}}><Text style={{paddingVertical:8}}>Run CPU/GPU source probe (45 seconds)</Text></Pressable>
      <Pressable testID="perf-source-check" accessibilityRole="button" accessibilityLabel="Probe app CPU performance counters" onPress={() => {setTraceError(null);NativeModules.BenchSignals.runPerfProbe().catch((e:Error)=>setTraceError(e.message));}}><Text style={{paddingVertical:8}}>Probe CPU performance counters</Text></Pressable>
      <Pressable testID="trace-check" accessibilityRole="button" accessibilityLabel="Capture Android system trace" onPress={() => { setTraceError(null);NativeModules.BenchSignals.startTrace().catch((e:Error)=>setTraceError(e.message)); }}><Text style={{paddingVertical:8}}>Capture Android system trace (~30s)</Text></Pressable>
      <View style={{flexDirection:'row',flexWrap:'wrap',gap:12}}>{([[2,'Native heap'],[1,'Java heap'],[3,'Stacks']] as const).map(([kind,label]) => <Pressable key={kind} testID={`profile-${kind}`} accessibilityRole="button" accessibilityLabel={`Capture ${label} profile`} onPress={() => {setTraceError(null);NativeModules.BenchSignals.startProfile(kind).catch((e:Error)=>setTraceError(e.message));}}><Text style={{fontSize:12,paddingVertical:8}}>{label}</Text></Pressable>)}</View>
      <View style={{flexDirection:'row',flexWrap:'wrap',gap:12}}>
        <Pressable testID="profile-system-enable" accessibilityRole="button" accessibilityLabel="Enable OS triggered profiles" onPress={() => {setTraceError(null);NativeModules.BenchSignals.setSystemProfilingTriggers(true).catch((e:Error)=>setTraceError(e.message));}}><Text style={{paddingVertical:8,fontSize:12}}>Enable OS-triggered profiles</Text></Pressable>
        <Pressable testID="profile-system-disable" accessibilityRole="button" accessibilityLabel="Disable OS triggered profiles" onPress={() => {setTraceError(null);NativeModules.BenchSignals.setSystemProfilingTriggers(false).catch((e:Error)=>setTraceError(e.message));}}><Text style={{paddingVertical:8,fontSize:12}}>Disable OS-triggered profiles</Text></Pressable>
        <Pressable testID="profile-running" accessibilityRole="button" accessibilityLabel="Request running OS trace" onPress={() => {setTraceError(null);NativeModules.BenchSignals.requestRunningSystemTrace().catch((e:Error)=>setTraceError(e.message));}}><Text style={{paddingVertical:8,fontSize:12}}>Request running OS trace</Text></Pressable>
      </View>
      <Text>{traceError || value?.traceState || 'Trace not requested'}</Text>
    </>}
    {Platform.OS !== 'android' && traceError && <Text>{traceError}</Text>}
    <Text selectable style={{fontSize:11}}>{value?.path}</Text>
    <Text style={{fontSize:12}}>Full observations in JSONL, every ~10 seconds. Unavailable sources are retained with their errors.</Text>
  </View>;
}
