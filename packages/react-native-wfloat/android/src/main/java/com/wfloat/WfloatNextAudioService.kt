package com.wfloat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** Opt-in: the host declares this service, WAKE_LOCK and its FGS permissions. */
class WfloatNextAudioService : Service() {
  companion object {
    private const val CHANNEL = "wfloat_audio"
    private const val NOTIFICATION = 0x57464c
    private data class Owner(val type: Int, val ready: CompletableFuture<Unit>, val lost: (String) -> Unit, var serviceGeneration: String? = null)
    private val owners = mutableMapOf<String, Owner>()
    private val lock = Any()
    private var service: WfloatNextAudioService? = null

    internal fun acquire(context: Context, microphone: Boolean, foreground: Boolean, lost: (String) -> Unit): String {
      check(foreground) { "Start or resume continued audio while the app is foregrounded" }
      val type = if (microphone) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
      val info = try { context.packageManager.getServiceInfo(ComponentName(context, WfloatNextAudioService::class.java), 0) }
        catch (e: PackageManager.NameNotFoundException) { throw IllegalStateException("backgroundBehavior=continue requires declaring com.wfloat.WfloatNextAudioService; see README.md Mobile audio policy and AndroidManifest.background.example.xml", e) }
      check(info.enabled && !info.exported) { "WfloatNextAudioService must be enabled and exported=false" }
      check(info.processName == context.applicationInfo.processName) { "WfloatNextAudioService must run in the application process" }
      if (Build.VERSION.SDK_INT >= 29) check(info.foregroundServiceType and type == type) { "Declare the required microphone/mediaPlayback foregroundServiceType" }
      val permissions = mutableListOf("android.permission.WAKE_LOCK")
      if (Build.VERSION.SDK_INT >= 28) permissions.add("android.permission.FOREGROUND_SERVICE")
      if (Build.VERSION.SDK_INT >= 34) permissions.add(if (microphone) "android.permission.FOREGROUND_SERVICE_MICROPHONE" else "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK")
      if (microphone) permissions.add("android.permission.RECORD_AUDIO")
      permissions.forEach { check(context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED) { "Required permission is not granted: $it" } }
      val id = UUID.randomUUID().toString()
      val owner = Owner(type, CompletableFuture(), lost)
      synchronized(lock) { owners[id] = owner }
      try {
        val intent = Intent(context, WfloatNextAudioService::class.java)
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        owner.ready.get(10, TimeUnit.SECONDS)
        return id
      } catch (e: Exception) {
        release(context, id)
        throw IllegalStateException("Cannot start foreground audio service: ${e.cause?.message ?: e.message}", e)
      }
    }
    internal fun release(context: Context, id: String) {
      val current: WfloatNextAudioService?
      val empty: Boolean
      synchronized(lock) {
        owners.remove(id); empty = owners.isEmpty(); current = service
        if (empty) current?.releaseWakeLock()
      }
      if (empty) context.stopService(Intent(context, WfloatNextAudioService::class.java))
      else current?.let { instance -> android.os.Handler(android.os.Looper.getMainLooper()).post { instance.refresh() } }
    }
  }
  private val generation = UUID.randomUUID().toString()
  private var destroyed = false
  private var wakeLock: PowerManager.WakeLock? = null
  private fun releaseWakeLock() = synchronized(lock) {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
  }
  override fun onCreate() { super.onCreate(); synchronized(lock) { service = this } }
  override fun onBind(intent: Intent?): IBinder? = null
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    refresh()
    // Live capture/model state cannot be reconstructed after process death.
    return START_NOT_STICKY
  }
  private fun refresh() {
    if (destroyed) return
    val snapshot = synchronized(lock) { owners.values.toList().onEach { it.serviceGeneration = generation } }
    if (snapshot.isEmpty()) { releaseWakeLock(); stopForeground(true); stopSelf(); return }
    try {
      val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(NotificationChannel(CHANNEL, "Wfloat audio", NotificationManager.IMPORTANCE_LOW))
      val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
      val microphone = snapshot.any { it.type == ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE }
      builder.setSmallIcon(android.R.drawable.ic_btn_speak_now).setContentTitle("Audio active")
        .setContentText(if (microphone) "Microphone capture is active" else "Speech preparation or playback is active")
        .setCategory(Notification.CATEGORY_SERVICE).setOngoing(true)
      val types = snapshot.fold(0) { bits, owner -> bits or owner.type }
      if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, builder.build(), types)
      else startForeground(NOTIFICATION, builder.build())
      synchronized(lock) {
        // Last-owner release can race service startup. Never acquire for a
        // stale snapshot; the live audio owners define the complete lifetime.
        if (owners.values.any { it.serviceGeneration == generation }) {
          val cpu = wakeLock ?: (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Wfloat:ContinuedAudio")
            .also { it.setReferenceCounted(false); wakeLock = it }
          // No duration cap: continued audio may be long-running. Release on
          // last owner, startup failure, or service destruction below.
          if (!cpu.isHeld) cpu.acquire()
        }
      }
      snapshot.forEach { it.ready.complete(Unit) }
    } catch (e: Exception) {
      releaseWakeLock()
      val failed = removeOwnedClients()
      failed.forEach { owner ->
        val wasReady = owner.ready.isDone
        owner.ready.completeExceptionally(e)
        if (wasReady) owner.lost("Foreground audio service failed: ${e.message}")
      }
      stopSelf()
    }
  }
  private fun removeOwnedClients(): List<Owner> = synchronized(lock) {
    val owned = owners.filterValues { it.serviceGeneration == generation }
    owned.keys.forEach { owners.remove(it) }
    owned.values.toList()
  }
  override fun onDestroy() {
    destroyed = true
    releaseWakeLock()
    synchronized(lock) { if (service === this) service = null }
    // A new acquire can race the asynchronous destruction of the previous
    // service. Pending clients belong to the next start, not the dying instance.
    val abandoned = removeOwnedClients()
    abandoned.forEach { owner ->
      val wasReady = owner.ready.isDone
      owner.ready.completeExceptionally(IllegalStateException("Foreground audio service stopped"))
      if (wasReady) owner.lost("Foreground audio service stopped")
    }
    stopForeground(true)
    super.onDestroy()
  }
}
