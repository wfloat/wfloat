import { loadSttModel, loadTtsModel, loadVadModel } from "./dist/index.js";

const elements = {
  assetHost: document.getElementById("assetHost"),
  autoPlay: document.getElementById("autoPlay"),
  clearLog: document.getElementById("clearLog"),
  emotion: document.getElementById("emotion"),
  generate: document.getElementById("generate"),
  intensity: document.getElementById("intensity"),
  load: document.getElementById("load"),
  log: document.getElementById("log"),
  modelId: document.getElementById("modelId"),
  padding: document.getElementById("padding"),
  pause: document.getElementById("pause"),
  play: document.getElementById("play"),
  progress: document.getElementById("progress"),
  speed: document.getElementById("speed"),
  stop: document.getElementById("stop"),
  sttAudio: document.getElementById("sttAudio"),
  sttStreamingStart: document.getElementById("sttStreamingStart"),
  sttStreamingStop: document.getElementById("sttStreamingStop"),
  sttMicStart: document.getElementById("sttMicStart"),
  sttMicStop: document.getElementById("sttMicStop"),
  sttLanguage: document.getElementById("sttLanguage"),
  sttModelId: document.getElementById("sttModelId"),
  sttProgress: document.getElementById("sttProgress"),
  sttSummary: document.getElementById("sttSummary"),
  sttStreamingSummary: document.getElementById("sttStreamingSummary"),
  sttStreamingTiming: document.getElementById("sttStreamingTiming"),
  sttStreamingTranscript: document.getElementById("sttStreamingTranscript"),
  sttTask: document.getElementById("sttTask"),
  sttTiming: document.getElementById("sttTiming"),
  transcript: document.getElementById("transcript"),
  transcribe: document.getElementById("transcribe"),
  detectVad: document.getElementById("detectVad"),
  loadStt: document.getElementById("loadStt"),
  loadVad: document.getElementById("loadVad"),
  summary: document.getElementById("summary"),
  text: document.getElementById("text"),
  timing: document.getElementById("timing"),
  vadAudio: document.getElementById("vadAudio"),
  vadModelId: document.getElementById("vadModelId"),
  vadProgress: document.getElementById("vadProgress"),
  vadResult: document.getElementById("vadResult"),
  vadSummary: document.getElementById("vadSummary"),
  vadTiming: document.getElementById("vadTiming"),
  voice: document.getElementById("voice"),
};

let ttsModel = null;
let sttModel = null;
let vadModel = null;
let lastResult = null;
let recordedMicAudio = null;
let offlineMicrophoneRecording = false;
let streamingSession = null;
let streamingStartedAt = 0;

