import type { LoadModelProgressEvent } from "../tts/types.js";
import type { TranscriptionResult } from "../stt/types.js";
import type { SttModelAssetsResponse, WorkerRequest, WorkerResponse } from "./workerTypes.js";
// @ts-ignore
import workerCode from "./worker-inline.js";

type PendingRequest = {
  resolve: (value: WorkerResponse) => void;
  reject: (err: Error) => void;
  onLoadProgress?: (message: Extract<WorkerResponse, { type: "stt-load-model-progress" }>) => void;
};

const blob = new Blob([workerCode], { type: "text/javascript" });

export class SttWorkerBridge {
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

      if (message.type === "stt-load-model-progress") {
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
      const error = new Error(event.message || "Worker error");
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
      language?: string;
      task?: "transcribe" | "translate";
      modelAssetHost?: string;
    },
    persistentId: string | undefined,
    onProgress?: (message: { event: LoadModelProgressEvent }) => void,
  ): Promise<Extract<WorkerResponse, { type: "stt-load-model-done" }>> {
    const id = this.id;
    this.id += 1;

    const response = await this.request(
      {
        id,
        type: "stt-load-model",
        modelId: options.modelId,
        ...(persistentId ? { persistentId } : {}),
        ...(options.modelAssetHost ? { modelAssetHost: options.modelAssetHost } : {}),
        ...(options.language ? { language: options.language } : {}),
        ...(options.task ? { task: options.task } : {}),
      },
      {
        onLoadProgress: onProgress as PendingRequest["onLoadProgress"],
      },
    );

    if (response.type !== "stt-load-model-done") {
      throw new Error(`Unexpected worker response type: ${response.type}`);
    }

    return response;
  }

  static async transcribe(options: {
    samples: Float32Array;
    sampleRate: number;
  }): Promise<TranscriptionResult> {
    const id = this.id;
    this.id += 1;

    const response = await this.request({
      id,
      type: "stt-transcribe",
      samples: options.samples,
      sampleRate: options.sampleRate,
    });

    if (response.type !== "stt-transcribe-done") {
      throw new Error(`Unexpected worker response type: ${response.type}`);
    }

    return response.result;
  }
}

export type { SttModelAssetsResponse };
