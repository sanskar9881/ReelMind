// videoProcessor.js — two-pass in-browser render with FFmpeg.wasm.

import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import { checkWebCodecsSupport } from './webcodecs/support.js'
import { renderWithWebCodecs } from './webcodecs/renderer.js'
import { remapToOutputTimeline, toSRT } from './captions.js'

// The ESM core, not the UMD one: @ffmpeg/ffmpeg 0.12 always spawns a
// `type: "module"` worker, where `importScripts` doesn't exist, so its loader
// falls through to `import(coreURL)` — which needs a real ES module with a
// `default` export. The UMD build has neither and fails with
// "failed to import ffmpeg-core.js".
const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm'

const RES = {
  '720p': { w: 1280, h: 720 },
  '1080p': { w: 1920, h: 1080 },
}

let _ffmpeg = null
let _loading = null

/**
 * Lazily create + load a single FFmpeg instance. The ~30MB core download
 * happens once per session; subsequent calls return the cached instance.
 */
export async function loadEngine(onProgress = () => {}) {
  if (_ffmpeg && _ffmpeg.loaded) return _ffmpeg
  if (_loading) return _loading

  _loading = (async () => {
    const ffmpeg = new FFmpeg()
    ffmpeg.on('log', ({ message }) => {
      // Uncomment for debugging: console.debug('[ffmpeg]', message)
      void message
    })

    onProgress({ stage: 'engine', pct: 0, msg: 'Downloading FFmpeg core (~30MB, one time)…' })

    const [coreURL, wasmURL] = await Promise.all([
      toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    ])

    onProgress({ stage: 'engine', pct: 60, msg: 'Starting FFmpeg…' })
    await ffmpeg.load({ coreURL, wasmURL })
    onProgress({ stage: 'engine', pct: 100, msg: 'Engine ready.' })

    _ffmpeg = ffmpeg
    return ffmpeg
  })()

  try {
    return await _loading
  } finally {
    _loading = null
  }
}

// @ffmpeg/core@0.12.6 DOES ship libass (its logs report FriBidi + HarfBuzz), but
// it has no fontconfig and the wasm FS is empty, so the subtitles filter loads
// and then draws nothing: "can't find selected font provider". Handing libass a
// font directory via `fontsdir=` is what makes burn-in actually work. DejaVu is
// the conventional libass fallback face and has broad glyph coverage.
const CAPTION_FONT_URL = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf'
const CAPTION_FONT_DIR = '/fonts'
const CAPTION_FONT_FILE = `${CAPTION_FONT_DIR}/DejaVuSans-Bold.ttf`
const CAPTION_FONT_NAME = 'DejaVu Sans Bold'
let _captionFont = null

