import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';
import type { EventEmitter } from 'react-native/Libraries/Types/CodegenTypes';

/** Private transport. Public API types live in next/, not in Codegen's limited IDL. */
export interface Spec extends TurboModule {
  request(requestId: string, command: string): Promise<string>;
  cancel(requestId: string): void;
  readonly onEvent: EventEmitter<{ requestId: string; payload: string }>;
}
// Lazy lookup lets importing types/helpers work before native installation checks.
export function nativeRuntime(): Spec {
  return TurboModuleRegistry.getEnforcing<Spec>('WfloatNext');
}
