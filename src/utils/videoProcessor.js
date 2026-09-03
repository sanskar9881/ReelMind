// videoProcessor.js — two-pass in-browser render with FFmpeg.wasm.

import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import { checkWebCodecsSupport } from './webcodecs/support.js'
import { renderWithWebCodecs } from './webcodecs/renderer.js'

const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd'

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
      const withRealAudio = [
        '-ss', String(seg.start),
        '-i', src,
        '-t', String(dur),
        '-map', '0:v:0', '-map', '0:a:0',
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
        '-af', af ? `apad,${af}` : 'apad', '-shortest',
        part,
      ]
      const withSilentAudio = [
        '-ss', String(seg.start),
        '-i', src,
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-t', String(dur),
        '-map', '0:v:0', '-map', '1:a:0',
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
        ...(af ? ['-af', af] : []),
        '-shortest',
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
      if (code !== 0) {
        await ffmpeg.deleteFile(part).catch(() => {})
        code = await ffmpeg.exec(withSilentAudio)
        if (code !== 0) throw new Error(`Failed to normalize segment ${i + 1} ("${clip.name}").`)
      }
      partFiles.push(part)
    }

    if (!partFiles.length) throw new Error('No segments could be normalized — check that the source clips are still loaded.')

    // ---- PASS 2 -----------------------------------------------------------
    step = units.length
    execProgress = 0
    const list = partFiles.map((p) => `file '${p}'`).join('\n') + '\n'
    await ffmpeg.writeFile('list.txt', new TextEncoder().encode(list))

    await ffmpeg.exec([
      '-f', 'concat', '-safe', '0', '-i', 'list.txt',
      '-c', 'copy',
      'output.mp4',
    ])

    const data = await ffmpeg.readFile('output.mp4')
    const blob = new Blob([data.buffer], { type: 'video/mp4' })
    onProgress({ stage: 'done', pct: 100, msg: 'Render complete.' })
    return { url: URL.createObjectURL(blob), size: blob.size }
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
    await kill('output.mp4')
  }
}

/**
 * Pre-split every segment around its filler / struck-sentence / retake ranges so
 * a renderer that has no cut logic of its own (the WebCodecs path) still drops
 * them. The FFmpeg path does its own splitting, so it keeps the original plan.
 */
function applyCutRanges(plan) {
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

/**
 * How many shots (plan segments) and how many extra internal splices the cut
 * ranges introduce. `internalCuts` is the number of within-shot joins created by
 * filler / struck / retake removal — for the "Rendered N shots, M internal cuts"
 * readout.
 */
export function countCuts(plan) {
  const shots = plan?.segments?.length || 0
  const split = applyCutRanges(plan)
  const units = split.segments?.length || 0
  return { shots, internalCuts: Math.max(0, units - shots), units }
}

/**
 * Preferred entry point. Uses the GPU (WebCodecs) path when the browser supports
 * it, otherwise the FFmpeg.wasm software path. If the WebCodecs path throws
 * mid-render (it has real cross-browser edge cases) the whole render is retried
 * through FFmpeg rather than failing.
 *
 * @returns {Promise<{url,size,method:'webcodecs'|'ffmpeg',fellBack:boolean,fallbackReason?:string,reason?:string}>}
 */
export async function render(clips, plan, opts = {}, onProgress = () => {}) {
  const support = opts.forceFFmpeg
    ? { supported: false, reason: 'Forced software render.' }
    : await checkWebCodecsSupport()

  if (support.supported) {
    try {
      onProgress({ stage: 'webcodecs', pct: 0, msg: 'Starting GPU render…' })
      const out = await renderWithWebCodecs(clips, applyCutRanges(plan), opts, onProgress)
      return { ...out, method: 'webcodecs', fellBack: false }
    } catch (err) {
      // WebCodecs failed — log and retry the entire render on FFmpeg.
      console.error('[render] WebCodecs path failed; falling back to FFmpeg:', err)
      onProgress({
        stage: 'fallback',
        pct: 0,
        msg: `GPU render failed (${err?.message || err}). Retrying with FFmpeg…`,
      })
      const out = await renderVideo(clips, plan, opts, onProgress)
      return { ...out, method: 'ffmpeg', fellBack: true, fallbackReason: err?.message || String(err) }
    }
  }

  const out = await renderVideo(clips, plan, opts, onProgress)
  return { ...out, method: 'ffmpeg', fellBack: false, reason: support.reason }
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