/** Install the caption face into the FFmpeg FS once per engine instance. */
async function ensureCaptionFont(ffmpeg) {
  if (_captionFont) return _captionFont
  _captionFont = (async () => {
    const res = await fetch(CAPTION_FONT_URL)
    if (!res.ok) throw new Error(`caption font fetch failed (${res.status})`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    await ffmpeg.createDir(CAPTION_FONT_DIR).catch(() => {})
    await ffmpeg.writeFile(CAPTION_FONT_FILE, bytes)
    return true
  })()
  try {
    return await _captionFont
  } catch (err) {
    _captionFont = null // let the next render retry the fetch
    throw err
  }
}

const pad4 = (n) => String(n).padStart(3, '0')

const clipKey = (r) => (r.clipId != null ? `id:${r.clipId}` : `name:${r.clip ?? ''}`)

/**
 * Coalesce exclude ranges: sort by start, then fuse any two on the SAME clip
 * whose gap is under `gapThreshold`. A 0.1s survivor wedged between two removed
 * fillers is a glitch, not an edit — so remove it with them. Pure + testable.
 *
 * @param {{clipId?:string,clip?:string,start:number,end:number}[]} ranges
 * @param {number} [gapThreshold]  seconds
 * @returns {{clipId?:string,clip?:string,start:number,end:number}[]}
 */
export function coalesceRanges(ranges, gapThreshold = 0.12) {
  const list = (ranges || [])
    .filter((r) => r && Number.isFinite(+r.start) && Number.isFinite(+r.end) && +r.end > +r.start)
    .map((r) => ({ ...r, start: +r.start, end: +r.end }))
    .sort((a, b) => clipKey(a).localeCompare(clipKey(b)) || a.start - b.start || a.end - b.end)

  if (list.length < 2) return list

  const out = [list[0]]
  for (let i = 1; i < list.length; i++) {
    const cur = list[i]
    const last = out[out.length - 1]
    if (clipKey(cur) === clipKey(last) && cur.start - last.end < gapThreshold) {
      last.end = Math.max(last.end, cur.end)
    } else {
      out.push(cur)
    }
  }
  return out
}

/**
 * Cut `cuts` (filler / struck-sentence / retake ranges) out of one segment,
 * returning the surviving [start,end] pieces. A piece shorter than `minLen` is
 * merged into whichever neighbour is longer; a lone tiny piece is dropped — a
 * sub-quarter-second survivor reads as a glitch, not an edit.
 */
function splitAroundCuts(seg, cuts, minLen = 0.25) {
  const inside = (cuts || [])
    .filter((c) => (c.clipId != null ? c.clipId === seg.clipId : c.clip === seg.clip))
    .map((c) => [Math.max(seg.start, +c.start), Math.min(seg.end, +c.end)])
    .filter(([a, b]) => b - a > 0.02)
    .sort((a, b) => a[0] - b[0])

  if (!inside.length) return [{ start: seg.start, end: seg.end }]

  const pieces = []
  let cursor = seg.start
  for (const [a, b] of inside) {
    if (a > cursor) pieces.push({ start: cursor, end: a })
    cursor = Math.max(cursor, b)
  }
  if (cursor < seg.end) pieces.push({ start: cursor, end: seg.end })

  const dur = (p) => p.end - p.start

  let i = 0
  while (i < pieces.length) {
    if (dur(pieces[i]) >= minLen) {
      i++
      continue
    }
    const prev = pieces[i - 1]
    const next = pieces[i + 1]
    if (!prev && !next) {
      pieces.splice(i, 1) // lone tiny piece — drop it
      break
    }
    if (prev && (!next || dur(prev) >= dur(next))) {
      prev.end = pieces[i].end
      pieces.splice(i, 1)
      i = Math.max(0, i - 1) // re-check the grown neighbour
    } else {
      next.start = pieces[i].start
      pieces.splice(i, 1) // re-check the grown `next`, now at index i
    }
  }
  return pieces
}

/**
 * Two-pass render.
 * PASS 1: trim + normalize every render unit to its own part file (identical
 *         codec, resolution, fps and audio layout). When plan.removeFillers or
 *         plan.excludeRanges is set, each segment is first split around those
 *         spans so they're dropped, tiny leftovers merged into a neighbour.
 * PASS 2: concat-demux the parts with -c copy.
 *
 * @param {object[]} clips  library clips ({id,name,file,duration,...})
 * @param {object}   plan   validated plan ({segments:[{clipId,start,end,...}]})
 * @param {object}   opts   { resolution: '720p' | '1080p' }
 * @param {(p:{stage,pct,msg})=>void} onProgress
 * @returns {Promise<{url:string,size:number}>}
 */
export async function renderVideo(clips, plan, opts = {}, onProgress = () => {}) {
  const { w, h } = RES[opts.resolution] || RES['720p']
  const segments = plan.segments || []
  if (!segments.length) throw new Error('Nothing to render — the plan has no segments.')

  const ffmpeg = await loadEngine(onProgress)
  const byId = new Map(clips.map((c) => [c.id, c]))

  // When filler / struck-sentence / retake removal is active, a single plan
  // segment can become several render units (the spans between the cuts).
  const cuts =
    plan.removeFillers || plan.excludeRanges?.length || plan.fillerRanges?.length
      ? coalesceRanges([...(plan.fillerRanges || []), ...(plan.excludeRanges || [])])
      : []

  const units = []
  for (const seg of segments) {
    const clip = byId.get(seg.clipId) || clips.find((c) => c.name === seg.clip)
    if (!clip) continue
    const pieces = cuts.length ? splitAroundCuts(seg, cuts) : [{ start: seg.start, end: seg.end }]
    for (const pc of pieces) {
      if (pc.end - pc.start < 0.1) continue
      units.push({ clip, start: pc.start, end: pc.end, transition: seg.transition, role: seg.role })
    }
  }
  if (!units.length) throw new Error('Nothing to render — every segment was cut away.')

  const totalSteps = units.length + 1 // parts + concat
  let step = 0
  let execProgress = 0

  const onExec = ({ progress }) => {
    execProgress = Math.max(0, Math.min(1, progress || 0))
    const overall = ((step + execProgress) / totalSteps) * 100
    onProgress({
      stage: step < units.length ? 'normalize' : 'concat',
      pct: Math.min(99, Math.round(overall)),
      msg:
        step < units.length
          ? `Normalizing segment ${step + 1} / ${units.length}…`
          : 'Stitching final cut…',
    })
  }
  ffmpeg.on('progress', onExec)

  const writtenSources = new Set() // clipId -> written once
  const sourceName = new Map() // clipId -> FS filename
  const partFiles = []

  try {
    // ---- PASS 1 -------------------------------------------------------------
    for (let i = 0; i < units.length; i++) {
      step = i
      execProgress = 0
      const seg = units[i]
      const clip = seg.clip

      if (!writtenSources.has(clip.id)) {
        const ext = (clip.name.match(/\.[a-z0-9]+$/i) || ['.mp4'])[0]
        const srcName = `src_${writtenSources.size}${ext}`
        onProgress({
          stage: 'normalize',
          pct: Math.round((i / totalSteps) * 100),
          msg: `Loading "${clip.name}" into engine…`,
        })
        await ffmpeg.writeFile(srcName, await fetchFile(clip.file))
        writtenSources.add(clip.id)
        sourceName.set(clip.id, srcName)
      }

      const src = sourceName.get(clip.id)
      const part = `part_${pad4(i)}.mp4`
      const dur = Math.max(0.1, seg.end - seg.start)
      const vf = `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30`

      // Every part is a butt-join in the concat. Micro-fade the audio edges so
      // the splice doesn't click. Skip on parts too short to fade cleanly.
      const F = 0.015
      const af = dur < 0.06 ? null : `afade=t=in:st=0:d=${F},afade=t=out:st=${(dur - F).toFixed(3)}:d=${F}`

      // Real footage is a mix of clips with and without an audio track. Every
      // part file must end up with the SAME stream layout or Pass 2's `-c copy`
      // concat fails. Try mapping the clip's own audio (padded to video length);
      // if the clip has no audio stream that exec errors, so fall back to a
      // synthesized silent stereo track.
      //
      // A/V SYNC: use `-t <dur>` on the OUTPUT (not `-shortest`) so the part is
      // exactly `dur` seconds. `apad` guarantees the audio reaches `dur` before
      // `-t` trims it, so audio is never cut BELOW the video length.
      const dstArg = String(dur)
      const withRealAudio = [
        '-ss', String(seg.start),
        '-i', src,
        '-map', '0:v:0', '-map', '0:a:0',
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
        '-af', af ? `apad,${af}` : 'apad',
        '-t', dstArg,
        part,
      ]
      const withSilentAudio = [
        '-ss', String(seg.start),
        '-i', src,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-map', '0:v:0', '-map', '1:a:0',
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
        ...(af ? ['-af', af] : []),
        '-t', dstArg,
        part,
      ]

      // ffmpeg.exec resolves to an exit code (0 ok, non-zero on error), it does
      // not reject — so branch on the code, not a try/catch.
      let code
      try {
        code = await ffmpeg.exec(withRealAudio)
      } catch {
        code = 1
      }
      let usedSilent = false
      if (code !== 0) {
        await ffmpeg.deleteFile(part).catch(() => {})
        code = await ffmpeg.exec(withSilentAudio)
        usedSilent = true
        if (code !== 0) throw new Error(`Failed to normalize segment ${i + 1} ("${clip.name}").`)
      }
      partFiles.push(part)

      opts.onDiag?.({
        phase: 'ffmpeg-part',
        index: i,
        clip: clip.name,
        srcIn: +seg.start.toFixed(4),
        srcOut: +seg.end.toFixed(4),
        partDuration: +dur.toFixed(4),
        audio: usedSilent ? 'silent (synthesized)' : 'source',
      })
    }

    if (!partFiles.length) throw new Error('No segments could be normalized — check that the source clips are still loaded.')

    // ---- PASS 2 -----------------------------------------------------------
    step = units.length
    execProgress = 0
    const list = partFiles.map((p) => `file '${p}'`).join('\n') + '\n'
    await ffmpeg.writeFile('list.txt', new TextEncoder().encode(list))

    const srt = opts.captions?.srt
    let captionsBurned = false
    let captionsSkippedReason = null

    if (srt) {
      // Burn captions with libass. Timeline is already remapped to the concat
      // output, so no offset needed. Re-encode video (can't filter a -c copy).
      const st = opts.captions.style || {}
      const fontSize = st.size === 'S' ? 18 : st.size === 'L' ? 32 : 24
      const alignment = st.position === 'top' ? 6 : 2 // libass numpad anchors
      const marginV = Math.round((st.marginScale ?? 0.08) * 720)

      let fontOk = true
      try {
        await ensureCaptionFont(ffmpeg)
      } catch (err) {
        fontOk = false
        captionsSkippedReason = `Could not load the caption font (${err?.message || err}).`
      }

      if (fontOk) {
        await ffmpeg.writeFile('captions.srt', new TextEncoder().encode(srt))
        const style = `FontName=${CAPTION_FONT_NAME},FontSize=${fontSize},PrimaryColour=&Hffffff,OutlineColour=&H000000,Outline=2,Alignment=${alignment},MarginV=${marginV}`

        // exec() returns 0 even when the filter silently drew nothing, so the
        // log is the only truthful signal. libass emits `fontselect:` only once
        // it has actually resolved a face to draw with.
        const logged = []
        const tap = ({ message }) => logged.push(message)
        ffmpeg.on('log', tap)
        let code
        try {
          code = await ffmpeg.exec([
            '-f', 'concat', '-safe', '0', '-i', 'list.txt',
            '-vf', `subtitles=captions.srt:fontsdir=${CAPTION_FONT_DIR}:force_style='${style}'`,
            '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
            '-c:a', 'copy',
            'output.mp4',
          ])
        } catch {
          code = 1
        } finally {
          ffmpeg.off('log', tap)
        }

        const log = logged.join('\n')
        const hardFailure = /No such filter|Unable to parse|Error initializing|Error opening filters/i.test(log)
        const drewText = /fontselect:/i.test(log)
        if (code === 0 && !hardFailure && drewText) {
          captionsBurned = true
        } else {
          captionsSkippedReason = hardFailure
            ? 'The subtitles filter failed to initialise in this FFmpeg build.'
            : 'libass loaded but could not resolve a font face to draw with.'
        }
      }

      if (!captionsBurned) {
        console.warn(`[renderVideo] ${captionsSkippedReason} Rendering without burned-in captions.`)
        await ffmpeg.deleteFile('output.mp4').catch(() => {})
        await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'output.mp4'])
      }
    } else {
      await ffmpeg.exec([
        '-f', 'concat', '-safe', '0', '-i', 'list.txt',
        '-c', 'copy',
        'output.mp4',
      ])
    }

    const data = await ffmpeg.readFile('output.mp4')
    const blob = new Blob([data.buffer], { type: 'video/mp4' })
    onProgress({ stage: 'done', pct: 100, msg: 'Render complete.' })
    return {
      url: URL.createObjectURL(blob),
      size: blob.size,
      captionsBurned,
      ...(captionsSkippedReason ? { captionsSkippedReason } : {}),
    }
  } finally {
    ffmpeg.off('progress', onExec)
    // Free everything — browser memory is capped ~2-4GB and leaks crash the tab.
    const kill = async (name) => {
      try {
        await ffmpeg.deleteFile(name)
      } catch {
        /* not present */
      }
    }
    for (const name of sourceName.values()) await kill(name)
    for (const p of partFiles) await kill(p)
    await kill('list.txt')
    await kill('captions.srt')
    await kill('output.mp4')
  }
}

