import {
  SherpaModule,
  ModuleConfig,
  OfflineTts,
  createOfflineTts,
  prepareWfloatText,
} from "../wasm/sherpa-onnx-tts.js";
import { SPEAKER_IDS, VALID_EMOTIONS, VALID_SIDS } from "../tts/catalog.js";
import type { TtsEmotion } from "../tts/types.js";
// @ts-ignore
import createSherpaModule from "../wasm/sherpa-onnx-wasm-main-tts.js";
import {
  ModelAssetsResponse,
  SpeechGenerateDialogueWorkerOptions,
  SpeechGenerateWorkerOptions,
  WorkerRequest,
  WorkerResponse,
} from "./workerTypes.js";
import { computeStartTime } from "../util/schedulingUtil.js";

let SherpaModuleInstancePromise: Promise<SherpaModule>;
let TTS: OfflineTts | null = null;
// let CURRENT_GENERATE_ID: number | null = null;
// let DO_EARLY_STOP: Boolean = false;
let EARLY_STOP_MESSAGE_ID: number | null = null;

let MODEL_ASSET_URLS: ModelAssetsResponse | null = null;
// const REGISTRY_URL = "http://192.168.1.239:8000/assets"; // "http://localhost:8000/assets";
// MODEL_ASSET_URLS = {
//   model_onnx: "",
//   model_tokens: "",
//   wasm_binary: `${REGISTRY_URL}/sherpa-onnx-wasm-simd-tts/1.13.0/sherpa-onnx-wasm-main-tts.wasm`,
//   wasm_data: `${REGISTRY_URL}/sherpa-onnx-wasm-simd-tts/1.13.0/sherpa-onnx-wasm-main-tts.data`,
// };

const defaultModuleConfig: ModuleConfig = {
  locateFile: (path: string) => {
    if (path.endsWith(".wasm")) return MODEL_ASSET_URLS!.wasm_binary;
    if (path.endsWith(".data")) return MODEL_ASSET_URLS!.wasm_data;
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
  persistentId?: string,
): Promise<ModelAssetsResponse> {
  const params = new URLSearchParams();
  params.set("model_id", modelId);
  params.set("platform", platform);
  params.set("version", version);
  if (persistentId) {
    params.set("persistent_id", persistentId);
  }

  const HOST = "https://wfloat.com";
  const response = await fetch(`${HOST}/api/model-assets?${params.toString()}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  const data: ModelAssetsResponse = await response.json();
  return data;
}

async function getSherpaModule() {
  if (!SherpaModuleInstancePromise) {
    SherpaModuleInstancePromise = createSherpaModule(defaultModuleConfig);
  }
  return SherpaModuleInstancePromise;
}

function postResponse(message: WorkerResponse, transfer: Transferable[] = []): void {
  (
    self as unknown as { postMessage: (value: WorkerResponse, transfer: Transferable[]) => void }
  ).postMessage(message, transfer);
}

async function handleLoadSpeechModel(
  id: number,
  modelId: string,
  persistentId?: string,
): Promise<void> {
  const PLATFORM = "web";
  const VERSION = "1.5.2";
  MODEL_ASSET_URLS = await getModelAssets(modelId, PLATFORM, VERSION, persistentId);
  const MODEL_NAME = new URL(MODEL_ASSET_URLS!.model_onnx).pathname.split("/").pop();
  const TOKENS_NAME = new URL(MODEL_ASSET_URLS!.model_tokens).pathname.split("/").pop();

  if (TTS) {
    TTS.free();
    TTS = null;
  }

  let isSherpaModuleResolved = false;
  const sherpaModulePromise = getSherpaModule().then((module) => {
    isSherpaModuleResolved = true;
    return module;
  });

  const response = await fetch(MODEL_ASSET_URLS.model_onnx);
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

  const tokensResponse = await fetch(MODEL_ASSET_URLS.model_tokens);
  if (!tokensResponse.ok) {
    throw new Error("Failed to fetch tokens.txt");
  }
  const tokensText = await tokensResponse.text();
  sherpaModule.FS.writeFile(`/${TOKENS_NAME}`, tokensText);

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
    persistentId: MODEL_ASSET_URLS.persistent_id,
  });
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
  const sherpaModule = await getSherpaModule();

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
  const sherpaModule = await getSherpaModule();

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
      await handleLoadSpeechModel(message.id, message.modelId, message.persistentId);
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
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    postResponse({
      id: message.id,
      type: "request-error",
      error: errorMessage,
    });
  }
};
