import { loadSttModel, loadTtsModel } from "./dist/index.js";

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
  sttLanguage: document.getElementById("sttLanguage"),
  sttModelId: document.getElementById("sttModelId"),
  sttProgress: document.getElementById("sttProgress"),
  sttSummary: document.getElementById("sttSummary"),
  sttTask: document.getElementById("sttTask"),
  sttTiming: document.getElementById("sttTiming"),
  transcript: document.getElementById("transcript"),
  transcribe: document.getElementById("transcribe"),
  loadStt: document.getElementById("loadStt"),
  summary: document.getElementById("summary"),
  text: document.getElementById("text"),
  timing: document.getElementById("timing"),
  voice: document.getElementById("voice"),
};

let ttsModel = null;
let sttModel = null;
let lastResult = null;

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
    setSttButtons({ loaded: true, busy: false });
    appendLog("STT model loaded");
  } catch (error) {
    sttModel = null;
    elements.sttSummary.textContent = "STT load failed";
    setSttButtons({ loaded: false, busy: false });
    appendLog("STT load failed", error);
    throw error;
  }
}

async function transcribe() {
  if (!sttModel) {
    appendLog("Cannot transcribe before loading the STT model");
    return;
  }

  const file = elements.sttAudio.files?.[0];
  if (!file) {
    appendLog("Cannot transcribe without choosing an audio file");
    return;
  }

  setSttButtons({ loaded: true, busy: true });
  elements.sttSummary.textContent = "Transcribing";
  elements.sttProgress.value = 0;
  elements.transcript.textContent = "";

  const startedAt = performance.now();
  appendLog("STT transcription request", {
    modelId: elements.sttModelId.value.trim(),
    name: file.name,
    size: file.size,
    type: file.type,
  });

  try {
    const result = await sttModel.transcribe({ audio: file });
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
setButtons({ loaded: false, busy: false });
setSttButtons({ loaded: false, busy: false });
