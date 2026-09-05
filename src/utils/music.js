// music.js — soundtrack: load, analyse, duck, and snap cuts to the beat.
//
// There is NO bundled track library and there never will be one. Shipping music
// with the app means shipping a licensing liability with every copy of it, and
// "royalty free" on a download page is not a licence audit. The user brings
// their own file, or picks from MUSIC_SOURCES — links out to catalogues that
// state their own terms, where the licence is between the creator and the
// catalogue, as it should be.
//
// Everything here is pure DSP and plain data. Nothing touches the renderer; the
// renderer asks for a finished bed (renderMusicBed) and mixes it.

import { remapToOutputTimeline } from './captions.js'
import { LIMITS } from './candidates.js'

/** Bed defaults. All overridable per render. */
export const MUSIC = {
  /** Music level under speech. Not 0 — a bed that vanishes sounds broken. */
  duckGain: 0.25,
  /** Level with nothing else going on. */
  bedGain: 1,
  /** Duck ramps. Instant gain changes are audible as pumping. */
  rampSeconds: 0.3,
  /** Track head/tail fades, so a bed never starts or stops mid-phrase. */
  fadeInSeconds: 1.5,
  fadeOutSeconds: 2.5,
  /** Two speech ranges closer than this stay ducked through the gap. */
  bridgeSeconds: 0.8,
  /** Default overall music level relative to the dialogue. */
  defaultGain: 0.5,
  /** Working rate for analysis — half of 44.1k is plenty for an onset envelope. */
  analysisRate: 22050,
  /** Onset envelope hop, seconds (~10ms). */
  hopSeconds: 0.01,
  fftSize: 1024,
  /** Tempo search range. */
  minBpm: 60,
  maxBpm: 180,
  /** Below this, the UI must say the beat grid is unreliable rather than use it. */
  lowConfidence: 0.5,
}

/**
 * Curated free-music sources. Links only — we never proxy, mirror or bundle the
 * audio, and each catalogue states its own terms, which the user accepts there.
 * `attribution: true` means the licence generally requires crediting the artist.
 */
export const MUSIC_SOURCES = [
  {
    name: 'YouTube Audio Library',
    url: 'https://studio.youtube.com/channel/UC/music',
    note: 'Free for any use on and off YouTube. Some tracks require attribution — the library marks which.',
    attribution: 'some',
  },
  {
    name: 'Pixabay Music',
    url: 'https://pixabay.com/music/',
    note: 'Pixabay Content Licence — free for commercial use, no attribution required.',
    attribution: 'no',
  },
  {
    name: 'Free Music Archive',
    url: 'https://freemusicarchive.org/',
    note: 'Per-track Creative Commons licences. Check each track — some are non-commercial only.',
    attribution: 'usually',
  },
  {
    name: 'ccMixter',
    url: 'http://dig.ccmixter.org/',
    note: 'Creative Commons remixes and instrumentals. Attribution required on most tracks.',
    attribution: 'yes',
  },
  {
    name: 'Incompetech (Kevin MacLeod)',
    url: 'https://incompetech.com/music/royalty-free/music.html',
    note: 'CC BY — free for commercial use with credit, or buy a no-attribution licence.',
    attribution: 'yes',
  },
  {
    name: 'Uppbeat',
    url: 'https://uppbeat.io/',
    note: 'Free tier for creators, with a credit. Paid tier removes the credit requirement.',
    attribution: 'yes',
  },
]

// ---- loading ---------------------------------------------------------------

/**
 * Decode an uploaded audio file.
 *
 * @param {File|Blob} file
 * @returns {Promise<{buffer: AudioBuffer, duration: number, name: string, sampleRate: number}>}
 */
export async function loadTrack(file) {
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) throw new Error('Web Audio is unavailable in this browser.')
  const bytes = await file.arrayBuffer()
  const ctx = new AC()
  let buffer
  try {
    buffer = await ctx.decodeAudioData(bytes)
  } catch (err) {
    throw new Error(
      `Could not decode "${file.name || 'track'}" — try MP3, M4A, WAV or OGG. (${err?.message || err})`,
    )
  } finally {
    ctx.close()
  }
  return {
    buffer,
    duration: buffer.duration,
    name: file.name || 'track',
    sampleRate: buffer.sampleRate,
  }
}

