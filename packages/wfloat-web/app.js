import { loadTtsModel } from "./dist/index.js";

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
  summary: document.getElementById("summary"),
  text: document.getElementById("text"),
  timing: document.getElementById("timing"),
  voice: document.getElementById("voice"),
};

let ttsModel = null;
let lastResult = null;

function appendLog(message, payload) {
  const lines = [`[${new Date().toLocaleTimeString()}] ${message}`];

  if (payload !== undefined) {
    lines.push(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
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
    appendLog("Load failed", String(error));
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
    appendLog("Synthesis failed", String(error));
    throw error;
  } finally {
    setButtons({ loaded: Boolean(ttsModel), busy: false });
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
      appendLog(`${name} failed`, String(error));
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
});
setButtons({ loaded: false, busy: false });
