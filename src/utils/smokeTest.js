// smokeTest.js — dev-only end-to-end render check that needs no user files.
//
// Generates two 3s clips in-browser (canvas video + an oscillator tone), then
// runs the real pipeline: probe → analyze → mock plan → render → verifyRender,
// once forcing the WebCodecs engine and once forcing FFmpeg, and reports both.
// Ten seconds, repeatable, no footage required.

import { probeAll } from './videoMeta.js'
import { analyzeAll } from './analyzer.js'
import { generateEditPlan, mockPlan, resolveTargetDuration } from './ai.js'
import { keepRatioFor } from './candidates.js'
import { render, applyCutRanges, resolveJoinPath } from './videoProcessor.js'
import { remapToOutputTimeline } from './captions.js'
import { analyzeEditedVideo, buildProfile, describeProfile } from './styleProfile.js'
import { verifyRender, measureSync } from './verify.js'

function pickMime() {
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(c)) return c
  }
  return 'video/webm'
}

async function makeClip({ name, freq, color, seconds = 3, w = 640, h = 360 }) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')

  const AC = window.AudioContext || window.webkitAudioContext
  const actx = new AC()
  const osc = actx.createOscillator()
  osc.type = 'sine'
  osc.frequency.value = freq
  const gain = actx.createGain()
  gain.gain.value = 0.2
  const dest = actx.createMediaStreamDestination()
  osc.connect(gain)
  gain.connect(dest)

  const vStream = canvas.captureStream(30)
  const stream = new MediaStream([...vStream.getVideoTracks(), ...dest.stream.getAudioTracks()])

  const requested = pickMime()
  const rec = new MediaRecorder(stream, { mimeType: requested, videoBitsPerSecond: 2_000_000 })
  const chunks = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const stopped = new Promise((res) => {
    rec.onstop = res
  })

  let raf = 0
  const t0 = performance.now()
  const draw = () => {
    const t = (performance.now() - t0) / 1000
    ctx.fillStyle = '#0b0b14'
    ctx.fillRect(0, 0, w, h)
    const x = w * 0.15 + w * 0.6 * (0.5 + 0.5 * Math.sin(t * 2))
    const y = h * 0.5 + h * 0.25 * Math.sin(t * 3)
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(x, y, 40, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#eeeeff'
    ctx.font = '20px sans-serif'
    ctx.fillText(`${name}  ${t.toFixed(1)}s  ${freq}Hz`, 20, 34)
    raf = requestAnimationFrame(draw)
  }
  draw()

  osc.start()
  rec.start()
  // The container the browser actually settled on (may differ from requested).
  const actualMime = rec.mimeType || requested
  await new Promise((r) => setTimeout(r, seconds * 1000))
  rec.stop()
  try {
    osc.stop()
  } catch {
    /* already stopped */
  }
  cancelAnimationFrame(raf)
  await stopped
  actx.close()

  const type = (actualMime.split(';')[0] || 'video/webm').trim()
  const blob = new Blob(chunks, { type })
  const ext = type.includes('mp4') ? 'mp4' : 'webm'
  return { file: new File([blob], `${name}.${ext}`, { type }), mimeType: actualMime }
}

async function runEngine(engine, clips, plan, onDiag, log, opts = {}) {
  const t0 = performance.now()
  try {
    const out = await render(
      clips,
      plan,
      { resolution: '720p', forceEngine: engine, onDiag, ...opts },
      () => {},
    )
    const secs = ((performance.now() - t0) / 1000).toFixed(1)
    const report = await verifyRender(out.url, out)
    const sync = await measureSync(out.url)
    for (const c of report.checks) log(`  ${c.passed ? '✓' : '✗'} ${c.name}: ${c.detail}`)
    const syncTxt = Number.isFinite(sync.deltaMs) ? `${sync.deltaMs}ms` : 'n/a'
    log(`  A/V sync: ${syncTxt}${sync.drift ? '  ← DRIFT' : ''}`)
    URL.revokeObjectURL(out.url)
    const ok = report.ok && !sync.drift
    const durDeltaMs = Math.round((report.actualDuration - report.expectedDuration) * 1000)
    return { ok, method: out.method, secs, syncTxt, durDeltaMs, report, sync }
  } catch (err) {
    const secs = ((performance.now() - t0) / 1000).toFixed(1)
    return { ok: false, method: engine, secs, error: err?.message || String(err) }
  }
}