/**
 * Pre-split every segment around its filler / struck-sentence / retake ranges so
 * a renderer that has no cut logic of its own (the WebCodecs path) still drops
 * them. The FFmpeg path does its own splitting, so it keeps the original plan.
 */
export function applyCutRanges(plan) {
  const raw = [...(plan.fillerRanges || []), ...(plan.excludeRanges || [])]
  if (!raw.length) return plan
  const cuts = coalesceRanges(raw)

  const segments = []
  for (const seg of plan.segments) {
    for (const piece of splitAroundCuts(seg, cuts)) {
      if (piece.end - piece.start < 0.1) continue
      segments.push({ ...seg, start: piece.start, end: piece.end })
    }
  }
  const next = { ...plan, segments }
  delete next.fillerRanges
  delete next.excludeRanges
  delete next.retakeRanges
  delete next.removeFillers
  return next
}

/** Overlap consumed by one crossfaded boundary, and by a hard cut (none). */
export const XFADE_DURATION = 0.5
export const CUT_DURATION = 0

/**
 * Decide how a given engine will actually JOIN the plan's segments — before
 * anything is remapped against that timeline. Caption remapping and the
 * expected-duration calculation both read from here, so they can never disagree
 * with what the renderer does.
 *
 * The two engines genuinely differ:
 *  - WebCodecs composites crossfades on the canvas, so a non-cut boundary
 *    overlaps the previous segment and SHORTENS the timeline by XFADE_DURATION.
 *  - FFmpeg joins pre-normalised parts with the concat demuxer (`-c copy`).
 *    There is no xfade chain, so every boundary is a hard cut and the timeline
 *    is the plain sum of segment durations, whatever the plan asked for.
 *
 * If an xfade filter chain is ever added to the FFmpeg join, return
 * `{ path: 'xfade', transitionDuration: XFADE_DURATION }` for it here and both
 * the caption remap and the duration expectation follow automatically.
 *
 * @param {object} plan    the plan as it will be rendered (post applyCutRanges)
 * @param {'webcodecs'|'ffmpeg'} engine
 * @returns {{path:'concat'|'xfade', transitionDuration:number}}
 */
