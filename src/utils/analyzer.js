// analyzer.js — client-side content analysis. No uploads, no ML.
// Produces per-clip audio energy, motion and silence data the planner uses to
// pick *where* inside a clip to cut, not just how long.
//
// Everything here is heavy on memory (decoded PCM + canvas pixel reads), so
// callers MUST run this one clip at a time — see analyzeAll / the "sequential"
// rule in CLAUDE.md.

import { findRetakes } from './retakes.js'

const MOTION_SAMPLE_W = 64 // downscaled frame width for pixel diffing
const MOTION_FPS = 4 // frames sampled per second of video
const AUDIO_WIN = 0.25 // seconds per RMS window
const SILENCE_RMS = 0.015 // below this normalized RMS = "silent"
const SILENCE_MIN = 0.4 // ignore silences shorter than this (seconds)

const clamp01 = (n) => Math.max(0, Math.min(1, n))

// ---- audio -----------------------------------------------------------------

async function analyzeAudio(file, duration) {
  const empty = { hasAudio: false, energy: 0, windows: [], silences: [], loudestAt: 0 }
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return empty

  let buf
  try {
    const bytes = await file.arrayBuffer()
    const ctx = new AC()
    buf = await ctx.decodeAudioData(bytes)
    ctx.close()
  } catch {
    return empty // no audio track, or a container the AudioContext can't decode
  }
  if (!buf || !buf.length) return empty

  const sr = buf.sampleRate
  const chans = []
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c))

  const winSamples = Math.max(1, Math.floor(AUDIO_WIN * sr))
  const windows = []
  let maxRms = 0

  for (let start = 0; start < buf.length; start += winSamples) {
    const end = Math.min(buf.length, start + winSamples)
    let sumSq = 0
    for (let i = start; i < end; i++) {
      let s = 0
      for (let c = 0; c < chans.length; c++) s += chans[c][i]
      s /= chans.length
      sumSq += s * s
    }
    const rms = Math.sqrt(sumSq / (end - start))
    if (rms > maxRms) maxRms = rms
    windows.push({ t: start / sr, rms })
  }

  // Normalize RMS to the clip's own peak so quiet-recorded footage still ranks.
  const norm = maxRms || 1
  let loudest = { t: 0, v: 0 }
  for (const w of windows) {
    w.level = clamp01(w.rms / norm)
    if (w.level > loudest.v) loudest = { t: w.t, v: w.level }
  }

  // Silence runs.
  const silences = []
  let runStart = null
  for (let i = 0; i < windows.length; i++) {
    const quiet = windows[i].level < SILENCE_RMS / (norm || 1) || windows[i].rms < SILENCE_RMS
    if (quiet && runStart == null) runStart = windows[i].t
    if (!quiet && runStart != null) {
      const runEnd = windows[i].t
      if (runEnd - runStart >= SILENCE_MIN) silences.push({ start: runStart, end: runEnd })
      runStart = null
    }
  }
  if (runStart != null && duration - runStart >= SILENCE_MIN) {
    silences.push({ start: runStart, end: duration })
  }

  const energy = clamp01(windows.reduce((a, w) => a + w.level, 0) / (windows.length || 1))
  return { hasAudio: true, energy, windows, silences, loudestAt: loudest.t }
}

// ---- motion --------------------------------------------------------------

function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.src = url
    v.onloadeddata = () => resolve(v)
    v.onerror = () => reject(new Error('motion: video failed to load'))
  })
}

function seek(v, t) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      v.removeEventListener('seeked', onSeeked)
      resolve()
    }
    v.addEventListener('seeked', onSeeked)
    setTimeout(() => reject(new Error('motion: seek timeout')), 8000)
    v.currentTime = Math.min(t, Math.max(0, v.duration - 0.05))
  })
}

async function analyzeMotion(url, duration, width, height) {
  const empty = { windows: [], avg: 0, busiestAt: 0 }
  let v
  try {
    v = await loadVideo(url)
  } catch {
    return empty
  }

  const w = MOTION_SAMPLE_W
  const h = Math.max(1, Math.round((w * height) / width)) || 36
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  const step = 1 / MOTION_FPS
  const windows = []
  let prev = null
  let busiest = { t: 0, v: 0 }

  try {
    for (let t = 0; t < duration; t += step) {
      await seek(v, t)
      ctx.drawImage(v, 0, 0, w, h)
      const frame = ctx.getImageData(0, 0, w, h).data
      if (prev) {
        let diff = 0
        for (let i = 0; i < frame.length; i += 4) {
          diff += Math.abs(frame[i] - prev[i]) + Math.abs(frame[i + 1] - prev[i + 1]) + Math.abs(frame[i + 2] - prev[i + 2])
        }
        // Mean per-pixel channel delta, 0..1.
        const score = clamp01(diff / ((frame.length / 4) * 3 * 255))
        windows.push({ t, score })
        if (score > busiest.v) busiest = { t, v: score }
      }
      prev = frame
    }
  } catch {
    // partial data is still useful
  } finally {
    v.removeAttribute('src')
    v.load()
  }

  const avg = clamp01(windows.reduce((a, x) => a + x.score, 0) / (windows.length || 1))
  return { windows, avg, busiestAt: busiest.t }
}

// ---- highlights --------------------------------------------------------

/**
 * Fuse audio level + motion into a single "interestingness" curve and pick the
 * best non-overlapping windows. Returns [{ start, end, score }] sorted by score.
 */
