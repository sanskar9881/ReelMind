// verify.js — post-render sanity harness. Loads the produced blob into a
// detached <video> and checks the things that actually break in a WebCodecs
// pipeline: timestamp unit errors, wrong resolution, non-seekable output
// (moov at the end), garbage frames from mid-GOP decoding, and a missing or
// silent audio track.

function loadVideo(blobUrl, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.src = blobUrl
    const to = setTimeout(() => reject(new Error('metadata load timed out')), timeoutMs)
    v.onloadedmetadata = () => {
      clearTimeout(to)
      resolve(v)
    }
    v.onerror = () => {
      clearTimeout(to)
      reject(new Error(`video failed to load (code ${v.error?.code ?? '?'})`))
    }
  })
}

function seekTo(video, t, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`seek to ${t.toFixed(2)}s did not resolve in ${timeoutMs}ms`)), timeoutMs)
    const done = () => {
      clearTimeout(to)
      video.removeEventListener('seeked', done)
      resolve(video.currentTime)
    }
    video.addEventListener('seeked', done)
    try {
      video.currentTime = t
    } catch (e) {
      clearTimeout(to)
      reject(e)
    }
  })
}

async function decodeAudio(blobUrl) {
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  const buf = await fetch(blobUrl).then((r) => r.arrayBuffer())
  const ctx = new AC()
  try {
    return await ctx.decodeAudioData(buf)
  } finally {
    ctx.close()
  }
}

function expectedDuration(plan) {
  if (!plan) return null
  if (typeof plan.totalDuration === 'number') return plan.totalDuration
  const segs = plan.segments || []
  if (!segs.length) return null
  const td = 0.5
  let d = 0
  segs.forEach((s, i) => {
    const len = Math.max(0, s.end - s.start)
    if (i > 0 && s.transition && s.transition !== 'cut') d -= Math.min(td, len / 2)
    d += len
  })
  return d
}

/**
 * @param {string} blobUrl
 * @param {{totalDuration?:number, width?:number, height?:number, segments?:object[]}} plan
 * @returns {Promise<{ok:boolean, checks:{name:string,passed:boolean,detail:string}[], warnings:string[]}>}
 */
