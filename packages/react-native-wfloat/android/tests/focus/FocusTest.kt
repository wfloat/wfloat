package com.wfloat

private class Playback(val focus: String, var started: Boolean = false, var paused: Boolean = false)

fun main() {
  val modes = listOf("interruptOthers", "duckOthers", "mixWithOthers")
  var checked = 0
  for (firstMode in modes) for (newMode in modes) {
    val first = Playback(firstMode, started = true)
    val newer = Playback(newMode)
    val players = mutableListOf(first, newer)
    fun checkStart() = requireCompatiblePlaybackFocus(newer, players, { it.started && !it.paused }, { it.focus })

    // Every ordered combination: a conflict fails, leaves the old state intact,
    // and never promotes the newer playback. Matching overlap is allowed.
    val initial = runCatching { checkStart() }
    check(initial.isSuccess == (firstMode == newMode))
    check(first.started && !first.paused && !newer.started)
    if (initial.isFailure) check(initial.exceptionOrNull()?.message?.contains("Conflicting audioFocus") == true)

    // Prepared-only handles do not own focus, even with incompatible options.
    first.started = false
    checkStart()

    // Paused storage is independent of operation policy and can coexist.
    first.started = true; first.paused = true
    checkStart()

    // Resuming the newer handle must recheck the currently audible owner.
    first.paused = false; newer.started = true; newer.paused = true
    check(runCatching { checkStart() }.isSuccess == (firstMode == newMode))
    check(newer.paused && !first.paused)

    // Underrun is still started playback: no queued-PCM shortcut may release its
    // policy. Completion removes the player; it no longer participates.
    check(runCatching { checkStart() }.isSuccess == (firstMode == newMode))
    players.remove(first)
    checkStart()

    // Self/resume never conflicts with its own retained player record.
    newer.paused = false
    checkStart()
    checked++
  }
  println("PASS: $checked ordered focus pairs; active conflict, prepared/paused exclusion, resume recheck, buffering ownership, completion and self exclusion")
}