function loadDuration(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'metadata'
    v.src = url
    v.onloadedmetadata = () => resolve(v.duration)
    v.onerror = () => reject(new Error('could not load rendered video'))
  })
}

/**
 * Captions must land on the timeline the chosen engine actually produces. The
 * two engines join differently (WebCodecs crossfades and shortens; FFmpeg
 * concats and does not), so a plan with fades is the case that catches a remap
 * pointed at the wrong timeline. Assert the last cue ends with the video.
 */
async function captionTimelineCheck(clips, onDiag, log) {
  const [a, b] = clips
  const segments = [
    { clip: a.name, clipId: a.id, start: 0.2, end: 1.8, transition: 'cut', role: 'hook' },
    { clip: b.name, clipId: b.id, start: 0.2, end: 1.8, transition: 'fade', role: 'body' },
    { clip: a.name, clipId: a.id, start: 1.9, end: 2.9, transition: 'fade', role: 'outro' },
  ]
  const plan = { title: 'fade caption check', reasoning: '', music: 'none', segments }

  // One cue spanning each segment, in that clip's source time.
  const cuesByClip = {}
  for (const s of segments) {
    ;(cuesByClip[s.clipId] ||= []).push({
      start: s.start,
      end: s.end,
      lines: ['caption'],
      words: [],
    })
  }
  for (const k of Object.keys(cuesByClip)) cuesByClip[k].sort((x, y) => x.start - y.start)

  const split = applyCutRanges(plan)
  const out = {}
  for (const engine of ['webcodecs', 'ffmpeg']) {
    try {
      const join = resolveJoinPath(split, engine)
      const cues = remapToOutputTimeline(cuesByClip, split, {
        transitionDuration: join.transitionDuration,
      })
      const lastCueEnd = cues.length ? cues[cues.length - 1].end : NaN

      const r = await render(
        clips,
        plan,
        {
          resolution: '720p',
          forceEngine: engine,
          onDiag,
          captions: { cuesByClip, style: { size: 'M', position: 'bottom' } },
        },
        () => {},
      )
      const duration = await loadDuration(r.url)
      URL.revokeObjectURL(r.url)

      const deltaMs = Math.round(Math.abs(duration - lastCueEnd) * 1000)
      const ok = deltaMs <= 150
      log(
        `  ${ok ? '✓' : '✗'} ${engine} (${join.path}): last cue ends ${lastCueEnd.toFixed(3)}s, video ${duration.toFixed(3)}s → Δ ${deltaMs}ms${ok ? '' : '  ← >150ms'}`,
      )
      out[engine] = { ok, deltaMs, lastCueEnd, duration, joinPath: join.path, captionsBurned: r.captionsBurned }
    } catch (err) {
      log(`  ✗ ${engine}: ${err?.message || err}`)
      out[engine] = { ok: false, error: err?.message || String(err) }
    }
  }
  return out
}

/**
 * Record a synthetic "already edited" video: hard cuts at KNOWN times, with
 * gentle motion inside each shot so the rolling-median baseline is realistic
 * rather than degenerately zero.
 */
async function makeEditedTestVideo(shotLengths, w = 640, h = 360) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')

  // Distinct lightness per shot — a cut has to move luma, not just hue.
  const lightness = [14, 76, 32, 90, 46, 66, 22, 82]
  const bounds = []
  let acc = 0
  for (const len of shotLengths) {
    acc += len
    bounds.push(acc)
  }
  const total = acc

  // Video-only stream — must NOT request an audio codec or MediaRecorder stalls
  // waiting for a track that will never arrive.
  const videoOnly = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp8', 'video/webm']
  const mime = videoOnly.find((m) => MediaRecorder.isTypeSupported?.(m)) || 'video/webm'
  const rec = new MediaRecorder(canvas.captureStream(30), {
    mimeType: mime,
    videoBitsPerSecond: 3_000_000,
  })
  const chunks = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const stopped = new Promise((r) => (rec.onstop = r))

  let raf = 0
  const t0 = performance.now()
  const draw = () => {
    const t = (performance.now() - t0) / 1000
    let shot = 0
    while (shot < bounds.length - 1 && t >= bounds[shot]) shot++
    const L = lightness[shot % lightness.length]
    ctx.fillStyle = `hsl(${shot * 47} 12% ${L}%)`
    ctx.fillRect(0, 0, w, h)
    // small in-shot movement → a non-zero baseline diff, like real footage
    ctx.fillStyle = `hsl(${shot * 47} 60% ${Math.min(95, L + 18)}%)`
    ctx.beginPath()
    ctx.arc(w / 2 + Math.sin(t * 2.2) * w * 0.18, h / 2 + Math.cos(t * 1.7) * h * 0.12, 26, 0, Math.PI * 2)
    ctx.fill()
    raf = requestAnimationFrame(draw)
  }
  draw()
  rec.start()
  await new Promise((r) => setTimeout(r, total * 1000 + 250))
  rec.stop()
  cancelAnimationFrame(raf)
  await stopped

  const type = (rec.mimeType.split(';')[0] || 'video/webm').trim()
  const blob = new Blob(chunks, { type })
  return new File([blob], `edited.${type.includes('mp4') ? 'mp4' : 'webm'}`, { type })
}