export async function verifyRender(blobUrl, plan = {}) {
  const checks = []
  const warnings = []
  const add = (name, passed, detail) => checks.push({ name, passed, detail: String(detail) })

  let video
  try {
    video = await loadVideo(blobUrl)
  } catch (e) {
    add('loads', false, e.message)
    return { ok: false, checks, warnings }
  }
  add('loads', true, `readyState ${video.readyState}`)

  // --- duration --------------------------------------------------------
  const expected = expectedDuration(plan)
  const actual = video.duration
  if (expected == null) {
    add('duration', true, `${actual.toFixed(2)}s (no expected value to compare)`)
  } else {
    const delta = Math.abs(actual - expected)
    const passed = delta <= 0.4
    let detail = `${actual.toFixed(2)}s vs expected ${expected.toFixed(2)}s (Δ ${delta.toFixed(2)}s)`
    if (!passed) {
      const ratio = actual / expected
      if (ratio > 100 || ratio < 0.01) {
        detail += ' — ~1000× off looks like a µs/ms timestamp unit error'
      }
    }
    add('duration', passed, detail)
  }

  // --- resolution -----------------------------------------------------
  if (plan.width && plan.height) {
    const passed = video.videoWidth === plan.width && video.videoHeight === plan.height
    add('resolution', passed, `${video.videoWidth}×${video.videoHeight} vs requested ${plan.width}×${plan.height}`)
  } else {
    add('resolution', true, `${video.videoWidth}×${video.videoHeight} (no requested size)`)
  }

  // --- seekable (moov at front) -------------------------------------
  let seekOk = true
  const seekDetails = []
  for (const frac of [0.25, 0.5, 0.75]) {
    const t = Math.max(0, Math.min(actual - 0.05, actual * frac))
    try {
      const landed = await seekTo(video, t)
      seekDetails.push(`${Math.round(frac * 100)}%→${landed.toFixed(2)}s`)
    } catch (e) {
      seekOk = false
      seekDetails.push(`${Math.round(frac * 100)}% FAILED (${e.message})`)
    }
  }
  add('seekable', seekOk, seekOk ? seekDetails.join(', ') : `${seekDetails.join('; ')} — moov atom likely at end (fastStart)`)

  // --- mid frame is not uniform -----------------------------------
  try {
    await seekTo(video, Math.max(0, Math.min(actual - 0.05, actual * 0.5)))
    const cw = 48
    const ch = 27
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    const cx = canvas.getContext('2d', { willReadFrequently: true })
    cx.drawImage(video, 0, 0, cw, ch)
    const { data } = cx.getImageData(0, 0, cw, ch)
    let rMin = 255
    let rMax = 0
    let gMin = 255
    let gMax = 0
    let bMin = 255
    let bMax = 0
    for (let i = 0; i < data.length; i += 4) {
      rMin = Math.min(rMin, data[i])
      rMax = Math.max(rMax, data[i])
      gMin = Math.min(gMin, data[i + 1])
      gMax = Math.max(gMax, data[i + 1])
      bMin = Math.min(bMin, data[i + 2])
      bMax = Math.max(bMax, data[i + 2])
    }
    const spread = Math.max(rMax - rMin, gMax - gMin, bMax - bMin)
    const passed = spread >= 8
    add(
      'mid-frame not uniform',
      passed,
      passed
        ? `channel spread ${spread}`
        : `frame is nearly one colour (spread ${spread}) — mid-GOP decode may have produced garbage`,
    )
  } catch (e) {
    add('mid-frame not uniform', false, `could not sample a frame: ${e.message}`)
  }

  // --- audio track present + non-silent ---------------------------
  try {
    let hasAudio = null
    if (typeof video.mozHasAudio === 'boolean') hasAudio = video.mozHasAudio
    else if (typeof video.webkitAudioDecodedByteCount === 'number') {
      // needs a moment of playback to tick over
      hasAudio = video.webkitAudioDecodedByteCount > 0 ? true : null
    }

    if (hasAudio === true) {
      add('audio track', true, 'reported by the media element')
    } else {
      const buf = await decodeAudio(blobUrl)
      if (!buf) {
        add('audio track', false, 'no decodable audio and the element reports none')
      } else {
        let peak = 0
        for (let ch = 0; ch < buf.numberOfChannels; ch++) {
          const d = buf.getChannelData(ch)
          for (let i = 0; i < d.length; i += 64) peak = Math.max(peak, Math.abs(d[i]))
        }
        const passed = peak > 0.0005
        add('audio track', passed, passed ? `peak sample ${peak.toFixed(4)}` : 'audio decodes but is silent')
      }
    }
  } catch (e) {
    add('audio track', false, `audio check threw: ${e.message}`)
  }

  video.removeAttribute('src')
  video.load()

  const ok = checks.every((c) => c.passed)
  return { ok, checks, warnings, expectedDuration: expected, actualDuration: actual }
}

/**
 * Decode the rendered audio, compare its length against the video element's
 * duration. Anything over 100ms of delta is drift worth chasing.
 * @returns {Promise<{audioDuration:number|null, videoDuration:number, deltaMs:number, drift:boolean}>}
 */
export async function measureSync(blobUrl) {
  const video = await loadVideo(blobUrl)
  const videoDuration = video.duration
  video.removeAttribute('src')
  video.load()

  let audioDuration = null
  try {
    const buf = await decodeAudio(blobUrl)
    if (buf) audioDuration = buf.duration
  } catch {
    audioDuration = null
  }

  const deltaMs = audioDuration == null ? NaN : Math.round(Math.abs(audioDuration - videoDuration) * 1000)
  return {
    audioDuration,
    videoDuration,
    deltaMs,
    drift: Number.isFinite(deltaMs) && deltaMs > 100,
  }
}