export function resolveJoinPath(plan, engine) {
  const segs = plan?.segments || []
  const anyTransition = segs.some((s, i) => i > 0 && s.transition && s.transition !== 'cut')
  if (engine === 'ffmpeg' || !anyTransition) {
    return { path: 'concat', transitionDuration: CUT_DURATION }
  }
  return { path: 'xfade', transitionDuration: XFADE_DURATION }
}

/**
 * How many shots (plan segments) and how many extra internal splices the cut
 * ranges introduce. `internalCuts` is the number of within-shot joins created by
 * filler / struck / retake removal — for the "Rendered N shots, M internal cuts"
 * readout.
 *
 * @param {object} plan
 * @param {{transitionDuration?:number}} [opts]  pullback per crossfaded
 *   boundary. Pass the value from resolveJoinPath() for the engine that will
 *   render, or totalDuration will describe a video nobody is going to produce.
 */
export function countCuts(plan, opts = {}) {
  const shots = plan?.segments?.length || 0
  const split = applyCutRanges(plan)
  const segs = split.segments || []
  const units = segs.length

  const td = opts.transitionDuration ?? XFADE_DURATION
  let totalDuration = 0
  segs.forEach((s, i) => {
    const len = Math.max(0, s.end - s.start)
    if (td > 0 && i > 0 && s.transition && s.transition !== 'cut') {
      totalDuration -= Math.min(td, len / 2)
    }
    totalDuration += len
  })

  return { shots, internalCuts: Math.max(0, units - shots), units, totalDuration }
}

