// styleProfile.js — learn a creator's editing rhythm from their own finished
// videos, then bias future plans toward it.
//
// Deliberately narrow: shot lengths, opening hook, transition ratio, pacing
// curve. No transcript, no audio. Transcribing someone's finished upload to
// guess cut-on-speech-vs-motion is slow and the signal is weak.

const SCHEMA_VERSION = 1
const STORE_KEY = 'reelmind.styleProfiles'

// --- cut detection tuning -------------------------------------------------
const SAMPLE_FPS = 4 // frames sampled per second of source
const SAMPLE_W = 64 // downscaled width for luma diffing
const ROLLING_WINDOW = 24 // diffs kept for the rolling median (~6s at 4fps)
const HARD_CUT_RATIO = 3.5 // single-sample spike above this × median = hard cut
const TRANSITION_RATIO = 1.8 // sustained elevation above this × median
const MIN_SHOT_S = 0.4 // ignore a cut within this of the previous one
// The spec's "sustained for 8-20 frames" is expressed in SOURCE frames (~0.27s
// to 0.67s at 30fps). We sample at 4fps, so the resolvable equivalent is a run
// of 2-6 samples (0.5s-1.5s), which also covers the crossfade lengths this app
// itself produces.
const TRANSITION_MIN_SAMPLES = 2
const TRANSITION_MAX_SAMPLES = 6

const clamp01 = (n) => Math.max(0, Math.min(1, n))

function median(xs) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function percentile(xs, p) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const i = clamp01(p) * (s.length - 1)
  const lo = Math.floor(i)
  const hi = Math.ceil(i)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo)
}

// ---- frame sampling ------------------------------------------------------

function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.muted = true
    v.playsInline = true
    v.preload = 'auto'
    v.src = url
    v.onerror = () => reject(new Error('could not decode this video'))
    v.onloadeddata = () => {
      // MediaRecorder WebM reports duration: Infinity until seeked past the end.
      // A creator's own export is very often exactly that.
      if (isFinite(v.duration)) return resolve(v)
      const onTime = () => {
        v.removeEventListener('timeupdate', onTime)
        const rewind = () => {
          v.removeEventListener('seeked', rewind)
          resolve(v)
        }
        v.addEventListener('seeked', rewind)
        try {
          v.currentTime = 0
        } catch {
          resolve(v)
        }
      }
      v.addEventListener('timeupdate', onTime)
      try {
        v.currentTime = 1e101
      } catch {
        resolve(v)
      }
    }
  })
}

function seek(v, t) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('seek timed out')), 8000)
    const done = () => {
      clearTimeout(to)
      v.removeEventListener('seeked', done)
      resolve()
    }
    v.addEventListener('seeked', done)
    try {
      v.currentTime = Math.min(t, Math.max(0, v.duration - 0.05))
    } catch (e) {
      clearTimeout(to)
      reject(e)
    }
  })
}

/**
 * Analyze a FINISHED, already-edited video for editing rhythm only.
 *
 * Cut detection compares each frame-to-frame luma difference against a ROLLING
 * MEDIAN of recent diffs rather than a fixed threshold — a fixed threshold
 * over-triggers on hard lighting changes and misses cuts in flat footage.
 *
 * @returns {Promise<{shotLengths:number[],cutCount:number,transitionCount:number,
 *   transitionRatio:number,duration:number,confidence:number}>}
 */
export async function analyzeEditedVideo(file, onProgress = () => {}) {
  const url = URL.createObjectURL(file)
  let video = null
  try {
    onProgress({ pct: 0, msg: `Loading ${file.name}…` })
    video = await loadVideo(url)
    const duration = video.duration
    if (!isFinite(duration) || duration <= 0) {
      throw new Error(`"${file.name}" has no readable duration`)
    }

    const w = SAMPLE_W
    const h = Math.max(1, Math.round((w * video.videoHeight) / (video.videoWidth || w))) || 36
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    const step = 1 / SAMPLE_FPS
    const total = Math.max(2, Math.floor(duration / step))
    const diffs = [] // { t, diff } — mean abs luma delta vs previous sample
    let prevLuma = null

    for (let i = 0; i < total; i++) {
      const t = i * step
      await seek(video, t)
      ctx.drawImage(video, 0, 0, w, h)
      const px = ctx.getImageData(0, 0, w, h).data

      const luma = new Float32Array(w * h)
      for (let p = 0, q = 0; p < px.length; p += 4, q++) {
        luma[q] = 0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2]
      }
      if (prevLuma) {
        let sum = 0
        for (let q = 0; q < luma.length; q++) sum += Math.abs(luma[q] - prevLuma[q])
        diffs.push({ t, diff: sum / luma.length / 255 })
      }
      prevLuma = luma

      if (i % 8 === 0) {
        onProgress({
          pct: Math.round((i / total) * 100),
          msg: `Scanning ${file.name} — ${Math.round(t)}s / ${Math.round(duration)}s`,
        })
      }
    }

    const result = detectCuts(diffs, duration)
    onProgress({ pct: 100, msg: `${file.name}: ${result.cutCount + result.transitionCount} cuts found` })
    return { ...result, name: file.name }
  } finally {
    if (video) {
      video.removeAttribute('src')
      video.load()
    }
    URL.revokeObjectURL(url)
  }
}

