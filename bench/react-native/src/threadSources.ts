import { useEffect } from 'react';
import { AppState, NativeModules, Platform } from 'react-native';
import { SourcePoller } from './sourcePoller';

async function read(method: 'read' | 'readCpu') {
  if (!NativeModules.BenchThreads?.[method]) throw new Error('Native thread source missing; rebuild the app');
  const value = await NativeModules.BenchThreads[method]();
  if (value?.platform !== Platform.OS) throw new Error('Unexpected thread source platform');
  return value as unknown;
}
export const threadCpuSource = new SourcePoller(() => read('readCpu'));
export const threadCountSource = new SourcePoller(() => read('read'));
let owners = 0;
let subscription: ReturnType<typeof AppState.addEventListener> | null = null;
function update() {
  const active = owners > 0 && AppState.currentState === 'active';
  threadCpuSource.setActive(active); threadCountSource.setActive(active);
}
// Owned by the app/experiment, not the cards. Removing a card never stops capture.
export function useThreadSources(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    if (++owners === 1) subscription = AppState.addEventListener('change', update);
    update();
    return () => {
      if (--owners === 0) { subscription?.remove(); subscription = null; }
      update();
    };
  }, [enabled]);
}