/**
 * Cut detection is the load-bearing part of style profiles — if it is off by 2×,
 * every number in the profile is fiction. Assert against a video whose shot
 * lengths we chose.
 */
async function styleProfileCheck(log) {
  const shotLengths = [1.5, 2.0, 1.0, 2.5, 1.2, 1.8]
  const trueCuts = shotLengths.length - 1
  const sorted = [...shotLengths].sort((x, y) => x - y)
  const trueMedian = (sorted[2] + sorted[3]) / 2

  log(`  Building a synthetic edit: ${shotLengths.length} shots, ${trueCuts} cuts, ${shotLengths.reduce((s, n) => s + n, 0).toFixed(1)}s`)
  const file = await makeEditedTestVideo(shotLengths)
  log(`  Recorded ${(file.size / 1024).toFixed(0)}KB (${file.type}); scanning at 4fps…`)

  let lastPct = -1
  const a = await analyzeEditedVideo(file, (p) => {
    if (p.pct >= lastPct + 25) {
      lastPct = p.pct
      log(`    ${p.msg}`)
    }
  })
  const detected = a.cutCount + a.transitionCount

  const cutTol = Math.max(1, trueCuts * 0.15)
  const cutOk = Math.abs(detected - trueCuts) <= cutTol
  const detectedMedian = median(a.shotLengths)
  const medTol = trueMedian * 0.2
  const medOk = Math.abs(detectedMedian - trueMedian) <= medTol

  log(
    `  ${cutOk ? '✓' : '✗'} cuts: detected ${detected}, actual ${trueCuts} (${a.cutCount} hard, ${a.transitionCount} transition) — tolerance ±${cutTol.toFixed(1)}`,
  )
  log(
    `  ${medOk ? '✓' : '✗'} median shot: detected ${detectedMedian.toFixed(2)}s, actual ${trueMedian.toFixed(2)}s — tolerance ±${medTol.toFixed(2)}s`,
  )
  log(`  confidence ${a.confidence.toFixed(2)} · shots ${a.shotLengths.map((n) => n.toFixed(1)).join(', ')}`)

  let profileLine = ''
  try {
    const p = buildProfile([a], 'Smoke style')
    profileLine = describeProfile(p)
    log(`  profile: ${profileLine}`)
  } catch (e) {
    log(`  ✗ buildProfile: ${e.message}`)
  }

  return { ok: cutOk && medOk, detected, trueCuts, detectedMedian, trueMedian, confidence: a.confidence }
}

