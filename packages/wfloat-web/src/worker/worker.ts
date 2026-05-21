import {
  SherpaModule,
  ModuleConfig,
  OfflineTts,
  createOfflineTts,
  prepareWfloatText,
} from "../wasm/sherpa-onnx-tts.js";
import { createOnlineRecognizer, OfflineRecognizer } from "../wasm/sherpa-onnx-asr.js";
import { createVad } from "../wasm/sherpa-onnx-vad.js";
import { SPEAKER_IDS, VALID_EMOTIONS, VALID_SIDS } from "../tts/catalog.js";
import type { TtsEmotion } from "../tts/types.js";
import { fetchSttModelManifest, fetchTtsModelManifest, fetchVadModelManifest } from "../modelManifest.js";
// @ts-ignore
import createSherpaSpeechModule from "../wasm/sherpa-onnx-wasm-main-speech.js";
import {
  ModelAssetsResponse,
  SpeechGenerateDialogueWorkerOptions,
  SpeechGenerateWorkerOptions,
  SttModelAssetsResponse,
  VadModelAssetsResponse,
  WorkerRequest,
  WorkerResponse,
} from "./workerTypes.js";
import { computeStartTime } from "../util/schedulingUtil.js";
import type { VadSegment, VadSpeechStartEvent } from "../vad/types.js";

let SherpaSpeechModuleInstancePromise: Promise<SherpaModule>;
let TTS: OfflineTts | null = null;
let OFFLINE_STT: OfflineRecognizer | null = null;
let ONLINE_STT: ReturnType<typeof createOnlineRecognizer> | null = null;
// let CURRENT_GENERATE_ID: number | null = null;
// let DO_EARLY_STOP: Boolean = false;
let EARLY_STOP_MESSAGE_ID: number | null = null;

let TTS_MODEL_ASSET_URLS: ModelAssetsResponse | null = null;
let STT_MODEL_ASSET_URLS: SttModelAssetsResponse | null = null;
let STT_MODEL_ID: string | null = null;
let VAD: ReturnType<typeof createVad> | null = null;
let VAD_MODEL_ASSET_URLS: VadModelAssetsResponse | null = null;
let VAD_MODEL_ID: string | null = null;
let NEXT_STT_SESSION_ID = 1;
const STT_SESSIONS = new Map<number, ReturnType<ReturnType<typeof createOnlineRecognizer>["createStream"]>>();
let NEXT_VAD_SESSION_ID = 1;
type VadSessionState = {
  id: number;
  pendingSamples: Float32Array;
  sampleRate: number;
  processedSampleCount: number;
  speechDetected: boolean;
  emittedWindowCount: number;
  speechStartCount: number;
  speechEndCount: number;
};
const VAD_SESSIONS = new Map<number, VadSessionState>();
let INSTALLED_ESPEAK_ARCHIVE_URL: string | null = null;
let SHERPA_SPEECH_RUNTIME_URLS: { wasm_binary: string; wasm_data?: string } | null = null;

const WEB_PLATFORM = "web";
const WFLOAT_WEB_VERSION = "1.5.2";
const SHERPA_ONNX_VERSION = "1.13.1";

function assertPinnedSherpaRuntimeVersion(
  runtimeVersion: string | undefined,
  requestedVersion: string,
  modelId: string,
): void {
  if (!runtimeVersion) {
    throw new Error(`Model asset manifest for ${modelId} is missing runtime.version.`);
  }

  if (runtimeVersion !== requestedVersion) {
    throw new Error(
      `Model asset manifest for ${modelId} returned sherpa runtime ${runtimeVersion}, expected ${requestedVersion}.`,
    );
  }
}

const defaultSpeechModuleConfig: ModuleConfig = {
  locateFile: (path: string) => {
    if (path.endsWith(".wasm")) return SHERPA_SPEECH_RUNTIME_URLS!.wasm_binary;
    if (path.endsWith(".data") && SHERPA_SPEECH_RUNTIME_URLS?.wasm_data) return SHERPA_SPEECH_RUNTIME_URLS.wasm_data;
    return path;
  },
  print: (text: string) => {}, //console.log(text),
  printErr: (text: string) => console.error("wasm:", text),
  onAbort: (what: unknown) => console.error("wasm abort:", what),
};

async function getModelAssets(
  modelId: string,
  platform: string,
  version: string,
  sherpaOnnxVersion: string,
  modelAssetHost?: string,
  persistentId?: string,
): Promise<ModelAssetsResponse> {
  const data = await fetchTtsModelManifest({
    modelName: modelId,
    platform,
    version,
    sherpaOnnxVersion,
    modelAssetHost,
    persistentId,
  });

  assertPinnedSherpaRuntimeVersion(data.runtime?.version, sherpaOnnxVersion, modelId);

  if (
    data.files?.model?.url &&
    data.files?.tokens?.url &&
    data.runtime?.wasm_binary?.url
  ) {
    return {
      model_onnx: data.files.model.url,
      model_tokens: data.files.tokens.url,
      wasm_binary: data.runtime.wasm_binary.url,
      wasm_data: data.runtime.wasm_data?.url,
      espeak_data: data.files.espeak_data?.url,
      persistent_id: data.persistent_id,
    };
  }

  throw new Error("Model asset manifest is missing required URLs.");
}

async function getSttModelAssets(
  modelId: string,
  platform: string,
  version: string,
  sherpaOnnxVersion: string,
  modelAssetHost?: string,
  persistentId?: string,
): Promise<SttModelAssetsResponse> {
  const data = await fetchSttModelManifest({
    modelName: modelId,
    platform,
    version,
    sherpaOnnxVersion,
    modelAssetHost,
    persistentId,
  });

  assertPinnedSherpaRuntimeVersion(data.runtime?.version, sherpaOnnxVersion, modelId);

  if (!data.family || !data.files?.tokens?.url || !data.runtime?.wasm_binary?.url) {
    throw new Error("STT model asset manifest is missing required URLs.");
  }

  const response: SttModelAssetsResponse = {
    family: data.family,
    tokens: data.files.tokens.url,
    wasm_binary: data.runtime.wasm_binary.url,
    wasm_data: data.runtime.wasm_data?.url,
    persistent_id: data.persistent_id,
  };

  if (data.files.encoder?.url) response.encoder = data.files.encoder.url;
  if (data.files.decoder?.url) response.decoder = data.files.decoder.url;
  if (data.files.preprocessor?.url) response.preprocessor = data.files.preprocessor.url;
  if (data.files.joiner?.url) response.joiner = data.files.joiner.url;
  if (data.files.uncached_decoder?.url) response.uncached_decoder = data.files.uncached_decoder.url;
  if (data.files.cached_decoder?.url) response.cached_decoder = data.files.cached_decoder.url;

  return response;
}

async function getVadModelAssets(
  modelId: string,
  platform: string,
  version: string,
  sherpaOnnxVersion: string,
  modelAssetHost?: string,
  persistentId?: string,
): Promise<VadModelAssetsResponse> {
  const data = await fetchVadModelManifest({
    modelName: modelId,
    platform,
    version,
    sherpaOnnxVersion,
    modelAssetHost,
    persistentId,
  });

  assertPinnedSherpaRuntimeVersion(data.runtime?.version, sherpaOnnxVersion, modelId);

  if (!data.family || !data.files?.model?.url || !data.runtime?.wasm_binary?.url) {
    throw new Error("VAD model asset manifest is missing required URLs.");
  }

  return {
    family: data.family,
    model: data.files.model.url,
    wasm_binary: data.runtime.wasm_binary.url,
    wasm_data: data.runtime.wasm_data?.url,
    persistent_id: data.persistent_id,
  };
}

