// renderer.js — GPU render path. Decode (VideoDecoder) → composite on an
// OffscreenCanvas → re-encode (VideoEncoder) → mux (mp4-muxer). Transitions are
// composited directly on the canvas, which is cheaper and more flexible than
// FFmpeg's xfade chain.
//
// MEMORY: every VideoFrame holds GPU memory the GC will not reclaim. Every frame
// created or received here is .close()d the instant it is done with, and both
// the decode and encode queues are kept shallow with explicit backpressure.

import { Muxer, ArrayBufferTarget } from 'mp4-muxer'
import { demux } from './demuxer.js'
import { concatWithSplice, findZeroCrossing } from '../audioSplice.js'
import { createFrameTracker } from '../memoryGuard.js'

const FPS = 30
const FRAME_US = 1_000_000 / FPS
const US = 1_000_000

const RES = {
  '720p': { w: 1280, h: 720, bitrate: 5_000_000, codec: 'avc1.42001f' },
  '1080p': { w: 1920, h: 1080, bitrate: 10_000_000, codec: 'avc1.640028' },
}

const tick = (ms = 4) => new Promise((r) => setTimeout(r, ms))

async function drainEncoder(encoder) {
  while (encoder.encodeQueueSize > 8) await tick()
}
async function drainDecoder(decoder) {
  while (decoder.decodeQueueSize > 4) await tick()
}

// Equal-power crossfade curve (cos/sin), not linear — a linear overlap dips in
// perceived loudness at the midpoint.
function equalPowerCurve(dir, n = 64) {
  const c = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * (Math.PI / 2)
    c[i] = dir === 'in' ? Math.sin(x) : Math.cos(x)
  }
  return c
}

// scale/pad geometry — identical intent to the FFmpeg path's
// scale=…:force_original_aspect_ratio=decrease,pad=…:(ow-iw)/2:(oh-ih)/2
function letterbox(fw, fh, W, H) {
  const scale = Math.min(W / fw, H / fh)
  const dw = Math.round(fw * scale)
  const dh = Math.round(fh * scale)
  return { dw, dh, dx: Math.floor((W - dw) / 2), dy: Math.floor((H - dh) / 2) }
}

// ---- captions ---------------------------------------------------------

// Cues are sorted by start; find the one covering `t` in O(log n) — at 30fps
// over ten minutes a linear scan is 18,000 array walks per render.
function findActiveCue(cues, t) {
  let lo = 0
  let hi = cues.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid].start <= t) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans >= 0 && t < cues[ans].end ? cues[ans] : null
}

