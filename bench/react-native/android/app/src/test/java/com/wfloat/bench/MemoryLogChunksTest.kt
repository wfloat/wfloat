package com.wfloat.bench

import org.junit.Assert.*
import org.junit.Test

class MemoryLogChunksTest {
  @Test fun preservesLargeUnicodePayloadAndIdentity() {
    val payload = "{\"error\":\"" + "漢字😀".repeat(2200) + "\"}"
    val parts = MemoryLogChunks.encode(payload, 42, 987)
    assertTrue(parts.size > 1)
    assertEquals(payload, parts.mapIndexed { index, line ->
      val prefix = "WfloatMemoryChunk pid=42 seq=987 part=${index + 1}/${parts.size} "
      assertTrue(line.startsWith(prefix))
      assertTrue(line.toByteArray(Charsets.UTF_8).size < 4000)
      val fragment = line.removePrefix(prefix)
      assertEquals(fragment, String(fragment.toByteArray(Charsets.UTF_8), Charsets.UTF_8))
      fragment
    }.joinToString(""))
  }
  @Test fun handlesSinglePartAndBoundarySurrogates() {
    assertEquals(listOf("WfloatMemoryChunk pid=1 seq=1 part=1/1 {}"), MemoryLogChunks.encode("{}", 1, 1))
    for (prefix in listOf(998, 999, 1000)) {
      val text = "x".repeat(prefix) + "😀tail"
      val parts = MemoryLogChunks.encode(text, 1, 1)
      assertEquals(text, parts.joinToString("") { it.substringAfter(Regex("part=\\d+/\\d+ ").find(it)!!.value) })
      assertTrue(parts.all { !Character.isHighSurrogate(it.last()) })
    }
  }
  @Test fun rejectsInvalidRecordIdentity() {
    assertThrows(IllegalArgumentException::class.java) { MemoryLogChunks.encode("{}", 0, 1) }
    assertThrows(IllegalArgumentException::class.java) { MemoryLogChunks.encode("{}", 1, 0) }
    assertThrows(IllegalArgumentException::class.java) { MemoryLogChunks.encode("", 1, 1) }
  }
}
