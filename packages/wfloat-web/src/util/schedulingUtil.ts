export function computeStartTime(
  sentencePhonemesList: string[],
  phonemesPerSec: number = 30.0,
  audioSecPerPhoneme: number = 0.04,
): number {
  const N = sentencePhonemesList.length;

  if (N === 0) return 0.0;

  // Compute durations derived from phoneme counts
  const C: number[] = sentencePhonemesList.map((s) => s.length / phonemesPerSec);

  const P: number[] = sentencePhonemesList.map((s) => s.length * audioSecPerPhoneme);

  // Prefix sums
  const prefixC: number[] = [0.0];
  const prefixP: number[] = [0.0];

  for (let i = 0; i < N; i++) {
    prefixC.push(prefixC[prefixC.length - 1] + C[i]);
    prefixP.push(prefixP[prefixP.length - 1] + P[i]);
  }

  // Constraint:
  // For i = 0..N-1:
  // prefixC[i+1] <= Tstart + prefixP[i]
  // => Tstart >= prefixC[i+1] - prefixP[i]
  let Tstart = 0.0;

  for (let i = 0; i < N; i++) {
    const required = prefixC[i + 1] - prefixP[i];
    if (required > Tstart) {
      Tstart = required;
    }
  }

  // Clamp to at least first sentence compute time
  Tstart = Math.max(Tstart, C[0]);

  return Tstart;
}