// ---- beat detection --------------------------------------------------------

/** Mono downmix, decimated to `rate`. Averaging, not dropping — no aliasing whine. */
function monoAt(buffer, rate) {
  const chs = []
  for (let c = 0; c < buffer.numberOfChannels; c++) chs.push(buffer.getChannelData(c))
  const ratio = buffer.sampleRate / rate
  const outLen = Math.max(1, Math.floor(buffer.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const a = Math.floor(i * ratio)
    const b = Math.min(chs[0].length, Math.floor((i + 1) * ratio))
    let sum = 0
    let n = 0
    for (let j = a; j < b; j++) {
      for (const ch of chs) sum += ch[j]
      n += chs.length
    }
    out[i] = n ? sum / n : 0
  }
  return out
}

/**
 * In-place iterative radix-2 FFT. Real input arrives in `re` with `im` zeroed.
 * Small enough to own outright — pulling a library in for one transform is how
 * a 40KB dependency ends up in a video editor.
 */
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k]
        const ui = im[i + k]
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ur + vr
        im[i + k] = ui + vi
        re[i + k + len / 2] = ur - vr
        im[i + k + len / 2] = ui - vi
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

/**
 * Spectral flux onset envelope: the sum of POSITIVE magnitude changes between
 * consecutive frames. Positive-only is the whole trick — energy arriving is a
 * note starting, energy leaving is a note ending, and only the first is a beat.
 */
export function onsetEnvelope(mono, rate, opts = {}) {
  const N = opts.fftSize || MUSIC.fftSize
  const hop = Math.max(1, Math.round((opts.hopSeconds || MUSIC.hopSeconds) * rate))
  const frames = Math.max(1, Math.floor((mono.length - N) / hop) + 1)
  const bins = N / 2
  const win = new Float32Array(N)
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)) // Hann

  const flux = new Float32Array(frames)
  let prev = new Float32Array(bins)
  const re = new Float32Array(N)
  const im = new Float32Array(N)
  const mag = new Float32Array(bins)

  for (let f = 0; f < frames; f++) {
    const off = f * hop
    for (let i = 0; i < N; i++) {
      const s = off + i < mono.length ? mono[off + i] : 0
      re[i] = s * win[i]
      im[i] = 0
    }
    fft(re, im)
    let sum = 0
    for (let b = 0; b < bins; b++) {
      mag[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b])
      const d = mag[b] - prev[b]
      if (d > 0) sum += d
    }
    flux[f] = sum
    const t = prev
    prev = mag.slice()
    t.fill(0)
  }

  // Normalise to 0..1 so the thresholds below mean the same on a quiet track.
  let max = 0
  for (const v of flux) if (v > max) max = v
  if (max > 0) for (let i = 0; i < flux.length; i++) flux[i] /= max
  return { flux, hop, rate, hopSeconds: hop / rate }
}

/** Median of a window of the envelope — the adaptive part of the threshold. */
function windowMedian(arr, centre, radius) {
  const a = Math.max(0, centre - radius)
  const b = Math.min(arr.length, centre + radius + 1)
  const slice = Array.prototype.slice.call(arr, a, b).sort((x, y) => x - y)
  const m = slice.length >> 1
  return slice.length % 2 ? slice[m] : (slice[m - 1] + slice[m]) / 2
}

/**
 * Tempo by autocorrelation of the onset envelope, restricted to 60-180 BPM.
 * @returns {{bpm:number, strength:number, lag:number}} strength is the ACF peak
 *          over the mean ACF in range — 1.0 means "no periodicity at all".
 */
