import type { TranscriptData, TranscriptSegment, TranscriptWord } from './types.js';

export function joinText(a: string, b: string): string {
  if (!a) return b.trim();
  if (!b) return a.trim();
  return `${a.trimEnd()} ${b.trimStart()}`;
}
/** Reconcile only text attributable to the actual retained audio overlap.
 * The reference is recognized from that short overlap itself, not guessed from
 * the entire transcript. This bounds removal even for repeated phrases. */
export function overlapText(previous: string, next: string, reference: string): { text: string; droppedWords: number } {
  if (!previous) return { text: next.trim(), droppedWords: 0 };
  const before = previous.trim().split(/\s+/).filter(Boolean);
  const after = next.trim().split(/\s+/).filter(Boolean);
  const key = (word: string) => word.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const anchor = reference.trim().split(/\s+/).filter(Boolean).map(key).filter(Boolean);
  if (!anchor.length) return { text: joinText(previous, next), droppedWords: 0 };
  const distance = (a: string[], b: string[]) => {
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 0; i < a.length; i++) {
      const next = [i + 1];
      for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
      row = next;
    }
    return row[b.length];
  };
  const find = (words: string[], suffix: boolean) => {
    let best = 0, score = Infinity;
    const allowance = anchor.length < 3 ? 0 : Math.max(1, Math.floor(anchor.length / 3));
    for (let count = Math.max(1, anchor.length - allowance); count <= Math.min(words.length, anchor.length + allowance); count++) {
      const part = (suffix ? words.slice(-count) : words.slice(0, count)).map(key);
      // Align boundary words to actual reference positions, never substitute
      // them away. Merely finding a boundary word somewhere near the reference
      // edge could consume a repeated word preceding the real audio overlap.
      let edits = Infinity;
      for (let start = 0; start <= Math.min(allowance, anchor.length - 1); start++) {
        if (part[0] !== anchor[start]) continue;
        for (let end = Math.max(start, anchor.length - 1 - allowance); end < anchor.length; end++) {
          if (part[part.length - 1] !== anchor[end]) continue;
          if ((part.length === 1) !== (start === end)) continue;
          edits = Math.min(edits, start + anchor.length - 1 - end +
            distance(part.slice(1, -1), anchor.slice(start + 1, end)));
        }
      }
      // Equal-quality candidates favor removing fewer words. Uncertain
      // recognition may repeat audio text, but must not eat preceding speech.
      if (edits <= allowance && edits < score) { best = count; score = edits; }
    }
    return best;
  };
  const oldCount = find(before, true), newCount = find(after, false);
  if (oldCount && newCount) {
    // Keep the newer recognition of the overlap (including spelling revisions).
    return { text: joinText(before.slice(0, -oldCount).join(' '), next), droppedWords: oldCount };
  }
  // A cut through a word can make the short reference unreliable. Prefer
  // possible repetition to deleting new speech without matching both sides.
  return { text: joinText(previous, next), droppedWords: 0 };
}
export function offsetTranscript(data: TranscriptData, offsetMs: number): TranscriptData {
  const word = (w: TranscriptWord): TranscriptWord => ({ ...w, ...(w.timing ? { timing: {
    startMs: w.timing.startMs + offsetMs, endMs: w.timing.endMs + offsetMs,
  } } : {}) });
  const segment = (s: TranscriptSegment): TranscriptSegment => ({ ...s,
    ...(s.timing ? { timing: { startMs: s.timing.startMs + offsetMs, endMs: s.timing.endMs + offsetMs } } : {}),
    ...(s.words ? { words: s.words.map(word) } : {}),
  });
  return { text: data.text, ...(data.segments ? { segments: data.segments.map(segment) } : {}),
    ...(data.words ? { words: data.words.map(word) } : {}) };
}
export function appendTranscript(a: TranscriptData, b: TranscriptData): TranscriptData {
  return { text: joinText(a.text, b.text),
    ...(a.segments || b.segments ? { segments: [...a.segments ?? [], ...b.segments ?? []] } : {}),
    ...(a.words || b.words ? { words: [...a.words ?? [], ...b.words ?? []] } : {}),
  };
}
/** A bounded, owned audio queue; consumption drops references to processed chunks. */
export class AudioQueue {
  private chunks: Float32Array[] = [];
  private head = 0;
  private offset = 0;
  length = 0;
  append(samples: Float32Array) { if (samples.length) { this.chunks.push(samples); this.length += samples.length; } }
  peek(count = this.length): Float32Array {
    count = Math.min(count, this.length);
    const output = new Float32Array(count);
    let written = 0;
    for (let i = this.head; i < this.chunks.length && written < count; i++) {
      const chunk = this.chunks[i];
      const start = i === this.head ? this.offset : 0;
      const end = Math.min(chunk.length, start + count - written);
      output.set(chunk.subarray(start, end), written); written += end - start;
    }
    return output;
  }
  discard(count: number) {
    count = Math.min(count, this.length); this.length -= count;
    while (count > 0) {
      const chunk = this.chunks[this.head];
      const used = Math.min(count, chunk.length - this.offset);
      this.offset += used; count -= used;
      if (this.offset === chunk.length) { this.chunks[this.head++] = new Float32Array(0); this.offset = 0; }
    }
    if (this.head > 64 || this.length === 0) { this.chunks = this.chunks.slice(this.head); this.head = 0; }
  }
  take(count: number) { const output = this.peek(count); this.discard(output.length); return output; }
  clear() { this.chunks = []; this.head = this.offset = this.length = 0; }
}
export const SAMPLE_RATE = 16000;
export const WINDOW_SAMPLES = 25 * SAMPLE_RATE;
/** Prefer a quiet boundary near the end of a bounded full-audio window. Windows
 * partition the original audio exactly: no dropped samples or duplicate overlap. */
export function fileWindowLength(samples: Float32Array, start: number): number {
  const remaining = samples.length - start;
  if (remaining <= WINDOW_SAMPLES) return remaining;
  const frame = 320;
  let best = WINDOW_SAMPLES, lowest = Infinity;
  for (let end = 20 * SAMPLE_RATE; end <= WINDOW_SAMPLES; end += frame) {
    let power = 0;
    for (let i = start + end - frame; i < start + end; i++) power += samples[i] * samples[i];
    if (power < lowest) { lowest = power; best = end; }
  }
  return lowest / frame < 1e-6 ? best : WINDOW_SAMPLES;
}
/** Conservative energy endpoint for windowed offline models, not a VAD model.
 * We still decode all supplied audio; this only decides when to finalize. */
export function endsInSilence(samples: Float32Array): boolean {
  const tail = Math.round(1.2 * SAMPLE_RATE);
  if (samples.length < tail + SAMPLE_RATE) return false;
  let power = 0;
  for (let i = samples.length - tail; i < samples.length; i++) power += samples[i] * samples[i];
  return power / tail < 1e-8;
}
