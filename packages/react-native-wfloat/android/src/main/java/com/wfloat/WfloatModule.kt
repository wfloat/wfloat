package com.wfloat

import android.net.Uri
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.module.annotations.ReactModule
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.HomophoneReplacerConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineStream
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsWfloatModelConfig
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineStream
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.zip.ZipInputStream
import kotlin.math.abs

private const val DEFAULT_INTENSITY = 0.5
private const val DEFAULT_SPEED = 1.0
private const val DEFAULT_DIALOGUE_SILENCE_SEC = 0.2
private const val DEFAULT_SENTENCE_SILENCE_SEC = 0.1
private const val DEFAULT_DOWNLOAD_PROGRESS_DELTA = 0.01
private const val READY_MARKER_FILE_NAME = ".ready"

private data class PreparedTextPayload(
  val rawTextChunks: List<String>,
  val textCleanChunks: List<String>,
)

private data class PreparedDialogueSegment(
  val rawTextChunks: List<String>,
  val textCleanChunks: List<String>,
  val rawText: String,
  val sid: Int,
  val speed: Float,
  val sentenceSilencePaddingSec: Float,
)

private data class GeneratedTimelineChunk(
  val index: Int,
  val text: String,
  val textHighlightStart: Int,
  val textHighlightEnd: Int,
  val startSec: Double,
  val endSec: Double,
  val durationSec: Double,
  val progress: Double,
  val textHighlightSegment: Int?,
)

private data class GeneratedSpeechResult(
  val sampleRate: Int,
  val durationSec: Double,
  val text: String,
  val timelineChunks: List<GeneratedTimelineChunk>,
)

private data class GenerationSummary(
  val outcome: GenerationOutcome,
  val result: GeneratedSpeechResult?,
)

private data class SttFileSet(
  val family: String,
  val model: String?,
  val tokens: String?,
  val preprocessor: String?,
  val encoder: String?,
  val decoder: String?,
  val joiner: String?,
  val uncachedDecoder: String?,
  val cachedDecoder: String?,
)

private data class SttTranscriptionToken(
  val text: String,
  val startSec: Double,
  val durationSec: Double,
  val confidence: Double,
)

private data class SttTranscriptionSegment(
  val text: String,
  val startSec: Double,
  val durationSec: Double,
)

private data class SttTranscriptionResult(
  val text: String,
  val modelId: String,
  val language: String,
  val emotion: String,
  val event: String,
  val json: String,
  val tokens: List<SttTranscriptionToken>,
  val segments: List<SttTranscriptionSegment>,
)

private data class StreamingSttResult(
  val text: String,
  val modelId: String,
  val isEndpoint: Boolean,
  val json: String,
)

private enum class GenerationOutcome {
  COMPLETED,
  CANCELLED,
}