export function estimateTempo(flux, hopSeconds, opts = {}) {
  const minBpm = opts.minBpm || MUSIC.minBpm
  const maxBpm = opts.maxBpm || MUSIC.maxBpm
  const minLag = Math.max(1, Math.round(60 / maxBpm / hopSeconds))
  const maxLag = Math.min(flux.length - 1, Math.round(60 / minBpm / hopSeconds))
  if (maxLag <= minLag) return { bpm: 0, strength: 0, lag: 0 }

  let mean = 0
  for (const v of flux) mean += v
  mean /= flux.length || 1

  let bestLag = minLag
  let best = -Infinity
  let sum = 0
  let n = 0
  const acf = new Float64Array(maxLag + 1)
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acc = 0
    for (let i = 0; i + lag < flux.length; i++) acc += (flux[i] - mean) * (flux[i + lag] - mean)
    acc /= flux.length - lag
    acf[lag] = acc
    sum += acc
    n++
    if (acc > best) {
      best = acc
      bestLag = lag
    }
  }
  const avg = n ? sum / n : 0
  // Strength: how far the winning lag stands above the average correlation.
  // 0 = no periodicity, 1 = the winning lag towers over every other. Clamped:
  // a negative mean correlation can otherwise push this above 1 and turn a
  // structureless track into a confident one.
  const strength =
    best > 0 ? Math.max(0, Math.min(1, (best - avg) / Math.abs(best))) : 0
  return { bpm: 60 / (bestLag * hopSeconds), strength, lag: bestLag }
}

/**
 * Beat positions, tempo, and an honest confidence.
 *
 * Confidence is the point of this function as much as the beats are. Onset
 * detection genuinely fails on ambient pads, rubato piano and fingerpicked
 * acoustic — there is no pulse to find — and a UI that shows a beat grid anyway
 * invites the user to snap every cut to noise. Below MUSIC.lowConfidence the
 * caller is expected to say so and leave beat snapping off.
 *
 * @param {AudioBuffer|{sampleRate:number,length:number,numberOfChannels:number,getChannelData:Function}} audioBuffer
 * @param {{onProgress?:Function}} [opts]
 * @returns {{beats:number[], bpm:number, confidence:number, envelope:object}}
 */