function assertCompatibleSpeechRuntime(nextRuntime: {
  wasm_binary: string;
  wasm_data?: string;
}): void {
  if (!SHERPA_SPEECH_RUNTIME_URLS) {
    SHERPA_SPEECH_RUNTIME_URLS = nextRuntime;
    return;
  }

  if (
    SHERPA_SPEECH_RUNTIME_URLS.wasm_binary !== nextRuntime.wasm_binary ||
    SHERPA_SPEECH_RUNTIME_URLS.wasm_data !== nextRuntime.wasm_data
  ) {
    throw new Error("Attempted to reuse the shared sherpa speech module with a different runtime URL.");
  }
}

async function getSherpaSpeechModule(runtime: {
  wasm_binary: string;
  wasm_data?: string;
}) {
  assertCompatibleSpeechRuntime(runtime);
  if (!SherpaSpeechModuleInstancePromise) {
    SherpaSpeechModuleInstancePromise = createSherpaSpeechModule(defaultSpeechModuleConfig);
  }
  return SherpaSpeechModuleInstancePromise;
}

function getFileNameFromUrl(url: string, label: string): string {
  const name = new URL(url).pathname.split("/").pop();
  if (!name) {
    throw new Error(`Failed to determine filename for ${label}.`);
  }
  return name;
}

function pathDirname(path: string): string {
  const normalizedPath = path.replace(/\/+/g, "/");
  const lastSlashIndex = normalizedPath.lastIndexOf("/");
  if (lastSlashIndex <= 0) {
    return "/";
  }
  return normalizedPath.slice(0, lastSlashIndex);
}

function pathBasename(path: string): string {
  const normalizedPath = path.replace(/\/+/g, "/");
  const lastSlashIndex = normalizedPath.lastIndexOf("/");
  return lastSlashIndex === -1 ? normalizedPath : normalizedPath.slice(lastSlashIndex + 1);
}

function fsPathExists(module: SherpaModule, path: string): boolean {
  try {
    module.FS.stat(path);
    return true;
  } catch {
    return false;
  }
}

function ensureModuleDirectory(module: SherpaModule, path: string): void {
  if (!path || path === "/") {
    return;
  }

  if (fsPathExists(module, path)) {
    return;
  }

  const parent = pathDirname(path);
  if (parent !== path) {
    ensureModuleDirectory(module, parent);
  }

  if (!fsPathExists(module, path)) {
    module.FS.mkdir(path);
  }
}

function removeModulePathRecursive(module: SherpaModule, path: string): void {
  if (!fsPathExists(module, path)) {
    return;
  }

  const stat = module.FS.stat(path);
  const mode = stat.mode as number;
  const isDirectory = typeof module.FS.isDir === "function" ? module.FS.isDir(mode) : false;

  if (!isDirectory) {
    module.FS.unlink(path);
    return;
  }

  const entries = module.FS.readdir(path).filter((entry: string) => entry !== "." && entry !== "..");
  for (const entry of entries) {
    const childPath = path === "/" ? `/${entry}` : `${path}/${entry}`;
    removeModulePathRecursive(module, childPath);
  }

  module.FS.rmdir(path);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  ) >>> 0;
}

