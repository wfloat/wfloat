package com.wfloat

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.CancellationException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/** Immutable verified assets live outside both cache and Android backup. */
internal class NextAssets(context: Context) {
  companion object {
    // Sherpa's eSpeak initialization outlives Runtime/model instances in a process.
    private val processEspeakPaths = ConcurrentHashMap.newKeySet<String>()
  }
  private val root = File(context.noBackupFilesDir, "wfloat-next").apply { mkdirs() }
  private val locks = ConcurrentHashMap<String, Any>()
  private val pins = mutableMapOf<String, Int>()
  private val deleted = mutableSetOf<String>()
  init {
    root.listFiles()?.filter { it.name.endsWith(".delete-on-restart") }?.forEach { marker ->
      val target = File(root, marker.name.removeSuffix(".delete-on-restart"))
      if (!processEspeakPaths.any { it == target.path || it.startsWith(target.path + File.separator) }) {
        if (target.deleteRecursively() || !target.exists()) marker.delete()
      }
    }
  }
  fun pinEspeakForProcess(path: String) { processEspeakPaths.add(path) }
  private fun file(key: String): File {
    require(key.matches(Regex("[A-Za-z0-9_-]{1,128}"))) { "Invalid asset key" }
    return File(root, key)
  }
  private fun isPinned(path: String) = pins.any { (p, count) -> count > 0 && (p == path || p.startsWith(path + File.separator)) } ||
    processEspeakPaths.any { it == path || it.startsWith(path + File.separator) }
  @Synchronized fun pin(paths: List<String>) {
    paths.forEach { path ->
      require(deleted.none { path == it || path.startsWith(it + File.separator) }) { "Asset was deleted: $path" }
    }
    paths.forEach { pins[it] = (pins[it] ?: 0) + 1 }
  }
  @Synchronized fun unpin(paths: List<String>) {
    paths.forEach { path ->
      val count = (pins[path] ?: 1) - 1
      if (count <= 0) pins.remove(path) else pins[path] = count
    }
    deleted.toList().filter { !isPinned(it) }.forEach { path ->
      check(File(path).deleteRecursively() || !File(path).exists()) { "Asset deletion failed" }
      deleted.remove(path)
    }
  }
  fun stat(key: String, expectedHash: String?, expectedSize: Long?): Any = synchronized(locks.getOrPut(key) { Any() }) {
    synchronized(this) statLock@{
      val f = file(key)
      val marker = File(root, "$key.verified")
      if (!f.isFile || f.absolutePath in deleted || !marker.isFile) JSONObject.NULL
      else {
        val metadata = try { JSONObject(marker.readText()) } catch (_: org.json.JSONException) { return@statLock JSONObject.NULL }
        val digest = MessageDigest.getInstance("SHA-256")
        f.inputStream().use { input ->
          val buffer = ByteArray(65536)
          while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
        }
        val hash = digest.digest().joinToString("") { "%02x".format(it) }
        if (f.length() != metadata.optLong("sizeBytes", -1) || hash != metadata.optString("sha256", "") ||
          (expectedHash != null && hash != expectedHash.lowercase()) || (expectedSize != null && f.length() != expectedSize)) JSONObject.NULL
        else JSONObject().put("path", f.absolutePath).put("sizeBytes", f.length())
      }
    }
  }
  fun delete(key: String) = synchronized(locks.getOrPut(key) { Any() }) {
    synchronized(this) {
      val f = file(key)
      listOf(f, File(root, "espeak-$key")).forEach { target ->
        if (isPinned(target.absolutePath)) {
          deleted.add(target.absolutePath)
          if (processEspeakPaths.any { it == target.path || it.startsWith(target.path + File.separator) }) {
            File(root, target.name + ".delete-on-restart").writeText("1")
          }
        } else check(target.deleteRecursively() || !target.exists()) { "Asset deletion failed" }
      }
      listOf(File(root, "$key.partial"), File(root, "$key.resume"), File(root, "$key.verified")).forEach {
        check(it.delete() || !it.exists()) { "Partial deletion failed" }
      }
    }
    Unit
  }
  fun prepareEspeak(c: JSONObject, cancelled: AtomicBoolean): JSONObject {
    require(c.getString("format") == "zip") { "Android eSpeak assets require ZIP format" }
    val key = c.getString("key")
    file(key) // Validate before deriving any paths.
    return synchronized(locks.getOrPut(key) { Any() }) {
      val destination = File(root, "espeak-$key")
      val data = File(destination, "espeak-ng-data")
      val digest = MessageDigest.getInstance("SHA-256")
      File(c.getString("path")).inputStream().use { input ->
        val buffer = ByteArray(65536)
        while (true) {
          if (cancelled.get()) throw CancellationException("eSpeak extraction cancelled")
          val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n)
        }
      }
      val identity = digest.digest().joinToString("") { "%02x".format(it) }
      val reusable = synchronized(this) {
        if (File(destination, ".ready").isFile && File(destination, ".ready").readText() == identity && data.isDirectory) {
          val tombstone = File(root, destination.name + ".delete-on-restart")
          check(tombstone.delete() || !tombstone.exists()) { "Cannot restore eSpeak data" }
          deleted.remove(destination.absolutePath)
          true
        } else false
      }
      if (reusable) return@synchronized JSONObject().put("path", data.absolutePath)
      synchronized(this) { check(!isPinned(destination.absolutePath)) { "Cannot replace loaded eSpeak data" } }
      val staging = File(root, "espeak-$key.extracting")
      staging.deleteRecursively()
      check(staging.mkdirs()) { "Cannot create eSpeak extraction directory" }
      try {
        var total = 0L
        java.util.zip.ZipInputStream(File(c.getString("path")).inputStream().buffered()).use { zip ->
          while (true) {
            if (cancelled.get()) throw CancellationException("eSpeak extraction cancelled")
            val entry = zip.nextEntry ?: break
            val target = File(staging, entry.name).canonicalFile
            require(target.path.startsWith(staging.canonicalPath + File.separator)) { "Unsafe ZIP entry" }
            if (entry.isDirectory) target.mkdirs()
            else {
              target.parentFile!!.mkdirs()
              FileOutputStream(target).use { output ->
                val buffer = ByteArray(65536)
                while (true) {
                  if (cancelled.get()) throw CancellationException("eSpeak extraction cancelled")
                  val count = zip.read(buffer)
                  if (count < 0) break
                  total += count
                  require(total <= 512L * 1024 * 1024) { "eSpeak archive exceeds extraction limit" }
                  output.write(buffer, 0, count)
                }
                output.fd.sync()
              }
            }
            zip.closeEntry()
          }
        }
        val extracted = staging.walkTopDown().firstOrNull { it.isDirectory && it.name == "espeak-ng-data" }
          ?: error("ZIP does not contain espeak-ng-data")
        if (extracted != File(staging, "espeak-ng-data")) {
          check(extracted.renameTo(File(staging, "espeak-ng-data"))) { "Cannot normalize eSpeak data directory" }
        }
        FileOutputStream(File(staging, ".ready")).use { output -> output.write(identity.toByteArray()); output.fd.sync() }
        synchronized(this) {
          check(!isPinned(destination.absolutePath)) { "Cannot replace loaded eSpeak data" }
          check(!destination.exists() || destination.deleteRecursively()) { "Cannot replace incomplete eSpeak extraction" }
          check(staging.renameTo(destination)) { "Cannot publish eSpeak extraction" }
        }
        JSONObject().put("path", data.absolutePath)
      } finally { staging.deleteRecursively() }
    }
  }
  /** Same publication/pin lock as downloads; parts never cross the JS bridge. */
  fun assemble(c: JSONObject, cancelled: AtomicBoolean): JSONObject {
    val key = c.getString("key")
    return synchronized(locks.getOrPut(key) { Any() }) {
      synchronized(this) assembly@{
        val destination = file(key)
        val size = c.getLong("sizeBytes")
        val hash = c.getString("sha256").lowercase()
        require(size >= 0 && hash.matches(Regex("[0-9a-f]{64}"))) { "Invalid assembly size/hash" }
        fun checkCancelled() { if (cancelled.get()) throw CancellationException("Assembly cancelled") }
        checkCancelled()
        fun writeMarker() {
          val temporary = File(root, "$key.verified.partial")
          try {
            FileOutputStream(temporary).use { output ->
              output.write(JSONObject().put("sizeBytes", size).put("sha256", hash).toString().toByteArray()); output.fd.sync()
            }
            check(temporary.renameTo(File(root, "$key.verified"))) { "Cannot publish assembly marker" }
          } finally { temporary.delete() }
        }
        if (destination.isFile && destination.length() == size) {
          val digest = MessageDigest.getInstance("SHA-256")
          destination.inputStream().use { input ->
            val buffer = ByteArray(65536)
            while (true) {
              checkCancelled()
              val n = input.read(buffer); if (n < 0) break
              digest.update(buffer, 0, n)
            }
          }
          if (digest.digest().joinToString("") { "%02x".format(it) } == hash) {
            checkCancelled(); writeMarker(); deleted.remove(destination.absolutePath)
            return@assembly JSONObject().put("path", destination.absolutePath)
          }
        }
        check(!isPinned(destination.absolutePath)) { "Cannot replace a loaded asset" }
        val parts = c.getJSONArray("parts")
        require(parts.length() > 0) { "Assembly requires parts" }
        val staging = File(root, "$key.partial")
        val marker = File(root, "$key.verified.partial")
        try {
          val digest = MessageDigest.getInstance("SHA-256")
          var total = 0L
          FileOutputStream(staging).use { output ->
            val buffer = ByteArray(65536)
            for (i in 0 until parts.length()) {
              checkCancelled()
              val part = parts.getJSONObject(i)
              val source = file(part.getString("key"))
              require(source != destination && source.absolutePath !in deleted) { "Invalid/deleted assembly part" }
              val expectedSize = part.getLong("sizeBytes")
              require(expectedSize >= 0 && expectedSize <= size - total) { "Invalid part size" }
              val partDigest = MessageDigest.getInstance("SHA-256")
              var count = 0L
              source.inputStream().use { input ->
                while (true) {
                  checkCancelled()
                  val n = input.read(buffer); if (n < 0) break
                  require(n <= expectedSize - count) { "Part exceeds declared size" }
                  output.write(buffer, 0, n); digest.update(buffer, 0, n); partDigest.update(buffer, 0, n)
                  count += n; total += n
                }
              }
              require(count == expectedSize && partDigest.digest().joinToString("") { "%02x".format(it) } == part.getString("sha256").lowercase()) { "Assembly part integrity failed" }
            }
            require(total == size && digest.digest().joinToString("") { "%02x".format(it) } == hash) { "Assembly integrity failed" }
            output.fd.sync()
          }
          FileOutputStream(marker).use { output ->
            output.write(JSONObject().put("sizeBytes", size).put("sha256", hash).toString().toByteArray()); output.fd.sync()
          }
          checkCancelled()
          check(staging.renameTo(destination)) { "Cannot publish assembled asset" }
          check(marker.renameTo(File(root, "$key.verified"))) { "Cannot publish assembly marker" }
          deleted.remove(destination.absolutePath)
          JSONObject().put("path", destination.absolutePath)
        } finally { staging.delete(); marker.delete() }
      }
    }
  }
  fun download(c: JSONObject, cancelled: AtomicBoolean, emit: (JSONObject) -> Unit): JSONObject {
    val key = c.getString("key")
    return synchronized(locks.getOrPut(key) { Any() }) {
      val f = file(key)
      val size = c.getLong("sizeBytes")
      val sha = c.getString("sha256").lowercase()
      require(size >= 0 && sha.matches(Regex("[0-9a-f]{64}"))) { "Invalid asset size/hash" }
      val url = URL(c.getString("url"))
      require(url.protocol == "https" || url.protocol == "http") { "Expected HTTP(S) asset URL" }
      fun checkCancelled() { if (cancelled.get()) throw CancellationException("Download cancelled") }
      var lastProgressNanos = 0L
      fun progress(downloaded: Long, force: Boolean = false) {
        val now = System.nanoTime()
        if (force || now - lastProgressNanos >= 100_000_000L) {
          lastProgressNanos = now
          emit(JSONObject().put("type", "download").put("downloadedBytes", downloaded).put("totalBytes", size))
        }
      }
      fun valid(candidate: File): Boolean {
        if (!candidate.isFile || candidate.length() != size) return false
        val digest = MessageDigest.getInstance("SHA-256")
        candidate.inputStream().use { input ->
          val buffer = ByteArray(65536)
          while (true) {
            checkCancelled()
            val n = input.read(buffer)
            if (n < 0) break
            digest.update(buffer, 0, n)
          }
        }
        return digest.digest().joinToString("") { "%02x".format(it) } == sha
      }
      checkCancelled()
      fun writeMarker() {
        val temporary = File(root, "$key.verified.partial")
        FileOutputStream(temporary).use { output ->
          output.write(JSONObject().put("sizeBytes", size).put("sha256", sha).toString().toByteArray())
          output.fd.sync()
        }
        check(temporary.renameTo(File(root, "$key.verified"))) { "Cannot commit asset verification marker" }
      }
      // Hold the pin lock through verification and restoration: last-unpin must
      // not delete the retained immutable file between hashing and publication.
      val reusable = synchronized(this) {
        if (valid(f)) {
          writeMarker()
          deleted.remove(f.absolutePath)
          true
        } else false
      }
      if (reusable) { progress(size, true); return@synchronized JSONObject().put("path", f.absolutePath) }
      synchronized(this) { check((pins[f.absolutePath] ?: 0) == 0) { "Cannot replace a loaded asset" } }
      val partial = File(root, "$key.partial")
      val metadata = File(root, "$key.resume")
      val identity = "$url\n$size\n$sha"
      if (!metadata.isFile || metadata.readText() != identity || partial.length() > size) {
        check(partial.delete() || !partial.exists()) { "Cannot reset partial asset" }
        metadata.writeText(identity)
      }
      if (!valid(partial)) {
        if (partial.length() == size) check(partial.delete() || !partial.exists()) { "Cannot reset corrupt completed partial" }
        val offset = partial.length()
        val connection = url.openConnection() as HttpURLConnection
        connection.connectTimeout = 15000
        connection.readTimeout = 15000
        connection.setRequestProperty("Accept-Encoding", "identity")
        if (offset > 0) connection.setRequestProperty("Range", "bytes=$offset-")
        try {
          checkCancelled()
          val status = connection.responseCode
          require(status == 200 || status == 206) { "Asset HTTP $status" }
          val append = status == 206
          if (append) {
            val range = Regex("bytes (\\d+)-(\\d+)/(\\d+)").matchEntire(connection.getHeaderField("Content-Range") ?: "")
              ?: error("Invalid Content-Range")
            require(range.groupValues[1].toLong() == offset && range.groupValues[3].toLong() == size &&
              range.groupValues[2].toLong() == size - 1) { "Mismatched resumed range" }
          }
          var downloaded = if (append) offset else 0L
          progress(downloaded, true)
          connection.inputStream.use { input ->
            FileOutputStream(partial, append).use { output ->
              try {
                val buffer = ByteArray(65536)
                while (true) {
                  checkCancelled()
                  val n = input.read(buffer)
                  if (n < 0) break
                  require(downloaded + n <= size) { "Asset exceeds declared size" }
                  output.write(buffer, 0, n)
                  downloaded += n
                  progress(downloaded)
                }
              } finally { output.fd.sync() }
            }
          }
        } finally { connection.disconnect() }
      }
      if (!valid(partial)) {
        partial.delete()
        metadata.delete()
        error("Asset SHA256 or size verification failed")
      }
      checkCancelled()
      synchronized(this) {
        check((pins[f.absolutePath] ?: 0) == 0) { "Cannot replace a loaded asset" }
        check(partial.renameTo(f)) { "Cannot publish verified asset" }
      }
      writeMarker()
      metadata.delete()
      // Invoke terminal progress synchronously before the module resolves.
      progress(size, true)
      JSONObject().put("path", f.absolutePath)
    }
  }
}
