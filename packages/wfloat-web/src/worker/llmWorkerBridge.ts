import type { LlmGenerationResult, LlmTokenEvent, LoadLlmModelOptions } from "../llm/types.js";
import type { LlmChatWorkerOptions, LlmGenerateWorkerOptions, WorkerRequest, WorkerResponse } from "./workerTypes.js";
// @ts-ignore
import workerCode from "./worker-inline.js";

type PendingRequest = {
  resolve: (value: WorkerResponse) => void;
  reject: (err: Error) => void;
  onLoadProgress?: (message: Extract<WorkerResponse, { type: "llm-load-model-progress" }>) => void;
  onToken?: (event: LlmTokenEvent) => void;
};

const blob = new Blob([workerCode], { type: "text/javascript" });

export class LlmWorkerBridge {
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

      if (message.type === "llm-load-model-progress") {
        pendingRequest?.onLoadProgress?.(message);
        return;
      }

      if (message.type === "llm-generate-token") {
        pendingRequest?.onToken?.(message.event);
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
    modelId: string,
    options: LoadLlmModelOptions,
  ): Promise<Extract<WorkerResponse, { type: "llm-load-model-done" }>> {
    const id = this.id;
    this.id += 1;

    const response = await this.request(
      {
        id,
        type: "llm-load-model",
        modelId,
        ...(typeof options.contextSize === "number" ? { contextSize: options.contextSize } : {}),
        ...(typeof options.numThreads === "number" ? { numThreads: options.numThreads } : {}),
      },
      {
        onLoadProgress: (message) => options.onProgress?.(message.event),
      },
    );

    if (response.type !== "llm-load-model-done") {
      throw new Error(`Unexpected worker response type: ${response.type}`);
    }

    return response;
  }

  static async generate(
    options: LlmGenerateWorkerOptions,
    onToken?: (event: LlmTokenEvent) => void,
  ): Promise<LlmGenerationResult> {
    const id = this.id;
    this.id += 1;

    const response = await this.request(
      {
        id,
        type: "llm-generate",
        options,
      },
      { onToken },
    );

    if (response.type !== "llm-generate-done") {
      throw new Error(`Unexpected worker response type: ${response.type}`);
    }

    return response.result;
  }

  static async chat(
    options: LlmChatWorkerOptions,
    onToken?: (event: LlmTokenEvent) => void,
  ): Promise<LlmGenerationResult> {
    const id = this.id;
    this.id += 1;

    const response = await this.request(
      {
        id,
        type: "llm-chat",
        options,
      },
      { onToken },
    );

    if (response.type !== "llm-generate-done") {
      throw new Error(`Unexpected worker response type: ${response.type}`);
    }

    return response.result;
  }
}