function decodeZipFileName(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function sanitizeZipEntryPath(entryName: string): string {
  const normalized = entryName.replace(/\\/g, "/").replace(/^\/+/, "");
  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");

  if (segments.length === 0) {
    return "";
  }

  for (const segment of segments) {
    if (segment === "..") {
      throw new Error(`Invalid zip entry path: ${entryName}`);
    }
  }

  return segments.join("/");
}

function installStoredZipArchive(module: SherpaModule, archiveBytes: Uint8Array, destinationRoot: string): void {
  ensureModuleDirectory(module, destinationRoot);

  let offset = 0;
  while (offset + 4 <= archiveBytes.length) {
    const signature = readUint32LE(archiveBytes, offset);
    if (signature !== 0x04034b50) {
      break;
    }

    if (offset + 30 > archiveBytes.length) {
      throw new Error("Invalid zip archive header.");
    }

    const generalPurposeBitFlag = readUint16LE(archiveBytes, offset + 6);
    const compressionMethod = readUint16LE(archiveBytes, offset + 8);
    const compressedSize = readUint32LE(archiveBytes, offset + 18);
    const uncompressedSize = readUint32LE(archiveBytes, offset + 22);
    const fileNameLength = readUint16LE(archiveBytes, offset + 26);
    const extraFieldLength = readUint16LE(archiveBytes, offset + 28);

    if ((generalPurposeBitFlag & 0x0008) !== 0) {
      throw new Error("Zip archives using data descriptors are not supported.");
    }

    if (compressionMethod !== 0) {
      throw new Error("Compressed zip entries are not supported for web espeak staging.");
    }

    const fileNameOffset = offset + 30;
    const fileDataOffset = fileNameOffset + fileNameLength + extraFieldLength;
    const fileDataEnd = fileDataOffset + compressedSize;

    if (fileDataEnd > archiveBytes.length) {
      throw new Error("Zip entry extends beyond archive length.");
    }

    const rawFileName = decodeZipFileName(
      archiveBytes.subarray(fileNameOffset, fileNameOffset + fileNameLength),
    );
    const relativePath = sanitizeZipEntryPath(rawFileName);

    if (relativePath) {
      const destinationPath = `${destinationRoot}/${relativePath}`;
      const isDirectory = rawFileName.endsWith("/");

      if (isDirectory) {
        ensureModuleDirectory(module, destinationPath);
      } else {
        ensureModuleDirectory(module, pathDirname(destinationPath));
        const fileBytes = archiveBytes.slice(fileDataOffset, fileDataOffset + uncompressedSize);
        module.FS.writeFile(destinationPath, fileBytes);
      }
    }

    offset = fileDataEnd;
  }
}

async function installEspeakArchiveFromUrl(module: SherpaModule, archiveUrl: string): Promise<void> {
  if (INSTALLED_ESPEAK_ARCHIVE_URL === archiveUrl && fsPathExists(module, "/espeak-ng-data")) {
    return;
  }

  const response = await fetch(archiveUrl);
  if (!response.ok) {
    throw new Error("Failed to fetch espeak-ng-data archive.");
  }

  const archiveBytes = new Uint8Array(await response.arrayBuffer());
  if (fsPathExists(module, "/espeak-ng-data")) {
    removeModulePathRecursive(module, "/espeak-ng-data");
  }

  installStoredZipArchive(module, archiveBytes, "/");

  if (!fsPathExists(module, "/espeak-ng-data")) {
    const fallbackName = pathBasename(new URL(archiveUrl).pathname).replace(/\.zip$/i, "");
    if (fsPathExists(module, `/${fallbackName}/espeak-ng-data`)) {
      module.FS.rename(`/${fallbackName}/espeak-ng-data`, "/espeak-ng-data");
      if (fsPathExists(module, `/${fallbackName}`)) {
        removeModulePathRecursive(module, `/${fallbackName}`);
      }
    }
  }

  if (!fsPathExists(module, "/espeak-ng-data")) {
    throw new Error("Unable to locate extracted espeak-ng-data directory.");
  }

  INSTALLED_ESPEAK_ARCHIVE_URL = archiveUrl;
}

async function writeModuleFileFromUrl(
  module: SherpaModule,
  remoteUrl: string,
  targetName: string,
): Promise<void> {
  const response = await fetch(remoteUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch ${targetName}.`);
  }

  const targetPath = `/${targetName}`;
  const reader = response.body.getReader();
  let fileStream: ReturnType<SherpaModule["FS"]["open"]> | null = null;
  let writePosition = 0;

  try {
    fileStream = module.FS.open(targetPath, "w+");

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!value || value.length === 0) {
        continue;
      }

      module.FS.write(fileStream, value, 0, value.length, writePosition);
      writePosition += value.length;
    }
  } catch (error) {
    if (fsPathExists(module, targetPath)) {
      module.FS.unlink(targetPath);
    }
    throw error;
  } finally {
    if (fileStream) {
      module.FS.close(fileStream);
    }
    reader.releaseLock();
  }
}

function coerceNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "number" && Number.isFinite(item) ? item : null))
    .filter((item): item is number => item !== null);
}

function coerceStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function postResponse(message: WorkerResponse, transfer: Transferable[] = []): void {
  (
    self as unknown as { postMessage: (value: WorkerResponse, transfer: Transferable[]) => void }
  ).postMessage(message, transfer);
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function handleLoadSpeechModel(
  id: number,
  modelId: string,
  modelAssetHost?: string,
  persistentId?: string,
): Promise<void> {
  TTS_MODEL_ASSET_URLS = await getModelAssets(
    modelId,
    WEB_PLATFORM,
    WFLOAT_WEB_VERSION,
    SHERPA_ONNX_VERSION,
    modelAssetHost,
    persistentId,
  );
  const MODEL_NAME = new URL(TTS_MODEL_ASSET_URLS!.model_onnx).pathname.split("/").pop();
  const TOKENS_NAME = new URL(TTS_MODEL_ASSET_URLS!.model_tokens).pathname.split("/").pop();

  if (TTS) {
    TTS.free();
    TTS = null;
  }

  let isSherpaModuleResolved = false;
  const sherpaModulePromise = getSherpaSpeechModule({
    wasm_binary: TTS_MODEL_ASSET_URLS.wasm_binary,
    wasm_data: TTS_MODEL_ASSET_URLS.wasm_data,
  }).then((module) => {
    isSherpaModuleResolved = true;
    return module;
  });

  const response = await fetch(TTS_MODEL_ASSET_URLS.model_onnx);
  if (!response.ok || !response.body) {
    throw new Error("Failed to fetch model.onnx");
  }
  const reader = response.body.getReader();
  const totalBytesHeader = response.headers.get("content-length");
  const totalBytes = totalBytesHeader ? Number.parseInt(totalBytesHeader, 10) : NaN;
  const canReportDownloadProgress = Number.isFinite(totalBytes) && totalBytes > 0;
  let downloadedBytes = 0;
  let pendingModelChunks: Uint8Array[] = [];
  let modelFileStream: ReturnType<SherpaModule["FS"]["open"]> | null = null;
  let modelWritePosition = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (isSherpaModuleResolved || done) {
        const sherpaModule = await sherpaModulePromise;
        if (!modelFileStream) {
          modelFileStream = sherpaModule.FS.open(`/${MODEL_NAME}`, "w+");
        }
        for (const chunk of pendingModelChunks) {
          sherpaModule.FS.write(modelFileStream, chunk, 0, chunk.length, modelWritePosition);
          modelWritePosition += chunk.length;
        }
        if (value) {
          sherpaModule.FS.write(modelFileStream, value, 0, value.length, modelWritePosition);
          modelWritePosition += value.length;
        }

        pendingModelChunks = [];
        if (done) break;
      } else if (value) {
        pendingModelChunks.push(value);
      }
      if (!value) continue;

      if (canReportDownloadProgress) {
        downloadedBytes += value.length;
        postResponse({
          id,
          type: "speech-load-model-progress",
          event: {
            status: "downloading",
            progress: Math.min(downloadedBytes / totalBytes, 1),
          },
        });
      }
    }
  } finally {
    reader.releaseLock();
    if (modelFileStream) {
      const sherpaModule = await sherpaModulePromise;
      sherpaModule.FS.close(modelFileStream);
    }
  }

  const sherpaModule = await sherpaModulePromise;
  // if (pendingModelChunks.length) {
  //   const modelFileStream = sherpaModule.FS.open(`/${MODEL_NAME}`, "w+");
  //   for (const chunk of pendingModelChunks) {
  //     sherpaModule.FS.write(modelFileStream, chunk, 0, chunk.length);
  //   }
  //   sherpaModule.FS.close(modelFileStream);
  // }
  // pendingModelChunks = [];

  const tokensResponse = await fetch(TTS_MODEL_ASSET_URLS.model_tokens);
  if (!tokensResponse.ok) {
    throw new Error("Failed to fetch tokens.txt");
  }
  const tokensText = await tokensResponse.text();
  sherpaModule.FS.writeFile(`/${TOKENS_NAME}`, tokensText);

  if (TTS_MODEL_ASSET_URLS.espeak_data) {
    await installEspeakArchiveFromUrl(sherpaModule, TTS_MODEL_ASSET_URLS.espeak_data);
  }

  // console.log(sherpaModule.FS.readdir("/"));

  postResponse({
    id,
    type: "speech-load-model-progress",
    event: { status: "loading" },
  });

  TTS = createOfflineTts(sherpaModule, {
    offlineTtsModelConfig: {
      offlineTtsWfloatModelConfig: {
        model: `/${MODEL_NAME}`,
        tokens: `/${TOKENS_NAME}`,
        dataDir: "/espeak-ng-data",
        noiseScale: 0.667,
        noiseScaleW: 0.8,
        lengthScale: 1.0,
      },
      numThreads: 1,
      debug: 0,
      provider: "cpu",
    },
    ruleFsts: "",
    ruleFars: "",
    maxNumSentences: 1,
  });

  // console.log(TTS);

  postResponse({
    id,
    type: "speech-load-model-done",
    sampleRate: TTS.sampleRate,
    persistentId: TTS_MODEL_ASSET_URLS.persistent_id,
  });
}

function buildSttRecognizerConfig(options: {
  family: string;
  files: SttModelAssetsResponse;
  language?: string;
  task?: "transcribe" | "translate";
}) {
  const tokens = `/${getFileNameFromUrl(options.files.tokens, "tokens")}`;

  if (options.family === "whisper") {
    if (!options.files.encoder || !options.files.decoder) {
      throw new Error("Whisper STT manifest is missing encoder or decoder.");
    }

    return {
      modelConfig: {
        whisper: {
          encoder: `/${getFileNameFromUrl(options.files.encoder, "encoder")}`,
          decoder: `/${getFileNameFromUrl(options.files.decoder, "decoder")}`,
          language: options.language || "en",
          task: options.task || "transcribe",
          tailPaddings: -1,
        },
        tokens,
        modelType: "whisper",
        provider: "cpu",
        numThreads: 1,
        debug: 0,
      },
      decodingMethod: "greedy_search",
      maxActivePaths: 4,
    };
  }

  if (options.family === "moonshine") {
    if (
      !options.files.preprocessor ||
      !options.files.encoder ||
      !options.files.uncached_decoder ||
      !options.files.cached_decoder
    ) {
      throw new Error("Moonshine STT manifest is missing required files.");
    }

    return {
      modelConfig: {
        moonshine: {
          preprocessor: `/${getFileNameFromUrl(options.files.preprocessor, "preprocessor")}`,
          encoder: `/${getFileNameFromUrl(options.files.encoder, "encoder")}`,
          uncachedDecoder: `/${getFileNameFromUrl(options.files.uncached_decoder, "uncached decoder")}`,
          cachedDecoder: `/${getFileNameFromUrl(options.files.cached_decoder, "cached decoder")}`,
        },
        tokens,
        provider: "cpu",
        numThreads: 1,
        debug: 0,
      },
      decodingMethod: "greedy_search",
      maxActivePaths: 4,
    };
  }

  throw new Error(`Unsupported STT family: ${options.family}`);
}

function supportsStreamingSttFamily(family: string): boolean {
  return family === "zipformer-transducer";
}

function buildStreamingSttRecognizerConfig(options: {
  family: string;
  files: SttModelAssetsResponse;
}) {
  const tokens = `/${getFileNameFromUrl(options.files.tokens, "tokens")}`;

  if (options.family === "zipformer-transducer") {
    if (!options.files.encoder || !options.files.decoder || !options.files.joiner) {
      throw new Error("Streaming Zipformer STT manifest is missing encoder, decoder, or joiner.");
    }

    return {
      featConfig: {
        sampleRate: 16000,
        featureDim: 80,
      },
      modelConfig: {
        transducer: {
          encoder: `/${getFileNameFromUrl(options.files.encoder, "encoder")}`,
          decoder: `/${getFileNameFromUrl(options.files.decoder, "decoder")}`,
          joiner: `/${getFileNameFromUrl(options.files.joiner, "joiner")}`,
        },
        tokens,
        provider: "cpu",
        numThreads: 1,
        debug: 0,
      },
      decodingMethod: "greedy_search",
      maxActivePaths: 4,
      enableEndpoint: 1,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: 1.2,
      rule3MinUtteranceLength: 20,
      hotwordsFile: "",
      hotwordsScore: 1.5,
      ruleFsts: "",
      ruleFars: "",
      blankPenalty: 0,
      ctcFstDecoderConfig: {
        graph: "",
        maxActive: 3000,
      },
    };
  }

  throw new Error(`Unsupported streaming STT family: ${options.family}`);
}

function closeAllSttSessions(): void {
  for (const stream of STT_SESSIONS.values()) {
    stream.free();
  }
  STT_SESSIONS.clear();
}

function requireStreamingSession(sessionId: number) {
  const session = STT_SESSIONS.get(sessionId);
  if (!session) {
    throw new Error(`Unknown STT session: ${sessionId}`);
  }
  if (!ONLINE_STT || !STT_MODEL_ID) {
    throw new Error("Streaming STT model is not loaded.");
  }

  return session;
}

function decodeOnlineSession(stream: ReturnType<ReturnType<typeof createOnlineRecognizer>["createStream"]>): void {
  if (!ONLINE_STT) {
    throw new Error("Streaming STT model is not loaded.");
  }

  while (ONLINE_STT.isReady(stream)) {
    ONLINE_STT.decode(stream);
  }
}

function toStreamingResult(rawResult: Record<string, unknown>, isEndpoint: boolean) {
  if (!STT_MODEL_ID) {
    throw new Error("STT model id is not available.");
  }

  return {
    text: typeof rawResult.text === "string" ? rawResult.text : "",
    modelId: STT_MODEL_ID,
    isEndpoint,
    json: JSON.stringify(rawResult),
  };
}

async function handleLoadSttModel(
  id: number,
  options: Extract<WorkerRequest, { type: "stt-load-model" }>,
): Promise<void> {
  STT_MODEL_ASSET_URLS = await getSttModelAssets(
    options.modelId,
    WEB_PLATFORM,
    WFLOAT_WEB_VERSION,
    SHERPA_ONNX_VERSION,
    options.modelAssetHost,
    options.persistentId,
  );
  STT_MODEL_ID = options.modelId;

  closeAllSttSessions();

  if (OFFLINE_STT) {
    OFFLINE_STT.free();
    OFFLINE_STT = null;
  }

  if (ONLINE_STT) {
    ONLINE_STT.free();
    ONLINE_STT = null;
  }

  const sherpaModule = await getSherpaSpeechModule({
    wasm_binary: STT_MODEL_ASSET_URLS.wasm_binary,
    wasm_data: STT_MODEL_ASSET_URLS.wasm_data,
  });
  const fileEntries = [
    ["tokens", STT_MODEL_ASSET_URLS.tokens],
    ["encoder", STT_MODEL_ASSET_URLS.encoder],
    ["decoder", STT_MODEL_ASSET_URLS.decoder],
    ["preprocessor", STT_MODEL_ASSET_URLS.preprocessor],
    ["joiner", STT_MODEL_ASSET_URLS.joiner],
    ["uncached_decoder", STT_MODEL_ASSET_URLS.uncached_decoder],
    ["cached_decoder", STT_MODEL_ASSET_URLS.cached_decoder],
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string");

  const totalFiles = Math.max(fileEntries.length, 1);
  let completedFiles = 0;
  for (const [label, remoteUrl] of fileEntries) {
    const targetName = getFileNameFromUrl(remoteUrl, label);
    await writeModuleFileFromUrl(sherpaModule, remoteUrl, targetName);
    completedFiles += 1;
    postResponse({
      id,
      type: "stt-load-model-progress",
      event: {
        status: "downloading",
        progress: completedFiles / totalFiles,
      },
    });
  }

  postResponse({
    id,
    type: "stt-load-model-progress",
    event: { status: "loading" },
  });

  const supportsStreaming = supportsStreamingSttFamily(STT_MODEL_ASSET_URLS.family);
  if (supportsStreaming) {
    ONLINE_STT = createOnlineRecognizer(
      sherpaModule,
      buildStreamingSttRecognizerConfig({
        family: STT_MODEL_ASSET_URLS.family,
        files: STT_MODEL_ASSET_URLS,
      }),
    );
  } else {
    OFFLINE_STT = new OfflineRecognizer(
      buildSttRecognizerConfig({
        family: STT_MODEL_ASSET_URLS.family,
        files: STT_MODEL_ASSET_URLS,
        language: options.language,
        task: options.task,
      }),
      sherpaModule,
    );
  }

  postResponse({
    id,
    type: "stt-load-model-done",
    family: STT_MODEL_ASSET_URLS.family,
    supportsStreaming,
    persistentId: STT_MODEL_ASSET_URLS.persistent_id,
  });
}

async function handleSttTranscribe(
  id: number,
  samples: Float32Array,
  sampleRate: number,
): Promise<void> {
  if (ONLINE_STT && !OFFLINE_STT) {
    throw new Error(
      "The loaded STT model supports streaming sessions only. Use createSession() instead of transcribe().",
    );
  }

  if (!OFFLINE_STT || !STT_MODEL_ASSET_URLS || !STT_MODEL_ID) {
    throw new Error("STT model is not loaded. Call loadSttModel(...) first.");
  }

  const stream = OFFLINE_STT.createStream();
  try {
    stream.acceptWaveform(sampleRate, samples);
    OFFLINE_STT.decode(stream);
    const rawResult = OFFLINE_STT.getResult(stream) as Record<string, unknown>;

    const tokens = coerceStringArray(rawResult.tokens);
    const timestamps = coerceNumberArray(rawResult.timestamps);
    const durations = coerceNumberArray(rawResult.durations);
    const confidences = coerceNumberArray(rawResult.ys_log_probs);
    const segmentTexts = coerceStringArray(rawResult.segment_texts);
    const segmentTimestamps = coerceNumberArray(rawResult.segment_timestamps);
    const segmentDurations = coerceNumberArray(rawResult.segment_durations);

    postResponse({
      id,
      type: "stt-transcribe-done",
      result: {
        text: typeof rawResult.text === "string" ? rawResult.text : "",
        modelId: STT_MODEL_ID,
        language: typeof rawResult.lang === "string" ? rawResult.lang : "",
        emotion: typeof rawResult.emotion === "string" ? rawResult.emotion : "",
        event: typeof rawResult.event === "string" ? rawResult.event : "",
        json: JSON.stringify(rawResult),
        tokens:
          tokens.length > 0
            ? tokens.map((text, index) => ({
                text,
                startSec: timestamps[index] ?? 0,
                durationSec: durations[index] ?? 0,
                confidence: confidences[index] ?? 0,
              }))
            : undefined,
        segments:
          segmentTexts.length > 0
            ? segmentTexts.map((text, index) => ({
                text,
                startSec: segmentTimestamps[index] ?? 0,
                durationSec: segmentDurations[index] ?? 0,
              }))
            : undefined,
      },
    });
  } finally {
    stream.free();
  }
}

async function handleSttCreateSession(id: number): Promise<void> {
  if (!ONLINE_STT) {
    throw new Error("Streaming STT model is not loaded.");
  }

  const sessionId = NEXT_STT_SESSION_ID;
  NEXT_STT_SESSION_ID += 1;
  STT_SESSIONS.set(sessionId, ONLINE_STT.createStream());

  postResponse({
    id,
    type: "stt-create-session-done",
    sessionId,
  });
}

async function handleSttSessionPush(
  id: number,
  sessionId: number,
  samples: Float32Array,
  sampleRate: number,
): Promise<void> {
  const session = requireStreamingSession(sessionId);
  session.acceptWaveform(sampleRate, samples);
  decodeOnlineSession(session);
  postResponse({ id, type: "stt-session-push-done" });
}

async function handleSttSessionGetResult(id: number, sessionId: number): Promise<void> {
  const session = requireStreamingSession(sessionId);
  decodeOnlineSession(session);
  const rawResult = ONLINE_STT!.getResult(session) as Record<string, unknown>;
  postResponse({
    id,
    type: "stt-session-get-result-done",
    result: toStreamingResult(rawResult, ONLINE_STT!.isEndpoint(session)),
  });
}

async function handleSttSessionFinish(id: number, sessionId: number): Promise<void> {
  const session = requireStreamingSession(sessionId);
  session.inputFinished();
  decodeOnlineSession(session);
  const rawResult = ONLINE_STT!.getResult(session) as Record<string, unknown>;
  postResponse({
    id,
    type: "stt-session-finish-done",
    result: toStreamingResult(rawResult, ONLINE_STT!.isEndpoint(session)),
  });
}

async function handleSttSessionReset(id: number, sessionId: number): Promise<void> {
  const session = requireStreamingSession(sessionId);
  ONLINE_STT!.reset(session);
  postResponse({ id, type: "stt-session-reset-done" });
}

async function handleSttSessionClose(id: number, sessionId: number): Promise<void> {
  const session = requireStreamingSession(sessionId);
  session.free();
  STT_SESSIONS.delete(sessionId);
  postResponse({ id, type: "stt-session-close-done" });
}

function finiteNumberOrDefault(value: number | undefined, defaultValue: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
}

function buildVadConfig(options: {
  family: string;
  modelPath: string;
  threshold?: number;
  minSilenceDurationSec?: number;
  minSpeechDurationSec?: number;
  maxSpeechDurationSec?: number;
}) {
  const common = {
    threshold: finiteNumberOrDefault(options.threshold, 0.5),
    minSilenceDuration: finiteNumberOrDefault(options.minSilenceDurationSec, 0.5),
    minSpeechDuration: finiteNumberOrDefault(options.minSpeechDurationSec, 0.25),
    maxSpeechDuration: finiteNumberOrDefault(options.maxSpeechDurationSec, 20),
  };
  const normalizedFamily = options.family.toLowerCase().replace(/_/g, "-");

  if (normalizedFamily === "silero" || normalizedFamily === "silero-vad") {
    return {
      sileroVad: {
        model: options.modelPath,
        ...common,
        windowSize: 512,
      },
      tenVad: {
        model: "",
        ...common,
        windowSize: 256,
      },
      sampleRate: 16000,
      numThreads: 1,
      provider: "cpu",
      debug: 0,
      bufferSizeInSeconds: 30,
    };
  }

  if (normalizedFamily === "ten-vad" || normalizedFamily === "tenvad") {
    return {
      sileroVad: {
        model: "",
        ...common,
        windowSize: 512,
      },
      tenVad: {
        model: options.modelPath,
        ...common,
        windowSize: 256,
      },
      sampleRate: 16000,
      numThreads: 1,
      provider: "cpu",
      debug: 0,
      bufferSizeInSeconds: 30,
    };
  }

  throw new Error(`Unsupported VAD family: ${options.family}`);
}

async function handleLoadVadModel(
  id: number,
  options: Extract<WorkerRequest, { type: "vad-load-model" }>,
): Promise<void> {
  VAD_MODEL_ASSET_URLS = await getVadModelAssets(
    options.modelId,
    WEB_PLATFORM,
    WFLOAT_WEB_VERSION,
    SHERPA_ONNX_VERSION,
    options.modelAssetHost,
    options.persistentId,
  );
  VAD_MODEL_ID = options.modelId;

  if (VAD) {
    VAD.free();
    VAD = null;
  }
  VAD_SESSIONS.clear();

  const sherpaModule = await getSherpaSpeechModule({
    wasm_binary: VAD_MODEL_ASSET_URLS.wasm_binary,
    wasm_data: VAD_MODEL_ASSET_URLS.wasm_data,
  });
  const targetName = getFileNameFromUrl(VAD_MODEL_ASSET_URLS.model, "VAD model");
  await writeModuleFileFromUrl(sherpaModule, VAD_MODEL_ASSET_URLS.model, targetName);

  postResponse({
    id,
    type: "vad-load-model-progress",
    event: {
      status: "downloading",
      progress: 1,
    },
  });

  postResponse({
    id,
    type: "vad-load-model-progress",
    event: { status: "loading" },
  });

  VAD = createVad(
    sherpaModule,
    buildVadConfig({
      family: VAD_MODEL_ASSET_URLS.family,
      modelPath: `/${targetName}`,
      threshold: options.threshold,
      minSilenceDurationSec: options.minSilenceDurationSec,
      minSpeechDurationSec: options.minSpeechDurationSec,
      maxSpeechDurationSec: options.maxSpeechDurationSec,
    }),
  );

  postResponse({
    id,
    type: "vad-load-model-done",
    family: VAD_MODEL_ASSET_URLS.family,
    persistentId: VAD_MODEL_ASSET_URLS.persistent_id,
  });
}

async function handleVadDetect(
  id: number,
  samples: Float32Array,
  sampleRate: number,
): Promise<void> {
  if (!VAD || !VAD_MODEL_ASSET_URLS || !VAD_MODEL_ID) {
    throw new Error("VAD model is not loaded. Call loadVadModel(...) first.");
  }

  VAD.reset();

  const windowSize = VAD_MODEL_ASSET_URLS.family.toLowerCase().includes("ten") ? 256 : 512;
  for (let offset = 0; offset < samples.length; offset += windowSize) {
    VAD.acceptWaveform(samples.subarray(offset, Math.min(offset + windowSize, samples.length)));
  }
  VAD.flush();

  let speechSampleCount = 0;
  const segments = [];
  while (!VAD.isEmpty()) {
    const segment = VAD.front();
    speechSampleCount += segment.samples.length;
    segments.push({
      startSec: segment.start / sampleRate,
      durationSec: segment.samples.length / sampleRate,
      endSec: (segment.start + segment.samples.length) / sampleRate,
      startSample: segment.start,
      sampleCount: segment.samples.length,
      sampleRate,
      audio: segment.samples,
    });
    VAD.pop();
  }

  postResponse({
    id,
    type: "vad-detect-done",
    result: {
      modelId: VAD_MODEL_ID,
      segments,
      speechRatio: samples.length > 0 ? Math.min(speechSampleCount / samples.length, 1) : 0,
    },
  });
}

function vadWindowSize(): number {
  return VAD_MODEL_ASSET_URLS?.family.toLowerCase().includes("ten") ? 256 : 512;
}

function requireVadSession(sessionId: number): VadSessionState {
  const session = VAD_SESSIONS.get(sessionId);
  if (!session) {
    throw new Error(`Unknown VAD session: ${sessionId}`);
  }
  return session;
}

function concatFloat32(left: Float32Array, right: Float32Array): Float32Array {
  if (left.length === 0) {
    return new Float32Array(right);
  }
  if (right.length === 0) {
    return left;
  }

  const output = new Float32Array(left.length + right.length);
  output.set(left, 0);
  output.set(right, left.length);
  return output;
}

function vadSegmentToResult(segment: { samples: Float32Array; start: number }, sampleRate: number): VadSegment {
  return {
    startSec: segment.start / sampleRate,
    durationSec: segment.samples.length / sampleRate,
    endSec: (segment.start + segment.samples.length) / sampleRate,
    startSample: segment.start,
    sampleCount: segment.samples.length,
    sampleRate,
    audio: segment.samples,
  };
}

function drainVadSessionSegments(session: VadSessionState, sampleRate: number): VadSegment[] {
  if (!VAD) {
    return [];
  }

  const segments: VadSegment[] = [];
  while (!VAD.isEmpty()) {
    const segment = VAD.front();
    segments.push(vadSegmentToResult(segment, sampleRate));
    session.speechEndCount += 1;
    VAD.pop();
  }
  return segments;
}

async function handleVadCreateSession(id: number): Promise<void> {
  if (!VAD || !VAD_MODEL_ASSET_URLS || !VAD_MODEL_ID) {
    throw new Error("VAD model is not loaded. Call loadVadModel(...) first.");
  }

  if (VAD_SESSIONS.size > 0) {
    throw new Error("A live VAD session is already active.");
  }

  const sessionId = NEXT_VAD_SESSION_ID;
  NEXT_VAD_SESSION_ID += 1;
  VAD.reset();
  VAD_SESSIONS.set(sessionId, {
    id: sessionId,
    pendingSamples: new Float32Array(0),
    sampleRate: 16000,
    processedSampleCount: 0,
    speechDetected: false,
    emittedWindowCount: 0,
    speechStartCount: 0,
    speechEndCount: 0,
  });

  postResponse({
    id,
    type: "vad-create-session-done",
    sessionId,
  });
}

async function handleVadSessionPush(
  id: number,
  sessionId: number,
  samples: Float32Array,
  sampleRate: number,
): Promise<void> {
  if (!VAD || !VAD_MODEL_ID) {
    throw new Error("VAD model is not loaded. Call loadVadModel(...) first.");
  }

  const session = requireVadSession(sessionId);
  session.sampleRate = sampleRate;
  const windowSize = vadWindowSize();
  const speechStarts: VadSpeechStartEvent[] = [];
  const segments: VadSegment[] = [];
  let pending = concatFloat32(session.pendingSamples, samples);

  while (pending.length >= windowSize) {
    const window = pending.slice(0, windowSize);
    pending = pending.slice(windowSize);

    VAD.acceptWaveform(window);
    session.emittedWindowCount += 1;
    session.processedSampleCount += windowSize;

    const detected = VAD.isDetected();
    if (detected && !session.speechDetected) {
      session.speechStartCount += 1;
      const startSample = Math.max(0, session.processedSampleCount - windowSize);
      speechStarts.push({
        modelId: VAD_MODEL_ID,
        sampleRate,
        startSample,
        startSec: startSample / sampleRate,
      });
    }

    session.speechDetected = detected;
    segments.push(...drainVadSessionSegments(session, sampleRate));
  }

  session.pendingSamples = pending;
  postResponse({
    id,
    type: "vad-session-push-done",
    speechStarts,
    segments,
    emittedWindowCount: session.emittedWindowCount,
    speechStartCount: session.speechStartCount,
    speechEndCount: session.speechEndCount,
  });
}

async function handleVadSessionFinish(id: number, sessionId: number): Promise<void> {
  if (!VAD) {
    throw new Error("VAD model is not loaded. Call loadVadModel(...) first.");
  }

  const session = requireVadSession(sessionId);
  VAD.flush();
  const segments = drainVadSessionSegments(session, session.sampleRate);
  postResponse({
    id,
    type: "vad-session-finish-done",
    segments,
    emittedWindowCount: session.emittedWindowCount,
    speechStartCount: session.speechStartCount,
    speechEndCount: session.speechEndCount,
  });
}

async function handleVadSessionReset(id: number, sessionId: number): Promise<void> {
  const session = requireVadSession(sessionId);
  if (VAD) {
    VAD.reset();
  }
  session.pendingSamples = new Float32Array(0);
  session.processedSampleCount = 0;
  session.speechDetected = false;
  session.emittedWindowCount = 0;
  session.speechStartCount = 0;
  session.speechEndCount = 0;
  postResponse({ id, type: "vad-session-reset-done" });
}

async function handleVadSessionClose(id: number, sessionId: number): Promise<void> {
  requireVadSession(sessionId);
  VAD_SESSIONS.delete(sessionId);
  postResponse({ id, type: "vad-session-close-done" });
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function handleSpeechGenerate(
  id: number,
  options: SpeechGenerateWorkerOptions,
): Promise<void> {
  // this.status = "generating";
  const sherpaModule = await getSherpaSpeechModule({
    wasm_binary: TTS_MODEL_ASSET_URLS!.wasm_binary,
    wasm_data: TTS_MODEL_ASSET_URLS!.wasm_data,
  });

  if (!TTS) {
    throw new Error("TTS model is not loaded. Call loadTtsModel(...) first.");
  }

  const text = options.text;
  if (!text) {
    throw new Error("text is required.");
  }

  let emotion: TtsEmotion = "neutral";
  if (VALID_EMOTIONS.includes(options.emotion as TtsEmotion)) {
    emotion = options.emotion as TtsEmotion;
  }

  let intensity = 0.5;
  if (
    typeof options.intensity === "number" &&
    Number.isFinite(options.intensity) &&
    options.intensity >= 0 &&
    options.intensity <= 1
  ) {
    intensity = options.intensity;
  }

  let speed = 1.0;
  if (typeof options.speed === "number" && Number.isFinite(options.speed)) {
    speed = options.speed;
  }

  let silencePaddingSec = 0.1;
  if (
    typeof options.silencePaddingSec === "number" &&
    Number.isFinite(options.silencePaddingSec) &&
    options.silencePaddingSec >= 0
  ) {
    silencePaddingSec = options.silencePaddingSec;
  }

  let sid = 0;
  if (typeof options.voiceId === "number") {
    if (!Number.isInteger(options.voiceId) || !VALID_SIDS.includes(options.voiceId)) {
      throw new Error(`Invalid numeric voiceId: ${options.voiceId}`);
    }
    sid = options.voiceId;
  } else if (typeof options.voiceId === "string") {
    const voiceName = options.voiceId.trim();
    if (!voiceName) {
      sid = 0;
    } else {
      const mappedSid = SPEAKER_IDS[voiceName];
      if (mappedSid !== undefined) {
        sid = mappedSid;
      } else {
        throw new Error(`Invalid string voiceId: ${voiceName}`);
      }
    }
  }

  const preparedInput = prepareWfloatText(
    sherpaModule,
    {
      text,
      emotion,
      intensity,
    },
    TTS.handle,
  );

  // console.log("preparedInput", preparedInput);

  let tRuntime = 0;
  const tStart = performance.now();
  let rawTextCursor = 0;

  for (let i = 0; i < preparedInput.textClean.length; i++) {
    const tStartChunk = performance.now();
    const textClean = preparedInput.textClean[i];

    // if (id !== CURRENT_GENERATE_ID) {
    //   postResponse({ id, type: "speech-terminate-early-done" });
    //   return;
    // }
    const result = TTS.generate({
      text: preparedInput.textClean[i],
      sid,
      speed,
    });

    const progress = (i + 1) / preparedInput.textClean.length;

    const chunkRuntimeSec = (performance.now() - tStartChunk) / 1000;
    tRuntime = performance.now() - tStart;
    let phonemesPerSec = (preparedInput.textPhonemes[i].length - 2) / chunkRuntimeSec;
    let audioSecPerPhoneme =
      result.samples.length / result.sampleRate / (preparedInput.textPhonemes[i].length - 2);
    // phonemesPerSec = 30;
    const preventOverrunConstant = 0.75;
    phonemesPerSec *= preventOverrunConstant;
    audioSecPerPhoneme *= preventOverrunConstant;

    const tPlayAudio =
      computeStartTime(preparedInput.textPhonemes, phonemesPerSec, audioSecPerPhoneme) * 1000;
    const rawChunkText = preparedInput.text[i] ?? "";
    const highlightStart = rawTextCursor;
    const highlightEnd = rawTextCursor + rawChunkText.length;
    rawTextCursor = highlightEnd;

    await sleep(10);

    if (EARLY_STOP_MESSAGE_ID) {
      const earlyStopId = EARLY_STOP_MESSAGE_ID;
      EARLY_STOP_MESSAGE_ID = null;
      postResponse({ id, type: "speech-generate-done" });
      console.log("called speech-generate-done EARLY");
      postResponse({ id: earlyStopId, type: "speech-terminate-early-done" });
      return;
    }

    // console.log(`📢TPLAYAUDIO: ${tPlayAudio}`);

    postResponse(
      {
        id,
        type: "speech-generate-chunk",
        samples: result.samples,
        index: i,
        silencePaddingSec,
        progress,
        tPlayAudio: tPlayAudio!,
        tRuntime: tRuntime,
        highlightStart,
        highlightEnd,
        text: rawChunkText,
      },
      // [result.samples.buffer],
    );
  }

  postResponse({ id, type: "speech-generate-done" });
}

async function handleSpeechGenerateDialogue(
  id: number,
  options: SpeechGenerateDialogueWorkerOptions,
): Promise<void> {
  // this.status = "generating";
  const sherpaModule = await getSherpaSpeechModule({
    wasm_binary: TTS_MODEL_ASSET_URLS!.wasm_binary,
    wasm_data: TTS_MODEL_ASSET_URLS!.wasm_data,
  });

  if (!TTS) {
    throw new Error("TTS model is not loaded. Call loadTtsModel(...) first.");
  }

  const segments = options.segments;
  if (!segments?.length) {
    throw new Error("segments is required.");
  }

  let defaultSpeed = 1.0;
  if (typeof options.speed === "number" && Number.isFinite(options.speed)) {
    defaultSpeed = options.speed;
  }

  let silenceBetweenSegmentsSec = 0.2;
  if (
    typeof options.silenceBetweenSegmentsSec === "number" &&
    Number.isFinite(options.silenceBetweenSegmentsSec) &&
    options.silenceBetweenSegmentsSec >= 0
  ) {
    silenceBetweenSegmentsSec = options.silenceBetweenSegmentsSec;
  }

  const segmentsWithDefaults = segments.map((segment) => {
    let emotion: TtsEmotion = "neutral";
    if (VALID_EMOTIONS.includes(segment.emotion as TtsEmotion)) {
      emotion = segment.emotion as TtsEmotion;
    }

    let intensity = 0.5;
    if (
      typeof segment.intensity === "number" &&
      Number.isFinite(segment.intensity) &&
      segment.intensity >= 0 &&
      segment.intensity <= 1
    ) {
      intensity = segment.intensity;
    }

    let speed = defaultSpeed;
    if (typeof segment.speed === "number" && Number.isFinite(segment.speed)) {
      speed = segment.speed;
    }

    let sentenceSilencePaddingSec = 0.1;
    if (
      typeof segment.sentenceSilencePaddingSec === "number" &&
      Number.isFinite(segment.sentenceSilencePaddingSec) &&
      segment.sentenceSilencePaddingSec >= 0
    ) {
      sentenceSilencePaddingSec = segment.sentenceSilencePaddingSec;
    }

    let sid = 0;
    if (typeof segment.voiceId === "number") {
      if (!Number.isInteger(segment.voiceId) || !VALID_SIDS.includes(segment.voiceId)) {
        throw new Error(`Invalid numeric voiceId: ${segment.voiceId}`);
      }
      sid = segment.voiceId;
    } else if (typeof segment.voiceId === "string") {
      const voiceName = segment.voiceId.trim();
      if (voiceName) {
        const mappedSid = SPEAKER_IDS[voiceName];
        if (mappedSid !== undefined) {
          sid = mappedSid;
        } else {
          throw new Error(`Invalid string voiceId: ${voiceName}`);
        }
      }
    }

    return {
      ...segment,
      emotion,
      intensity,
      speed,
      sentenceSilencePaddingSec,
      sid,
    };
  });

  // const text = segmentsWithDefaults.map((segment) => segment.text).join(" ");
  // const firstSegment = segmentsWithDefaults[0];
  // const emotion = firstSegment.emotion;
  // const intensity = firstSegment.intensity;
  // const speed = firstSegment.speed;
  // const silencePaddingSec = firstSegment.silencePaddingEndSec;
  // const sid = firstSegment.sid;

  const preparedInputs = segmentsWithDefaults.map((e) =>
    prepareWfloatText(
      sherpaModule,
      {
        text: e.text,
        emotion: e.emotion,
        intensity: e.intensity,
      },
      TTS!.handle,
    ),
  );

  // console.log("preparedInput", preparedInput);

  let tRuntime = 0;
  const tStart = performance.now();
  let progressIndex = 0;
  let totalChunks = 0;
  let textPhonemesFlattened: string[] = [];
  for (let i = 0; i < segmentsWithDefaults.length; i++) {
    for (let j = 0; j < preparedInputs[i].textClean.length; j++) {
      totalChunks += 1;
      textPhonemesFlattened.push(preparedInputs[i].textPhonemes[j]);
    }
  }

  for (let i = 0; i < segmentsWithDefaults.length; i++) {
    let rawTextCursor = 0;

    for (let j = 0; j < preparedInputs[i].textClean.length; j++) {
      const tStartChunk = performance.now();
      const textClean = preparedInputs[i].textClean[j];
      const result = TTS.generate({
        text: textClean,
        sid: segmentsWithDefaults[i].sid,
        speed: segmentsWithDefaults[i].speed,
      });

      progressIndex += 1;
      const progress = progressIndex / totalChunks;

      const chunkRuntimeSec = (performance.now() - tStartChunk) / 1000;
      tRuntime = performance.now() - tStart;
      let phonemesPerSec = (preparedInputs[i].textPhonemes[j].length - 2) / chunkRuntimeSec;
      let audioSecPerPhoneme =
        result.samples.length / result.sampleRate / (preparedInputs[i].textPhonemes[j].length - 2);
      // phonemesPerSec = 30;
      const preventOverrunConstant = 0.75;
      phonemesPerSec *= preventOverrunConstant;
      audioSecPerPhoneme *= preventOverrunConstant;

      const tPlayAudio =
        computeStartTime(textPhonemesFlattened, phonemesPerSec, audioSecPerPhoneme) * 1000;
      const rawChunkText = preparedInputs[i].text[j] ?? "";
      const highlightStart = rawTextCursor;
      const highlightEnd = rawTextCursor + rawChunkText.length;
      rawTextCursor = highlightEnd;

      await sleep(10);

      if (EARLY_STOP_MESSAGE_ID) {
        const earlyStopId = EARLY_STOP_MESSAGE_ID;
        EARLY_STOP_MESSAGE_ID = null;
        postResponse({ id, type: "speech-generate-done" });
        console.log("called speech-generate-done EARLY");
        postResponse({ id: earlyStopId, type: "speech-terminate-early-done" });
        return;
      }

      // console.log(`📢TPLAYAUDIO: ${tPlayAudio}`);

      let silencePaddingSec = segmentsWithDefaults[i].sentenceSilencePaddingSec;
      if (j === preparedInputs[i].textClean.length - 1) {
        silencePaddingSec = silenceBetweenSegmentsSec;
      }

      postResponse(
        {
          id,
          type: "speech-generate-chunk",
          samples: result.samples,
          index: i,
          silencePaddingSec,
          progress,
          tPlayAudio: tPlayAudio!,
          tRuntime: tRuntime,
          highlightStart,
          highlightEnd,
          textHighlightSegment: i,
          text: rawChunkText,
        },
        // [result.samples.buffer],
      );
    }
  }

  postResponse({ id, type: "speech-generate-done" });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  try {
    if (message.type === "speech-load-model") {
      await handleLoadSpeechModel(message.id, message.modelId, message.modelAssetHost, message.persistentId);
      return;
    }

    if (message.type === "speech-generate") {
      // CURRENT_GENERATE_ID = message.id;
      await handleSpeechGenerate(message.id, message.options);
      return;
    }

    if (message.type === "speech-generate-dialogue") {
      // CURRENT_GENERATE_ID = message.id;
      await handleSpeechGenerateDialogue(message.id, message.options);
      return;
    }

    if (message.type === "speech-terminate-early") {
      console.log(`MESSAGE RECEIVED speech-terminate-early ${message.id}`);
      // DO_EARLY_STOP = true;
      EARLY_STOP_MESSAGE_ID = message.id;
      return;
    }

    if (message.type === "stt-load-model") {
      await handleLoadSttModel(message.id, message);
      return;
    }

    if (message.type === "stt-transcribe") {
      await handleSttTranscribe(message.id, message.samples, message.sampleRate);
      return;
    }

    if (message.type === "stt-create-session") {
      await handleSttCreateSession(message.id);
      return;
    }

    if (message.type === "stt-session-push") {
      await handleSttSessionPush(message.id, message.sessionId, message.samples, message.sampleRate);
      return;
    }

    if (message.type === "stt-session-get-result") {
      await handleSttSessionGetResult(message.id, message.sessionId);
      return;
    }

    if (message.type === "stt-session-finish") {
      await handleSttSessionFinish(message.id, message.sessionId);
      return;
    }

    if (message.type === "stt-session-reset") {
      await handleSttSessionReset(message.id, message.sessionId);
      return;
    }

    if (message.type === "stt-session-close") {
      await handleSttSessionClose(message.id, message.sessionId);
      return;
    }

    if (message.type === "vad-load-model") {
      await handleLoadVadModel(message.id, message);
      return;
    }

    if (message.type === "vad-detect") {
      await handleVadDetect(message.id, message.samples, message.sampleRate);
      return;
    }

    if (message.type === "vad-create-session") {
      await handleVadCreateSession(message.id);
      return;
    }

    if (message.type === "vad-session-push") {
      await handleVadSessionPush(message.id, message.sessionId, message.samples, message.sampleRate);
      return;
    }

    if (message.type === "vad-session-finish") {
      await handleVadSessionFinish(message.id, message.sessionId);
      return;
    }

    if (message.type === "vad-session-reset") {
      await handleVadSessionReset(message.id, message.sessionId);
      return;
    }

    if (message.type === "vad-session-close") {
      await handleVadSessionClose(message.id, message.sessionId);
      return;
    }
  } catch (error) {
    postResponse({
      id: message.id,
      type: "request-error",
      error: describeUnknownError(error),
    });
  }
};
