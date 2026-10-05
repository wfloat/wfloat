package com.wfloat

import android.content.Context
import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.json.JSONObject

fun main() {
  val temporary = Files.createTempDirectory("wfloat-assets-test").toFile()
  val bytes = ByteArray(200000) { (it % 251).toByte() }
  val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
  val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
  var rangeSeen = false
  var mode = "normal"
  server.createContext("/asset") { exchange ->
    val range = exchange.requestHeaders.getFirst("Range")
    val offset = range?.removePrefix("bytes=")?.removeSuffix("-")?.toInt() ?: 0
    rangeSeen = rangeSeen || offset > 0
    val start = if (mode == "ignore") 0 else offset
    if (range != null && mode != "ignore") exchange.responseHeaders.add("Content-Range", "bytes ${if (mode == "bad-range") offset + 1 else offset}-${bytes.size - 1}/${bytes.size}")
    exchange.sendResponseHeaders(if (range != null && mode != "ignore") 206 else 200, (bytes.size - start).toLong())
    try { exchange.responseBody.use { out ->
      var index = start
      while (index < bytes.size) {
        val n = minOf(16384, bytes.size - index)
        out.write(bytes, index, n); out.flush(); index += n
        Thread.sleep(20)
      }
    } } catch (_: Exception) {}
    exchange.close()
  }
  server.start()
  try {
    val assets = NextAssets(Context(temporary))
    val command = JSONObject().put("key", "model").put("url", "http://127.0.0.1:${server.address.port}/asset")
      .put("sha256", hash).put("sizeBytes", bytes.size)
    val cancelled = AtomicBoolean(false)
    check(runCatching { assets.download(command, cancelled) { if (it.getLong("downloadedBytes") > 0) cancelled.set(true) } }.isFailure)
    val partial = File(temporary, "wfloat-next/model.partial")
    check(partial.length() in 1 until bytes.size.toLong())
    check(assets.stat("model", hash, bytes.size.toLong()) == JSONObject.NULL)
    cancelled.set(false)
    mode = "bad-range"
    check(runCatching { assets.download(command, cancelled) {} }.isFailure)
    mode = "normal"
    val progress = mutableListOf<Pair<Long, Long>>()
    val path = assets.download(command, cancelled) { progress.add(Pair(System.nanoTime(), it.getLong("downloadedBytes"))) }.getString("path")
    check(progress.first().second > 0 && progress.last().second == bytes.size.toLong())
    check(progress.size <= 5) { "Progress must be throttled, including initial/final" }
    progress.drop(1).dropLast(1).zipWithNext().forEach { (a, b) -> check(b.first - a.first >= 100_000_000) }
    check(rangeSeen && File(path).readBytes().contentEquals(bytes))
    check(assets.stat("model", hash, bytes.size.toLong()) is JSONObject)
    check(assets.stat("model", "0".repeat(64), bytes.size.toLong()) == JSONObject.NULL)
    val marker = File(temporary, "wfloat-next/model.verified")
    marker.writeText("{broken")
    check(assets.stat("model", hash, bytes.size.toLong()) == JSONObject.NULL)
    assets.download(command, cancelled) {}
    File(path).writeBytes(bytes.copyOf().also { it[0] = 42 })
    check(assets.stat("model", hash, bytes.size.toLong()) == JSONObject.NULL)
    assets.download(command, cancelled) {}
    assets.pin(listOf(path))
    assets.delete("model")
    check(File(path).isFile && assets.stat("model", hash, bytes.size.toLong()) == JSONObject.NULL)
    val mismatch = JSONObject(command.toString()).put("sha256", "0".repeat(64))
    check(runCatching { assets.download(mismatch, cancelled) {} }.isFailure)
    check(assets.stat("model", hash, bytes.size.toLong()) == JSONObject.NULL)
    check(assets.download(command, cancelled) {}.getString("path") == path)
    check(assets.stat("model", hash, bytes.size.toLong()) is JSONObject)
    assets.pin(listOf(path)) // B can load while A retains its pin.
    assets.unpin(listOf(path))
    check(File(path).readBytes().contentEquals(bytes))
    assets.delete("model")
    check(File(path).exists())
    assets.unpin(listOf(path))
    check(!File(path).exists())
    cancelled.set(false)
    check(runCatching { assets.download(command, cancelled) { if (it.getLong("downloadedBytes") > 0) cancelled.set(true) } }.isFailure)
    cancelled.set(false)
    mode = "ignore"
    assets.download(command, cancelled) {}
    check(File(path).readBytes().contentEquals(bytes))
    assets.delete("model")
    File(temporary, "wfloat-next/model.partial").writeBytes(ByteArray(bytes.size))
    File(temporary, "wfloat-next/model.resume").writeText("${command.getString("url")}\n${bytes.size}\n$hash")
    assets.download(command, cancelled) {}
    check(File(path).readBytes().contentEquals(bytes))
    check(runCatching { assets.stat("../escape", null, null) }.isFailure)

    fun digest(value: ByteArray) = MessageDigest.getInstance("SHA-256").digest(value).joinToString("") { "%02x".format(it) }
    val left = bytes.copyOfRange(0, 100001); val right = bytes.copyOfRange(100001, bytes.size)
    val assetRoot = File(temporary, "wfloat-next")
    File(assetRoot, "left").writeBytes(left); File(assetRoot, "right").writeBytes(right)
    val assembly = JSONObject().put("key", "encoder").put("sizeBytes", bytes.size).put("sha256", hash)
      .put("parts", org.json.JSONArray().put(JSONObject().put("key", "left").put("sizeBytes", left.size).put("sha256", digest(left)))
        .put(JSONObject().put("key", "right").put("sizeBytes", right.size).put("sha256", digest(right))))
    val encoder = File(assets.assemble(assembly, cancelled).getString("path"))
    check(encoder.readBytes().contentEquals(bytes))
    check(assets.stat("encoder", hash, bytes.size.toLong()) is JSONObject)
    File(assetRoot, "left").delete() // Whole cache reuse does not need transport parts.
    check(assets.assemble(assembly, cancelled).getString("path") == encoder.path)
    assets.pin(listOf(encoder.path)); assets.delete("encoder")
    check(encoder.exists() && assets.stat("encoder", hash, bytes.size.toLong()) == JSONObject.NULL)
    assets.assemble(assembly, cancelled); assets.unpin(listOf(encoder.path))
    check(encoder.exists()) // Verified reload rescinds deferred deletion.
    assets.pin(listOf(encoder.path)); assets.delete("encoder"); assets.unpin(listOf(encoder.path))
    check(!encoder.exists())
    File(assetRoot, "left").writeBytes(left)
    val corrupted = right.copyOf(); corrupted[0] = (corrupted[0].toInt() xor 1).toByte()
    File(assetRoot, "right").writeBytes(corrupted)
    check(runCatching { assets.assemble(assembly, cancelled) }.isFailure)
    check(!encoder.exists() && !File(assetRoot, "encoder.partial").exists())
    File(assetRoot, "right").writeBytes(right)
    assembly.put("sha256", "0".repeat(64))
    check(runCatching { assets.assemble(assembly, cancelled) }.isFailure)
    check(!encoder.exists() && !File(assetRoot, "encoder.partial").exists())
    assembly.put("sha256", hash); cancelled.set(true)
    check(runCatching { assets.assemble(assembly, cancelled) }.isFailure)
    cancelled.set(false); assets.assemble(assembly, cancelled)
    encoder.writeBytes(ByteArray(bytes.size))
    check(assets.stat("encoder", hash, bytes.size.toLong()) == JSONObject.NULL)
    assets.assemble(assembly, cancelled)
    check(encoder.readBytes().contentEquals(bytes))
    assets.delete("encoder"); assets.delete("left"); assets.delete("right")
    check(!encoder.exists() && !File(assetRoot, "encoder.verified").exists())

    fun archive(name: String, entry: String): File = File(temporary, name).also { f ->
      ZipOutputStream(f.outputStream()).use { zip -> zip.putNextEntry(ZipEntry(entry)); zip.write("data".toByteArray()); zip.closeEntry() }
    }
    val zip = archive("espeak.zip", "prefix/espeak-ng-data/phondata")
    val extraction = JSONObject().put("key", "speech").put("path", zip.absolutePath).put("format", "zip")
    val data = assets.prepareEspeak(extraction, cancelled).getString("path")
    check(File(data, "phondata").readText() == "data")
    assets.pin(listOf(data))
    assets.delete("speech")
    check(File(data).isDirectory)
    check(assets.prepareEspeak(extraction, cancelled).getString("path") == data)
    assets.unpin(listOf(data))
    check(File(data).isDirectory)
    assets.delete("speech")
    check(!File(data).exists())
    val retainedData = assets.prepareEspeak(extraction, cancelled).getString("path")
    assets.pinEspeakForProcess(retainedData)
    assets.delete("speech")
    val tombstone = File(temporary, "wfloat-next/espeak-speech.delete-on-restart")
    check(tombstone.isFile)
    check(assets.prepareEspeak(extraction, cancelled).getString("path") == retainedData)
    check(!tombstone.exists())
    assets.pin(listOf(retainedData))
    assets.unpin(listOf(retainedData))
    val malicious = archive("bad.zip", "../outside")
    extraction.put("key", "bad").put("path", malicious.absolutePath)
    check(runCatching { assets.prepareEspeak(extraction, cancelled) }.isFailure)
    check(!File(temporary, "wfloat-next/outside").exists())
    println("PASS: cancellation/resume, Content-Range rejection, range-ignored restart, hash verification, pin-safe deletion, ZIP extraction and traversal rejection")
  } finally { server.stop(0); temporary.deleteRecursively() }
}