function median(xs) {
  if (!xs?.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Selection math at three scales, with no footage and no render — pure planner.
 *
 * This is the check that the old flat "20% of footage, minimum 60s" never could
 * have passed: a 15-second clip cannot yield 60 seconds, so selection chased a
 * target it could not reach and returned a single 3-second fragment. Each case
 * asserts the OUTPUT duration, because that is what the user watches.
 */
export function planScaleCheck(log = () => {}) {
  // Synthetic analysis, not null: with no analysis every body candidate scores
  // identically on position alone, they all tie, and mergeAbutting folds the
  // whole clip into one block — a shape no real footage produces. Varying the
  // audio and motion baselines gives selection something to actually choose
  // between, which is what is under test.
  const fakeAnalysis = (clips) => {
    const A = {}
    for (const c of clips) {
      const audio = []
      const motion = []
      for (let t = 0; t < c.duration; t += 0.25) {
        audio.push({ t: +t.toFixed(2), level: 0.45 + 0.35 * Math.sin(t * 0.9) * Math.cos(t * 0.13) })
      }
      for (let t = 0; t < c.duration; t += 0.5) {
        motion.push({ t: +t.toFixed(2), score: 0.2 + 0.15 * Math.sin(t * 0.4 + 1) })
      }
      A[c.id] = {
        audio: { hasAudio: true, energy: 0.45, windows: audio, silences: [], loudestAt: 0 },
        motion: { windows: motion },
        motionAvg: 0.2,
        lumaAvg: 0.52,
        contrastAvg: 0.48,
      }
    }
    return A
  }

  const cases = [
    {
      name: '1 clip · 15s',
      clips: [{ id: 'a', name: 'short-a.mp4', duration: 15, width: 1280, height: 720 }],
      expect: { min: 10, max: 14, minSegs: 1, maxSegs: 2 },
    },
    {
      name: '3 clips · 15s each',
      clips: [1, 2, 3].map((i) => ({
        id: `c${i}`,
        name: `short-${i}.mp4`,
        duration: 15,
        width: 1280,
        height: 720,
      })),
      expect: { min: 25, max: 38 },
    },
    {
      name: '1 clip · 10min',
      clips: [{ id: 'long', name: 'long.mp4', duration: 600, width: 1280, height: 720 }],
      expect: { min: 120, max: 150 },
    },
  ]

  const results = []
  for (const c of cases) {
    const footage = c.clips.reduce((a, x) => a + x.duration, 0)
    let row
    try {
      const plan = mockPlan(c.clips, 'a vlog', fakeAnalysis(c.clips), null)
      const out = plan.segments.reduce((a, s2) => a + (s2.end - s2.start), 0)
      const segs = plan.segments.length
      const target = resolveTargetDuration('a vlog', c.clips)
      const durOk = out >= c.expect.min && out <= c.expect.max
      const segOk =
        (c.expect.minSegs == null || segs >= c.expect.minSegs) &&
        (c.expect.maxSegs == null || segs <= c.expect.maxSegs)
      row = { name: c.name, ok: durOk && segOk, out, segs, target, footage, durOk, segOk }
    } catch (err) {
      row = { name: c.name, ok: false, error: err?.message || String(err), footage }
    }
    results.push(row)

    if (row.error) {
      log(`  ✗ ${c.name}: ${row.error}`)
      continue
    }
    const segTxt =
      c.expect.minSegs == null
        ? `${row.segs} segments`
        : `${row.segs} segments (expect ${c.expect.minSegs}-${c.expect.maxSegs})`
    log(
      `  ${row.ok ? '✓' : '✗'} ${c.name}: kept ${row.out.toFixed(1)}s of ${footage}s ` +
        `(${Math.round((row.out / footage) * 100)}%) — expect ${c.expect.min}-${c.expect.max}s · ${segTxt}`,
    )
    log(
      `      keep ratio ${keepRatioFor(footage).toFixed(2)} · target ${row.target.toFixed(1)}s` +
        `${row.durOk ? '' : '  ← duration out of range'}${row.segOk ? '' : '  ← segment count out of range'}`,
    )
  }

  const ok = results.every((r) => r.ok)
  log(`  ${ok ? '✓' : '✗'} selection scale: ${results.filter((r) => r.ok).length}/${results.length} cases`)
  return { ok, cases: results }
}

/**
 * @param {(line:string)=>void} log
 * @param {(d:object)=>void} [onDiag]
 * @returns {Promise<{ok:boolean, results:object, mime:string, isMp4:boolean}>}
 */
export async function runSmokeTest(log = () => {}, onDiag) {
  if (typeof MediaRecorder === 'undefined') {
    log('✗ MediaRecorder is unavailable in this browser — running the planner checks only')
    const scaleOnly = planScaleCheck(log)
    return { ok: false, results: { planScale: scaleOnly }, mime: '', isMp4: false }
  }

  // Selection scale first — it is pure math, needs no recording, and it is the
  // check that fails loudest when the keep ratio is retuned.
  log('── planner: selection scale ──')
  let scaleCheck = { ok: false }
  try {
    scaleCheck = planScaleCheck(log)
  } catch (e) {
    log(`  ✗ ${e?.message || e}`)
  }

  // Style-profile cut detection runs next: it is independent of the render
  // pipeline, and recording a fresh clip is more reliable before several
  // encoders have been spun up and torn down in this page.
  log('── style profile: cut detection accuracy ──')
  let styleCheck = { ok: false }
  try {
    styleCheck = await styleProfileCheck(log)
  } catch (e) {
    log(`  ✗ ${e?.message || e}`)
  }

  log(`Recording 2 test clips (requested ${pickMime()})…`)
  const a = await makeClip({ name: 'toneA', freq: 440, color: '#09F6FF' })
  const b = await makeClip({ name: 'toneB', freq: 880, color: '#FF2566' })

  const mime = a.mimeType || b.mimeType || ''
  log(`MediaRecorder produced: ${mime}  (A ${(a.file.size / 1024).toFixed(0)}KB · B ${(b.file.size / 1024).toFixed(0)}KB)`)

  const isMp4 = /mp4/i.test(mime) || a.file.name.endsWith('.mp4')
  if (!isMp4) {
    log('⚠️  WebCodecs path cannot be tested — mp4box cannot demux WebM. FFmpeg fallback will run instead.')
  }

  const { clips, errors } = await probeAll([a.file, b.file])
  for (const e of errors) log(`⚠ probe: ${e.name}: ${e.message}`)
  if (clips.length < 2) {
    log('✗ probe produced fewer than 2 clips')
    return { ok: false, results: {}, mime, isMp4 }
  }
  log(`Probed: ${clips.map((c) => `${c.name} ${c.duration.toFixed(2)}s ${c.width}×${c.height}`).join(' · ')}`)

  const analysis = await analyzeAll(clips, () => {})
  const plan = await generateEditPlan(clips, 'snappy 5 second test montage', analysis, null)
  const planLen = plan.segments.reduce((s, x) => s + (x.end - x.start), 0)
  log(`Plan: ${plan.segments.length} segments, ${planLen.toFixed(2)}s`)

  const results = {}
  for (const engine of ['webcodecs', 'ffmpeg']) {
    log(`── forceEngine: ${engine} ──`)
    results[engine] = await runEngine(engine, clips, plan, onDiag, log)
  }

  // Diagnostic run: same clips, but force every segment to a hard cut so there
  // is zero transition-offset math. If this delta ≈ 0, the overshoot lives in
  // transition offsets; if it stays ~90ms it is muxer/encoder timebase.
  log('── forceEngine: webcodecs (cut-only) ──')
  const cutPlan = { ...plan, segments: plan.segments.map((s) => ({ ...s, transition: 'cut' })) }
  results['webcodecs-cut'] = await runEngine('webcodecs', clips, cutPlan, onDiag, log)

  log('── caption timeline (3 segments, fade transitions) ──')
  const capCheck = await captionTimelineCheck(clips, onDiag, log)
  results.captionTimeline = capCheck
  results.styleProfile = styleCheck
  results.planScale = scaleCheck


  clips.forEach((c) => URL.revokeObjectURL(c.url))

  log('── summary ──')
  const line = (r) =>
    r.error
      ? `❌ ${r.method} — ${r.error}`
      : `${r.ok ? '✅' : '❌'} ${r.method} — ${r.secs}s, sync ${r.syncTxt}`
  log(line(results.webcodecs))
  log(line(results.ffmpeg))

  log('── duration deltas ──')
  const dline = (label, r) =>
    log(`  ${label}: ${r?.error ? 'n/a (' + r.error + ')' : (r.durDeltaMs >= 0 ? '+' : '') + r.durDeltaMs + 'ms'}`)
  dline('webcodecs (as-planned)', results.webcodecs)
  dline('webcodecs (cut-only)  ', results['webcodecs-cut'])
  dline('ffmpeg                ', results.ffmpeg)

  // FFmpeg must pass. WebCodecs must pass only if the recording was actually MP4
  // (otherwise there is nothing for mp4box to demux — not a real failure).
  const capOk = !!capCheck.ffmpeg?.ok && (isMp4 ? !!capCheck.webcodecs?.ok : true)
  const overallOk =
    !!results.ffmpeg?.ok &&
    (isMp4 ? !!results.webcodecs?.ok : true) &&
    capOk &&
    !!styleCheck.ok &&
    !!scaleCheck.ok
  log(overallOk ? '✅ SMOKE TEST PASSED' : '❌ SMOKE TEST FAILED')

  return { ok: overallOk, results, mime, isMp4 }
}
