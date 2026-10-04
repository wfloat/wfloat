package com.wfloat

import android.content.Context
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteOrder
import java.util.concurrent.CancellationException
import java.util.concurrent.atomic.AtomicBoolean

internal object NextAudioDecoder {
  fun decode(context: Context, value: String, cancelled: AtomicBoolean): JSONObject {
    val uri = Uri.parse(value)
    require(uri.scheme == "file" || uri.scheme == "content") { "Audio URI must be file:// or content://; remote fetching is app-owned" }
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    try {
      extractor.setDataSource(context, uri, null)
      val index = (0 until extractor.trackCount).firstOrNull {
        extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
      } ?: error("URI contains no decodable audio track")
      extractor.selectTrack(index)
      val format = extractor.getTrackFormat(index)
      val decoder = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
      codec = decoder
      decoder.configure(format, null, null, 0)
      decoder.start()
      var rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
      var channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
      var encoding = AudioFormat.ENCODING_PCM_16BIT
      var inputEnded = false
      var outputEnded = false
      val samples = JSONArray()
      val info = MediaCodec.BufferInfo()
      while (!outputEnded) {
        if (cancelled.get()) throw CancellationException("Audio decoding cancelled")
        if (!inputEnded) {
          val inputIndex = decoder.dequeueInputBuffer(10000)
          if (inputIndex >= 0) {
            val input = decoder.getInputBuffer(inputIndex)!!
            val count = extractor.readSampleData(input, 0)
            if (count < 0) {
              decoder.queueInputBuffer(inputIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputEnded = true
            } else {
              decoder.queueInputBuffer(inputIndex, 0, count, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }
        val outputIndex = decoder.dequeueOutputBuffer(info, 10000)
        if (outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          val output = decoder.outputFormat
          val nextRate = output.getInteger(MediaFormat.KEY_SAMPLE_RATE)
          require(samples.length() == 0 || nextRate == rate) { "Midstream sample-rate changes are unsupported" }
          rate = nextRate
          channels = output.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
          encoding = if (output.containsKey("pcm-encoding")) output.getInteger("pcm-encoding") else AudioFormat.ENCODING_PCM_16BIT
          require(channels > 0 && (encoding == AudioFormat.ENCODING_PCM_16BIT || encoding == AudioFormat.ENCODING_PCM_FLOAT)) { "Unsupported decoded PCM format" }
        } else if (outputIndex >= 0) {
          try {
            if (info.size > 0 && info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0) {
              val output = decoder.getOutputBuffer(outputIndex)!!.order(ByteOrder.nativeOrder())
              output.position(info.offset)
              output.limit(info.offset + info.size)
              val bytes = if (encoding == AudioFormat.ENCODING_PCM_FLOAT) 4 else 2
              require(output.remaining() % (channels * bytes) == 0) { "Unaligned decoded PCM" }
              while (output.remaining() >= channels * bytes) {
                var mono = 0.0
                repeat(channels) { mono += if (bytes == 4) output.float.toDouble() else output.short / 32768.0 }
                samples.put((mono / channels).coerceIn(-1.0, 1.0))
              }
            }
            outputEnded = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
          } finally { decoder.releaseOutputBuffer(outputIndex, false) }
        }
      }
      return JSONObject().put("samples", samples).put("sampleRate", rate)
    } finally {
      try { codec?.release() } finally { extractor.release() }
    }
  }
}