export function detectBeats(audioBuffer, opts = {}) {
  const rate = opts.analysisRate || MUSIC.analysisRate
  opts.onProgress?.({ pct: 5, msg: 'Downmixing…' })
  const mono = monoAt(audioBuffer, rate)

  opts.onProgress?.({ pct: 20, msg: 'Onset envelope…' })
  const env = onsetEnvelope(mono, rate, opts)
  const { flux, hopSeconds } = env

  opts.onProgress?.({ pct: 60, msg: 'Estimating tempo…' })
  const tempo = estimateTempo(flux, hopSeconds, opts)

  opts.onProgress?.({ pct: 75, msg: 'Picking beats…' })
  // Adaptive median threshold. A fixed threshold picks every frame of a loud
  // section and nothing at all in a quiet one.
  const radius = Math.max(2, Math.round(0.1 / hopSeconds))
  const delta = opts.delta ?? 0.08
  const multiplier = opts.multiplier ?? 1.6
  const minGapFrames = Math.max(1, Math.round((60 / MUSIC.maxBpm / 2) / hopSeconds))

  const peaks = []
  let lastPeak = -Infinity
  for (let i = 1; i < flux.length - 1; i++) {
    const v = flux[i]
    if (v < flux[i - 1] || v < flux[i + 1]) continue // local max only
    const thr = windowMedian(flux, i, radius) * multiplier + delta
    if (v < thr) continue
    if (i - lastPeak < minGapFrames) {
      // Two peaks inside one beat period — keep the stronger.
      if (peaks.length && v > flux[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i
      continue
    }
    peaks.push(i)
    lastPeak = i
  }

  // Frame f covers [f·hop, f·hop+N). A click inside that window is detected AT
  // the window, so reporting the window's START puts every beat half a window
  // early — audible as cuts landing just ahead of the downbeat.
  const N = opts.fftSize || MUSIC.fftSize
  const centreOffset = N / 2 / rate
  const beats = peaks.map((i) => +(i * hopSeconds + centreOffset).toFixed(4))

  // Confidence has two independent halves, and the WEAKER one wins:
  //   1. is there a pulse at all (autocorrelation strength), and
  //   2. do the peaks we found actually land on that pulse (grid agreement)?
  // A track can autocorrelate well and still yield sloppy onsets; both must
  // hold before a caller should trust the grid.
  const period = tempo.bpm > 0 ? 60 / tempo.bpm : 0
  let agreement = 0
  if (period > 0 && beats.length >= 4) {
    // The grid does not start at t=0 — a track has an intro. Recover the phase
    // as the circular mean of the beats' positions within one period, then
    // measure agreement against THAT grid. Without this, a perfectly steady
    // track whose first beat is offset scores near zero.
    let sx = 0
    let sy = 0
    for (const b of beats) {
      const a = (2 * Math.PI * (b % period)) / period
      sx += Math.cos(a)
      sy += Math.sin(a)
    }
    const phase = (((Math.atan2(sy, sx) / (2 * Math.PI)) * period) + period) % period
    const tol = Math.min(0.07, period * 0.12)
    let hits = 0
    for (const b of beats) {
      const rel = (b - phase) / period
      if (Math.abs(rel - Math.round(rel)) * period <= tol) hits++
    }
    agreement = hits / beats.length
  }
  const density = beats.length / Math.max(1, audioBuffer.length / audioBuffer.sampleRate) // beats/sec
  // A believable pulse is between roughly 0.5 and 4 beats per second. Outside
  // that we are counting noise or missing the track entirely.
  const plausible = density >= 0.5 && density <= 4 ? 1 : density > 0 ? 0.4 : 0
  const confidence = +Math.max(
    0,
    Math.min(1, Math.min(tempo.strength, agreement) * plausible),
  ).toFixed(3)

  opts.onProgress?.({ pct: 100, msg: 'Done.' })
  return {
    beats,
    bpm: tempo.bpm ? +tempo.bpm.toFixed(1) : 0,
    confidence,
    envelope: { hopSeconds, frames: flux.length },
    detail: { tempoStrength: +tempo.strength.toFixed(3), agreement: +agreement.toFixed(3), density: +density.toFixed(2) },
  }
}

// ---- ducking ---------------------------------------------------------------

/**
 * Speech ranges per clip, in SOURCE time.
 *
 * The transcript is the truthful source when there is one. Without it the
 * analyzer's silence detection is inverted instead — coarser, and it will call
 * a passing motorbike "speech", but a bed that ducks for a motorbike is a much
 * smaller failure than a bed that sits on top of the dialogue.
 */
export function speechRangesByClip(analysis, transcripts) {
  const A = analysis instanceof Map ? analysis : new Map(Object.entries(analysis || {}))
  const T = transcripts instanceof Map ? transcripts : new Map(Object.entries(transcripts || {}))
  const out = {}
  let source = 'none'

  for (const [clipId, tr] of T) {
    if (!tr || tr.error || !tr.sentences?.length) continue
    out[clipId] = tr.sentences.map((s) => ({ start: s.start, end: s.end }))
    source = 'transcript'
  }

  for (const [clipId, a] of A) {
    if (out[clipId] || !a || a.error) continue
    const dur = a.duration || 0
    const sil = (a.audio?.silences || []).slice().sort((x, y) => x.start - y.start)
    if (!a.audio?.hasAudio || !dur) continue
    // Everything that is not silence, when the clip has speech-like content.
    if (a.kind === 'quiet' || a.kind === 'broll') continue
    const ranges = []
    let cur = 0
    for (const s of sil) {
      if (s.start > cur) ranges.push({ start: cur, end: Math.min(s.start, dur) })
      cur = Math.max(cur, s.end)
    }
    if (cur < dur) ranges.push({ start: cur, end: dur })
    if (ranges.length) {
      out[clipId] = ranges
      if (source === 'none') source = 'analysis'
    }
  }

  return { byClip: out, source }
}

/** Merge overlapping/near ranges. */
function mergeRanges(ranges, bridge = 0) {
  const sorted = ranges.slice().sort((a, b) => a.start - b.start)
  const out = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start - last.end <= bridge) last.end = Math.max(last.end, r.end)
    else out.push({ start: r.start, end: r.end })
  }
  return out
}