/** Split the diff series into shots. Exported for testing. */
export function detectCuts(diffs, duration) {
  const events = [] // { t, kind: 'cut'|'transition', ratio }
  const window = []

  const rollingMedian = () => {
    if (!window.length) return 0
    return median(window)
  }

  let run = null // { startIdx, peak, samples }

  const closeRun = () => {
    if (!run) return
    const len = run.samples
    if (len === 1 && run.peak >= HARD_CUT_RATIO) {
      events.push({ t: run.t, kind: 'cut', ratio: run.peak })
    } else if (len >= TRANSITION_MIN_SAMPLES && len <= TRANSITION_MAX_SAMPLES) {
      events.push({ t: run.t, kind: 'transition', ratio: run.peak })
    }
    // A run of 1 below the hard-cut ratio is noise; a run longer than the
    // transition window is camera movement or a lighting change, not an edit.
    run = null
  }

  for (let i = 0; i < diffs.length; i++) {
    const med = rollingMedian()
    const ratio = med > 1e-6 ? diffs[i].diff / med : diffs[i].diff > 0.02 ? HARD_CUT_RATIO : 0

    if (ratio >= TRANSITION_RATIO) {
      if (run) {
        run.samples++
        run.peak = Math.max(run.peak, ratio)
      } else {
        run = { t: diffs[i].t, peak: ratio, samples: 1 }
      }
    } else {
      closeRun()
    }

    // The rolling baseline must track ordinary motion, not the spikes it is
    // measuring against, so elevated samples are kept out of the window.
    if (ratio < TRANSITION_RATIO) {
      window.push(diffs[i].diff)
      if (window.length > ROLLING_WINDOW) window.shift()
    }
  }
  closeRun()

  // Drop anything too close to its predecessor — flicker, not an edit.
  const kept = []
  for (const e of events) {
    if (kept.length && e.t - kept[kept.length - 1].t < MIN_SHOT_S) continue
    kept.push(e)
  }

  const shotLengths = []
  let prev = 0
  for (const e of kept) {
    shotLengths.push(+(e.t - prev).toFixed(3))
    prev = e.t
  }
  if (duration - prev > 0.05) shotLengths.push(+(duration - prev).toFixed(3))

  const cutCount = kept.filter((e) => e.kind === 'cut').length
  const transitionCount = kept.filter((e) => e.kind === 'transition').length
  const boundaries = cutCount + transitionCount

  // Confidence is how cleanly the spikes separate from the baseline. A detector
  // scraping just above its own threshold is guessing, and the UI must say so.
  const medRatio = kept.length ? median(kept.map((e) => e.ratio)) : 0
  let confidence = clamp01((medRatio - 2) / 8)
  if (kept.length < 3) confidence *= 0.5
  if (!kept.length) confidence = 0

  return {
    shotLengths,
    cutCount,
    transitionCount,
    transitionRatio: boundaries ? transitionCount / boundaries : 0,
    duration,
    confidence: +confidence.toFixed(3),
  }
}

// ---- profile ------------------------------------------------------------

const PACING_BUCKETS = 10

/**
 * Aggregate 1-5 analyzed videos into a profile.
 * The schema is source-agnostic on purpose so in-app edit history can be merged
 * in later without a migration.
 */
