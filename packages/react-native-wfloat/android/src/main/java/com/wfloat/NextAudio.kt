package com.wfloat

import android.Manifest
import android.app.Activity
import android.app.Application
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.*
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.ReactApplicationContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean

/** One microphone source, independently of playback; never changes the app-wide audio mode. */
internal class NextAudio(private val context: ReactApplicationContext, private val emit: (String, JSONObject) -> Unit) :
  Application.ActivityLifecycleCallbacks {
  private val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val application = context.applicationContext as Application
  private val handler = Handler(Looper.getMainLooper())
  @Volatile private var foreground = context.currentActivity?.hasWindowFocus() == true
  private var startedActivities = if (context.currentActivity != null) 1 else 0
  @Volatile private var closed = false
  private val changes = java.util.concurrent.Executors.newSingleThreadExecutor()
  private val playbackClock = java.util.concurrent.Executors.newSingleThreadScheduledExecutor()
  private fun later(action: () -> Unit) {
    if (closed) return
    try { changes.execute(action) } catch (_: java.util.concurrent.RejectedExecutionException) { }
  }
  private fun change(action: () -> Unit) {
    if (closed) return
    try { changes.execute { synchronized(this) { if (!closed) action() } } }
    catch (_: java.util.concurrent.RejectedExecutionException) { }
  }
  private var mic: Capture? = null
  private val captures = mutableMapOf<String, Capture>()
  private val terminalCaptures = mutableSetOf<String>()
  private val players = mutableMapOf<String, Player>()
  private data class PreparedPlayback(val requestId: String, val focus: String, var token: String? = null)
  private val preparedPlayers = mutableMapOf<String, PreparedPlayback>()
  private val closedPlayers = mutableSetOf<String>()
  private var focusRequest: AudioFocusRequest? = null
  private var focusHeld = false
  private var focusMode: String? = null
  private val focusListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
    if (focusChange < 0) change {
      players.values.toList().forEach { pause(it, false) }
      mic?.let { suspendCapture(it, false) }
    }
  }
  private var modeListener: AudioManager.OnModeChangedListener? = null
  private val noisy = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) = change {
      players.values.toList().forEach { pause(it, false) }
      mic?.let { suspendCapture(it, false) }
    }
  }
  init {
    playbackClock.scheduleWithFixedDelay({
      synchronized(this) {
        if (!closed) players.values.toList().filter { it.started && !it.paused }.forEach { p ->
          try { emitPosition(p, true) }
          catch (e: Exception) {
            players.remove(p.id); p.close()
            if (players.values.none { it.started && !it.paused }) releaseFocus()
            emit(p.requestId, JSONObject().put("type", "playbackState").put("state", "failed").put("message", e.message))
          }
        }
      }
    }, 50, 50, java.util.concurrent.TimeUnit.MILLISECONDS)
    application.registerActivityLifecycleCallbacks(this)
    if (Build.VERSION.SDK_INT >= 31) {
      val listener = AudioManager.OnModeChangedListener { mode ->
        if (mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_IN_COMMUNICATION) change {
          players.values.toList().forEach { pause(it, false) }
          mic?.let { suspendCapture(it, false) }
        }
      }
      modeListener = listener
      manager.addOnModeChangedListener(context.mainExecutor, listener)
    }
    if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), Context.RECEIVER_NOT_EXPORTED)
    else context.registerReceiver(noisy, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
  }
  private fun policy(options: JSONObject): String {
    val value = options.optString("backgroundBehavior", "pauseUntilResumed")
    require(value in listOf("continue", "pauseAndAutoResume", "pauseUntilResumed")) { "Unknown backgroundBehavior" }
    return value
  }
  private data class PendingFrame(val sequence: Long, val samples: ShortArray, val sampleRate: Int) {
    fun event(): JSONObject {
      val pcm = JSONArray()
      samples.forEach { pcm.put(it / 32768.0) }
      return JSONObject().put("type", "audio").put("sequence", sequence)
        .put("samples", pcm).put("sampleRate", sampleRate)
    }
  }
  private data class Capture(val id: String, val requestId: String, val policy: String, val voice: Boolean) {
    val running = AtomicBoolean(false)
    var serviceToken: String? = null
    var recorder: AudioRecord? = null
    var thread: Thread? = null
    var echo: AcousticEchoCanceler? = null
    var noise: NoiseSuppressor? = null
    var callback: AudioManager.AudioRecordingCallback? = null
    var autoResume = false
    var nextSequence = 1L
    var lastBacklogWarningNanos = 0L
    val pending = java.util.TreeMap<Long, PendingFrame>()
  }
  private fun warning(c: Capture, message: String) {
    Log.w("WfloatNext", message)
    emit(c.requestId, JSONObject().put("type", "warning").put("message", message))
  }
  private fun captureState(c: Capture, state: String) = emit(c.requestId, JSONObject().put("type", "captureState").put("state", state))
  @Synchronized fun command(requestId: String, c: JSONObject): Any {
    check(!closed) { "Audio coordinator closed" }
    when (c.getString("op")) {
      "micAck" -> {
        val capture = captures[c.getString("captureId")] ?: error("Unknown captureId")
        val sequence = c.getLong("sequence")
        synchronized(capture.pending) {
          require(sequence >= 0 && sequence < capture.nextSequence) { "Invalid microphone acknowledgement" }
          capture.pending.headMap(sequence, true).clear()
        }
      }
      "micDrain" -> {
        val capture = captures[c.getString("captureId")] ?: error("Unknown captureId")
        val after = c.getLong("afterSequence")
        return synchronized(capture.pending) { JSONArray(capture.pending.tailMap(after, false).values.map { it.event() }) }
      }
      "micStart" -> {
        val id = c.getString("captureId")
        require(id !in terminalCaptures) { "Capture is terminal" }
        require(mic == null || mic!!.id == id) { "Only one shared microphone source is supported; attach consumers to the same capture" }
        var capture = mic
        if (capture == null) {
          val options = c.optJSONObject("options") ?: JSONObject()
          try { capture = Capture(id, requestId, policy(options), options.optBoolean("voiceProcessing", false)) }
          catch (e: Exception) {
            terminalCaptures.add(id)
            emit(requestId, JSONObject().put("type", "captureState").put("state", "failed"))
            throw e
          }
          mic = capture
          captures[id] = capture
        }
        try { startCapture(capture) }
        catch (e: Exception) { failCapture(capture, e.message ?: "Microphone failed"); throw e }
        return JSONObject().put("state", if (capture.running.get()) "recording" else "paused")
      }
      "micStop" -> {
        val id = c.getString("captureId")
        val capture = mic
        // JS may stop while its permission check is pending, before micStart.
        // Fence this identity even when no recorder exists; a late start must fail.
        terminalCaptures.add(id)
        if (capture != null && capture.id == id) {
          stopRecorder(capture)
          mic = null
          captureState(capture, "stopped")
          return synchronized(capture.pending) { JSONArray(capture.pending.values.map { it.event() }) }
        }
      }
      "playbackPrepare" -> {
        val id = c.getString("playbackId")
        require(id !in closedPlayers) { "Playback is terminal" }
        val options = c.optJSONObject("options") ?: JSONObject()
        require(policy(options) == "continue") { "playbackPrepare requires backgroundBehavior=continue" }
        val focus = options.optString("audioFocus", "interruptOthers")
        require(focus in listOf("interruptOthers", "duckOthers", "mixWithOthers")) { "Unknown audioFocus" }
        players[id]?.let { player ->
          require(player.policy == "continue" && player.focus == focus && player.requestId == requestId) {
            "Playback preparation options/channel changed"
          }
          if (player.paused && !player.resumePrepared) {
            require(foreground) { "Prepare explicit playback resume while the app is foregrounded" }
            acquirePlayerLease(player)
            player.resumePrepared = true
            player.autoResume = false
          }
          return JSONObject.NULL
        }
        val existing = preparedPlayers[id]
        if (existing != null) {
          require(existing.requestId == requestId && existing.focus == focus) { "Playback preparation options/channel changed" }
        } else {
          val prepared = PreparedPlayback(requestId, focus)
          preparedPlayers[id] = prepared
          try {
            prepared.token = WfloatNextAudioService.acquire(context, false, foreground) { message ->
              change {
                val pending = preparedPlayers[id] === prepared
                val player = players[id]?.takeIf { it.serviceToken != null && it.serviceToken == prepared.token }
                if (pending || player != null) {
                  preparedPlayers.remove(id)
                  closedPlayers.add(id)
                  prepared.token?.let { WfloatNextAudioService.release(context, it) }
                  if (player != null) { players.remove(id); player.close() }
                  if (players.values.none { it.started && !it.paused }) releaseFocus()
                  emit(prepared.requestId, JSONObject().put("type", "playbackState").put("state", "failed").put("message", message))
                }
              }
            }
          } catch (e: Exception) { releasePrepared(id); throw e }
        }
      }
      "playbackStart" -> {
        val id = c.getString("playbackId")
        require(id !in closedPlayers) { "Playback is terminal" }
        val existing = players[id]
        if (existing != null) {
          require(foreground || (existing.policy == "continue" && existing.serviceToken != null && (!existing.paused || existing.resumePrepared))) {
            "Resume interrupted playback while the app is foregrounded"
          }
          existing.autoResume = false
          startPlayer(existing)
        } else {
          val prepared = preparedPlayers[id]
          var created: Player? = null
          try {
            val options = c.optJSONObject("options") ?: JSONObject()
            val behavior = policy(options)
            val focus = options.optString("audioFocus", "interruptOthers")
            require(focus in listOf("interruptOthers", "duckOthers", "mixWithOthers")) { "Unknown audioFocus" }
            if (prepared != null) require(behavior == "continue" && focus == prepared.focus && requestId == prepared.requestId) {
              "Playback start must retain prepared options and event channel"
            }
            require(foreground || (behavior == "continue" && prepared?.token != null)) { "Start playback while foregrounded or prepare continued playback first" }
            val rate = c.getInt("sampleRate")
            require(rate in 8000..192000) { "Invalid playback sampleRate" }
            val samples = pcm(c.getJSONArray("samples"))
            val offset = c.optDouble("offsetMs", 0.0)
            require(offset.isFinite() && offset >= 0) { "Invalid playback offset" }
            val p = Player(id, prepared?.requestId ?: requestId, rate, behavior, focus, offset)
            created = p
            p.serviceToken = prepared?.token
            preparedPlayers.remove(id)
            players[id] = p
            if (samples.isNotEmpty()) { p.queue.put(samples); startPlayer(p) }
          } catch (e: Exception) {
            releasePrepared(id)
            players.remove(id); created?.close()
            if (players.values.none { it.started && !it.paused }) releaseFocus()
            throw e
          }
        }
      }
      "playbackAppend" -> {
        val p = player(c)
        val samples = pcm(c.getJSONArray("samples"))
        if (samples.isNotEmpty()) {
          p.queue.put(samples)
          if (!p.started && !p.paused) startPlayer(p)
        }
      }
      "playbackPause" -> {
        val id = c.getString("playbackId")
        val prepared = preparedPlayers[id]
        if (prepared != null) {
          releasePrepared(id)
          emit(prepared.requestId, JSONObject().put("type", "playbackState").put("state", "paused"))
        } else pause(player(c), false)
      }
      "playbackClose" -> {
        val id = c.getString("playbackId")
        closedPlayers.add(id)
        releasePrepared(id)
        players.remove(id)?.let { p ->
          try { emitPosition(p, true) } finally { p.close() }
        }
        if (players.values.none { it.started && !it.paused }) releaseFocus()
      }
      "playbackPosition" -> return player(c).position()
      else -> error("Unknown audio command")
    }
    return JSONObject.NULL
  }
  private fun releasePrepared(id: String) {
    preparedPlayers.remove(id)?.token?.let { WfloatNextAudioService.release(context, it) }
  }
  private fun pcm(array: JSONArray) = FloatArray(array.length()) { index ->
    val value = array.getDouble(index)
    require(value.isFinite()) { "PCM contains non-finite sample" }
    value.coerceIn(-1.0, 1.0).toFloat()
  }
  private fun player(c: JSONObject) = players[c.getString("playbackId")] ?: error("Unknown playbackId")
  private fun startCapture(c: Capture) {
    if (c.running.get()) return
    c.autoResume = false
    captureState(c, "starting")
    require(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      "Microphone permission is not granted; RECORD_AUDIO must be granted before native capture starts"
    }
    if (!foreground && c.policy != "continue") { captureState(c, "paused"); c.autoResume = c.policy == "pauseAndAutoResume"; return }
    if (c.policy == "continue") c.serviceToken = WfloatNextAudioService.acquire(context, true, foreground) { message ->
      later { synchronized(this@NextAudio) { if (mic === c) failCapture(c, message) } }
    }
    val rate = 16000
    val minimum = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    require(minimum > 0) { "Microphone does not support 16 kHz mono capture" }
    val recorder = AudioRecord(if (c.voice) MediaRecorder.AudioSource.VOICE_COMMUNICATION else MediaRecorder.AudioSource.VOICE_RECOGNITION,
      rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum, 6400))
    c.recorder = recorder
    check(recorder.state == AudioRecord.STATE_INITIALIZED) { "Microphone initialization failed" }
    if (c.voice) {
      try {
        if (AcousticEchoCanceler.isAvailable()) c.echo = AcousticEchoCanceler.create(recorder.audioSessionId)
        if (NoiseSuppressor.isAvailable()) c.noise = NoiseSuppressor.create(recorder.audioSessionId)
        c.echo?.enabled = true
        c.noise?.enabled = true
        if (c.echo?.enabled != true) warning(c, "voiceProcessing requested but native echo cancellation is unavailable; continuing without echo cancellation")
      } catch (e: Exception) { warning(c, "Native voice processing unavailable; continuing with capture: ${e.message}") }
    }
    if (Build.VERSION.SDK_INT >= 29) {
      val callback = object : AudioManager.AudioRecordingCallback() {
        override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
          if (configs.any { it.clientAudioSessionId == recorder.audioSessionId && it.isClientSilenced }) {
            change { if (mic === c) suspendCapture(c, false) }
          }
        }
      }
      c.callback = callback
      manager.registerAudioRecordingCallback(callback, handler)
    }
    recorder.startRecording()
    check(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) { "Microphone did not enter recording state" }
    c.running.set(true)
    captureState(c, "recording")
    c.thread = Thread({
      val buffer = ShortArray(1600)
      try {
        while (c.running.get()) {
          val n = recorder.read(buffer, 0, buffer.size)
          if (!c.running.get()) break
          if (n == AudioRecord.ERROR_DEAD_OBJECT) {
            change { if (mic === c) suspendCapture(c, false) }
            break
          }
          check(n > 0) { "Microphone read failed ($n)" }
          val frame = synchronized(c.pending) {
            val sequence = c.nextSequence++
            PendingFrame(sequence, buffer.copyOf(n), rate).also { c.pending[sequence] = it }
          }
          emit(c.requestId, frame.event())
          // Retention is lossless and warning-only. Session buffer limits belong
          // to the explicit STT maxBufferedAudioMs policy, not the transport.
          val now = System.nanoTime()
          if (synchronized(c.pending) { c.pending.size >= 600 } &&
            now - c.lastBacklogWarningNanos >= 30_000_000_000L) {
            c.lastBacklogWarningNanos = now
            warning(c, "Microphone audio is accumulating while consumers are delayed; retained audio continues growing until acknowledged")
          }
        }
      } catch (e: Exception) {
        if (c.running.get()) later { synchronized(this@NextAudio) { if (mic === c && c.running.get()) failCapture(c, e.message ?: "Capture failed") } }
      }
    }, "WfloatNextCapture").apply { isDaemon = true; start() }
  }
  private fun stopRecorder(c: Capture) {
    c.running.set(false)
    c.callback?.let { manager.unregisterAudioRecordingCallback(it) }
    c.callback = null
    try { c.recorder?.stop() } catch (_: IllegalStateException) { }
    c.thread?.join(1000)
    c.thread = null
    c.echo?.release(); c.echo = null
    c.noise?.release(); c.noise = null
    c.recorder?.release(); c.recorder = null
    c.serviceToken?.let { WfloatNextAudioService.release(context, it) }; c.serviceToken = null
  }
  private fun suspendCapture(c: Capture, lifecycle: Boolean) {
    if (!c.running.get()) { if (!lifecycle) c.autoResume = false; return }
    stopRecorder(c)
    c.autoResume = lifecycle && c.policy == "pauseAndAutoResume"
    captureState(c, "paused")
  }
  private fun failCapture(c: Capture, message: String) {
    stopRecorder(c)
    terminalCaptures.add(c.id)
    mic = null
    emit(c.requestId, JSONObject().put("type", "captureState").put("state", "failed").put("message", message))
    emit(c.requestId, JSONObject().put("type", "error").put("message", message))
  }
  private fun acquireFocus(p: Player) {
    requireCompatiblePlaybackFocus(p, players.values, { it.started && !it.paused }, { it.focus })
    val mode = p.focus
    if (mode == "mixWithOthers") { releaseFocus(); return }
    if (focusHeld && focusMode == mode) return
    val previousRequest = focusRequest
    val previousHeld = focusHeld
    val previousMode = focusMode
    val gain = if (mode == "duckOthers") AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK else AudioManager.AUDIOFOCUS_GAIN_TRANSIENT
    val result = if (Build.VERSION.SDK_INT >= 26) {
      val request = AudioFocusRequest.Builder(gain).setAudioAttributes(attributes()).setAcceptsDelayedFocusGain(false)
        .setOnAudioFocusChangeListener(focusListener, handler).build()
      focusRequest = request
      manager.requestAudioFocus(request)
    } else manager.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, gain)
    if (result != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      if (Build.VERSION.SDK_INT >= 26) focusRequest?.let { manager.abandonAudioFocusRequest(it) }
      focusRequest = previousRequest; focusHeld = previousHeld; focusMode = previousMode
      error("Audio focus was denied")
    }
    if (Build.VERSION.SDK_INT >= 26) previousRequest?.let { manager.abandonAudioFocusRequest(it) }
    focusHeld = true
    focusMode = mode
  }
  private fun releaseFocus() {
    if (Build.VERSION.SDK_INT >= 26) focusRequest?.let { manager.abandonAudioFocusRequest(it) }
    else if (focusHeld) manager.abandonAudioFocus(focusListener)
    focusRequest = null; focusHeld = false; focusMode = null
  }
  private fun attributes() = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
  private fun acquirePlayerLease(p: Player) {
    if (p.policy == "continue" && p.serviceToken == null) {
      p.serviceToken = WfloatNextAudioService.acquire(context, false, foreground) { message ->
        later { synchronized(this@NextAudio) {
          if (players[p.id] === p) {
            players.remove(p.id); p.close()
            if (players.values.none { it.started && !it.paused }) releaseFocus()
            emit(p.requestId, JSONObject().put("type", "playbackState").put("state", "failed").put("message", message))
          }
        } }
      }
    }
  }
  private fun startPlayer(p: Player) {
    acquirePlayerLease(p)
    try {
      acquireFocus(p)
      p.track.play()
      p.started = true
      p.paused = false
      p.resumePrepared = false
    } catch (e: Exception) {
      p.resumePrepared = false
      p.serviceToken?.let { WfloatNextAudioService.release(context, it) }; p.serviceToken = null
      throw e
    }
  }
  private fun emitPosition(p: Player, force: Boolean = false) {
    val position = p.position()
    if (force || position != p.lastEmittedPosition) {
      p.lastEmittedPosition = position
      emit(p.requestId, JSONObject().put("type", "playbackPosition").put("positionMs", position))
    }
  }
  private fun pause(p: Player, lifecycle: Boolean) {
    val wasResumePrepared = p.resumePrepared
    p.resumePrepared = false
    if (p.paused) {
      // A prepared resume still has a paused track. Another explicit pause or
      // interruption must revoke its lease, not leave a background restart armed.
      p.serviceToken?.let { WfloatNextAudioService.release(context, it) }; p.serviceToken = null
      if (!lifecycle) p.autoResume = false
      if (wasResumePrepared) emit(p.requestId, JSONObject().put("type", "playbackState").put("state", "paused"))
      return
    }
    p.paused = true
    p.track.pause()
    emitPosition(p, true)
    p.serviceToken?.let { WfloatNextAudioService.release(context, it) }; p.serviceToken = null
    p.autoResume = lifecycle && p.policy == "pauseAndAutoResume"
    if (players.values.none { it.started && !it.paused }) releaseFocus()
    emit(p.requestId, JSONObject().put("type", "playbackState").put("state", "paused"))
  }
  private inner class Player(val id: String, val requestId: String, val rate: Int, val policy: String, val focus: String, val offset: Double) {
    val queue = LinkedBlockingQueue<FloatArray>()
    val alive = AtomicBoolean(true)
    @Volatile var paused = false
    var autoResume = false
    var started = false
    var resumePrepared = false
    var serviceToken: String? = null
    var lastEmittedPosition = -1.0
    private var previousHead = 0L
    private var wraps = 0L
    val track: AudioTrack
    val thread: Thread
    init {
      val minimum = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT)
      require(minimum > 0) { "Unsupported playback format" }
      track = AudioTrack(attributes(), AudioFormat.Builder().setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
        .setEncoding(AudioFormat.ENCODING_PCM_FLOAT).build(), maxOf(minimum, rate / 5 * 4), AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE)
      if (track.state != AudioTrack.STATE_INITIALIZED) { track.release(); error("AudioTrack initialization failed") }
      thread = Thread({
        try {
          while (alive.get()) {
            val samples = queue.take()
            var index = 0
            while (index < samples.size && alive.get()) {
              if (paused) { Thread.sleep(10); continue }
              val count = track.write(samples, index, samples.size - index, AudioTrack.WRITE_NON_BLOCKING)
              check(count >= 0) { "AudioTrack write failed ($count)" }
              index += count
              if (count == 0) Thread.sleep(5)
            }
          }
        } catch (_: InterruptedException) {
        } catch (e: Exception) {
          later { synchronized(this@NextAudio) {
            if (players[id] === this && alive.get()) {
              players.remove(id); close(); if (players.values.none { it.started && !it.paused }) releaseFocus()
              emit(requestId, JSONObject().put("type", "playbackState").put("state", "failed").put("message", e.message))
            }
          } }
        }
      }, "WfloatNextPlayback").apply { isDaemon = true; start() }
    }
    fun position(): Double {
      val head = track.playbackHeadPosition.toLong() and 0xffffffffL
      if (head < previousHead) wraps += 1L shl 32
      previousHead = head
      return offset + (head + wraps) * 1000.0 / rate
    }
    fun close() {
      alive.set(false)
      thread.interrupt()
      thread.join(1000)
      try { track.pause(); track.flush() } finally { track.release() }
      queue.clear()
      serviceToken?.let { WfloatNextAudioService.release(context, it) }; serviceToken = null
    }
  }
  @Synchronized fun close() {
    if (closed) return
    closed = true
    changes.shutdownNow()
    playbackClock.shutdownNow()
    application.unregisterActivityLifecycleCallbacks(this)
    if (Build.VERSION.SDK_INT >= 31) modeListener?.let { manager.removeOnModeChangedListener(it) }
    modeListener = null
    context.unregisterReceiver(noisy)
    mic?.let { stopRecorder(it) }; mic = null
    preparedPlayers.keys.toList().forEach { releasePrepared(it) }
    players.values.forEach { it.close() }; players.clear()
    captures.clear()
    releaseFocus()
  }
  override fun onActivityStarted(activity: Activity) {
    startedActivities++
    foreground = true
    change {
      mic?.takeIf { it.autoResume }?.let { c ->
        try { startCapture(c) } catch (e: Exception) { failCapture(c, e.message ?: "Microphone resume failed") }
      }
      players.values.toList().filter { it.autoResume }.forEach { p ->
        p.autoResume = false
        try {
          startPlayer(p)
          emit(p.requestId, JSONObject().put("type", "playbackState").put("state", "resumed"))
        } catch (e: Exception) {
          players.remove(p.id); p.close(); if (players.values.none { it.started && !it.paused }) releaseFocus()
          emit(p.requestId, JSONObject().put("type", "playbackState").put("state", "failed").put("message", e.message))
        }
      }
    }
  }
  override fun onActivityStopped(activity: Activity) {
    startedActivities = maxOf(0, startedActivities - 1)
    if (startedActivities == 0 && !activity.isChangingConfigurations) {
      foreground = false
      change {
        mic?.takeIf { it.policy != "continue" }?.let { suspendCapture(it, true) }
        players.values.toList().filter { it.policy != "continue" }.forEach { pause(it, true) }
      }
    }
  }
  override fun onActivityCreated(activity: Activity, state: Bundle?) {}
  override fun onActivityResumed(activity: Activity) { foreground = true }
  override fun onActivityPaused(activity: Activity) {}
  override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
  override fun onActivityDestroyed(activity: Activity) {}
}