/**
 * Gain envelope for the music bed over the OUTPUT timeline.
 *
 * Music that does not drop under speech is not a soundtrack, it is interference
 * — so this is not optional decoration, it is what makes the feature usable.
 *
 * Speech ranges are mapped through the same remap the captions use, which is
 * what keeps the duck aligned with reordering, excluded ranges and the engine's
 * join path. A curve built on source time would duck the wrong seconds the
 * moment a segment moved.
 *
 * @returns {{points:{t:number,gain:number}[], ranges:{start,end}[], source:string,
 *            duckedSeconds:number, totalSeconds:number}}
 */
export function buildDuckingCurve(plan, analysis, transcripts, opts = {}) {
  const duck = opts.duckGain ?? MUSIC.duckGain
  const bed = opts.bedGain ?? MUSIC.bedGain
  const ramp = opts.rampSeconds ?? MUSIC.rampSeconds
  const { byClip, source } = speechRangesByClip(analysis, transcripts)

  const cues = {}
  for (const [clipId, ranges] of Object.entries(byClip)) {
    cues[clipId] = ranges.map((r) => ({ start: r.start, end: r.end, lines: [], words: [] }))
  }

  const mapped = remapToOutputTimeline(cues, plan, {
    transitionDuration: opts.transitionDuration ?? 0.5,
  }).map((c) => ({ start: c.start, end: c.end }))

  const totalSeconds = opts.totalSeconds ?? mapped.reduce((m, r) => Math.max(m, r.end), 0)
  // Bridge short gaps: ducking back up for 400ms between two sentences is the
  // pumping artefact every amateur edit has.
  const ranges = mergeRanges(mapped, opts.bridgeSeconds ?? MUSIC.bridgeSeconds).map((r) => ({
    start: Math.max(0, r.start),
    end: Math.min(totalSeconds || r.end, r.end),
  }))

  const points = [{ t: 0, gain: bed }]
  const push = (t, gain) => {
    const clamped = Math.max(0, totalSeconds ? Math.min(t, totalSeconds) : t)
    const last = points[points.length - 1]
    if (last && Math.abs(last.t - clamped) < 1e-4) {
      last.gain = gain
      return
    }
    if (last && clamped < last.t) return // ramps collided — the duck simply holds
    points.push({ t: +clamped.toFixed(4), gain })
  }

  for (const r of ranges) {
    push(Math.max(0, r.start - ramp), bed)
    push(r.start, duck)
    push(r.end, duck)
    push(r.end + ramp, bed)
  }
  if (totalSeconds) push(totalSeconds, points[points.length - 1].gain === duck ? duck : bed)

  return {
    points,
    ranges,
    source,
    duckedSeconds: +ranges.reduce((a, r) => a + (r.end - r.start), 0).toFixed(2),
    totalSeconds: +totalSeconds.toFixed(3),
  }
}

/** Linear-interpolated gain at time t. */
export function gainAt(curve, t) {
  const pts = curve?.points || []
  if (!pts.length) return 1
  if (t <= pts[0].t) return pts[0].gain
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const a = pts[i - 1]
      const b = pts[i]
      const span = b.t - a.t
      if (span <= 1e-6) return b.gain
      return a.gain + ((t - a.t) / span) * (b.gain - a.gain)
    }
  }
  return pts[pts.length - 1].gain
}

// ---- beat snapping ---------------------------------------------------------

const nearestBeat = (t, beats) => {
  if (!beats?.length) return null
  let lo = 0
  let hi = beats.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (beats[mid] < t) lo = mid + 1
    else hi = mid
  }
  const a = beats[lo]
  const b = lo > 0 ? beats[lo - 1] : a
  return Math.abs(a - t) <= Math.abs(b - t) ? a : b
}

/** Is `t` inside a spoken word in this clip's transcript? */
function insideWord(tr, t) {
  if (!tr || tr.error) return false
  for (const s of tr.sentences || []) {
    if (t <= s.start || t >= s.end) continue
    const words = s.words || []
    if (!words.length) return true // sentence-level only: treat the whole span as spoken
    for (const w of words) if (t > w.start + 0.02 && t < w.end - 0.02) return true
  }
  return false
}

