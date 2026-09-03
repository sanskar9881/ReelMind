// audioSplice.js — cut hygiene for butt-joined audio.
//
// Every internal cut (filler removal, retake removal, struck line) splices two
// audio pieces at an arbitrary sample. If the waveform value differs across the
// join, that step is an audible click. After a heavy edit there can be dozens.
//
// Two cheap fixes, applied together:
//   1. snap the cut to the nearest zero crossing  (findZeroCrossing)
//   2. equal-power micro-fade the piece edges       (applyEdgeFades)
//
// This is a SPLICE (butt join). It is NOT a crossfade/transition, where two
// pieces overlap — that case keeps its own equal-power overlap logic.

export const SPLICE_MS = 15

/**
 * Ramp the first and last `ms` of a channel with an equal-power curve, in place.
 * Fade in:  gain = sin(t·π/2)   (first sample → 0, inner edge → 1)
 * Fade out: gain = cos(t·π/2)   (inner edge → 1, last sample → 0)
 * A linear ramp leaves a perceptible dip at the join; equal-power does not.
 *
 * Buffers shorter than 2× the ramp get a proportionally shorter ramp rather
 * than being skipped — very short survivors still need smoothing.
 *
 * @param {Float32Array} channelData
 * @param {number} sampleRate
 * @param {number} [ms]
 * @returns {Float32Array} the same array
 */
export function applyEdgeFades(channelData, sampleRate, ms = SPLICE_MS) {
  const len = channelData.length
  if (len < 2 || !sampleRate) return channelData

  let ramp = Math.floor((ms / 1000) * sampleRate)
  if (ramp < 1) ramp = 1
  if (len < ramp * 2) ramp = Math.floor(len / 2) // proportionally shorter, never skip
  if (ramp < 1) return channelData

  for (let i = 0; i < ramp; i++) {
    // fade in over [0, ramp)
    channelData[i] *= Math.sin((i / ramp) * (Math.PI / 2))
    // fade out over [len-ramp, len)
    const j = len - ramp + i
    channelData[j] *= Math.cos(((i + 1) / ramp) * (Math.PI / 2))
  }
  return channelData
}

/**
 * Edge-fade every channel of every buffer, then butt-join them into one buffer.
 * Use for SPLICES (sequential pieces), not overlapping crossfades.
 *
 * @param {AudioBuffer[]} buffers
 * @param {number} sampleRate
 * @param {number} channels  channel count of the output
 * @returns {AudioBuffer}
 */
export function concatWithSplice(buffers, sampleRate, channels) {
  let total = 0
  for (const b of buffers) total += b.length

  const out = new AudioBuffer({
    length: Math.max(1, total),
    numberOfChannels: Math.max(1, channels),
    sampleRate,
  })

  let offset = 0
  for (const b of buffers) {
    const nc = b.numberOfChannels
    for (let ch = 0; ch < nc; ch++) applyEdgeFades(b.getChannelData(ch), sampleRate)
    for (let ch = 0; ch < channels; ch++) {
      out.getChannelData(ch).set(b.getChannelData(Math.min(ch, nc - 1)), offset)
    }
    offset += b.length
  }
  return out
}

/**
 * Nearest sample to `targetSample` where the waveform crosses zero, searched
 * within ±`searchRadius`. Snapping the cut here removes most of the click before
 * the fade is even applied.
 *
 * @param {Float32Array} channelData
 * @param {number} targetSample
 * @param {number} [searchRadius]  default ≈ 0.01·44100
 * @returns {number} adjusted sample index, or `targetSample` if none found
 */
export function findZeroCrossing(channelData, targetSample, searchRadius = 441) {
  const len = channelData.length
  if (len < 2) return targetSample

  const clampIdx = (i) => (i < 1 ? 1 : i > len - 1 ? len - 1 : i)
  const center = clampIdx(Math.round(targetSample))
  const radius = Math.max(1, Math.round(searchRadius))

  const crosses = (i) => {
    const a = channelData[i - 1]
    const b = channelData[i]
    return (a <= 0 && b >= 0) || (a >= 0 && b <= 0)
  }

  if (crosses(center)) return center
  for (let d = 1; d <= radius; d++) {
    const lo = center - d
    const hi = center + d
    if (lo >= 1 && crosses(lo)) return lo
    if (hi <= len - 1 && crosses(hi)) return hi
  }
  return targetSample
}
