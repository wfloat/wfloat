import { NativeModules } from "react-native";

export type CpuStatus = {
  running: boolean;
  stopping: boolean;
  workers: number;
  targetWorkers: number;
  elapsedMs: number;
  blocks: number;
  checksum: number;
  reason: string;
  gpuEnabled?: boolean;
  gpuActive?: boolean;
  gpuBatches?: number;
  gpuChecksum?: number;
  gpuLastBatchMs?: number;
  gpuRenderer?: string;
  gpuError?: string;
};

function collector() {
  if (!NativeModules.BenchCpu)
    throw new Error("Native CPU workload is missing. Rebuild the app.");
  return NativeModules.BenchCpu;
}
export const startCpuStress = (withGpu = false): Promise<CpuStatus> =>
  withGpu ? collector().startCombined() : collector().start();
export const readCpuStress = (): Promise<CpuStatus> => collector().read();
export const stopCpuStress = (reason = 0): Promise<void> =>
  collector().stop(reason);