/**
 * Move segment boundaries onto the nearest musical beat.
 *
 * The hard rule is maxShift: a cut dragged to a distant beat is no longer the
 * cut the planner chose. 0.25s is about the largest move that still reads as
 * "the same cut, tightened" rather than a different edit. Boundaries that
 * cannot move legally are LEFT ALONE — a partially snapped edit is normal and
 * correct, and forcing the rest would break content to serve the grid.
 *
 * Beats are in output time; a boundary moves by trimming the source in/out
 * point, so every later segment shifts with it — the walk is sequential for
 * exactly that reason.
 *
 * @param {object} plan
 * @param {number[]} beats  seconds, ascending, in OUTPUT time
 * @param {{maxShift?:number, transcripts?:Map, clips?:Array, minSegment?:number,
 *          transitionDuration?:number}} [opts]
 * @returns {{plan:object, moved:number, considered:number, skipped:object, shifts:number[]}}
 */
export function snapCutsToBeats(plan, beats, opts = {}) {
  const maxShift = opts.maxShift ?? 0.25
  const minSegment = opts.minSegment ?? LIMITS.absoluteMinSeconds
  const transitionSec = opts.transitionDuration ?? 0
  const T =
    opts.transcripts instanceof Map
      ? opts.transcripts
      : new Map(Object.entries(opts.transcripts || {}))
  const clipDur = new Map((opts.clips || []).map((c) => [c.id, c.duration]))

  const segs = (plan?.segments || []).map((s) => ({ ...s }))
  const skipped = { tooFar: 0, sentence: 0, tooShort: 0, bounds: 0, noBeat: 0 }
  const shifts = []
  let considered = 0
  let outCursor = 0

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const len = Math.max(0, seg.end - seg.start)
    if (i > 0 && seg.transition && seg.transition !== 'cut') {
      outCursor -= Math.min(transitionSec, len / 2)
    }

    // The cut INTO this segment is the boundary that can move. The first
    // segment's head is the start of the video, which no beat should drag.
    if (i > 0) {
      considered++
      const beat = nearestBeat(outCursor, beats)
      const delta = beat == null ? null : beat - outCursor
      if (delta == null) {
        skipped.noBeat++
      } else if (Math.abs(delta) > maxShift) {
        skipped.tooFar++
      } else {
        // delta > 0 → the cut happens later → this segment starts later in its
        // source, so it gets shorter by delta. delta < 0 → it starts earlier.
        const newStart = seg.start + delta
        const dur = clipDur.get(seg.clipId)
        if (newStart < 0 || (dur != null && newStart > dur)) {
          skipped.bounds++
        } else if (seg.end - newStart < minSegment) {
          skipped.tooShort++
        } else if (insideWord(T.get(seg.clipId), newStart)) {
          skipped.sentence++
        } else {
          seg.start = +newStart.toFixed(4)
          shifts.push(+delta.toFixed(4))
          outCursor = beat
        }
      }
    }

    outCursor += Math.max(0, seg.end - seg.start)
  }

  return {
    plan: { ...plan, segments: segs },
    moved: shifts.length,
    considered,
    skipped,
    shifts,
    meanShiftMs: shifts.length
      ? Math.round((shifts.reduce((a, s) => a + Math.abs(s), 0) / shifts.length) * 1000)
      : 0,
  }
}

// ---- bed rendering ---------------------------------------------------------

/**
 * Render the finished music bed: the track, looped or trimmed to the output
 * length, with the ducking curve, head/tail fades and the user's level applied.
 *
 * Both engines mix THIS — one bed, one gain envelope, so the WebCodecs and
 * FFmpeg outputs cannot disagree about the soundtrack.
 *
 * @param {AudioBuffer} track
 * @param {{points:{t:number,gain:number}[]}|null} curve
 * @param {number} totalSeconds
 * @param {{gain?:number, sampleRate?:number, loop?:boolean, startAt?:number,
 *          fadeInSeconds?:number, fadeOutSeconds?:number}} [opts]
 * @returns {Promise<AudioBuffer>}
 */
