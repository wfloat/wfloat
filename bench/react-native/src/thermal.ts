import { NativeModules } from "react-native";

export type ThermalReading = {
  availability: "available" | "unavailable";
  state: string | null;
  rawValue: number | null;
  sampledAtMs: number;
  uptimeMs: number;
  source: string;
  platform: "ios" | "android";
  osVersion: string;
  environment: "simulator" | "emulator" | "device";
  note: string;
};

export async function readThermalState(): Promise<ThermalReading> {
  if (!NativeModules.BenchThermal?.read) {
    throw new Error("Native thermal collector is missing. Rebuild the app.");
  }
  return NativeModules.BenchThermal.read();
}
