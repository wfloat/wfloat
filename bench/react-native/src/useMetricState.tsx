import { createContext, useCallback, useContext, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { MetricPublication } from './metricPublication';

export const MetricPublicationContext = createContext<MetricPublication | null>(null);

// Normal use keeps React's original setter. During the bounded overhead check,
// functional updates still consume the latest value while publication can stop.
// Polling, native reads/logs and tracker calculations continue unchanged.
export function useMetricState<T>(label: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const [state, commit] = useState(initial);
  const value = useRef(state);
  const meter = useContext(MetricPublicationContext);
  meter?.render();
  const set = useCallback((action: SetStateAction<T>) => {
    const next = typeof action === 'function' ? (action as (previous: T) => T)(value.current) : action;
    value.current = next;
    meter?.write(label, next);
    if (!meter || meter.publish) commit(next);
  }, [label, meter]);
  return [state, meter ? set : commit];
}