export async function renderMusicBed(track, curve, totalSeconds, opts = {}) {
  const rate = opts.sampleRate || 44100
  const gain = opts.gain ?? MUSIC.defaultGain
  const fadeIn = opts.fadeInSeconds ?? MUSIC.fadeInSeconds
  const fadeOut = opts.fadeOutSeconds ?? MUSIC.fadeOutSeconds
  const frames = Math.max(1, Math.round(totalSeconds * rate))
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext
  if (!OAC) throw new Error('OfflineAudioContext is unavailable in this browser.')

  const oac = new OAC(2, frames, rate)
  const src = oac.createBufferSource()
  src.buffer = track
  // A track shorter than the edit loops; a longer one is simply cut off by the
  // context length, which is why the tail fade matters.
  src.loop = opts.loop ?? track.duration < totalSeconds
  const g = oac.createGain()
  src.connect(g)

  // Ducking curve first, as scheduled ramps — linear between the points we
  // built, which is what the 300ms ramps in buildDuckingCurve encode.
  const pts = curve?.points?.length ? curve.points : [{ t: 0, gain: 1 }]
  g.gain.setValueAtTime(pts[0].gain * gain, 0)
  for (const p of pts) {
    g.gain.linearRampToValueAtTime(p.gain * gain, Math.max(0, Math.min(totalSeconds, p.t)))
  }

  // Head and tail fades, applied as a second gain stage so they multiply with
  // the duck instead of overwriting its schedule.
  const fader = oac.createGain()
  g.connect(fader)
  fader.connect(oac.destination)
  const fi = Math.min(fadeIn, totalSeconds / 2)
  const fo = Math.min(fadeOut, totalSeconds / 2)
  fader.gain.setValueAtTime(fi > 0 ? 0.0001 : 1, 0)
  if (fi > 0) fader.gain.exponentialRampToValueAtTime(1, fi)
  if (fo > 0) {
    fader.gain.setValueAtTime(1, Math.max(fi, totalSeconds - fo))
    fader.gain.exponentialRampToValueAtTime(0.0001, totalSeconds)
  }

  src.start(0, Math.max(0, opts.startAt || 0))
  return oac.startRendering()
}

/**
 * AudioBuffer → 16-bit PCM WAV bytes, for handing the bed to FFmpeg.wasm.
 * @returns {Uint8Array}
 */
export function audioBufferToWav(buffer) {
  const chans = Math.min(2, buffer.numberOfChannels)
  const len = buffer.length
  const rate = buffer.sampleRate
  const bytes = 44 + len * chans * 2
  const out = new ArrayBuffer(bytes)
  const view = new DataView(out)
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  view.setUint32(4, bytes - 8, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, chans, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * chans * 2, true)
  view.setUint16(32, chans * 2, true)
  view.setUint16(34, 16, true)
  str(36, 'data')
  view.setUint32(40, len * chans * 2, true)

  const data = []
  for (let c = 0; c < chans; c++) data.push(buffer.getChannelData(c))
  let off = 44
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < chans; c++) {
      let s = data[c][i]
      s = s > 1 ? 1 : s < -1 ? -1 : s
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      off += 2
    }
  }
  return new Uint8Array(out)
}

/**
 * One call for the render path: everything music, resolved into a bed.
 * Returns null when there is no music, so callers can stay branch-light.
 */
export async function prepareMusicBed(plan, opts = {}) {
  const track = opts.track
  if (!track || !opts.totalSeconds) return null
  const curve = opts.ducking === false
    ? null
    : buildDuckingCurve(plan, opts.analysis, opts.transcripts, {
        totalSeconds: opts.totalSeconds,
        transitionDuration: opts.transitionDuration,
      })
  const buffer = await renderMusicBed(track, curve, opts.totalSeconds, {
    gain: opts.gain,
    sampleRate: opts.sampleRate,
    startAt: opts.startAt,
  })
  return { buffer, curve }
}
