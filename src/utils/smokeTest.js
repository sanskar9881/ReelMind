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
import { detectBeats, buildDuckingCurve, gainAt, snapCutsToBeats, MUSIC } from './music.js'
import { TERMINAL_PUNCT, detectScript, recommendTier } from './transcribe.js'
import { findRetakes } from './retakes.js'
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
 * The music bed, through a real render, on both engines.
 *
 * The maths check above proves the curve is right; this proves the mix reaches
 * the file without moving anything. The assertion that matters is that adding
 * music does NOT change the duration — the bed is built to the output length,
 * so a longer file means it stretched the timeline and A/V sync went with it.
 */
async function musicRenderCheck(clips, onDiag, log) {
  const [a, b] = clips
  const plan = {
    title: 'music mix check',
    reasoning: '',
    music: 'none',
    segments: [
      { clip: a.name, clipId: a.id, start: 0.2, end: 1.8, transition: 'cut', role: 'hook' },
      { clip: b.name, clipId: b.id, start: 0.2, end: 1.8, transition: 'cut', role: 'outro' },
    ],
  }

  // A real AudioBuffer, because renderMusicBed schedules it on a real graph.
  const rate = 44100
  const seconds = 6
  const n = rate * seconds
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext
  const track = new OAC(2, n, rate).createBuffer(2, n, rate)
  for (let c = 0; c < 2; c++) {
    const d = track.getChannelData(c)
    for (let i = 0; i < n; i++) {
      const t = i / rate
      const phase = t % (60 / 128)
      d[i] = 0.1 * Math.sin(2 * Math.PI * 330 * t) + (phase < 0.04 ? 0.6 * Math.exp(-phase * 90) : 0)
    }
  }

  const out = {}
  for (const engine of ['webcodecs', 'ffmpeg']) {
    try {
      const silent = await render(clips, plan, { resolution: '720p', forceEngine: engine, onDiag }, () => {})
      const silentDur = await loadDuration(silent.url)
      URL.revokeObjectURL(silent.url)

      const withMusic = await render(
        clips,
        plan,
        {
          resolution: '720p',
          forceEngine: engine,
          onDiag,
          music: { track, gain: 0.5, ducking: true, analysis: null, transcripts: null },
        },
        () => {},
      )
      const musicDur = await loadDuration(withMusic.url)
      const report = await verifyRender(withMusic.url, withMusic)
      URL.revokeObjectURL(withMusic.url)

      const deltaMs = Math.round(Math.abs(musicDur - silentDur) * 1000)
      const audible = report.checks.find((c) => /audio/i.test(c.name))
      const ok = deltaMs <= 120 && withMusic.music?.mixed === true && (!audible || audible.passed)
      log(
        `  ${ok ? '✓' : '✗'} ${engine}: ${silentDur.toFixed(3)}s silent → ${musicDur.toFixed(3)}s with music (Δ ${deltaMs}ms)` +
          `, bed ${withMusic.music?.seconds ?? 'n/a'}s${audible ? `, ${audible.detail}` : ''}${ok ? '' : '  ← music changed the timeline'}`,
      )
      out[engine] = { ok, deltaMs, silentDur, musicDur, music: withMusic.music || null }
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
 * A click track at a known tempo, as an AudioBuffer-shaped object. Real music
 * is not available to a test, and a synthetic pulse is the only way to assert
 * that the detector finds the tempo we actually put there.
 */
function makeClickTrack({ bpm = 128, seconds = 20, rate = 44100, ambient = false }) {
  const n = Math.round(seconds * rate)
  const d = new Float32Array(n)
  const period = 60 / bpm
  for (let i = 0; i < n; i++) {
    const t = i / rate
    d[i] = 0.05 * Math.sin(2 * Math.PI * 220 * t) // sustained pad under everything
    if (ambient) {
      d[i] += 0.15 * Math.sin(2 * Math.PI * 0.3 * t) * Math.sin(2 * Math.PI * 330 * t)
    } else {
      const phase = t % period
      if (phase < 0.04) d[i] += 0.8 * Math.exp(-phase * 90) * Math.sin(2 * Math.PI * 1400 * t)
    }
  }
  return {
    sampleRate: rate,
    length: n,
    numberOfChannels: 1,
    duration: seconds,
    getChannelData: () => d,
  }
}

/**
 * Devanagari text handling, end to end through the pure text stages.
 *
 * Every one of these was silently broken before Hindi and Marathi were
 * supported, and all of them fail the same way: no error, just empty or wrong
 * results that look like a legitimately quiet clip.
 */
export function i18nCheck(log = () => {}) {
  const checks = []
  const add = (ok, msg) => {
    checks.push({ ok, msg })
    log(`  ${ok ? '✓' : '✗'} ${msg}`)
  }

  add(
    TERMINAL_PUNCT.test('हैं।') && TERMINAL_PUNCT.test('गया॥') && TERMINAL_PUNCT.test('done.') && !TERMINAL_PUNCT.test('यह'),
    'danda । and double danda ॥ end a sentence, a bare word does not',
  )

  // Sentence splitting: the danda must actually produce three sentences.
  const hindi = 'नमस्ते दोस्तों। आज हम घूमने जा रहे हैं। बहुत मज़ा आएगा।'
  const words = hindi.split(' ').map((t, i) => ({ text: t, start: i * 0.4, end: i * 0.4 + 0.35 }))
  let count = 0
  for (const w of words) if (TERMINAL_PUNCT.test(w.text)) count++
  add(count === 3, `Hindi paragraph splits into ${count} sentences (expect 3) — [.!?] alone gives 1`)

  add(
    detectScript('नमस्ते दोस्तों, आज हम घूमने जा रहे हैं।') === 'devanagari' &&
      detectScript('Hello friends, today we are going out.') === 'latin',
    'script detection separates Devanagari from Latin',
  )
  add(
    detectScript('आज हम camera setup कर रहे हैं और bag पैक हो गया है।') === 'mixed',
    'code-mixed Hinglish reads as "mixed", so it never raises a false script-mismatch warning',
  )

  // Retake detection tokenises; the old [^a-z] strip emptied every Hindi token.
  const groups = findRetakes(
    [
      { text: 'आज हम पुणे जा रहे हैं।', start: 0, end: 2, words: [] },
      { text: 'आज हम पुणे जा रहे हैं।', start: 2.5, end: 4.5, words: [] },
      { text: 'वहाँ का खाना बहुत अच्छा है।', start: 5, end: 7, words: [] },
    ],
    {},
  )
  add(
    groups.length === 1 && groups[0].takes.length === 2,
    `retake detection finds ${groups.length} group of ${groups[0]?.takes.length ?? 0} takes in Hindi (expect 1 of 2)`,
  )

  add(recommendTier('mr') === 'accurate' && recommendTier('hi') === 'fast', 'Marathi recommends the Accurate model, Hindi does not')

  const ok = checks.every((c) => c.ok)
  log(`  ${ok ? '✓' : '✗'} Devanagari handling: ${checks.filter((c) => c.ok).length}/${checks.length} checks`)
  return { ok, checks }
}

/**
 * Music maths: tempo, honest confidence, ducking and beat snapping. Pure DSP
 * and plain data, so this runs with no MediaRecorder, no encoder and no files.
 *
 * The confidence assertions matter as much as the tempo one. A detector that
 * returns a beat grid for an ambient pad is worse than one that returns
 * nothing, because the UI will offer to snap every cut to that noise.
 */
export function musicMathCheck(log = () => {}) {
  const checks = []
  const add = (ok, msg) => {
    checks.push({ ok, msg })
    log(`  ${ok ? '✓' : '✗'} ${msg}`)
  }

  for (const bpm of [90, 128]) {
    const r = detectBeats(makeClickTrack({ bpm, seconds: 20 }))
    const errPct = Math.abs(r.bpm - bpm) / bpm
    add(
      errPct <= 0.03 && r.confidence >= MUSIC.lowConfidence,
      `${bpm} BPM click: detected ${r.bpm} BPM (${(errPct * 100).toFixed(1)}% error), confidence ${r.confidence} — tolerance 3%, confidence ≥ ${MUSIC.lowConfidence}`,
    )
    // Beats must land ON the pulse, not half a window early.
    const period = 60 / bpm
    const worst = r.beats.slice(0, 12).reduce((m, b) => {
      const off = Math.abs((b % period) - (b % period > period / 2 ? period : 0))
      return Math.max(m, off)
    }, 0)
    add(worst <= 0.04, `${bpm} BPM beat placement: worst offset ${(worst * 1000).toFixed(0)}ms from the true grid — tolerance 40ms`)
  }

  const amb = detectBeats(makeClickTrack({ ambient: true, seconds: 20 }))
  add(
    amb.confidence < MUSIC.lowConfidence,
    `ambient pad: confidence ${amb.confidence} — must stay under ${MUSIC.lowConfidence}, and it reports so rather than inventing a grid`,
  )

  // Ducking: gain must sit at duckGain across speech and return to 1 outside it.
  const plan = {
    segments: [
      { clipId: 'a', clip: 'a.mp4', start: 0, end: 10, transition: 'cut' },
      { clipId: 'b', clip: 'b.mp4', start: 0, end: 10, transition: 'cut' },
    ],
  }
  const transcripts = { a: { sentences: [{ start: 1, end: 4, text: 'hello', words: [] }] } }
  const analysis = {
    b: { duration: 10, kind: 'talking', audio: { hasAudio: true, silences: [{ start: 0, end: 2 }, { start: 6, end: 10 }] } },
  }
  const curve = buildDuckingCurve(plan, analysis, transcripts, { totalSeconds: 20 })
  const duckedMid = gainAt(curve, 2.5)
  const openMid = gainAt(curve, 8)
  const ramped = gainAt(curve, 0.85) // mid-ramp: between the two, never a step
  add(
    Math.abs(duckedMid - MUSIC.duckGain) < 0.01,
    `duck under speech: gain ${duckedMid.toFixed(2)} at 2.5s (inside speech) — expect ${MUSIC.duckGain}`,
  )
  add(openMid > 0.99, `full level with no speech: gain ${openMid.toFixed(2)} at 8s — expect 1.00`)
  add(
    ramped > MUSIC.duckGain + 0.05 && ramped < 0.99,
    `ramp is gradual: gain ${ramped.toFixed(2)} mid-ramp at 0.85s — a step here is the pumping artefact`,
  )
  add(
    curve.source === 'transcript',
    `speech source: "${curve.source}" — the transcript wins when there is one`,
  )
  // The clip with no transcript still ducks, from the analyzer's silences.
  const secondRange = curve.ranges.find((r) => r.start >= 10)
  add(!!secondRange, `analyzer fallback: ${curve.ranges.length} ranges, including one past 10s from silence detection alone`)

  // Snapping: never further than maxShift, whatever the beat grid says.
  const beats = Array.from({ length: 60 }, (_, i) => +(i * 0.5).toFixed(3))
  const snapPlan = {
    segments: [
      { clipId: 'a', clip: 'a.mp4', start: 0, end: 3.1, transition: 'cut' },
      { clipId: 'b', clip: 'b.mp4', start: 2, end: 5.4, transition: 'cut' },
      { clipId: 'c', clip: 'c.mp4', start: 0, end: 9, transition: 'cut' },
    ],
  }
  const snapped = snapCutsToBeats(snapPlan, beats, { clips: [] })
  const maxMove = snapped.shifts.reduce((m, x) => Math.max(m, Math.abs(x)), 0)
  add(
    snapped.moved > 0 && maxMove <= 0.25,
    `snap to beat: moved ${snapped.moved}/${snapped.considered} boundaries, largest ${(maxMove * 1000).toFixed(0)}ms — cap is 250ms`,
  )
  const far = snapCutsToBeats(snapPlan, [0, 7.9, 30], { clips: [] })
  add(
    far.moved === 0 && far.skipped.tooFar === far.considered,
    `distant beats refused: ${far.skipped.tooFar}/${far.considered} left alone rather than dragged to a beat that is not there`,
  )
  const guarded = snapCutsToBeats(snapPlan, beats, {
    clips: [],
    transcripts: { b: { sentences: [{ start: 1.2, end: 4, text: 'x', words: [{ text: 'x', start: 1.2, end: 4 }] }] } },
  })
  add(
    guarded.skipped.sentence > 0,
    `word guard: ${guarded.skipped.sentence} boundary left alone rather than cutting into a spoken word`,
  )

  const ok = checks.every((c) => c.ok)
  log(`  ${ok ? '✓' : '✗'} music maths: ${checks.filter((c) => c.ok).length}/${checks.length} checks`)
  return { ok, checks }
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
    const musicOnly = musicMathCheck(log)
    return { ok: false, results: { planScale: scaleOnly, musicMath: musicOnly }, mime: '', isMp4: false }
  }

  // Selection scale first — it is pure math, needs no recording, and it is the
  // check that fails loudest when the keep ratio is retuned.
  log('── i18n: Devanagari text handling ──')
  let i18n = { ok: false }
  try {
    i18n = i18nCheck(log)
  } catch (e) {
    log(`  ✗ ${e?.message || e}`)
  }

  log('── music: tempo, ducking, beat snapping ──')
  let musicCheck = { ok: false }
  try {
    musicCheck = musicMathCheck(log)
  } catch (e) {
    log(`  ✗ ${e?.message || e}`)
  }

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

  log('── music: bed through a real render ──')
  const musicRender = await musicRenderCheck(clips, onDiag, log)
  results.musicRender = musicRender

  log('── caption timeline (3 segments, fade transitions) ──')
  const capCheck = await captionTimelineCheck(clips, onDiag, log)
  results.captionTimeline = capCheck
  results.styleProfile = styleCheck
  results.planScale = scaleCheck
  results.musicMath = musicCheck
  results.i18n = i18n


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
  const musicOk = !!musicRender.ffmpeg?.ok && (isMp4 ? !!musicRender.webcodecs?.ok : true)
  const overallOk =
    !!results.ffmpeg?.ok &&
    (isMp4 ? !!results.webcodecs?.ok : true) &&
    capOk &&
    !!styleCheck.ok &&
    !!scaleCheck.ok &&
    !!musicCheck.ok &&
    !!i18n.ok &&
    musicOk
  log(overallOk ? '✅ SMOKE TEST PASSED' : '❌ SMOKE TEST FAILED')

  return { ok: overallOk, results, mime, isMp4 }
}