@ReactModule(name = WfloatModule.NAME)
class WfloatModule(reactContext: ReactApplicationContext) :
  NativeWfloatSpec(reactContext) {

  private val workQueue: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "WfloatWorkQueue")
  }
  private val stateLock = Any()

  @Volatile
  private var offlineTts: OfflineTts? = null

  @Volatile
  private var loadedModelPath: String? = null

  @Volatile
  private var loadedTokensPath: String? = null

  @Volatile
  private var loadedDataDir: String? = null

  @Volatile
  private var speechSession: WfloatAudioSession? = null

  @Volatile
  private var loadModelInProgress = false

  @Volatile
  private var offlineRecognizer: OfflineRecognizer? = null

  @Volatile
  private var onlineRecognizer: OnlineRecognizer? = null

  @Volatile
  private var loadedSttModelId: String? = null

  @Volatile
  private var loadedSttFamily: String? = null

  @Volatile
  private var loadedSttPaths: SttFileSet? = null

  private val sttSessions = LinkedHashMap<Int, OnlineStream>()
  private var nextSttSessionId = 1

  override fun getName(): String {
    return NAME
  }

  override fun invalidate() {
    cancelCurrentSpeechSession()
    closeAllSttSessions()

    synchronized(stateLock) {
      offlineTts?.free()
      offlineTts = null
      loadedModelPath = null
      loadedTokensPath = null
      loadedDataDir = null
      offlineRecognizer?.release()
      offlineRecognizer = null
      onlineRecognizer?.release()
      onlineRecognizer = null
      loadedSttModelId = null
      loadedSttFamily = null
      loadedSttPaths = null
    }

    workQueue.shutdownNow()
    super.invalidate()
  }

  override fun loadModel(options: ReadableMap, promise: Promise) {
    val modelId: String
    val modelUrl: String
    val tokensUrl: String
    val espeakDataUrl: String
    val espeakChecksum: String

    try {
      modelId = readRequiredString(options, "modelId")
      modelUrl = readRequiredString(options, "modelUrl")
      tokensUrl = readRequiredString(options, "tokensUrl")
      espeakDataUrl = readRequiredString(options, "espeakDataUrl")
      espeakChecksum = normalizeChecksum(readRequiredString(options, "espeakChecksum"))
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error.message, error)
      return
    }

    if (modelId.isBlank() || modelUrl.isBlank() || tokensUrl.isBlank() ||
      espeakDataUrl.isBlank() || espeakChecksum.isBlank()
    ) {
      promise.reject(
        "invalid_arguments",
        "modelId, modelUrl, tokensUrl, espeakDataUrl, and espeakChecksum are required."
      )
      return
    }

    synchronized(stateLock) {
      if (loadModelInProgress) {
        promise.reject("load_in_progress", "A loadModel operation is already in progress.")
        return
      }
      loadModelInProgress = true
    }

    workQueue.execute {
      try {
        val modelFileName = requireFileNameFromUrl(modelUrl)
        val tokensFileName = requireFileNameFromUrl(tokensUrl)
        val espeakArchiveFileName = requireFileNameFromUrl(espeakDataUrl)

        val modelDirectory = cacheDirectoryForModelId(modelId)
        ensureDirectoryExists(modelDirectory)
        ensureDirectoryExists(espeakCacheRootDirectory())
        ensureDirectoryExists(espeakWorkRootDirectory())

        val modelPath = File(modelDirectory, modelFileName)
        val tokensPath = File(modelDirectory, tokensFileName)
        val espeakDirectory = espeakDirectoryForChecksum(espeakChecksum)
        val espeakArchivePath = File(espeakWorkRootDirectory(), espeakArchiveFileName)

        var completedDownloadCount = 0
        val needsModelDownload = !modelPath.exists()
        val needsTokensDownload = !tokensPath.exists()
        val needsEspeakDownload = !isInstalledEspeakDirectory(espeakDirectory)
        val totalPlannedDownloadCount =
          (if (needsModelDownload) 1 else 0) +
            (if (needsTokensDownload) 1 else 0) +
            (if (needsEspeakDownload) 1 else 0)
        var lastEmittedDownloadProgress = -1.0

        fun emitDownloadProgress(phaseProgress: Double) {
          val clamped = phaseProgress.coerceIn(0.0, 1.0)
          val overallProgress = if (totalPlannedDownloadCount > 0) {
            (completedDownloadCount + clamped) / totalPlannedDownloadCount.toDouble()
          } else {
            clamped
          }

          if (overallProgress < 1.0 &&
            lastEmittedDownloadProgress >= 0 &&
            abs(lastEmittedDownloadProgress - overallProgress) < DEFAULT_DOWNLOAD_PROGRESS_DELTA
          ) {
            return
          }

          lastEmittedDownloadProgress = overallProgress
          emitLoadModelProgress("downloading", overallProgress)
        }

        fun downloadIfNeeded(shouldDownload: Boolean, url: String, destination: File) {
          if (!shouldDownload) {
            return
          }

          emitDownloadProgress(0.0)
          downloadFile(url, destination) { phaseProgress ->
            emitDownloadProgress(phaseProgress)
          }
          completedDownloadCount += 1
        }

        downloadIfNeeded(needsModelDownload, modelUrl, modelPath)
        downloadIfNeeded(needsTokensDownload, tokensUrl, tokensPath)
        if (needsEspeakDownload) {
          downloadIfNeeded(true, espeakDataUrl, espeakArchivePath)
          installEspeakArchive(espeakArchivePath, espeakChecksum, espeakDirectory)
          espeakArchivePath.delete()
        }

        cancelCurrentSpeechSession()
        emitLoadModelProgress("loading", null)

        val newTts = synchronized(stateLock) {
          if (offlineTts != null &&
            loadedModelPath == modelPath.absolutePath &&
            loadedTokensPath == tokensPath.absolutePath &&
            loadedDataDir == espeakDirectory.absolutePath
          ) {
            offlineTts
          } else {
            null
          }
        } ?: createOfflineTts(
          modelPath = modelPath,
          tokensPath = tokensPath,
          dataDir = espeakDirectory
        )

        synchronized(stateLock) {
          val oldTts = offlineTts
          offlineTts = newTts
          loadedModelPath = modelPath.absolutePath
          loadedTokensPath = tokensPath.absolutePath
          loadedDataDir = espeakDirectory.absolutePath
          if (oldTts != null && oldTts !== newTts) {
            oldTts.free()
          }
        }

        cleanupStaleModelFiles(modelDirectory, setOf(modelFileName, tokensFileName))
        cleanupStaleEspeakDirectories(espeakDirectory)
        emitLoadModelProgress("completed", null)
        promise.resolve(null)
      } catch (error: Throwable) {
        promise.reject(loadModelErrorCode(error), error.message ?: "Failed to load model.", error)
      } finally {
        synchronized(stateLock) {
          loadModelInProgress = false
        }
        cleanupEspeakWorkDirectory()
      }
    }
  }

  override fun loadSttModel(options: ReadableMap, promise: Promise) {
    val modelId: String
    val family: String
    val fileSet: SttFileSet
    val language: String
    val task: String

    try {
      modelId = readRequiredString(options, "modelId")
      family = readRequiredString(options, "family")
      fileSet = SttFileSet(
        family = family,
        model = readString(options, "modelUrl"),
        tokens = readString(options, "tokensUrl"),
        preprocessor = readString(options, "preprocessorUrl"),
        encoder = readString(options, "encoderUrl"),
        decoder = readString(options, "decoderUrl"),
        joiner = readString(options, "joinerUrl"),
        uncachedDecoder = readString(options, "uncachedDecoderUrl"),
        cachedDecoder = readString(options, "cachedDecoderUrl"),
      )
      language = readString(options, "language")?.ifBlank { "en" } ?: "en"
      task = readString(options, "task")?.ifBlank { "transcribe" } ?: "transcribe"
      validateSttFileSet(fileSet)
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error.message, error)
      return
    }

    synchronized(stateLock) {
      if (loadModelInProgress) {
        promise.reject("load_in_progress", "A loadModel operation is already in progress.")
        return
      }
      loadModelInProgress = true
    }

    workQueue.execute {
      try {
        val modelDirectory = cacheDirectoryForModelId(modelId)
        ensureDirectoryExists(modelDirectory)

        val requiredDownloads = requiredSttDownloads(fileSet, modelDirectory)
        val totalPlannedDownloadCount = requiredDownloads.count { !it.destination.exists() }
        var completedDownloadCount = 0
        var lastEmittedDownloadProgress = -1.0

        fun emitDownloadProgress(phaseProgress: Double) {
          val clamped = phaseProgress.coerceIn(0.0, 1.0)
          val overallProgress = if (totalPlannedDownloadCount > 0) {
            (completedDownloadCount + clamped) / totalPlannedDownloadCount.toDouble()
          } else {
            clamped
          }

          if (overallProgress < 1.0 &&
            lastEmittedDownloadProgress >= 0 &&
            abs(lastEmittedDownloadProgress - overallProgress) < DEFAULT_DOWNLOAD_PROGRESS_DELTA
          ) {
            return
          }

          lastEmittedDownloadProgress = overallProgress
          emitLoadModelProgress("downloading", overallProgress)
        }

        requiredDownloads.forEach { asset ->
          if (!asset.destination.exists()) {
            emitDownloadProgress(0.0)
            downloadFile(asset.url, asset.destination) { phaseProgress ->
              emitDownloadProgress(phaseProgress)
            }
            completedDownloadCount += 1
          }
        }

        emitLoadModelProgress("loading", null)
        closeAllSttSessions()

        val resolvedPaths = fileSet.copy(
          model = requiredDownloads.find { it.label == "model" }?.destination?.absolutePath,
          tokens = requiredDownloads.find { it.label == "tokens" }?.destination?.absolutePath,
          preprocessor = requiredDownloads.find { it.label == "preprocessor" }?.destination?.absolutePath,
          encoder = requiredDownloads.find { it.label == "encoder" }?.destination?.absolutePath,
          decoder = requiredDownloads.find { it.label == "decoder" }?.destination?.absolutePath,
          joiner = requiredDownloads.find { it.label == "joiner" }?.destination?.absolutePath,
          uncachedDecoder = requiredDownloads.find { it.label == "uncached_decoder" }?.destination?.absolutePath,
          cachedDecoder = requiredDownloads.find { it.label == "cached_decoder" }?.destination?.absolutePath,
        )

        val newOfflineRecognizer: OfflineRecognizer?
        val newOnlineRecognizer: OnlineRecognizer?
        when (family) {
          "whisper" -> {
            newOfflineRecognizer = createOfflineWhisperRecognizer(
              resolvedPaths,
              language,
              task
            )
            newOnlineRecognizer = null
          }
          "zipformer-transducer" -> {
            newOfflineRecognizer = null
            newOnlineRecognizer = createStreamingZipformerRecognizer(resolvedPaths)
          }
          else -> throw IllegalArgumentException("Unsupported STT family: $family")
        }

        synchronized(stateLock) {
          offlineRecognizer?.release()
          onlineRecognizer?.release()
          offlineRecognizer = newOfflineRecognizer
          onlineRecognizer = newOnlineRecognizer
          loadedSttModelId = modelId
          loadedSttFamily = family
          loadedSttPaths = resolvedPaths
        }

        emitLoadModelProgress("completed", null)
        promise.resolve(
          Arguments.createMap().apply {
            putString("family", family)
            putBoolean("supportsStreaming", family == "zipformer-transducer")
          }
        )
      } catch (error: Throwable) {
        promise.reject(loadModelErrorCode(error), error.message ?: "Failed to load STT model.", error)
      } finally {
        synchronized(stateLock) {
          loadModelInProgress = false
        }
      }
    }
  }

  override fun transcribe(options: ReadableMap, promise: Promise) {
    val recognizer = offlineRecognizer
    val modelId = loadedSttModelId
    if (recognizer == null && onlineRecognizer != null) {
      promise.reject(
        "invalid_model_mode",
        "The loaded STT model supports streaming sessions only. Use createSession() instead of transcribe()."
      )
      return
    }
    if (recognizer == null || modelId == null) {
      promise.reject("not_loaded", "STT model is not loaded. Call loadSttModel(...) first.")
      return
    }

    val samples: FloatArray
    val sampleRate: Int
    try {
      samples = readRequiredFloatArray(options, "samples")
      sampleRate = readRequiredPositiveInt(options, "sampleRate")
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error.message, error)
      return
    }

    workQueue.execute {
      val stream = recognizer.createStream()

      try {
        stream.acceptWaveform(samples, sampleRate)
        recognizer.decode(stream)
        val result = recognizer.getResult(stream)
        promise.resolve(
          mapOfflineRecognizerResult(
            modelId = modelId,
            result = result
          ).toWritableMap()
        )
      } catch (error: Throwable) {
        promise.reject(
          "transcribe_failed",
          error.message ?: "Failed to transcribe audio.",
          error
        )
      } finally {
        stream.release()
      }
    }
  }

  override fun createSttSession(promise: Promise) {
    val recognizer = onlineRecognizer
    val modelId = loadedSttModelId
    if (recognizer == null || modelId == null) {
      promise.reject(
        "not_loaded",
        "Streaming STT model is not loaded. Call loadSttModel(...) with a streaming-capable model first."
      )
      return
    }

    synchronized(stateLock) {
      val sessionId = nextSttSessionId
      nextSttSessionId += 1
      sttSessions[sessionId] = recognizer.createStream()
      promise.resolve(sessionId.toDouble())
    }
  }

  override fun pushSttSessionAudio(options: ReadableMap, promise: Promise) {
    val recognizer = onlineRecognizer
    if (recognizer == null) {
      promise.reject("not_loaded", "Streaming STT model is not loaded.")
      return
    }

    val sessionId: Int
    val samples: FloatArray
    val sampleRate: Int
    try {
      sessionId = readRequiredNonNegativeInt(options, "sessionId")
      samples = readRequiredFloatArray(options, "samples")
      sampleRate = readRequiredPositiveInt(options, "sampleRate")
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error.message, error)
      return
    }

    workQueue.execute {
      try {
        val session = requireSttSession(sessionId)
        session.acceptWaveform(samples, sampleRate)
        decodeOnlineSession(recognizer, session)
        promise.resolve(null)
      } catch (error: Throwable) {
        promise.reject("session_push_failed", error.message ?: "Failed to push session audio.", error)
      }
    }
  }

  override fun getSttSessionResult(options: ReadableMap, promise: Promise) {
    val recognizer = onlineRecognizer
    val modelId = loadedSttModelId
    if (recognizer == null || modelId == null) {
      promise.reject("not_loaded", "Streaming STT model is not loaded.")
      return
    }

    val sessionId: Int
    try {
      sessionId = readRequiredNonNegativeInt(options, "sessionId")
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error.message, error)
      return
    }

    workQueue.execute {
      try {
        val session = requireSttSession(sessionId)
        decodeOnlineSession(recognizer, session)
        val result = recognizer.getResult(session)
        promise.resolve(
          StreamingSttResult(
            text = result.text,
            modelId = modelId,
            isEndpoint = recognizer.isEndpoint(session),
            json = buildStreamingJson(result.text, result.tokens, result.timestamps)
          ).toWritableMap()
        )
      } catch (error: Throwable) {
        promise.reject("session_result_failed", error.message ?: "Failed to get session result.", error)
      }
    }
  }

  override fun finishSttSession(options: ReadableMap, promise: Promise) {
    val recognizer = onlineRecognizer
    val modelId = loadedSttModelId
    if (recognizer == null || modelId == null) {
      promise.reject("not_loaded", "Streaming STT model is not loaded.")
      return
    }

    val sessionId: Int
    try {
      sessionId = readRequiredNonNegativeInt(options, "sessionId")
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error.message, error)
      return
    }

    workQueue.execute {
      try {
        val session = requireSttSession(sessionId)
        session.inputFinished()
        decodeOnlineSession(recognizer, session)
        val result = recognizer.getResult(session)
        promise.resolve(
          StreamingSttResult(
            text = result.text,
            modelId = modelId,
            isEndpoint = recognizer.isEndpoint(session),
            json = buildStreamingJson(result.text, result.tokens, result.timestamps)
          ).toWritableMap()
        )
      } catch (error: Throwable) {
        promise.reject("session_finish_failed", error.message ?: "Failed to finish session.", error)
      }
    }
  }

  override fun resetSttSession(options: ReadableMap, promise: Promise) {
    val recognizer = onlineRecognizer
    if (recognizer == null) {
      promise.reject("not_loaded", "Streaming STT model is not loaded.")
      return
    }

    val sessionId: Int
    try {
      sessionId = readRequiredNonNegativeInt(options, "sessionId")
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error.message, error)
      return
    }

    workQueue.execute {
      try {
        recognizer.reset(requireSttSession(sessionId))
        promise.resolve(null)
      } catch (error: Throwable) {
        promise.reject("session_reset_failed", error.message ?: "Failed to reset session.", error)
      }
    }
  }

  override fun closeSttSession(options: ReadableMap, promise: Promise) {
    val sessionId: Int
    try {
      sessionId = readRequiredNonNegativeInt(options, "sessionId")
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error.message, error)
      return
    }

    workQueue.execute {
      synchronized(stateLock) {
        sttSessions.remove(sessionId)?.release()
      }
      promise.resolve(null)
    }
  }

  override fun generate(options: ReadableMap, promise: Promise) {
    val tts = offlineTts
    if (tts == null) {
      promise.reject(
        "not_loaded",
        "TTS model is not loaded. Call loadTtsModel(...) first."
      )
      return
    }

    val requestId: Int
    val text: String
    val sid: Int
    val emotion: String
    val intensity: Double
    val speed: Double
    val silencePaddingSec: Float
    val autoPlay: Boolean

    try {
      requestId = readRequiredNonNegativeInt(options, "requestId")
      text = readRequiredString(options, "text")
      sid = readRequiredNonNegativeInt(options, "sid")
      emotion = readString(options, "emotion")?.ifBlank { "neutral" } ?: "neutral"
      intensity = normalizeIntensity(readDouble(options, "intensity"), DEFAULT_INTENSITY)
      speed = normalizePositiveDouble(readDouble(options, "speed"), DEFAULT_SPEED)
      silencePaddingSec = normalizeNonNegativeDouble(
        readDouble(options, "silencePaddingSec"),
        0.0
      ).toFloat()
      autoPlay = if (!options.hasKey("autoPlay") || options.isNull("autoPlay")) {
        true
      } else {
        options.getBoolean("autoPlay")
      }
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error.message, error)
      return
    }

    if (text.isBlank()) {
      promise.reject("invalid_arguments", "text is required.")
      return
    }

    val session = createSpeechSession(requestId, tts, autoPlay)

    workQueue.execute {
      try {
        val outcome = generateSpeech(
          tts = tts,
          session = session,
          text = text,
          sid = sid,
          emotion = emotion,
          intensity = intensity.toFloat(),
          speed = speed.toFloat(),
          silencePaddingSec = silencePaddingSec
        )

        if (outcome.outcome == GenerationOutcome.CANCELLED) {
          promise.resolve(null)
          return@execute
        }

        promise.resolve(outcome.result?.toWritableMap())
      } catch (error: Throwable) {
        if (isCurrentSpeechSession(session)) {
          cancelCurrentSpeechSession()
        } else {
          session.cancel()
        }
        promise.reject(
          "generate_failed",
          error.message ?: "Failed to generate speech audio.",
          error
        )
      }
    }
  }

  override fun generateDialogue(options: ReadableMap, promise: Promise) {
    val tts = offlineTts
    if (tts == null) {
      promise.reject(
        "not_loaded",
        "TTS model is not loaded. Call loadTtsModel(...) first."
      )
      return
    }

    val requestId: Int
    val nativeSegments: ReadableArray
    val silenceBetweenSegmentsSec: Float
    val autoPlay: Boolean

    try {
      requestId = readRequiredNonNegativeInt(options, "requestId")
      nativeSegments = readRequiredArray(options, "segments")
      silenceBetweenSegmentsSec = normalizeNonNegativeDouble(
        readDouble(options, "silenceBetweenSegmentsSec"),
        DEFAULT_DIALOGUE_SILENCE_SEC
      ).toFloat()
      autoPlay = if (!options.hasKey("autoPlay") || options.isNull("autoPlay")) {
        true
      } else {
        options.getBoolean("autoPlay")
      }
    } catch (error: IllegalArgumentException) {
      promise.reject("invalid_arguments", error.message, error)
      return
    }

    if (nativeSegments.size() == 0) {
      promise.reject("invalid_arguments", "segments is required.")
      return
    }

    val session = createSpeechSession(requestId, tts, autoPlay)

    workQueue.execute {
      try {
        val outcome = generateDialogueSpeech(
          tts = tts,
          session = session,
          segments = nativeSegments,
          silenceBetweenSegmentsSec = silenceBetweenSegmentsSec
        )

        if (outcome.outcome == GenerationOutcome.CANCELLED) {
          promise.resolve(null)
          return@execute
        }

        promise.resolve(outcome.result?.toWritableMap())
      } catch (error: Throwable) {
        if (isCurrentSpeechSession(session)) {
          cancelCurrentSpeechSession()
        } else {
          session.cancel()
        }
        promise.reject(
          "generate_failed",
          error.message ?: "Failed to generate speech audio.",
          error
        )
      }
    }
  }

  override fun play(promise: Promise) {
    speechSession?.play()
    promise.resolve(null)
  }

  override fun pause(promise: Promise) {
    speechSession?.pause()
    promise.resolve(null)
  }

  private fun createSpeechSession(
    requestId: Int,
    tts: OfflineTts,
    autoPlay: Boolean,
  ): WfloatAudioSession {
    val sampleRate = tts.sampleRate()
    val session = WfloatAudioSession(
      requestId = requestId,
      sampleRate = sampleRate,
      startPaused = !autoPlay,
      progressHandler = { progressRequestId, progress, isPlaying, textHighlightStart, textHighlightEnd, text, textHighlightSegment ->
        emitSpeechProgress(
          progressRequestId,
          progress,
          isPlaying,
          textHighlightStart,
          textHighlightEnd,
          text,
          textHighlightSegment
        )
      },
      playbackFinishedHandler = { finishedRequestId ->
        if (speechSession?.requestId == finishedRequestId) {
          speechSession = null
        }
        emitSpeechPlaybackFinished(finishedRequestId)
      }
    )

    val previousSession = speechSession
    speechSession = session
    previousSession?.cancel()
    return session
  }

  private fun generateSpeech(
    tts: OfflineTts,
    session: WfloatAudioSession,
    text: String,
    sid: Int,
    emotion: String,
    intensity: Float,
    speed: Float,
    silencePaddingSec: Float,
  ): GenerationSummary {
    val preparedPayload = preparedTextPayload(tts, text, emotion, intensity)
    val totalChunkCount = preparedPayload.textCleanChunks.size
    var rawTextCursor = 0
    val sampleRate = tts.sampleRate()
    var scheduledFrameCursor = 0L
    val timelineChunks = mutableListOf<GeneratedTimelineChunk>()

    if (totalChunkCount == 0) {
      session.markGenerationComplete()
      return buildGenerationSummary(
        outcome = if (session.isCancelled() || !isCurrentSpeechSession(session)) {
          GenerationOutcome.CANCELLED
        } else {
          GenerationOutcome.COMPLETED
        },
        sampleRate = sampleRate,
        text = text,
        timelineChunks = timelineChunks,
        totalScheduledFrames = scheduledFrameCursor
      )
    }

    preparedPayload.textCleanChunks.forEachIndexed { index, textClean ->
      if (session.isCancelled() || !isCurrentSpeechSession(session)) {
        return buildGenerationSummary(
          outcome = GenerationOutcome.CANCELLED,
          sampleRate = sampleRate,
          text = text,
          timelineChunks = timelineChunks,
          totalScheduledFrames = scheduledFrameCursor
        )
      }

      val samples = tts.generate(textClean, sid, speed).samples
      val rawChunkText = preparedPayload.rawTextChunks.getOrElse(index) { "" }
      val highlightStart = rawTextCursor
      val highlightEnd = rawTextCursor + rawChunkText.length
      rawTextCursor = highlightEnd
      val chunkSilencePaddingSec =
        if (index + 1 < totalChunkCount && silencePaddingSec > 0f) silencePaddingSec
        else 0f
      val chunkStartFrame = scheduledFrameCursor
      val chunkEndFrame = chunkStartFrame + samples.size.toLong()
      val chunkStartSec = framesToSeconds(chunkStartFrame, sampleRate)
      val chunkEndSec = framesToSeconds(chunkEndFrame, sampleRate)
      timelineChunks.add(
        GeneratedTimelineChunk(
          index = timelineChunks.size,
          text = rawChunkText,
          textHighlightStart = highlightStart,
          textHighlightEnd = highlightEnd,
          startSec = chunkStartSec,
          endSec = chunkEndSec,
          durationSec = chunkEndSec - chunkStartSec,
          progress = (index + 1).toDouble() / totalChunkCount.toDouble(),
          textHighlightSegment = null
        )
      )
      scheduledFrameCursor = chunkEndFrame

      session.enqueueSpeech(
        samples = samples,
        progress = (index + 1).toDouble() / totalChunkCount.toDouble(),
        text = rawChunkText,
        textHighlightStart = highlightStart,
        textHighlightEnd = highlightEnd,
        silencePaddingSec = chunkSilencePaddingSec,
        sampleRate = sampleRate
      )

      if (chunkSilencePaddingSec > 0f) {
        scheduledFrameCursor += silenceFrameCount(chunkSilencePaddingSec, sampleRate).toLong()
      }
    }

    session.markGenerationComplete()
    return buildGenerationSummary(
      outcome = if (session.isCancelled() || !isCurrentSpeechSession(session)) {
        GenerationOutcome.CANCELLED
      } else {
        GenerationOutcome.COMPLETED
      },
      sampleRate = sampleRate,
      text = text,
      timelineChunks = timelineChunks,
      totalScheduledFrames = scheduledFrameCursor
    )
  }

  private fun generateDialogueSpeech(
    tts: OfflineTts,
    session: WfloatAudioSession,
    segments: ReadableArray,
    silenceBetweenSegmentsSec: Float,
  ): GenerationSummary {
    val preparedSegments = mutableListOf<PreparedDialogueSegment>()
    var totalChunkCount = 0
    val sampleRate = tts.sampleRate()

    for (index in 0 until segments.size()) {
      val segment = segments.getMap(index)
        ?: throw IllegalArgumentException("segments[$index] is required.")
      val text = readRequiredString(segment, "text")
      if (text.isBlank()) {
        throw IllegalArgumentException("segments[$index].text is required.")
      }

      val sid = readRequiredNonNegativeInt(segment, "sid")
      val emotion = readString(segment, "emotion")?.ifBlank { "neutral" } ?: "neutral"
      val intensity = normalizeIntensity(readDouble(segment, "intensity"), DEFAULT_INTENSITY)
      val speed = normalizePositiveDouble(readDouble(segment, "speed"), DEFAULT_SPEED)
      val sentenceSilencePaddingSec = normalizeNonNegativeDouble(
        readDouble(segment, "sentenceSilencePaddingSec"),
        DEFAULT_SENTENCE_SILENCE_SEC
      )

      val preparedPayload = preparedTextPayload(tts, text, emotion, intensity.toFloat())
      preparedSegments.add(
        PreparedDialogueSegment(
          rawTextChunks = preparedPayload.rawTextChunks,
          textCleanChunks = preparedPayload.textCleanChunks,
          rawText = text,
          sid = sid,
          speed = speed.toFloat(),
          sentenceSilencePaddingSec = sentenceSilencePaddingSec.toFloat()
        )
      )
      totalChunkCount += preparedPayload.textCleanChunks.size
    }

    if (totalChunkCount == 0) {
      session.markGenerationComplete()
      return buildGenerationSummary(
        outcome = if (session.isCancelled() || !isCurrentSpeechSession(session)) {
          GenerationOutcome.CANCELLED
        } else {
          GenerationOutcome.COMPLETED
        },
        sampleRate = sampleRate,
        text = preparedSegments.joinToString(separator = "\n") { it.rawText },
        timelineChunks = emptyList(),
        totalScheduledFrames = 0
      )
    }

    var progressIndex = 0
    var scheduledFrameCursor = 0L
    val timelineChunks = mutableListOf<GeneratedTimelineChunk>()
    val segmentOffsets = computeDialogueSegmentOffsets(preparedSegments.map { it.rawText })

    preparedSegments.forEachIndexed { segmentIndex, segment ->
      var rawTextCursor = 0
      segment.textCleanChunks.forEachIndexed { index, textClean ->
        if (session.isCancelled() || !isCurrentSpeechSession(session)) {
          return buildGenerationSummary(
            outcome = GenerationOutcome.CANCELLED,
            sampleRate = sampleRate,
            text = preparedSegments.joinToString(separator = "\n") { it.rawText },
            timelineChunks = timelineChunks,
            totalScheduledFrames = scheduledFrameCursor
          )
        }

        val samples = tts.generate(textClean, segment.sid, segment.speed).samples
        progressIndex += 1
        val rawChunkText = segment.rawTextChunks.getOrElse(index) { "" }
        val segmentBaseOffset = segmentOffsets[segmentIndex]
        val relativeHighlightStart = rawTextCursor
        val relativeHighlightEnd = rawTextCursor + rawChunkText.length
        val highlightStart = segmentBaseOffset + relativeHighlightStart
        val highlightEnd = segmentBaseOffset + relativeHighlightEnd
        rawTextCursor = relativeHighlightEnd
        val silencePaddingSec =
          if (index + 1 == segment.textCleanChunks.size) silenceBetweenSegmentsSec
          else segment.sentenceSilencePaddingSec
        val chunkStartFrame = scheduledFrameCursor
        val chunkEndFrame = chunkStartFrame + samples.size.toLong()
        val chunkStartSec = framesToSeconds(chunkStartFrame, sampleRate)
        val chunkEndSec = framesToSeconds(chunkEndFrame, sampleRate)
        timelineChunks.add(
          GeneratedTimelineChunk(
            index = timelineChunks.size,
            text = rawChunkText,
            textHighlightStart = highlightStart,
            textHighlightEnd = highlightEnd,
            startSec = chunkStartSec,
            endSec = chunkEndSec,
            durationSec = chunkEndSec - chunkStartSec,
            progress = progressIndex.toDouble() / totalChunkCount.toDouble(),
            textHighlightSegment = segmentIndex
          )
        )
        scheduledFrameCursor = chunkEndFrame

        session.enqueueSpeech(
          samples = samples,
          progress = progressIndex.toDouble() / totalChunkCount.toDouble(),
          text = rawChunkText,
          textHighlightStart = highlightStart,
          textHighlightEnd = highlightEnd,
          silencePaddingSec = silencePaddingSec,
          sampleRate = sampleRate,
          textHighlightSegment = segmentIndex
        )

        if (silencePaddingSec > 0f) {
          scheduledFrameCursor += silenceFrameCount(silencePaddingSec, sampleRate).toLong()
        }
      }
    }

    session.markGenerationComplete()
    return buildGenerationSummary(
      outcome = if (session.isCancelled() || !isCurrentSpeechSession(session)) {
        GenerationOutcome.CANCELLED
      } else {
        GenerationOutcome.COMPLETED
      },
      sampleRate = sampleRate,
      text = preparedSegments.joinToString(separator = "\n") { it.rawText },
      timelineChunks = timelineChunks,
      totalScheduledFrames = scheduledFrameCursor
    )
  }

  private fun preparedTextPayload(
    tts: OfflineTts,
    text: String,
    emotion: String,
    intensity: Float,
  ): PreparedTextPayload {
    val payload = tts.prepareWfloatText(text, emotion, intensity)
    return PreparedTextPayload(
      rawTextChunks = payload.text,
      textCleanChunks = payload.textClean
    )
  }

  private fun buildGenerationSummary(
    outcome: GenerationOutcome,
    sampleRate: Int,
    text: String,
    timelineChunks: List<GeneratedTimelineChunk>,
    totalScheduledFrames: Long,
  ): GenerationSummary {
    val result = if (outcome == GenerationOutcome.COMPLETED) {
      GeneratedSpeechResult(
        sampleRate = sampleRate,
        durationSec = framesToSeconds(totalScheduledFrames, sampleRate),
        text = text,
        timelineChunks = timelineChunks
      )
    } else {
      null
    }

    return GenerationSummary(outcome = outcome, result = result)
  }

  private fun framesToSeconds(frameCount: Long, sampleRate: Int): Double {
    if (sampleRate <= 0) {
      return 0.0
    }

    return frameCount.toDouble() / sampleRate.toDouble()
  }

  private fun silenceFrameCount(silencePaddingSec: Float, sampleRate: Int): Int {
    if (silencePaddingSec <= 0f || sampleRate <= 0) {
      return 0
    }

    return (silencePaddingSec * sampleRate).toInt()
  }

  private fun computeDialogueSegmentOffsets(segments: List<String>): List<Int> {
    val offsets = mutableListOf<Int>()
    var cursor = 0

    segments.forEachIndexed { index, segmentText ->
      offsets.add(cursor)
      cursor += segmentText.length
      if (index + 1 < segments.size) {
        cursor += 1
      }
    }

    return offsets
  }

  private fun createOfflineTts(
    modelPath: File,
    tokensPath: File,
    dataDir: File,
  ): OfflineTts {
    val config = OfflineTtsConfig(
      model = OfflineTtsModelConfig(
        wfloat = OfflineTtsWfloatModelConfig(
          model = modelPath.absolutePath,
          tokens = tokensPath.absolutePath,
          dataDir = dataDir.absolutePath,
          lexicon = "",
          dictDir = "",
          noiseScale = 0.667f,
          noiseScaleW = 0.8f,
          lengthScale = 1.0f
        ),
        numThreads = 1,
        debug = false,
        provider = "cpu"
      ),
      maxNumSentences = 1,
      silenceScale = 0.2f
    )

    return OfflineTts(config = config)
  }

  private data class DownloadedAsset(
    val label: String,
    val url: String,
    val destination: File,
  )

  private fun validateSttFileSet(fileSet: SttFileSet) {
    when (fileSet.family) {
      "whisper" -> {
        if (fileSet.encoder.isNullOrBlank() || fileSet.decoder.isNullOrBlank() || fileSet.tokens.isNullOrBlank()) {
          throw IllegalArgumentException("Whisper STT manifests require encoderUrl, decoderUrl, and tokensUrl.")
        }
      }
      "zipformer-transducer" -> {
        if (fileSet.encoder.isNullOrBlank() ||
          fileSet.decoder.isNullOrBlank() ||
          fileSet.joiner.isNullOrBlank() ||
          fileSet.tokens.isNullOrBlank()
        ) {
          throw IllegalArgumentException(
            "Streaming Zipformer STT manifests require encoderUrl, decoderUrl, joinerUrl, and tokensUrl."
          )
        }
      }
      else -> throw IllegalArgumentException("Unsupported STT family: ${fileSet.family}")
    }
  }

  private fun requiredSttDownloads(
    fileSet: SttFileSet,
    directory: File,
  ): List<DownloadedAsset> {
    val assets = mutableListOf<DownloadedAsset>()

    fun add(label: String, url: String?) {
      if (url.isNullOrBlank()) {
        return
      }
      assets.add(
        DownloadedAsset(
          label = label,
          url = url,
          destination = File(directory, requireFileNameFromUrl(url))
        )
      )
    }

    add("model", fileSet.model)
    add("tokens", fileSet.tokens)
    add("preprocessor", fileSet.preprocessor)
    add("encoder", fileSet.encoder)
    add("decoder", fileSet.decoder)
    add("joiner", fileSet.joiner)
    add("uncached_decoder", fileSet.uncachedDecoder)
    add("cached_decoder", fileSet.cachedDecoder)
    return assets
  }

  private fun createOfflineWhisperRecognizer(
    fileSet: SttFileSet,
    language: String,
    task: String,
  ): OfflineRecognizer {
    val config = OfflineRecognizerConfig(
      featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
      modelConfig = OfflineModelConfig(
        whisper = OfflineWhisperModelConfig(
          encoder = fileSet.encoder ?: "",
          decoder = fileSet.decoder ?: "",
          language = language,
          task = task,
          tailPaddings = 1000
        ),
        tokens = fileSet.tokens ?: "",
        numThreads = 1,
        debug = false,
        provider = "cpu",
        modelType = "whisper",
      ),
      hr = HomophoneReplacerConfig(),
      decodingMethod = "greedy_search",
      maxActivePaths = 4,
      hotwordsFile = "",
      hotwordsScore = 1.5f,
      ruleFsts = "",
      ruleFars = "",
      blankPenalty = 0.0f,
    )

    return OfflineRecognizer(config = config)
  }

  private fun createStreamingZipformerRecognizer(
    fileSet: SttFileSet,
  ): OnlineRecognizer {
    val config = OnlineRecognizerConfig(
      featConfig = FeatureConfig(sampleRate = 16000, featureDim = 80),
      modelConfig = OnlineModelConfig(
        transducer = OnlineTransducerModelConfig(
          encoder = fileSet.encoder ?: "",
          decoder = fileSet.decoder ?: "",
          joiner = fileSet.joiner ?: "",
        ),
        tokens = fileSet.tokens ?: "",
        numThreads = 1,
        debug = false,
        provider = "cpu",
        modelType = "zipformer",
      ),
      hr = HomophoneReplacerConfig(),
      enableEndpoint = true,
      decodingMethod = "greedy_search",
      maxActivePaths = 4,
      hotwordsFile = "",
      hotwordsScore = 1.5f,
      ruleFsts = "",
      ruleFars = "",
      blankPenalty = 0.0f,
    )

    return OnlineRecognizer(config = config)
  }

  private fun mapOfflineRecognizerResult(
    modelId: String,
    result: com.k2fsa.sherpa.onnx.OfflineRecognizerResult,
  ): SttTranscriptionResult {
    val timestamps = result.timestamps
    val durations = result.durations
    val confidences = FloatArray(result.tokens.size)
    val tokens = result.tokens.mapIndexed { index, text ->
      SttTranscriptionToken(
        text = text,
        startSec = timestamps.getOrNull(index)?.toDouble() ?: 0.0,
        durationSec = durations.getOrNull(index)?.toDouble() ?: 0.0,
        confidence = confidences.getOrNull(index)?.toDouble() ?: 0.0
      )
    }

    return SttTranscriptionResult(
      text = result.text,
      modelId = modelId,
      language = result.lang,
      emotion = result.emotion,
      event = result.event,
      json = buildOfflineJson(result),
      tokens = tokens,
      segments = emptyList(),
    )
  }

  private fun buildOfflineJson(result: com.k2fsa.sherpa.onnx.OfflineRecognizerResult): String {
    val tokenJson = result.tokens.joinToString(separator = ",", prefix = "[", postfix = "]") {
      "\"${escapeJson(it)}\""
    }
    return "{\"text\":\"${escapeJson(result.text)}\",\"tokens\":$tokenJson}"
  }

  private fun buildStreamingJson(
    text: String,
    tokens: Array<String>,
    timestamps: FloatArray,
  ): String {
    val tokenJson = tokens.joinToString(separator = ",", prefix = "[", postfix = "]") {
      "\"${escapeJson(it)}\""
    }
    val timestampJson =
      timestamps.joinToString(separator = ",", prefix = "[", postfix = "]") { it.toString() }
    return "{\"text\":\"${escapeJson(text)}\",\"tokens\":$tokenJson,\"timestamps\":$timestampJson}"
  }

  private fun decodeOnlineSession(recognizer: OnlineRecognizer, stream: OnlineStream) {
    while (recognizer.isReady(stream)) {
      recognizer.decode(stream)
    }
  }

  private fun requireSttSession(sessionId: Int): OnlineStream {
    synchronized(stateLock) {
      return sttSessions[sessionId]
        ?: throw IllegalArgumentException("Unknown STT session: $sessionId")
    }
  }

  private fun closeAllSttSessions() {
    synchronized(stateLock) {
      sttSessions.values.forEach { it.release() }
      sttSessions.clear()
    }
  }

  private fun cancelCurrentSpeechSession() {
    val currentSession = speechSession
    speechSession = null
    currentSession?.cancel()
  }

  private fun isCurrentSpeechSession(session: WfloatAudioSession): Boolean {
    return speechSession === session
  }

  private fun cacheRootDirectory(): File {
    return File(reactApplicationContext.cacheDir, "wfloat")
  }

  private fun modelCacheRootDirectory(): File {
    return File(cacheRootDirectory(), "models")
  }

  private fun espeakCacheRootDirectory(): File {
    return File(cacheRootDirectory(), "espeak")
  }

  private fun espeakWorkRootDirectory(): File {
    return File(cacheRootDirectory(), "espeak-work")
  }

  private fun cacheDirectoryForModelId(modelId: String): File {
    return File(modelCacheRootDirectory(), modelId)
  }

  private fun espeakDirectoryForChecksum(checksum: String): File {
    return File(espeakCacheRootDirectory(), checksum)
  }

  private fun isInstalledEspeakDirectory(directory: File): Boolean {
    return directory.isDirectory && File(directory, READY_MARKER_FILE_NAME).exists()
  }

  private fun ensureDirectoryExists(directory: File) {
    if (!directory.exists() && !directory.mkdirs()) {
      throw IOException("Failed to create directory: ${directory.absolutePath}")
    }
  }

  private fun cleanupStaleModelFiles(directory: File, activeFileNames: Set<String>) {
    directory.listFiles()?.forEach { file ->
      if (file.name in activeFileNames) {
        return@forEach
      }

      if (file.name.endsWith(".onnx") || file.name.endsWith("_tokens.txt")) {
        file.delete()
      }
    }
  }

  private fun cleanupStaleEspeakDirectories(activeDirectory: File) {
    espeakCacheRootDirectory().listFiles()?.forEach { file ->
      if (file.isDirectory && file.absolutePath != activeDirectory.absolutePath) {
        file.deleteRecursively()
      }
    }
  }

  private fun cleanupEspeakWorkDirectory() {
    espeakWorkRootDirectory().deleteRecursively()
  }

  private fun installEspeakArchive(
    archivePath: File,
    checksum: String,
    destinationDirectory: File,
  ) {
    val computedChecksum = sha256ForFile(archivePath)
    if (computedChecksum != checksum) {
      throw IOException("Downloaded espeak-ng-data checksum did not match the expected value.")
    }

    ensureDirectoryExists(espeakWorkRootDirectory())
    val extractionRoot = File(espeakWorkRootDirectory(), UUID.randomUUID().toString())
    ensureDirectoryExists(extractionRoot)

    unzipArchive(archivePath, extractionRoot)
    val resolvedDataDirectory = resolvedEspeakDataDirectory(extractionRoot)

    destinationDirectory.deleteRecursively()
    if (!resolvedDataDirectory.renameTo(destinationDirectory)) {
      resolvedDataDirectory.copyRecursively(destinationDirectory, overwrite = true)
      resolvedDataDirectory.deleteRecursively()
    }

    File(destinationDirectory, READY_MARKER_FILE_NAME).writeText(READY_MARKER_FILE_NAME)
    extractionRoot.deleteRecursively()
  }

  private fun resolvedEspeakDataDirectory(extractionRoot: File): File {
    val visibleContents = extractionRoot.listFiles()
      ?.filterNot { it.name.startsWith(".") || it.name == "__MACOSX" }
      .orEmpty()

    val namedDirectory = File(extractionRoot, "espeak-ng-data")
    if (namedDirectory.isDirectory) {
      return namedDirectory
    }

    val childDirectories = visibleContents.filter { it.isDirectory }
    if (visibleContents.size == 1 && childDirectories.size == 1) {
      return childDirectories.first()
    }

    return extractionRoot
  }

  private fun unzipArchive(archivePath: File, destinationDirectory: File) {
    ZipInputStream(BufferedInputStream(FileInputStream(archivePath))).use { zipInputStream ->
      var entry = zipInputStream.nextEntry
      while (entry != null) {
        val outputFile = File(destinationDirectory, entry.name)
        val canonicalDestinationPath = destinationDirectory.canonicalPath
        val canonicalOutputPath = outputFile.canonicalPath
        if (canonicalOutputPath != canonicalDestinationPath &&
          !canonicalOutputPath.startsWith("$canonicalDestinationPath${File.separator}")
        ) {
          throw IOException("Invalid zip entry path: ${entry.name}")
        }

        if (entry.isDirectory) {
          ensureDirectoryExists(outputFile)
        } else {
          ensureDirectoryExists(outputFile.parentFile ?: destinationDirectory)
          FileOutputStream(outputFile).use { outputStream ->
            zipInputStream.copyTo(outputStream)
          }
        }
        zipInputStream.closeEntry()
        entry = zipInputStream.nextEntry
      }
    }
  }

  private fun downloadFile(
    urlString: String,
    destination: File,
    onProgress: (Double) -> Unit,
  ) {
    ensureDirectoryExists(destination.parentFile ?: throw IOException("Missing parent directory."))

    val temporaryFile = File.createTempFile("wfloat-download-", ".tmp", destination.parentFile)
    val connection = (URL(urlString).openConnection() as HttpURLConnection).apply {
      instanceFollowRedirects = true
      requestMethod = "GET"
      connectTimeout = 30_000
      readTimeout = 30_000
      doInput = true
    }

    try {
      connection.connect()
      val responseCode = connection.responseCode
      if (responseCode !in 200..299) {
        throw IOException("Request failed: $responseCode")
      }

      val totalBytes = connection.contentLengthLong
      connection.inputStream.use { inputStream ->
        BufferedInputStream(inputStream).use { bufferedInputStream ->
          FileOutputStream(temporaryFile).use { outputStream ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var bytesWritten = 0L
            while (true) {
              val bytesRead = bufferedInputStream.read(buffer)
              if (bytesRead < 0) {
                break
              }
              outputStream.write(buffer, 0, bytesRead)
              bytesWritten += bytesRead
              if (totalBytes > 0) {
                onProgress(bytesWritten.toDouble() / totalBytes.toDouble())
              }
            }
          }
        }
      }

      if (destination.exists()) {
        destination.delete()
      }
      if (!temporaryFile.renameTo(destination)) {
        temporaryFile.copyTo(destination, overwrite = true)
        temporaryFile.delete()
      }
    } finally {
      temporaryFile.delete()
      connection.disconnect()
    }
  }

  private fun sha256ForFile(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { inputStream ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val read = inputStream.read(buffer)
        if (read < 0) {
          break
        }
        digest.update(buffer, 0, read)
      }
    }

    return digest.digest().joinToString("") { byte -> "%02x".format(byte) }
  }

  private fun GeneratedTimelineChunk.toWritableMap() = Arguments.createMap().apply {
    putDouble("index", index.toDouble())
    putString("text", text)
    putDouble("textHighlightStart", textHighlightStart.toDouble())
    putDouble("textHighlightEnd", textHighlightEnd.toDouble())
    putDouble("startSec", startSec)
    putDouble("endSec", endSec)
    putDouble("durationSec", durationSec)
    putDouble("progress", progress)
    if (textHighlightSegment != null) {
      putDouble("textHighlightSegment", textHighlightSegment.toDouble())
    }
  }

  private fun GeneratedSpeechResult.toWritableMap() = Arguments.createMap().apply {
    putDouble("sampleRate", sampleRate.toDouble())
    putDouble("durationSec", durationSec)
    putString("text", text)
    putArray(
      "timelineChunks",
      Arguments.createArray().apply {
        timelineChunks.forEach { pushMap(it.toWritableMap()) }
      }
    )
  }

  private fun SttTranscriptionToken.toWritableMap() = Arguments.createMap().apply {
    putString("text", text)
    putDouble("startSec", startSec)
    putDouble("durationSec", durationSec)
    putDouble("confidence", confidence)
  }

  private fun SttTranscriptionSegment.toWritableMap() = Arguments.createMap().apply {
    putString("text", text)
    putDouble("startSec", startSec)
    putDouble("durationSec", durationSec)
  }

  private fun SttTranscriptionResult.toWritableMap() = Arguments.createMap().apply {
    putString("text", text)
    putString("modelId", modelId)
    putString("language", language)
    putString("emotion", emotion)
    putString("event", event)
    putString("json", json)
    putArray(
      "tokens",
      Arguments.createArray().apply {
        tokens.forEach { pushMap(it.toWritableMap()) }
      }
    )
    putArray(
      "segments",
      Arguments.createArray().apply {
        segments.forEach { pushMap(it.toWritableMap()) }
      }
    )
  }

  private fun StreamingSttResult.toWritableMap() = Arguments.createMap().apply {
    putString("text", text)
    putString("modelId", modelId)
    putBoolean("isEndpoint", isEndpoint)
    putString("json", json)
  }

  private fun escapeJson(value: String): String {
    return value
      .replace("\\", "\\\\")
      .replace("\"", "\\\"")
      .replace("\n", "\\n")
      .replace("\r", "\\r")
      .replace("\t", "\\t")
  }

  private fun normalizeChecksum(checksum: String): String {
    return checksum.trim().lowercase()
  }

  private fun requireFileNameFromUrl(url: String): String {
    val fileName = Uri.parse(url).lastPathSegment?.takeIf { it.isNotBlank() }
    return fileName ?: throw IllegalArgumentException("Invalid loadModel asset URL.")
  }

  private fun emitLoadModelProgress(status: String, progress: Double?) {
    val event = Arguments.createMap().apply {
      putString("status", status)
      if (progress != null) {
        putDouble("progress", progress)
      }
    }
    emitOnLoadModelProgress(event)
  }

  private fun emitSpeechProgress(
    requestId: Int,
    progress: Double,
    isPlaying: Boolean,
    textHighlightStart: Int,
    textHighlightEnd: Int,
    text: String,
    textHighlightSegment: Int?,
  ) {
    val event = Arguments.createMap().apply {
      putDouble("requestId", requestId.toDouble())
      putDouble("progress", progress)
      putBoolean("isPlaying", isPlaying)
      putDouble("textHighlightStart", textHighlightStart.toDouble())
      putDouble("textHighlightEnd", textHighlightEnd.toDouble())
      putString("text", text)
      if (textHighlightSegment != null) {
        putDouble("textHighlightSegment", textHighlightSegment.toDouble())
      }
    }
    emitOnSpeechProgress(event)
  }

  private fun emitSpeechPlaybackFinished(requestId: Int) {
    val event = Arguments.createMap().apply {
      putDouble("requestId", requestId.toDouble())
    }
    emitOnSpeechPlaybackFinished(event)
  }

  companion object {
    const val NAME = "Wfloat"

    private fun readRequiredString(map: ReadableMap, key: String): String {
      return readString(map, key)
        ?: throw IllegalArgumentException("$key is required.")
    }

    private fun readRequiredArray(map: ReadableMap, key: String): ReadableArray {
      return if (!map.hasKey(key) || map.isNull(key)) {
        throw IllegalArgumentException("$key is required.")
      } else {
        map.getArray(key) ?: throw IllegalArgumentException("$key is required.")
      }
    }

    private fun readString(map: ReadableMap, key: String): String? {
      return if (!map.hasKey(key) || map.isNull(key)) {
        null
      } else {
        map.getString(key)
      }
    }

    private fun readDouble(map: ReadableMap, key: String): Double? {
      return if (!map.hasKey(key) || map.isNull(key)) {
        null
      } else {
        map.getDouble(key)
      }
    }

    private fun readRequiredNonNegativeInt(map: ReadableMap, key: String): Int {
      val value = readDouble(map, key)
        ?: throw IllegalArgumentException("$key must be a non-negative integer.")
      if (!value.isFinite() || value < 0 || value != value.toInt().toDouble()) {
        throw IllegalArgumentException("$key must be a non-negative integer.")
      }
      return value.toInt()
    }

    private fun readRequiredPositiveInt(map: ReadableMap, key: String): Int {
      val value = readRequiredNonNegativeInt(map, key)
      if (value <= 0) {
        throw IllegalArgumentException("$key must be a positive integer.")
      }
      return value
    }

    private fun readRequiredFloatArray(map: ReadableMap, key: String): FloatArray {
      val array = readRequiredArray(map, key)
      val values = FloatArray(array.size())
      for (index in 0 until array.size()) {
        val value = array.getDouble(index)
        if (!value.isFinite()) {
          throw IllegalArgumentException("$key[$index] must be a finite number.")
        }
        values[index] = value.toFloat()
      }
      return values
    }

    private fun normalizeIntensity(value: Double?, defaultValue: Double): Double {
      if (value == null || !value.isFinite()) {
        return defaultValue
      }

      return value.coerceIn(0.0, 1.0)
    }

    private fun normalizePositiveDouble(value: Double?, defaultValue: Double): Double {
      if (value == null || !value.isFinite() || value <= 0.0) {
        return defaultValue
      }

      return value
    }

    private fun normalizeNonNegativeDouble(value: Double?, defaultValue: Double): Double {
      if (value == null || !value.isFinite()) {
        return defaultValue
      }

      return value.coerceAtLeast(0.0)
    }

    private fun loadModelErrorCode(error: Throwable): String {
      return when (error) {
        is IllegalArgumentException -> "invalid_arguments"
        is IOException -> "download_failed"
        else -> "load_failed"
      }
    }
  }
}