export function buildProfile(analyses, name) {
  const usable = (analyses || []).filter((a) => a && a.shotLengths?.length)
  if (!usable.length) throw new Error('No usable analyses — none of those videos produced shots.')

  const allShots = usable.flatMap((a) => a.shotLengths)
  const med = median(allShots)

  // Opening shot: averaged across sources. Vloggers are remarkably consistent
  // about hook length and it is one of the most personal signals available.
  const openings = usable.map((a) => a.shotLengths[0]).filter((n) => n > 0)
  const openingShotLength = openings.length
    ? openings.reduce((s, n) => s + n, 0) / openings.length
    : med

  const mean = allShots.reduce((s, n) => s + n, 0) / allShots.length
  const variance = allShots.reduce((s, n) => s + (n - mean) ** 2, 0) / allShots.length

  const totalTransitions = usable.reduce((s, a) => s + a.transitionCount, 0)
  const totalBoundaries = usable.reduce((s, a) => s + a.cutCount + a.transitionCount, 0)

  // Pacing: median shot length per normalized position, as a multiplier of the
  // overall median. Captures "opens fast and settles" vs "builds to the end".
  const buckets = Array.from({ length: PACING_BUCKETS }, () => [])
  for (const a of usable) {
    let pos = 0
    for (const len of a.shotLengths) {
      const norm = a.duration > 0 ? pos / a.duration : 0
      const b = Math.min(PACING_BUCKETS - 1, Math.floor(norm * PACING_BUCKETS))
      buckets[b].push(len)
      pos += len
    }
  }
  const pacingCurve = buckets.map((b) => (b.length && med > 0 ? +(median(b) / med).toFixed(3) : 1))

  return {
    schemaVersion: SCHEMA_VERSION,
    id: `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name: name || 'My style',
    createdAt: new Date().toISOString(),
    sourceCount: usable.length,
    sources: usable.map((a) => ({ name: a.name || 'clip', duration: +a.duration.toFixed(2) })),

    medianShotLength: +med.toFixed(3),
    p25ShotLength: +percentile(allShots, 0.25).toFixed(3),
    p75ShotLength: +percentile(allShots, 0.75).toFixed(3),
    openingShotLength: +openingShotLength.toFixed(3),
    shotLengthVariance: +variance.toFixed(4),
    transitionRatio: totalBoundaries ? +(totalTransitions / totalBoundaries).toFixed(3) : 0,
    pacingCurve,

    // The MINIMUM, not the average — one bad source should drag the whole
    // profile's trustworthiness down rather than be averaged away.
    confidence: +Math.min(...usable.map((a) => a.confidence ?? 0)).toFixed(3),
  }
}

/** Plain-language pacing description, shared by the UI and the Claude prompt. */
export function describePacing(pacingCurve) {
  if (!pacingCurve?.length) return 'steady throughout'
  const third = Math.max(1, Math.floor(pacingCurve.length / 3))
  const avg = (xs) => xs.reduce((s, n) => s + n, 0) / xs.length
  const head = avg(pacingCurve.slice(0, third))
  const tail = avg(pacingCurve.slice(-third))
  if (tail < head * 0.85) return 'you speed up toward the end'
  if (tail > head * 1.15) return 'you slow down toward the end'
  return 'steady pacing throughout'
}

/** One-sentence summary of a profile, in plain language. */
export function describeProfile(p) {
  if (!p) return ''
  const hardPct = Math.round((1 - (p.transitionRatio || 0)) * 100)
  const cutStyle =
    hardPct >= 80 ? 'mostly hard cuts' : hardPct >= 55 ? 'mixed cuts and transitions' : 'mostly transitions'
  return `${p.medianShotLength.toFixed(1)}s average shots, ${p.openingShotLength.toFixed(
    1,
  )}s opening hook, ${cutStyle}, ${describePacing(p.pacingCurve)}`
}

// ---- applying ----------------------------------------------------------

const MIN_SEGMENT_S = 0.7

/**
 * Bias a VALIDATED plan toward the profile. Order matters — see inline steps.
 *
 * Hard constraints always win: sentence boundaries, exclude ranges, the 0.7s
 * floor, and the source clip's real duration. The profile is applied first,
 * then everything is re-clamped against those.
 *
 * @param {object} plan
 * @param {object} profile
 * @param {{analysis?:Map, clips?:object[]}} [ctx] for sentence boundaries + clip durations
 */
export function applyProfile(plan, profile, ctx = {}) {
  if (!plan?.segments?.length || !profile) return plan

  const segs = plan.segments.map((s) => ({ ...s }))
  const durOf = (s) => Math.max(0, s.end - s.start)

  // 1. Uniform scale toward the profile's median, PRESERVING proportions. A
  //    single factor, not per-segment flattening — flattening would destroy the
  //    pacing the planner deliberately chose.
  const currentMedian = median(segs.map(durOf))
  if (currentMedian > 0.01 && profile.medianShotLength > 0.01) {
    const scale = Math.max(0.4, Math.min(2.5, profile.medianShotLength / currentMedian))
    for (const s of segs) s.end = s.start + durOf(s) * scale
  }

  // 2. Opening shot toward the profile's hook length — blended, so a
  //    deliberately chosen hook is not completely overridden.
  if (segs.length && profile.openingShotLength > 0.01) {
    const planned = durOf(segs[0])
    segs[0].end = segs[0].start + profile.openingShotLength * 0.7 + planned * 0.3
  }

  // 3. Bend by the pacing curve, using each segment's normalized position.
  const curve = profile.pacingCurve
  if (Array.isArray(curve) && curve.length) {
    const totalLen = segs.reduce((sum, s) => sum + durOf(s), 0)
    let pos = 0
    for (const s of segs) {
      const len = durOf(s)
      const norm = totalLen > 0 ? pos / totalLen : 0
      const mult = curve[Math.min(curve.length - 1, Math.floor(norm * curve.length))] ?? 1
      s.end = s.start + len * Math.max(0.5, Math.min(2, mult))
      pos += len
    }
  }

  // 4. Transitions from the ratio, distributed deterministically by position
  //    (Bresenham-style) so re-running produces byte-identical output.
  const ratio = clamp01(profile.transitionRatio || 0)
  let acc = 0
  for (let i = 1; i < segs.length; i++) {
    acc += ratio
    if (acc >= 1) {
      acc -= 1
      const original = plan.segments[i].transition
      segs[i].transition = original && original !== 'cut' ? original : 'fade'
    } else {
      segs[i].transition = 'cut'
    }
  }

  // --- re-clamp every hard constraint --------------------------------
  const clipById = new Map((ctx.clips || []).map((c) => [c.id, c]))
  const analysis = ctx.analysis instanceof Map ? ctx.analysis : null
  const excludes = plan.excludeRanges || []

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    const clip = clipById.get(s.clipId)
    const limit = clip?.duration ?? Infinity

    // Sentence boundaries win over the profile's preferred length.
    const bounds = analysis?.get(s.clipId)?.sentenceBoundaries
    if (bounds?.length) {
      let best = null
      let bestD = 1.2 // only snap if a boundary is genuinely nearby
      for (const b of bounds) {
        const d = Math.abs(b - s.end)
        if (d < bestD && b > s.start + MIN_SEGMENT_S) {
          bestD = d
          best = b
        }
      }
      if (best != null) s.end = best
    }

    // Never let a resized end land inside an excluded span.
    for (const e of excludes) {
      if (e.clipId && e.clipId !== s.clipId) continue
      if (s.end > e.start && s.end < e.end) s.end = e.start
    }

    // Never past the source clip.
    if (s.end > limit) s.end = limit

    // Never below the floor — and never past the next segment on the same clip.
    const next = segs[i + 1]
    if (next && next.clipId === s.clipId && s.end > next.start) s.end = next.start

    if (s.end - s.start < MIN_SEGMENT_S) {
      s.end = Math.min(limit, s.start + MIN_SEGMENT_S)
    }

    s.start = +s.start.toFixed(3)
    s.end = +s.end.toFixed(3)
  }

  const kept = segs.filter((s) => s.end - s.start >= 0.4)
  if (!kept.length) return plan // profile made it unrenderable — keep the original

  return {
    ...plan,
    segments: kept,
    appliedProfile: { id: profile.id, name: profile.name, confidence: profile.confidence },
  }
}

// ---- persistence --------------------------------------------------------

function freshStore() {
  return { schemaVersion: SCHEMA_VERSION, activeId: null, profiles: [] }
}

/** Read the store, discarding anything from an incompatible schema. Never throws. */
function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return freshStore()
    const parsed = JSON.parse(raw)
    const profiles = (parsed?.profiles || []).filter((p) => {
      if (p?.schemaVersion === SCHEMA_VERSION) return true
      console.warn(
        `[styleProfile] discarding profile "${p?.name ?? '?'}" — schemaVersion ${p?.schemaVersion} (expected ${SCHEMA_VERSION})`,
      )
      return false
    })
    const activeId = profiles.some((p) => p.id === parsed?.activeId) ? parsed.activeId : null
    return { schemaVersion: SCHEMA_VERSION, activeId, profiles }
  } catch (err) {
    console.warn('[styleProfile] store unreadable, starting fresh:', err?.message || err)
    return freshStore()
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store))
  } catch (err) {
    console.warn('[styleProfile] could not persist profiles:', err?.message || err)
  }
  return store
}

export function listProfiles() {
  return readStore().profiles
}

export function getActiveProfile() {
  const s = readStore()
  return s.profiles.find((p) => p.id === s.activeId) || null
}

export function setActiveProfile(id) {
  const s = readStore()
  s.activeId = s.profiles.some((p) => p.id === id) ? id : null
  return writeStore(s)
}

export function saveProfile(profile) {
  const s = readStore()
  const i = s.profiles.findIndex((p) => p.id === profile.id)
  if (i >= 0) s.profiles[i] = profile
  else s.profiles.push(profile)
  if (!s.activeId) s.activeId = profile.id
  writeStore(s)
  return profile
}

export function renameProfile(id, name) {
  const s = readStore()
  const p = s.profiles.find((x) => x.id === id)
  if (p) p.name = name || p.name
  writeStore(s)
  return p || null
}

export function deleteProfile(id) {
  const s = readStore()
  s.profiles = s.profiles.filter((p) => p.id !== id)
  if (s.activeId === id) s.activeId = s.profiles[0]?.id ?? null
  return writeStore(s)
}
