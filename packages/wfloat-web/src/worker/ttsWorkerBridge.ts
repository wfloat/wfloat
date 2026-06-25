import type {
  ModelAssetsResponse,
  SpeechGenerateDialogueWorkerOptions,
  SpeechGenerateWorkerOptions,
  WorkerRequest,
  WorkerRequestTemplate,
  WorkerResponse,
} from "./workerTypes.js";
import { createWfloatWorker } from "./createWorker.js";

type PendingRequest = {
  resolve: (value: WorkerResponse) => void;
  reject: (err: Error) => void;
  onLoadProgress?: (message: Extract<WorkerResponse, { type: "speech-load-model-progress" }>) => void;
  onGenerateChunk?: (message: Extract<WorkerResponse, { type: "speech-generate-chunk" }>) => void;
};

export class TtsWorkerBridge {
  private static id = 1;
  private static worker = createWfloatWorker();
  private static initialized = false;
  private static pending = new Map<number, PendingRequest>();

  private static init(): void {
    if (this.initialized) return;
    this.initialized = true;

    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;

      const pendingRequest = this.pending.get(message.id);

      if (message.type === "speech-load-model-progress") {
        pendingRequest?.onLoadProgress?.(message);
        return;
      }

      if (message.type === "speech-generate-chunk") {
        pendingRequest?.onGenerateChunk?.(message);
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
    requestTemplate: WorkerRequestTemplate,
    pending: Omit<PendingRequest, "resolve" | "reject"> = {},
  ): Promise<WorkerResponse> {
    this.init();

    return new Promise<WorkerResponse>((resolve, reject) => {
      const id = this.id;
      this.id += 1;

      this.pending.set(id, {
        resolve,
        reject,
        ...pending,
      });

      const request: WorkerRequest = {
        id,
        ...requestTemplate,
      };

      this.worker.postMessage(request);
    });
  }

  static async loadModel(
    modelId: string,
    onProgress?: (message: Extract<WorkerResponse, { type: "speech-load-model-progress" }>) => void,
  ): Promise<Extract<WorkerResponse, { type: "speech-load-model-done" }>> {
    const response = await this.request(
      {
        type: "speech-load-model",
        modelId,
      },
      {
        onLoadProgress: onProgress,
      },
    );

    if (response.type !== "speech-load-model-done") {
      throw new Error(`Unexpected worker response type: ${response.type}`);
    }

    return response;
  }

  static async generate(
    options: SpeechGenerateWorkerOptions,
    onChunk?: (message: Extract<WorkerResponse, { type: "speech-generate-chunk" }>) => void,
  ): Promise<Extract<WorkerResponse, { type: "speech-generate-done" }>> {
    const response = await this.request(
      {
        type: "speech-generate",
        options,
      },
      {
        onGenerateChunk: onChunk,
      },
    );

    if (response.type !== "speech-generate-done") {
      throw new Error(`Unexpected worker response type: ${response.type}`);
    }

    return response;
  }

  static async generateDialogue(
    options: SpeechGenerateDialogueWorkerOptions,
    onChunk?: (message: Extract<WorkerResponse, { type: "speech-generate-chunk" }>) => void,
  ): Promise<Extract<WorkerResponse, { type: "speech-generate-done" }>> {
    const response = await this.request(
      {
        type: "speech-generate-dialogue",
        options,
      },
      {
        onGenerateChunk: onChunk,
      },
    );

    if (response.type !== "speech-generate-done") {
      throw new Error(`Unexpected worker response type: ${response.type}`);
    }

    return response;
  }

  static async terminateEarly(): Promise<void> {
    const response = await this.request({
      type: "speech-terminate-early",
    });

    if (response.type !== "speech-terminate-early-done") {
      throw new Error(`Unexpected worker response type: ${response.type}`);
    }
  }
}

export type { ModelAssetsResponse };
