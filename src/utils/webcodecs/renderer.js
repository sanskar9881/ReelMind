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
  while (decoder.decodeQueueSize > 8) await tick()
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

// ---- audio -------------------------------------------------------------

async function buildAudioTrack(clips, plan, placements, totalSec, transitionSec, onProgress) {
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null

  const RATE = 44100
  const totalFrames = Math.max(1, Math.ceil(totalSec * RATE))
  const L = new Float32Array(totalFrames)
  const R = new Float32Array(totalFrames)

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

  const segs = plan.segments
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const clip = clips.find((c) => c.id === seg.clipId) || clips.find((c) => c.name === seg.clip)
    if (!clip) continue
    const src = await getAudio(clip)
    const segDur = Math.max(0.01, seg.end - seg.start)
    const fadeIn = i > 0 && seg.transition !== 'cut' ? Math.min(transitionSec, segDur / 2) : 0
    const fadeOut =
      i < segs.length - 1 && segs[i + 1].transition !== 'cut' ? Math.min(transitionSec, segDur / 2) : 0

    onProgress({ stage: 'audio', pct: Math.round((i / segs.length) * 100), msg: `Mixing audio ${i + 1}/${segs.length}…` })

    if (!src) continue

    const frames = Math.round(segDur * RATE)
    const oac = new OfflineAudioContext(2, frames, RATE)
    const node = oac.createBufferSource()
    node.buffer = src
    const gain = oac.createGain()
    node.connect(gain)
    gain.connect(oac.destination)

    gain.gain.setValueAtTime(1, 0)
    if (fadeIn > 0) gain.gain.setValueCurveAtTime(equalPowerCurve('in'), 0, fadeIn)
    if (fadeOut > 0) gain.gain.setValueCurveAtTime(equalPowerCurve('out'), Math.max(0, segDur - fadeOut), fadeOut)

    node.start(0, Math.max(0, seg.start), segDur)
    const rendered = await oac.startRendering()

    const cl = rendered.getChannelData(0)
    const cr = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : cl
    const offFrame = Math.round(placements[i] * RATE)
    for (let f = 0; f < cl.length && offFrame + f < totalFrames; f++) {
      L[offFrame + f] += cl[f]
      R[offFrame + f] += cr[f]
    }
  }

  // clamp any summed overlap
  for (let i = 0; i < totalFrames; i++) {
    if (L[i] > 1) L[i] = 1
    else if (L[i] < -1) L[i] = -1
    if (R[i] > 1) R[i] = 1
    else if (R[i] < -1) R[i] = -1
  }

  return { L, R, sampleRate: RATE, totalFrames }
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

  // Output-timeline placement (seconds) of each segment. A non-cut transition
  // overlaps the previous segment by `transitionSec`, shortening the timeline.
  const placements = []
  let cursor = 0
  for (let i = 0; i < segs.length; i++) {
    const segDur = Math.max(0.01, segs[i].end - segs[i].start)
    if (i > 0 && segs[i].transition !== 'cut') cursor -= Math.min(transitionSec, segDur / 2)
    placements.push(cursor)
    cursor += segDur
  }
  const timelineSec = Math.max(cursor, 0.1)

  const target = new ArrayBufferTarget()
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: W, height: H, frameRate: FPS },
    audio: { codec: 'aac', numberOfChannels: 2, sampleRate: 44100 },
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  })

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

      // --- decoder ------------------------------------------------------
      const decodedQueue = []
      let decoderError = null
      const decoder = new VideoDecoder({
        output: (frame) => decodedQueue.push(frame),
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
          const outFrame = new VideoFrame(canvas, {
            timestamp: Math.round(outIdx * FRAME_US),
            duration: Math.round(FRAME_US),
          })
          await drainEncoder(encoder)
          encoder.encode(outFrame, { keyFrame: outIdx % (FPS * 2) === 0 })
          outFrame.close()
          outIdx++
        }
        localOut++
      }

      const consume = async (frame) => {
        if (segmentDone) {
          frame.close()
          return
        }
        const ts = frame.timestamp
        if (ts + FRAME_US / 2 < startUs) {
          frame.close() // before the in-point — discard
          return
        }
        if (ts >= endUs) {
          segmentDone = true
          frame.close()
          return
        }
        // This source frame fills every output slot up to its timestamp.
        while (nextSrcT <= ts + FRAME_US / 2 && localOut < outFrames) {
          await renderOutputFrame(frame)
          nextSrcT += FRAME_US
        }
        frame.close()
      }

      // --- feed chunks ----------------------------------------------
      let fedPastEnd = 0
      for (let j = firstIdx; j < samples.length; j++) {
        if (decoderError) throw decoderError
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
        while (decodedQueue.length > 12) await consume(decodedQueue.shift())
        // Feed a few samples past the out-point so reordered (B-)frames land.
        if (s.timestamp >= endUs) {
          if (++fedPastEnd > 3) break
        }
        if (localOut >= outFrames) break
      }

      await decoder.flush()
      while (decodedQueue.length) await consume(decodedQueue.shift())
      decoder.close()
      if (decoderError) throw decoderError

      // If the source ran short, pad the segment by repeating the last canvas.
      while (localOut < outFrames) {
        if (localOut >= outFrames - holdN) {
          newTail.push(await createImageBitmap(canvas))
        } else {
          const vf = new VideoFrame(canvas, {
            timestamp: Math.round(outIdx * FRAME_US),
            duration: Math.round(FRAME_US),
          })
          await drainEncoder(encoder)
          encoder.encode(vf, { keyFrame: outIdx % (FPS * 2) === 0 })
          vf.close()
          outIdx++
        }
        localOut++
      }

      for (const b of tail) b.close()
      tail = newTail

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
    const audioTrack = await buildAudioTrack(clips, plan, placements, timelineSec, transitionSec, onProgress)
    await encodeAudio(audioTrack, muxer, onProgress)

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