/**
 * Preferred entry point. Uses the GPU (WebCodecs) path when the browser supports
 * it, otherwise the FFmpeg.wasm software path. If the WebCodecs path throws
 * mid-render (it has real cross-browser edge cases) the whole render is retried
 * through FFmpeg rather than failing.
 *
 * @param {object} opts
 *   - resolution: '720p' | '1080p'
 *   - forceEngine: 'webcodecs' | 'ffmpeg' — bypass the capability check. With
 *     'webcodecs', a failure is REPORTED (thrown), not silently fallen back —
 *     that failure is the signal a test is looking for.
 *   - forceFFmpeg: legacy alias for forceEngine: 'ffmpeg'
 *   - onDiag: per-segment diagnostics callback
 *   - captions: { cuesByClip, style } — source-time cues, remapped per engine
 * @returns {Promise<{url,size,method:'webcodecs'|'ffmpeg',joinPath:'concat'|'xfade',
 *   captionsBurned:boolean,captionsSkippedReason?:string,fellBack:boolean,
 *   fallbackReason?:string,reason?:string}>}
 */
export async function render(clips, plan, opts = {}, onProgress = () => {}) {
  const forceEngine = opts.forceEngine || (opts.forceFFmpeg ? 'ffmpeg' : null)

  const { w, h } = RES[opts.resolution] || RES['720p']
  const captionsOn = !!opts.captions?.cuesByClip && Object.keys(opts.captions.cuesByClip).length > 0
  const capStyle = opts.captions?.style || {}

  // Source-time cues → the finished output timeline. Remap against the SAME
  // split plan each engine renders, so captions land on the right frames.
  const splitPlan = applyCutRanges(plan)

  // Resolve the join path per engine FIRST — the same number then drives both
  // the caption remap and the expected duration, so they cannot disagree with
  // what actually renders.
  const joinFor = {
    webcodecs: resolveJoinPath(splitPlan, 'webcodecs'),
    ffmpeg: resolveJoinPath(splitPlan, 'ffmpeg'),
  }
  const statsFor = (engine) => ({
    ...countCuts(plan, { transitionDuration: joinFor[engine].transitionDuration }),
    width: w,
    height: h,
    joinPath: joinFor[engine].path,
    captions: captionsOn ? { style: capStyle } : null,
  })
  const capFor = (engine) =>
    captionsOn
      ? remapToOutputTimeline(opts.captions.cuesByClip, splitPlan, {
          transitionDuration: joinFor[engine].transitionDuration,
        })
      : null

  const runWebCodecs = async () => {
    onProgress({ stage: 'webcodecs', pct: 0, msg: 'Starting GPU render…' })
    const cues = capFor('webcodecs')
    const wcOpts = cues ? { ...opts, captions: { cues, style: capStyle } } : opts
    const out = await renderWithWebCodecs(clips, splitPlan, wcOpts, onProgress)
    return {
      ...out,
      ...statsFor('webcodecs'),
      method: 'webcodecs',
      fellBack: false,
      // The canvas compositor draws captions itself — always delivered.
      captionsBurned: !!cues,
    }
  }
  const runFFmpeg = async (extra) => {
    const cues = capFor('ffmpeg')
    const fOpts = cues ? { ...opts, captions: { srt: toSRT(cues), style: capStyle } } : opts
    const out = await renderVideo(clips, plan, fOpts, onProgress)
    return {
      ...out,
      ...statsFor('ffmpeg'),
      method: 'ffmpeg',
      fellBack: false,
      captionsBurned: cues ? !!out.captionsBurned : false,
      ...(cues && !out.captionsBurned
        ? { captionsSkippedReason: out.captionsSkippedReason || 'The software renderer could not burn in captions.' }
        : {}),
      ...extra,
    }
  }

  // --- forced engine: do exactly that, report failure verbatim ---------
  if (forceEngine === 'webcodecs') return runWebCodecs()
  if (forceEngine === 'ffmpeg') return runFFmpeg({ reason: 'Forced software render.' })

  // --- auto: capability check, GPU first, fall back on any error -------
  const support = await checkWebCodecsSupport()
  if (support.supported) {
    try {
      return await runWebCodecs()
    } catch (err) {
      console.error('[render] WebCodecs path failed; falling back to FFmpeg:', err)
      onProgress({
        stage: 'fallback',
        pct: 0,
        msg: `GPU render failed (${err?.message || err}). Retrying with FFmpeg…`,
      })
      return {
        ...(await runFFmpeg()),
        fellBack: true,
        fallbackReason: err?.message || String(err),
      }
    }
  }

  return runFFmpeg({ reason: support.reason })
}

/**
 * Rough wall-clock estimate for a render, in seconds. WebCodecs is GPU-bound and
 * far faster; FFmpeg.wasm software-decodes everything.
 *
 * @param {object} plan  validated plan
 * @param {object} opts  { resolution, method: 'webcodecs' | 'ffmpeg' }
 */
export function estimateRenderSeconds(plan, opts = {}) {
  const segs = plan?.segments || []
  const outSec = segs.reduce((a, s) => a + Math.max(0, s.end - s.start), 0)
  const is1080 = opts.resolution === '1080p'

  if (opts.method === 'webcodecs') {
    // ≈0.15× realtime at 720p, ≈0.3× at 1080p, plus demux/mux overhead.
    return Math.ceil(outSec * (is1080 ? 0.3 : 0.15)) + 3
  }

  // FFmpeg.wasm software path — unchanged heuristic.
  const perSec = is1080 ? 1.8 : 1.0
  return Math.ceil(outSec * perSec + segs.length * 0.5) + 5
}
