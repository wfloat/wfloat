/** Session-owned capture uses the same native coordinator as shared capture. */
export { startMicrophone } from '../audio-next/microphone';
export type MicrophoneCapture = { start(): Promise<void>; stop(): Promise<void> };