function pickHighlights(audio, motion, duration, winLen = 3) {
  const at = (arr, t, key) => {
    if (!arr.length) return 0
    let best = arr[0]
    for (const x of arr) if (Math.abs(x.t - t) < Math.abs(best.t - t)) best = x
    return best[key] || 0
  }

  const step = 0.5
  const scored = []
  for (let t = 0; t + winLen <= duration + 0.01; t += step) {
    let s = 0
    let n = 0
    for (let u = t; u < t + winLen; u += step) {
      const a = at(audio.windows, u, 'level')
      const m = at(motion.windows, u, 'score')
      const silent = audio.silences.some((sil) => u >= sil.start && u < sil.end)
      s += (silent ? 0 : 0.55 * a) + 0.45 * Math.min(1, m * 4)
      n++
    }
    scored.push({ start: t, end: t + winLen, score: n ? s / n : 0 })
  }

  scored.sort((a, b) => b.score - a.score)
  const chosen = []
  for (const c of scored) {
    if (chosen.some((x) => c.start < x.end && c.end > x.start)) continue
    chosen.push(c)
    if (chosen.length >= 6) break
  }
  return chosen
}

// ---- public --------------------------------------------------------------

/**
 * Analyze one probed clip. Expects { id, name, file, url, duration, width, height }.
 * @returns clip-shaped analysis object (safe to spread onto the clip).
 */
export async function analyzeClip(clip, onProgress = () => {}) {
  onProgress({ id: clip.id, phase: 'audio', msg: `Analyzing audio · ${clip.name}` })
  const audio = await analyzeAudio(clip.file, clip.duration)

  onProgress({ id: clip.id, phase: 'motion', msg: `Analyzing motion · ${clip.name}` })
  const motion = await analyzeMotion(clip.url, clip.duration, clip.width, clip.height)

  const highlights = pickHighlights(audio, motion, clip.duration)
  const motionScore = clamp01(motion.avg * 4)

  // Coarse content class from audio + motion alone. A transcript, when present,
  // upgrades this to 'talking' via withTranscript().
  let kind = 'quiet'
  if (motionScore > 0.45) kind = 'action'
  else if (audio.hasAudio && audio.energy > 0.2) kind = 'talking'
  else if (motionScore > 0.2) kind = 'broll'

  return {
    id: clip.id,
    name: clip.name,
    duration: clip.duration,
    audio,
    motion,
    highlights,
    kind,
    transcript: null, // filled by withTranscript() when the user transcribes
    sentenceBoundaries: null,
    // convenience scalars for UI / planner
    energy: audio.energy,
    motionAvg: motion.avg,
    silenceRatio: clamp01(
      audio.silences.reduce((a, s) => a + (s.end - s.start), 0) / (clip.duration || 1),
    ),
    suggestedStart: highlights.length ? highlights[0].start : Math.min(clip.duration * 0.1, 2),
    bestStart: highlights.length ? highlights[0].start : Math.min(clip.duration * 0.1, 2),
  }
}

/**
 * Fold a transcript (from transcribe.js) into an existing analysis object.
 * Returns a NEW object — the analyzer's own output is never mutated, and every
 * downstream path still works when transcript is null.
 *
 * @param {object|null} analysis  prior analyzeClip() output (or a bare stub)
 * @param {object|null} transcript  { words, sentences, fillers, ... } or null
 */
export function withTranscript(analysis, transcript) {
  const base = analysis && typeof analysis === 'object' ? analysis : {}
  if (!transcript || transcript.error || !transcript.sentences?.length) return base

  const duration =
    base.duration ||
    transcript.sentences[transcript.sentences.length - 1].end ||
    0
  const wps = (transcript.words?.length || 0) / (duration || 1)
  const first = transcript.sentences[0]

  // Literal retakes — a line said, disliked, said again. Non-destructive: this
  // only records the groups; excluding takes is a planner/UI decision.
  const retakes = findRetakes(transcript.sentences, {})

  return {
    ...base,
    transcript,
    retakes,
    // > 0.8 words/sec is unambiguously a talking clip, whatever the motion says.
    kind: wps > 0.8 ? 'talking' : base.kind || 'talking',
    // First spoken word beats a silence edge as an entry point.
    suggestedStart: Math.max(0, first.start - 0.2),
    bestStart: Math.max(0, first.start - 0.2),
    // Sentence ends never fall mid-thought the way a silence can.
    sentenceBoundaries: transcript.sentences.map((s) => s.end),
    wordsPerSecond: wps,
    hasTranscript: true,
  }
}

/**
 * Analyze many clips ONE AT A TIME (memory ceiling — see CLAUDE.md).
 * @returns Map<clipId, analysis>
 */
export async function analyzeAll(clips, onProgress = () => {}) {
  const out = new Map()
  for (let i = 0; i < clips.length; i++) {
    onProgress({ index: i, total: clips.length, id: clips[i].id, phase: 'start', msg: `Analyzing ${i + 1} / ${clips.length}` })
    try {
      out.set(clips[i].id, await analyzeClip(clips[i], onProgress))
    } catch (err) {
      out.set(clips[i].id, { id: clips[i].id, name: clips[i].name, error: err.message })
    }
  }
  onProgress({ index: clips.length, total: clips.length, phase: 'done', msg: 'Analysis complete' })
  return out
}