function drawCaption(ctx, W, H, cue, style = {}) {
  const lines = (cue.lines || []).slice(0, 2)
  if (!lines.length) return

  const fontPx = Math.max(12, Math.round(H * (style.sizeScale ?? 0.045)))
  const lineH = Math.round(fontPx * 1.28)
  const marginV = Math.round(H * (style.marginScale ?? 0.08))
  const family = style.fontFamily || "'DM Sans', system-ui, -apple-system, sans-serif"

  ctx.save()
  ctx.font = `700 ${fontPx}px ${family}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.lineJoin = 'round'
  ctx.miterLimit = 2

  // baseline of the LAST (bottom) line
  const lastBaseline =
    style.position === 'top' ? marginV + fontPx + (lines.length - 1) * lineH : H - marginV
  const topBaseline = lastBaseline - (lines.length - 1) * lineH

  if (style.background) {
    let maxW = 0
    for (const ln of lines) maxW = Math.max(maxW, ctx.measureText(ln).width)
    const padX = Math.round(fontPx * 0.55)
    const padY = Math.round(fontPx * 0.4)
    const boxW = Math.min(W - 8, maxW + padX * 2)
    const boxH = (lines.length - 1) * lineH + fontPx + padY * 2
    const boxX = Math.round((W - boxW) / 2)
    const boxY = Math.round(topBaseline - fontPx - padY + fontPx * 0.15)
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.beginPath()
    if (ctx.roundRect) ctx.roundRect(boxX, boxY, boxW, boxH, Math.round(fontPx * 0.28))
    else ctx.rect(boxX, boxY, boxW, boxH)
    ctx.fill()
  }

  ctx.lineWidth = Math.max(3, Math.round(fontPx * 0.12)) // ~3px stroke for legibility
  ctx.strokeStyle = '#000'
  ctx.fillStyle = '#fff'
  lines.forEach((ln, i) => {
    const y = lastBaseline - (lines.length - 1 - i) * lineH
    ctx.strokeText(ln, W / 2, y) // stroke first, fill over
    ctx.fillText(ln, W / 2, y)
  })
  ctx.restore()
}

// ---- audio -------------------------------------------------------------

const RATE = 44100

// Video encodes exactly round(segDur·FPS) frames per segment. The audio slice
// must be exactly that many frames long, expressed at RATE — otherwise the two
// drift apart by one rounding error per cut, and it accumulates.
function videoFramesFor(seg) {
  return Math.max(1, Math.round((seg.end - seg.start) * FPS))
}
function targetSamplesFor(seg) {
  return Math.round((videoFramesFor(seg) / FPS) * RATE)
}

/**
 * Sum the finished music bed into the finished dialogue master.
 *
 * Deliberately the LAST thing that happens to the audio: the bed is already
 * ducked and already exactly as long as the output, so mixing it here cannot
 * touch the per-segment sample math that A/V sync depends on. Length mismatches
 * are resolved by mixing the overlap and leaving the rest alone — never by
 * resampling or padding the dialogue track.
 */
function mixMusicBed(track, bed) {
  if (!track || !bed) return track
  if (bed.sampleRate !== track.sampleRate) {
    console.warn(
      `[renderer] music bed is ${bed.sampleRate}Hz but the track is ${track.sampleRate}Hz — skipping the mix`,
    )
    return track
  }
  const bl = bed.getChannelData(0)
  const br = bed.numberOfChannels > 1 ? bed.getChannelData(1) : bl
  const n = Math.min(track.totalFrames, bed.length)
  for (let i = 0; i < n; i++) {
    let l = track.L[i] + bl[i]
    let r = track.R[i] + br[i]
    track.L[i] = l > 1 ? 1 : l < -1 ? -1 : l
    track.R[i] = r > 1 ? 1 : r < -1 ? -1 : r
  }
  return track
}

async function buildAudioTrack(clips, plan, totalSec, transitionSec, onProgress, onDiag) {
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null

  const segs = plan.segments
  const hasTransition = segs.some((s, i) => i > 0 && s.transition !== 'cut')

  // Frame-derived sample offsets for the place+sum (transition) path, mirroring
  // the video timeline's overlap pull-back.
  const audioOffsets = []
  {
    let cursor = 0
    for (let i = 0; i < segs.length; i++) {
      const len = Math.max(0.01, segs[i].end - segs[i].start)
      if (i > 0 && segs[i].transition !== 'cut') cursor -= Math.round(Math.min(transitionSec, len / 2) * RATE)
      audioOffsets.push(cursor)
      cursor += targetSamplesFor(segs[i])
    }
  }

  const allocFrames = Math.max(1, Math.ceil(totalSec * RATE) + RATE) // + 1s slack
  const L = new Float32Array(allocFrames)
  const R = new Float32Array(allocFrames)
  let writtenFrames = 0

  const decoded = new Map() // clipId -> AudioBuffer | null
  const getAudio = async (clip) => {
    if (decoded.has(clip.id)) return decoded.get(clip.id)
    let buf = null
    try {
      const ctx = new AC()
      buf = await ctx.decodeAudioData(await clip.file.arrayBuffer())
      ctx.close()
    } catch {
      buf = null // clip has no decodable audio — contributes silence
    }
    decoded.set(clip.id, buf)
    return buf
  }

  const rendered = [] // per-segment AudioBuffers, in order (pure-cut path only)

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const clip = clips.find((c) => c.id === seg.clipId) || clips.find((c) => c.name === seg.clip)
    if (!clip) continue
    const src = await getAudio(clip)

    onProgress({ stage: 'audio', pct: Math.round((i / segs.length) * 100), msg: `Mixing audio ${i + 1}/${segs.length}…` })

    // A/V SYNC: snap the in-point to a zero crossing to kill the splice click,
    // then force the slice length back to match the video segment exactly. The
    // ±10ms snap shifts the content, never the length — so nothing accumulates.
    const targetSamples = targetSamplesFor(seg)
    let snappedIn = Math.max(0, seg.start)
    let snappedOut = seg.end
    if (src) {
      const sr = src.sampleRate
      const ch0 = src.getChannelData(0)
      const radius = Math.round(0.01 * sr)
      snappedIn = findZeroCrossing(ch0, seg.start * sr, radius) / sr
      snappedOut = findZeroCrossing(ch0, seg.end * sr, radius) / sr
      if (!Number.isFinite(snappedIn) || snappedIn < 0) snappedIn = Math.max(0, seg.start)
    }
    const segDur = targetSamples / RATE

    // Transitions overlap the neighbour → equal-power crossfade ramp (a
    // different case from a butt-joined splice, which gets edge fades below).
    const fadeIn = i > 0 && seg.transition !== 'cut' ? Math.min(transitionSec, segDur / 2) : 0
    const fadeOut =
      i < segs.length - 1 && segs[i + 1].transition !== 'cut' ? Math.min(transitionSec, segDur / 2) : 0

    let buf
    if (!src) {
      buf = new AudioBuffer({ length: targetSamples, numberOfChannels: 2, sampleRate: RATE })
    } else {
      // The OfflineAudioContext length forces the sample count exactly:
      // overshoot of the source is trimmed, undershoot is silence (zero-pad).
      const oac = new OfflineAudioContext(2, targetSamples, RATE)
      const node = oac.createBufferSource()
      node.buffer = src
      const gain = oac.createGain()
      node.connect(gain)
      gain.connect(oac.destination)

      gain.gain.setValueAtTime(1, 0)
      if (fadeIn > 0) gain.gain.setValueCurveAtTime(equalPowerCurve('in'), 0, fadeIn)
      if (fadeOut > 0) gain.gain.setValueCurveAtTime(equalPowerCurve('out'), Math.max(0, segDur - fadeOut), fadeOut)

      node.start(0, snappedIn) // no duration arg — context length bounds it
      buf = await oac.startRendering()
    }

    if (buf.length !== targetSamples) {
      console.warn(
        `[renderer] A/V length mismatch at segment ${i}: audio ${buf.length} samples, expected ${targetSamples} (video ${videoFramesFor(seg)} frames)`,
      )
    }

    onDiag?.({
      phase: 'audio',
      index: i,
      srcIn: +seg.start.toFixed(4),
      srcOut: +seg.end.toFixed(4),
      snappedAudioIn: +snappedIn.toFixed(4),
      snappedAudioOut: +snappedOut.toFixed(4),
      audioSamplesWritten: buf.length,
      expectedSamples: targetSamples,
    })

    if (!hasTransition) {
      rendered.push(buf) // butt-joined with splice hygiene below
      writtenFrames += buf.length
      continue
    }

    // Mixed sequence: place + sum for the overlaps, but micro-fade this piece's
    // butt-joined (cut) edges first so they don't click.
    const cl = buf.getChannelData(0)
    const cr = buf.numberOfChannels > 1 ? buf.getChannelData(1) : cl
    if (!fadeIn) {
      spliceFadeHead(cl, RATE)
      if (cr !== cl) spliceFadeHead(cr, RATE)
    }
    if (!fadeOut) {
      spliceFadeTail(cl, RATE)
      if (cr !== cl) spliceFadeTail(cr, RATE)
    }
    const off = Math.max(0, audioOffsets[i])
    for (let f = 0; f < cl.length && off + f < allocFrames; f++) {
      L[off + f] += cl[f]
      R[off + f] += cr[f]
    }
    writtenFrames = Math.max(writtenFrames, off + cl.length)
  }

  if (!hasTransition) {
    // One clean butt-join of every piece, each edge equal-power faded.
    const master = concatWithSplice(rendered, RATE, 2)
    return {
      L: master.getChannelData(0),
      R: master.numberOfChannels > 1 ? master.getChannelData(1) : master.getChannelData(0),
      sampleRate: RATE,
      totalFrames: master.length,
    }
  }

  const total = Math.min(allocFrames, Math.max(1, writtenFrames))
  for (let i = 0; i < total; i++) {
    if (L[i] > 1) L[i] = 1
    else if (L[i] < -1) L[i] = -1
    if (R[i] > 1) R[i] = 1
    else if (R[i] < -1) R[i] = -1
  }
  return { L: L.subarray(0, total), R: R.subarray(0, total), sampleRate: RATE, totalFrames: total }
}

// One-sided equal-power edge fades for the mixed (place+sum) path — a transition
// edge is already covered by the crossfade, so only the butt-joined edge needs
// smoothing. (concatWithSplice fades both edges for the pure-cut path.)
function spliceFadeHead(data, rate, ms = 15) {
  let ramp = Math.floor((ms / 1000) * rate)
  if (ramp < 1) ramp = 1
  if (data.length < ramp * 2) ramp = Math.floor(data.length / 2)
  for (let i = 0; i < ramp; i++) data[i] *= Math.sin((i / ramp) * (Math.PI / 2))
}
function spliceFadeTail(data, rate, ms = 15) {
  const len = data.length
  let ramp = Math.floor((ms / 1000) * rate)
  if (ramp < 1) ramp = 1
  if (len < ramp * 2) ramp = Math.floor(len / 2)
  for (let i = 0; i < ramp; i++) data[len - ramp + i] *= Math.cos(((i + 1) / ramp) * (Math.PI / 2))
}

async function encodeAudio(track, muxer, onProgress) {
  if (!track) return
  const { L, R, sampleRate, totalFrames } = track
  const encoder = new AudioEncoder({
    output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    error: (e) => {
      throw e
    },
  })
  encoder.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: 2, bitrate: 128000 })

  const CHUNK = 1024
  for (let off = 0; off < totalFrames; off += CHUNK) {
    const n = Math.min(CHUNK, totalFrames - off)
    const interleaved = new Float32Array(n * 2)
    for (let f = 0; f < n; f++) {
      interleaved[f * 2] = L[off + f]
      interleaved[f * 2 + 1] = R[off + f]
    }
    const ad = new AudioData({
      format: 'f32',
      sampleRate,
      numberOfFrames: n,
      numberOfChannels: 2,
      timestamp: Math.round((off / sampleRate) * US),
      data: interleaved,
    })
    encoder.encode(ad)
    ad.close()
    while (encoder.encodeQueueSize > 16) await tick()
    if (off % (CHUNK * 64) === 0) {
      onProgress({ stage: 'audio', pct: Math.round((off / totalFrames) * 100), msg: 'Encoding audio…' })
    }
  }
  await encoder.flush()
  encoder.close()
}

// ---- video -----------------------------------------------------------

/**
 * @returns {Promise<{url: string, size: number, method: 'webcodecs'}>}
 */
export async function renderWithWebCodecs(clips, plan, opts = {}, onProgress = () => {}) {
  const segs = plan?.segments || []
  if (!segs.length) throw new Error('Nothing to render — the plan has no segments.')

  const { w: W, h: H, bitrate, codec } = RES[opts.resolution] || RES['720p']
  const transitionSec = Math.max(0, Math.min(1.5, opts.transitionDuration ?? 0.5))
  const tdFramesBase = Math.round(transitionSec * FPS)
  const onDiag = typeof opts.onDiag === 'function' ? opts.onDiag : null

  // Output-timeline caption cues to burn into the canvas (already remapped).
  const capCues = (opts.captions?.cues || []).slice().sort((a, b) => a.start - b.start)
  const capStyle = opts.captions?.style || {}
  if (capCues.length && typeof document !== 'undefined' && document.fonts?.ready) {
    try {
      await document.fonts.ready
    } catch {
      /* fonts optional */
    }
  }

  // Nominal output-timeline length (seconds), accounting for transition overlap.
  let cursor = 0
  for (let i = 0; i < segs.length; i++) {
    const segDur = Math.max(0.01, segs[i].end - segs[i].start)
    if (i > 0 && segs[i].transition !== 'cut') cursor -= Math.min(transitionSec, segDur / 2)
    cursor += segDur
  }
  const timelineSec = Math.max(cursor, 0.1)

  const frames = createFrameTracker()

  const target = new ArrayBufferTarget()
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: W, height: H, frameRate: FPS },
    audio: { codec: 'aac', numberOfChannels: 2, sampleRate: 44100 },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  })
  // NOTE: the muxed container reports ~85ms longer than the exact track lengths
  // (video and audio each land dead-on the plan — see the "[renderer] timeline"
  // debug line). That is AAC encoder priming/padding surfaced in the MP4 track
  // duration; it shifts both tracks equally so A/V sync is unaffected, and it is
  // well within verifyRender's tolerance. Deliberately not chased.

  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d', { alpha: false })

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => {
      throw e
    },
  })
  encoder.configure({
    codec,
    width: W,
    height: H,
    bitrate,
    framerate: FPS,
    latencyMode: 'quality',
  })

  const demuxCache = new Map() // clipId -> demux() result
  let outIdx = 0 // global output frame counter (drives output timestamps)
  let totalOutFrames = 0
  for (const s of segs) totalOutFrames += Math.max(1, Math.round((s.end - s.start) * FPS))

  // Tail frames held from the previous segment for the next crossfade.
  let tail = [] // ImageBitmap[]

  try {
    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si]
      const clip = clips.find((c) => c.id === seg.clipId) || clips.find((c) => c.name === seg.clip)
      if (!clip) continue

      onProgress({
        stage: 'demux',
        pct: Math.round((outIdx / totalOutFrames) * 100),
        msg: `Reading "${clip.name}"…`,
      })

      let dem = demuxCache.get(clip.id)
      if (!dem) {
        dem = await demux(clip.file)
        demuxCache.set(clip.id, dem)
      }
      const { videoTrack, samples } = dem

      const startUs = Math.max(0, seg.start * US)
      const endUs = seg.end * US
      const segDurSec = Math.max(0.01, seg.end - seg.start)
      const outFrames = Math.max(1, Math.round(segDurSec * FPS))

      const incoming = si > 0 && seg.transition !== 'cut' ? seg.transition : 'cut'
      const nextTransition = si < segs.length - 1 ? segs[si + 1].transition : 'cut'
      const blendN = incoming !== 'cut' ? Math.min(tdFramesBase, tail.length, Math.floor(outFrames / 2)) : 0
      const holdN = nextTransition !== 'cut' ? Math.min(tdFramesBase, Math.floor(outFrames / 2)) : 0
      const newTail = []
      const outIdxAtStart = outIdx
      let encodedThisSeg = 0

      // --- decoder ------------------------------------------------------
      const decodedQueue = []
      let decoderError = null
      const decoder = new VideoDecoder({
        output: (frame) => {
          frames.track(frame)
          decodedQueue.push(frame)
        },
        error: (e) => {
          decoderError = e
        },
      })
      decoder.configure({
        codec: videoTrack.codec,
        codedWidth: videoTrack.width || W,
        codedHeight: videoTrack.height || H,
        description: videoTrack.description,
        hardwareAcceleration: 'prefer-hardware',
        optimizeForLatency: false,
      })

      // Start from the keyframe at or before the in-point — decoding mid-GOP
      // without a keyframe produces garbage.
      let firstIdx = 0
      for (let j = 0; j < samples.length; j++) {
        if (samples[j].type === 'key' && samples[j].timestamp <= startUs) firstIdx = j
      }

      // Output-frame cursor for this segment (source-relative µs).
      let nextSrcT = startUs
      let localOut = 0
      let segmentDone = false

      const renderOutputFrame = async (srcFrame) => {
        const fw = srcFrame.displayWidth || srcFrame.codedWidth
        const fh = srcFrame.displayHeight || srcFrame.codedHeight
        const { dw, dh, dx, dy } = letterbox(fw, fh, W, H)

        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, W, H)

        if (localOut < blendN && tail[localOut]) {
          // base = outgoing tail frame
          ctx.drawImage(tail[localOut], 0, 0, W, H)
          const p = (localOut + 1) / (blendN + 1)
          if (incoming === 'wipe') {
            ctx.save()
            ctx.beginPath()
            ctx.rect(0, 0, Math.round(W * p), H)
            ctx.clip()
            ctx.drawImage(srcFrame, dx, dy, dw, dh)
            ctx.restore()
          } else if (incoming === 'zoom') {
            const s = 1.15 - 0.15 * p
            const cw = dw * s
            const ch = dh * s
            ctx.globalAlpha = p
            ctx.drawImage(srcFrame, W / 2 - cw / 2, H / 2 - ch / 2, cw, ch)
            ctx.globalAlpha = 1
          } else {
            // fade / dissolve
            ctx.globalAlpha = p
            ctx.drawImage(srcFrame, dx, dy, dw, dh)
            ctx.globalAlpha = 1
          }
        } else {
          ctx.drawImage(srcFrame, dx, dy, dw, dh)
        }

        if (localOut >= outFrames - holdN) {
          // Hold — becomes the base of the NEXT segment's crossfade. Not encoded
          // here; the incoming segment encodes the blended result at this slot.
          newTail.push(await createImageBitmap(canvas))
        } else {
          // Burn the active caption over the composed frame, before it becomes a
          // VideoFrame. `outIdx / FPS` is the timestamp this frame will carry.
          if (capCues.length) {
            const cue = findActiveCue(capCues, outIdx / FPS)
            if (cue) drawCaption(ctx, W, H, cue, capStyle)
          }
          const outFrame = frames.track(
            new VideoFrame(canvas, {
              timestamp: Math.round(outIdx * FRAME_US),
              duration: Math.round(FRAME_US),
            }),
          )
          await drainEncoder(encoder)
          encoder.encode(outFrame, { keyFrame: outIdx % (FPS * 2) === 0 })
          frames.release(outFrame)
          outFrame.close()
          outIdx++
          encodedThisSeg++
        }
        localOut++
      }

      const consume = async (frame) => {
        if (segmentDone) {
          frames.release(frame)
          frame.close()
          return
        }
        const ts = frame.timestamp
        if (ts + FRAME_US / 2 < startUs) {
          frames.release(frame)
          frame.close() // before the in-point — discard
          return
        }
        if (ts >= endUs) {
          segmentDone = true
          frames.release(frame)
          frame.close()
          return
        }
        // This source frame fills every output slot up to its timestamp.
        while (nextSrcT <= ts + FRAME_US / 2 && localOut < outFrames) {
          await renderOutputFrame(frame)
          nextSrcT += FRAME_US
        }
        frames.release(frame)
        frame.close()
      }

      // Close every still-queued decoded frame (used on the error path so a
      // decoder failure doesn't also leak frames).
      const dropQueue = () => {
        for (const f of decodedQueue.splice(0)) {
          frames.release(f)
          try {
            f.close()
          } catch {
            /* already closed */
          }
        }
      }

      // --- feed chunks ----------------------------------------------
      let fedPastEnd = 0
      for (let j = firstIdx; j < samples.length; j++) {
        if (decoderError) {
          dropQueue()
          try {
            decoder.close()
          } catch {
            /* ignore */
          }
          throw decoderError
        }
        const s = samples[j]
        decoder.decode(
          new EncodedVideoChunk({
            type: s.type,
            timestamp: s.timestamp,
            duration: s.duration,
            data: s.data,
          }),
        )
        await drainDecoder(decoder)
        // Keep the decoded-frame backlog shallow (each frame is GPU memory).
        while (decodedQueue.length > 6) await consume(decodedQueue.shift())
        // Feed a few samples past the out-point so reordered (B-)frames land.
        if (s.timestamp >= endUs) {
          if (++fedPastEnd > 3) break
        }
        if (localOut >= outFrames) break
      }

      // Drain to empty BEFORE flush so the flush dump starts from a low base.
      while (decodedQueue.length) await consume(decodedQueue.shift())
      await decoder.flush()
      while (decodedQueue.length) await consume(decodedQueue.shift())
      decoder.close()
      if (decoderError) {
        dropQueue()
        throw decoderError
      }

      // If the source ran short, pad the segment by repeating the last canvas.
      while (localOut < outFrames) {
        if (localOut >= outFrames - holdN) {
          newTail.push(await createImageBitmap(canvas))
        } else {
          const vf = frames.track(
            new VideoFrame(canvas, {
              timestamp: Math.round(outIdx * FRAME_US),
              duration: Math.round(FRAME_US),
            }),
          )
          await drainEncoder(encoder)
          encoder.encode(vf, { keyFrame: outIdx % (FPS * 2) === 0 })
          frames.release(vf)
          vf.close()
          outIdx++
          encodedThisSeg++
        }
        localOut++
      }

      for (const b of tail) b.close()
      tail = newTail

      // Leak tripwire — surfaces the exact segment, not a dead tab 20s later.
      const peakOpen = frames.peak()
      frames.assertDrained(`segment ${si}`)
      frames.resetPeak()
      console.debug(`[renderer] segment ${si}: ${encodedThisSeg} frames encoded, peak open ${peakOpen}`)
      if (peakOpen > 20) {
        console.warn(`[renderer] segment ${si} peak open frames ${peakOpen} — backpressure may be slipping`)
      }

      // Timeline attribution: intended output-ts range for this segment vs the
      // timestamps actually stamped on its first/last encoded frame.
      const intendedFirstUs = Math.round(outIdxAtStart * FRAME_US)
      const intendedLastUs = Math.round(Math.max(outIdxAtStart, outIdx - 1) * FRAME_US)
      console.debug(
        `[renderer] segment ${si}: out frames [${outIdxAtStart}..${outIdx}) ` +
          `= ${(outIdxAtStart / FPS).toFixed(3)}s..${(outIdx / FPS).toFixed(3)}s ` +
          `| first/last frame ts ${(intendedFirstUs / 1e6).toFixed(3)}s/${(intendedLastUs / 1e6).toFixed(3)}s ` +
          `| src ${segDurSec.toFixed(3)}s (${Math.round(segDurSec * FPS)} frames nominal)`,
      )

      onDiag?.({
        phase: 'video',
        index: si,
        srcIn: +seg.start.toFixed(4),
        srcOut: +seg.end.toFixed(4),
        videoFramesEncoded: encodedThisSeg,
        outIdxRange: [outIdxAtStart, outIdx],
        peakOpenFrames: peakOpen,
      })

      onProgress({
        stage: 'video',
        pct: Math.round((outIdx / totalOutFrames) * 100),
        msg: `Encoded segment ${si + 1}/${segs.length}`,
      })
    }

    for (const b of tail) b.close()
    tail = []

    await encoder.flush()
    encoder.close()

    // --- audio ------------------------------------------------------
    onProgress({ stage: 'audio', pct: 0, msg: 'Building audio track…' })
    const audioTrack = mixMusicBed(
      await buildAudioTrack(clips, plan, timelineSec, transitionSec, onProgress, onDiag),
      opts.musicBed || null,
    )
    await encodeAudio(audioTrack, muxer, onProgress)

    // Timeline attribution: expected total = Σ segment durations − Σ transition
    // overlaps. Compare against what video and audio actually produced.
    const sumSegDur = segs.reduce((acc, s) => acc + Math.max(0, s.end - s.start), 0)
    let sumTransition = 0
    for (let i = 1; i < segs.length; i++) {
      if (segs[i].transition && segs[i].transition !== 'cut') {
        sumTransition += Math.min(transitionSec, (segs[i].end - segs[i].start) / 2)
      }
    }
    const expectedTotalSec = sumSegDur - sumTransition
    const actualVideoSec = outIdx / FPS
    const actualAudioSec = audioTrack ? audioTrack.totalFrames / audioTrack.sampleRate : 0
    console.debug(
      `[renderer] timeline: expected ${expectedTotalSec.toFixed(3)}s ` +
        `(Σseg ${sumSegDur.toFixed(3)} − Σtransition ${sumTransition.toFixed(3)}) · ` +
        `video ${actualVideoSec.toFixed(3)}s (Δ ${((actualVideoSec - expectedTotalSec) * 1000).toFixed(0)}ms) · ` +
        `audio ${actualAudioSec.toFixed(3)}s (Δ ${((actualAudioSec - expectedTotalSec) * 1000).toFixed(0)}ms)`,
    )
    onDiag?.({
      phase: 'timeline',
      expectedTotalSec: +expectedTotalSec.toFixed(4),
      actualVideoSec: +actualVideoSec.toFixed(4),
      actualAudioSec: +actualAudioSec.toFixed(4),
      videoFrames: outIdx,
    })

    // --- mux ------------------------------------------------------
    onProgress({ stage: 'mux', pct: 98, msg: 'Writing MP4…' })
    muxer.finalize()
    const blob = new Blob([target.buffer], { type: 'video/mp4' })
    onProgress({ stage: 'done', pct: 100, msg: 'GPU render complete.' })
    return { url: URL.createObjectURL(blob), size: blob.size, method: 'webcodecs' }
  } finally {
    for (const b of tail) {
      try {
        b.close()
      } catch {
        /* already closed */
      }
    }
    try {
      if (encoder.state !== 'closed') encoder.close()
    } catch {
      /* ignore */
    }
  }
}
