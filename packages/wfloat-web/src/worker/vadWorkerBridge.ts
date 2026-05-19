import type { LoadModelProgressEvent } from "../tts/types.js";
import type { VadDetectionResult } from "../vad/types.js";
import type { WorkerRequest, WorkerResponse } from "./workerTypes.js";
// @ts-ignore
import workerCode from "./worker-inline.js";

type PendingRequest = {
  resolve: (value: WorkerResponse) => void;
  reject: (err: Error) => void;
  onLoadProgress?: (message: Extract<WorkerResponse, { type: "vad-load-model-progress" }>) => void;
};

const blob = new Blob([workerCode], { type: "text/javascript" });

export class VadWorkerBridge {
  private static id = 1;
  private static worker = new Worker(URL.createObjectURL(blob), { type: "module" });
  private static initialized = false;
  private static pending = new Map<number, PendingRequest>();

  private static init(): void {
    if (this.initialized) return;
    this.initialized = true;

    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      const pendingRequest = this.pending.get(message.id);

      if (message.type === "vad-load-model-progress") {
        pendingRequest?.onLoadProgress?.(message);
        return;
      }

      if (!pendingRequest) {
        return;
      }

      this.pending.delete(message.id);

      if (message.type === "request-error") {
        pendingRequest.reject(new Error(message.error));
        return;
      }

      pendingRequest.resolve(message);
    };

    this.worker.onerror = (event: ErrorEvent) => {
      const details = [
        event.message || "Worker error",
        event.filename ? `file=${event.filename}` : "",
        typeof event.lineno === "number" && event.lineno > 0 ? `line=${event.lineno}` : "",
        typeof event.colno === "number" && event.colno > 0 ? `col=${event.colno}` : "",
      ]
        .filter((value) => value.length > 0)
        .join(" ");
      const error = new Error(details || "Worker error");
      for (const [id, pendingRequest] of this.pending.entries()) {
        this.pending.delete(id);
        pendingRequest.reject(error);
      }
    };
  }

  private static request(
    request: WorkerRequest,
    pending: Omit<PendingRequest, "resolve" | "reject"> = {},
  ): Promise<WorkerResponse> {
    this.init();

    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(request.id, {
        resolve,
        reject,
        ...pending,
      });

      this.worker.postMessage(request);
    });
  }

  static async loadModel(
    options: {
      modelId: string;
      modelAssetHost?: string;
      threshold?: number;
      minSilenceDurationSec?: number;
      minSpeechDurationSec?: number;
      maxSpeechDurationSec?: number;
    },
    persistentId: string | undefined,
    onProgress?: (message: { event: LoadModelProgressEvent }) => void,
  ): Promise<Extract<WorkerResponse, { type: "vad-load-model-done" }>> {
    const id = this.id;
    this.id += 1;

    const response = await this.request(
      {
        id,
        type: "vad-load-model",
        modelId: options.modelId,
        ...(persistentId ? { persistentId } : {}),
        ...(options.modelAssetHost ? { modelAssetHost: options.modelAssetHost } : {}),
        ...(typeof options.threshold === "number" ? { threshold: options.threshold } : {}),
        ...(typeof options.minSilenceDurationSec === "number"
          ? { minSilenceDurationSec: options.minSilenceDurationSec }
          : {}),
        ...(typeof options.minSpeechDurationSec === "number"
          ? { minSpeechDurationSec: options.minSpeechDurationSec }
          : {}),
        ...(typeof options.maxSpeechDurationSec === "number"
          ? { maxSpeechDurationSec: options.maxSpeechDurationSec }
          : {}),
      },
      {
        onLoadProgress: onProgress as PendingRequest["onLoadProgress"],
      },
    );

    if (response.type !== "vad-load-model-done") {
      throw new Error(`Unexpected worker response type: ${response.type}`);
    }

    return response;
  }

  static async detect(options: {
    samples: Float32Array;
    sampleRate: number;
  }): Promise<VadDetectionResult> {
    const id = this.id;
    this.id += 1;

    const response = await this.request({
      id,
      type: "vad-detect",
      samples: options.samples,
      sampleRate: options.sampleRate,
    });

    if (response.type !== "vad-detect-done") {
      throw new Error(`Unexpected worker response type: ${response.type}`);
    }

    return response.result;
  }
}
