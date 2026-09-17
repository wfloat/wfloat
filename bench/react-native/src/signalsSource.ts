import { useEffect } from 'react';
import { AppState, NativeModules, Platform } from 'react-native';
import { SourcePoller } from './sourcePoller';
export type SignalsSummary = {platform: string; sequence: number; sources: number; unavailable: number; state: string; path: string; traceState?: string};
export const signalsSource = new SourcePoller<SignalsSummary>(async () => {
  if (!NativeModules.BenchSignals?.read) throw new Error('Native OS sources missing; rebuild the app');
  const row = await NativeModules.BenchSignals.read();
  if (row?.platform !== Platform.OS || !Number.isSafeInteger(row.sequence) || !Number.isSafeInteger(row.sources) || !Number.isSafeInteger(row.unavailable) || row.unavailable < 0 || row.unavailable > row.sources || typeof row.path !== 'string' || typeof row.state !== 'string') throw new Error('Invalid OS source summary');
  return row;
}, 10000);
let owners = 0;
let subscription: ReturnType<typeof AppState.addEventListener> | null = null;
function update() { signalsSource.setActive(owners > 0 && AppState.currentState === 'active'); }
export function useSignalsSource(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    if (++owners === 1) subscription = AppState.addEventListener('change', update);
    update();
    return () => { if (--owners === 0) { subscription?.remove(); subscription = null; } update(); };
  }, [enabled]);
}