function formatError(error) {
  if (error instanceof Error) {
    return error.stack || `${error.name}: ${error.message}`;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function appendLog(message, payload) {
  const lines = [`[${new Date().toLocaleTimeString()}] ${message}`];

  if (payload !== undefined) {
    lines.push(typeof payload === "string" ? payload : formatError(payload));
  }

  elements.log.textContent = `${lines.join("\n")}\n\n${elements.log.textContent}`.trim();
}

function setSummary(text) {
  elements.summary.textContent = text;
}

function setProgress(value) {
  elements.progress.value = Math.max(0, Math.min(100, value));
}

function setButtons({ loaded, busy }) {
  elements.load.disabled = busy;
  elements.generate.disabled = !loaded || busy;
  elements.play.disabled = !loaded;
  elements.pause.disabled = !loaded;
  elements.stop.disabled = !loaded;
}

function setSttButtons({ loaded, busy }) {
  elements.loadStt.disabled = busy;
  elements.transcribe.disabled = !loaded || busy;
  elements.sttMicStart.disabled = !loaded || busy;
  elements.sttMicStop.disabled = !loaded || busy || !offlineMicrophoneRecording;
  elements.sttStreamingStart.disabled = !loaded || busy || !sttModel?.supportsStreaming || Boolean(streamingSession);
  elements.sttStreamingStop.disabled = !loaded || busy || !streamingSession;
}

function setVadButtons({ loaded, busy }) {
  elements.loadVad.disabled = busy;
  elements.detectVad.disabled = !loaded || busy;
}

function readSynthesisOptions() {
  return {
    autoPlay: elements.autoPlay.value === "true",
    emotion: elements.emotion.value.trim() || undefined,
    intensity: Number(elements.intensity.value || "0.5"),
    silencePaddingSec: Number(elements.padding.value || "0.1"),
    speed: Number(elements.speed.value || "1"),
    text: elements.text.value,
    voice: elements.voice.value.trim() || undefined,
  };
}

async function loadModel() {
  setSummary("Loading model");
  setProgress(0);
  setButtons({ loaded: false, busy: true });

  const modelId = elements.modelId.value.trim();
  const modelAssetHost = elements.assetHost.value.trim();

  appendLog("Loading TTS model", { modelAssetHost, modelId });

  try {
    ttsModel = await loadTtsModel(modelId, {
      modelAssetHost,
      onProgress(event) {
        if (event.status === "downloading") {
          setSummary(`Downloading model ${Math.round(event.progress * 100)}%`);
          setProgress(event.progress * 100);
        } else if (event.status === "loading") {
          setSummary("Initializing runtime");
          setProgress(100);
        } else if (event.status === "completed") {
          setSummary("Model ready");
          setProgress(100);
        }

        appendLog("Load progress", event);
      },
    });

    setSummary("Model ready");
    setButtons({ loaded: true, busy: false });
    appendLog("Model loaded");
  } catch (error) {
    ttsModel = null;
    setSummary("Model load failed");
    setButtons({ loaded: false, busy: false });
    appendLog("Load failed", error);
    throw error;
  }
}

async function synthesize() {
  if (!ttsModel) {
    appendLog("Cannot synthesize before loading the model");
    return;
  }

  setSummary("Synthesizing");
  setProgress(0);
  setButtons({ loaded: true, busy: true });

  const startedAt = performance.now();
  const options = readSynthesisOptions();

  appendLog("Synthesis request", options);

  try {
    lastResult = await ttsModel.synthesize({
      ...options,
      onFinishedPlaying() {
        appendLog("Playback finished");
      },
      onProgress(event) {
        setProgress(event.progress * 100);
        setSummary(event.isPlaying ? "Playing audio" : "Generating audio");
        appendLog("Synthesis progress", event);
      },
    });

    const elapsedMs = Math.round(performance.now() - startedAt);
    const chunkCount = lastResult.timeline?.chunks?.length ?? 0;
    elements.timing.textContent = `${elapsedMs} ms, ${chunkCount} chunks`;
    setSummary("Synthesis complete");
    setProgress(100);
    appendLog("Synthesis result", {
      chunkCount,
      modelId: lastResult.modelId,
      sampleRate: lastResult.audio?.sampleRate,
      text: lastResult.text,
    });
  } catch (error) {
    setSummary("Synthesis failed");
    appendLog("Synthesis failed", error);
    throw error;
  } finally {
    setButtons({ loaded: Boolean(ttsModel), busy: false });
  }
}

async function loadVad() {
  setVadButtons({ loaded: false, busy: true });
  elements.vadSummary.textContent = "Loading VAD model";
  elements.vadProgress.value = 0;
  elements.vadResult.textContent = "";

  const modelId = elements.vadModelId.value.trim();
  const modelAssetHost = elements.assetHost.value.trim();

  appendLog("Loading VAD model", { modelAssetHost, modelId });

  try {
    vadModel = await loadVadModel(modelId, {
      modelAssetHost,
      onProgress(event) {
        if (event.status === "downloading") {
          elements.vadSummary.textContent = `Downloading model ${Math.round(event.progress * 100)}%`;
          elements.vadProgress.value = event.progress * 100;
        } else if (event.status === "loading") {
          elements.vadSummary.textContent = "Initializing runtime";
          elements.vadProgress.value = 100;
        } else if (event.status === "completed") {
          elements.vadSummary.textContent = "Model ready";
          elements.vadProgress.value = 100;
        }

        appendLog("VAD load progress", event);
      },
    });

    elements.vadSummary.textContent = "Model ready";
    setVadButtons({ loaded: true, busy: false });
    appendLog("VAD model loaded", {
      family: vadModel.family,
      modelId: vadModel.modelId,
    });
  } catch (error) {
    vadModel = null;
    elements.vadSummary.textContent = "VAD load failed";
    setVadButtons({ loaded: false, busy: false });
    appendLog("VAD load failed", error);
    throw error;
  }
}

async function detectVad() {
  if (!vadModel) {
    appendLog("Cannot run VAD before loading the VAD model");
    return;
  }

  const file = elements.vadAudio.files?.[0];
  if (!file) {
    appendLog("Cannot run VAD without choosing an audio file");
    return;
  }

  setVadButtons({ loaded: true, busy: true });
  elements.vadSummary.textContent = "Detecting speech";
  elements.vadProgress.value = 0;
  elements.vadResult.textContent = "";

  const startedAt = performance.now();
  appendLog("VAD request", {
    modelId: elements.vadModelId.value.trim(),
    name: file.name,
    size: file.size,
    type: file.type,
  });

  try {
    const result = await vadModel.detect({ audio: file });
    const elapsedMs = Math.round(performance.now() - startedAt);
    elements.vadSummary.textContent = "VAD complete";
    elements.vadTiming.textContent =
      `${elapsedMs} ms, ${result.segments.length} segments, speech ratio ${result.speechRatio.toFixed(3)}`;
    elements.vadProgress.value = 100;
    elements.vadResult.textContent = JSON.stringify(
      {
        modelId: result.modelId,
        speechRatio: result.speechRatio,
        segments: result.segments.map((segment) => ({
          startSec: segment.startSec,
          durationSec: segment.durationSec,
          endSec: segment.endSec,
          startSample: segment.startSample,
          sampleCount: segment.sampleCount,
        })),
      },
      null,
      2,
    );
    appendLog("VAD result", {
      modelId: result.modelId,
      segments: result.segments.length,
      speechRatio: result.speechRatio,
    });
  } catch (error) {
    elements.vadSummary.textContent = "VAD failed";
    appendLog("VAD failed", error);
    throw error;
  } finally {
    setVadButtons({ loaded: Boolean(vadModel), busy: false });
  }
}

async function loadStt() {
  setSttButtons({ loaded: false, busy: true });
  elements.sttSummary.textContent = "Loading STT model";
  elements.sttProgress.value = 0;

  const modelId = elements.sttModelId.value.trim();
  const modelAssetHost = elements.assetHost.value.trim();
  const language = elements.sttLanguage.value.trim() || undefined;
  const task = elements.sttTask.value;

  appendLog("Loading STT model", { language, modelAssetHost, modelId, task });

  try {
    sttModel = await loadSttModel(modelId, {
      language,
      modelAssetHost,
      task,
      onProgress(event) {
        if (event.status === "downloading") {
          elements.sttSummary.textContent = `Downloading model ${Math.round(event.progress * 100)}%`;
          elements.sttProgress.value = event.progress * 100;
        } else if (event.status === "loading") {
          elements.sttSummary.textContent = "Initializing runtime";
          elements.sttProgress.value = 100;
        } else if (event.status === "completed") {
          elements.sttSummary.textContent = "Model ready";
          elements.sttProgress.value = 100;
        }

        appendLog("STT load progress", event);
      },
    });

    elements.sttSummary.textContent = "Model ready";
    elements.sttStreamingSummary.textContent = sttModel.supportsStreaming
      ? "Streaming session available"
      : "Offline STT model";
    setSttButtons({ loaded: true, busy: false });
    appendLog("STT model loaded", {
      family: sttModel.family,
      supportsStreaming: sttModel.supportsStreaming,
    });
  } catch (error) {
    sttModel = null;
    elements.sttSummary.textContent = "STT load failed";
    elements.sttStreamingSummary.textContent = "Streaming unavailable";
    setSttButtons({ loaded: false, busy: false });
    appendLog("STT load failed", error);
    throw error;
  }
}

async function startMicCapture() {
  if (!sttModel) {
    appendLog("Cannot start mic capture before loading the STT model");
    return;
  }

  setSttButtons({ loaded: true, busy: true });
  elements.sttSummary.textContent = "Starting microphone";
  elements.sttProgress.value = 0;

  try {
    recordedMicAudio = null;
    await sttModel.startMicrophone({ sampleRate: 16000 });
    offlineMicrophoneRecording = true;
    elements.sttSummary.textContent = "Recording microphone";
    elements.sttTiming.textContent = "Recording in progress";
    appendLog("Microphone capture started", {
      sampleRate: 16000,
    });
  } catch (error) {
    elements.sttSummary.textContent = "Microphone start failed";
    appendLog("Microphone start failed", error);
    throw error;
  } finally {
    setSttButtons({ loaded: Boolean(sttModel), busy: false });
  }
}

async function stopMicCapture() {
  if (!offlineMicrophoneRecording) {
    appendLog("Cannot stop mic capture because recording is not active");
    return;
  }

  setSttButtons({ loaded: true, busy: true });
  elements.sttSummary.textContent = "Stopping microphone";

  try {
    recordedMicAudio = await sttModel.stopMicrophone();
    offlineMicrophoneRecording = false;
    elements.sttSummary.textContent = "Microphone clip ready";
    elements.sttTiming.textContent = `${recordedMicAudio.durationMs} ms recorded`;
    appendLog("Microphone capture stopped", {
      durationMs: recordedMicAudio.durationMs,
      sampleRate: recordedMicAudio.sampleRate,
      samples: recordedMicAudio.audio.length,
    });
  } catch (error) {
    elements.sttSummary.textContent = "Microphone stop failed";
    appendLog("Microphone stop failed", error);
    throw error;
  } finally {
    setSttButtons({ loaded: Boolean(sttModel), busy: false });
  }
}

async function startStreamingSession() {
  if (!sttModel) {
    appendLog("Cannot start streaming before loading an STT model");
    return;
  }

  if (!sttModel.supportsStreaming) {
    appendLog("Loaded STT model does not support streaming sessions", {
      family: sttModel.family,
      modelId: sttModel.modelId,
    });
    return;
  }

  setSttButtons({ loaded: true, busy: true });
  elements.sttStreamingSummary.textContent = "Starting streaming session";
  elements.sttStreamingTranscript.textContent = "";
  elements.sttStreamingTiming.textContent = "Waiting for microphone";
  elements.transcript.textContent = "";

  try {
    streamingSession = await sttModel.createSession();
    streamingStartedAt = performance.now();

    await streamingSession.startMicrophone({
      sampleRate: 16000,
      onResult(partial) {
        elements.sttStreamingTranscript.textContent = partial.text || "(listening...)";
        elements.sttStreamingSummary.textContent = partial.isEndpoint
          ? "Endpoint detected"
          : "Streaming microphone";
      },
    });

    elements.sttStreamingSummary.textContent = "Streaming microphone";
    appendLog("Streaming STT session started", {
      modelId: sttModel.modelId,
      family: sttModel.family,
    });
  } catch (error) {
    elements.sttStreamingSummary.textContent = "Streaming start failed";
    if (streamingSession) {
      await streamingSession.close().catch(() => {});
      streamingSession = null;
    }
    appendLog("Streaming STT start failed", error);
    throw error;
  } finally {
    setSttButtons({ loaded: Boolean(sttModel), busy: false });
  }
}

async function stopStreamingSession() {
  if (!streamingSession) {
    appendLog("Cannot stop streaming because no session is active");
    return;
  }

  setSttButtons({ loaded: true, busy: true });
  elements.sttStreamingSummary.textContent = "Stopping streaming session";

  try {
    const session = streamingSession;
    streamingSession = null;

    const recordedAudio = await session.stopMicrophone();
    const finalResult = await session.finish();
    await session.close();

    const elapsedMs = Math.round(performance.now() - streamingStartedAt);
    elements.sttStreamingSummary.textContent = "Streaming complete";
    elements.sttStreamingTiming.textContent =
      `${elapsedMs} ms, ${recordedAudio.durationMs} ms captured, ${recordedAudio.chunkCount} chunks`;
    elements.sttStreamingTranscript.textContent = finalResult.text || "(empty transcript)";

    appendLog("Streaming STT result", {
      modelId: finalResult.modelId,
      isEndpoint: finalResult.isEndpoint,
      text: finalResult.text,
    });
  } catch (error) {
    elements.sttStreamingSummary.textContent = "Streaming stop failed";
    appendLog("Streaming STT stop failed", error);
    throw error;
  } finally {
    setSttButtons({ loaded: Boolean(sttModel), busy: false });
  }
}

async function transcribe() {
  if (!sttModel) {
    appendLog("Cannot transcribe before loading the STT model");
    return;
  }

  const file = elements.sttAudio.files?.[0];
  const audioSource = recordedMicAudio ?? file ?? null;
  if (!audioSource) {
    appendLog("Cannot transcribe without choosing an audio file or recording microphone audio");
    return;
  }

  setSttButtons({ loaded: true, busy: true });
  elements.sttSummary.textContent = "Transcribing";
  elements.sttProgress.value = 0;
  elements.transcript.textContent = "";

  const startedAt = performance.now();
  appendLog(
    "STT transcription request",
    recordedMicAudio
      ? {
          modelId: elements.sttModelId.value.trim(),
          sampleRate: recordedMicAudio.sampleRate,
          samples: recordedMicAudio.audio.length,
          source: "microphone",
        }
      : {
          modelId: elements.sttModelId.value.trim(),
          name: file.name,
          size: file.size,
          type: file.type,
          source: "file",
        },
  );

  try {
    const result = recordedMicAudio
      ? await sttModel.transcribe({
          audio: recordedMicAudio.audio,
          sampleRate: recordedMicAudio.sampleRate,
        })
      : await sttModel.transcribe({ audio: file });
    const elapsedMs = Math.round(performance.now() - startedAt);
    elements.sttSummary.textContent = "Transcription complete";
    elements.sttTiming.textContent = `${elapsedMs} ms`;
    elements.sttProgress.value = 100;
    elements.transcript.textContent = result.text || "(empty transcript)";
    appendLog("STT result", {
      language: result.language,
      modelId: result.modelId,
      text: result.text,
      tokens: result.tokens?.length ?? 0,
      segments: result.segments?.length ?? 0,
    });
  } catch (error) {
    elements.sttSummary.textContent = "Transcription failed";
    appendLog("STT transcription failed", error);
    throw error;
  } finally {
    setSttButtons({ loaded: Boolean(sttModel), busy: false });
  }
}

function safeCall(name, fn) {
  return async () => {
    if (!ttsModel) {
      appendLog(`${name} ignored because no model is loaded`);
      return;
    }

    try {
      await fn();
      appendLog(name);
    } catch (error) {
      appendLog(`${name} failed`, error);
      throw error;
    }
  };
}

elements.load.addEventListener("click", () => {
  loadModel().catch(() => {});
});

elements.generate.addEventListener("click", () => {
  synthesize().catch(() => {});
});
elements.loadStt.addEventListener("click", () => {
  loadStt().catch(() => {});
});
elements.loadVad.addEventListener("click", () => {
  loadVad().catch(() => {});
});
elements.detectVad.addEventListener("click", () => {
  detectVad().catch(() => {});
});
elements.sttStreamingStart.addEventListener("click", () => {
  startStreamingSession().catch(() => {});
});
elements.sttStreamingStop.addEventListener("click", () => {
  stopStreamingSession().catch(() => {});
});
elements.sttMicStart.addEventListener("click", () => {
  startMicCapture().catch(() => {});
});
elements.sttMicStop.addEventListener("click", () => {
  stopMicCapture().catch(() => {});
});
elements.transcribe.addEventListener("click", () => {
  transcribe().catch(() => {});
});

elements.play.addEventListener("click", safeCall("play", () => ttsModel.play()));
elements.pause.addEventListener("click", safeCall("pause", () => ttsModel.pause()));
elements.stop.addEventListener("click", safeCall("stop", () => ttsModel.stop()));

elements.clearLog.addEventListener("click", () => {
  elements.log.textContent = "";
  appendLog("Log cleared");
});

appendLog("Smoke page ready", {
  modelAssetHost: elements.assetHost.value,
  modelId: elements.modelId.value,
  sttModelId: elements.sttModelId.value,
});
elements.sttStreamingSummary.textContent = "Streaming idle";
setButtons({ loaded: false, busy: false });
setSttButtons({ loaded: false, busy: false });
setVadButtons({ loaded: false, busy: false });
