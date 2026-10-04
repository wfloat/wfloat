package com.wfloat

/** Check before requesting or abandoning OS focus. Buffering active playback
 * retains ownership until paused/closed; preparation and model loading do not. */
internal fun <T : Any> requireCompatiblePlaybackFocus(
  requester: T,
  players: Iterable<T>,
  isPlaying: (T) -> Boolean,
  focus: (T) -> String,
) {
  val requested = focus(requester)
  require(players.none { it !== requester && isPlaying(it) && focus(it) != requested }) {
    "Conflicting audioFocus: another playback is active; pause or finish it before starting $requested"
  }
}
