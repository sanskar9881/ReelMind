// demuxer.js — thin wrapper over mp4box.js to turn an MP4 File into
// EncodedVideoChunk-ready samples plus the decoder description (avcC).

import { createFile, DataStream, Endianness, MP4BoxBuffer } from 'mp4box'

const FEED_CHUNK = 1 << 20 // 1 MiB
const US = 1_000_000

// Serialize a config box (avcC / hvcC / …) and strip its 8-byte box header —
// VideoDecoder.configure() wants just the payload as `description`.
function boxToDescription(entry) {
  const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C
  if (!box) return undefined
  const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN)
  box.write(stream)
  return new Uint8Array(stream.buffer, 8) // drop size+type
}

/**
 * @param {File} file
 * @returns {Promise<{
 *   videoTrack: object,
 *   audioTrack: object|null,
 *   samples: Array<{data: Uint8Array, timestamp: number, duration: number, type: 'key'|'delta'}>
 * }>}  timestamps/durations are in MICROSECONDS on the source timeline.
 */
export async function demux(file) {
  const mp4 = createFile()
  const buffer = await file.arrayBuffer()

  let info = null
  let parseError = null
  const samples = []

  mp4.onError = (e) => {
    parseError = new Error(`mp4box could not parse "${file.name}": ${e}`)
  }
  // Arm extraction from INSIDE onReady. A fragmented MP4 (MediaRecorder output,
  // some phones/apps) can carry moov + every moof fragment in a single
  // appendBuffer; if start() isn't called before that call returns, the
  // fragments are parsed with no extraction armed and onSamples never fires.
  mp4.onReady = (i) => {
    info = i
    const v = i.videoTracks?.[0]
    if (!v) {
      parseError = new Error(`"${file.name}" has no video track WebCodecs can decode.`)
      return
    }
    mp4.setExtractionOptions(v.id, 'video', { nbSamples: Infinity })
    mp4.start()
  }
  mp4.onSamples = (_id, user, chunk) => {
    if (user !== 'video') return
    for (const s of chunk) {
      // mp4box may recycle the sample buffer — copy it.
      samples.push({
        data: s.data.slice(0),
        timestamp: Math.round((s.cts / s.timescale) * US),
        duration: Math.round((s.duration / s.timescale) * US),
        type: s.is_sync ? 'key' : 'delta',
      })
    }
  }

  for (let off = 0; off < buffer.byteLength; off += FEED_CHUNK) {
    const part = MP4BoxBuffer.fromArrayBuffer(
      buffer.slice(off, Math.min(off + FEED_CHUNK, buffer.byteLength)),
      off,
    )
    mp4.appendBuffer(part)
    if (parseError) throw parseError
  }
  mp4.flush()
  if (parseError) throw parseError
  if (!info) throw new Error(`Could not read the MP4 structure of "${file.name}" (no moov box).`)

  // Re-read after flush: a fragmented file only knows its true sample count and
  // duration once every moof has been parsed.
  const fresh = (typeof mp4.getInfo === 'function' && mp4.getInfo()) || info
  const v = fresh.videoTracks?.[0] || info.videoTracks[0]
  const a = fresh.audioTracks?.[0] || info.audioTracks?.[0] || null

  const trak = mp4.getTrackById(v.id)
  let description
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    description = boxToDescription(entry)
    if (description) break
  }
  if (!description) {
    throw new Error(`"${file.name}" is missing an avcC decoder description — cannot configure VideoDecoder.`)
  }

  if (!samples.length) throw new Error(`No video samples were extracted from "${file.name}".`)

  return {
    videoTrack: {
      id: v.id,
      codec: v.codec, // e.g. "avc1.42e01e"
      timescale: v.timescale,
      durationSec: v.duration / v.timescale,
      width: v.track_width || v.video?.width || 0,
      height: v.track_height || v.video?.height || 0,
      nbSamples: v.nb_samples || samples.length,
      description,
    },
    audioTrack: a
      ? {
          id: a.id,
          codec: a.codec,
          timescale: a.timescale,
          durationSec: a.duration / a.timescale,
          sampleRate: a.audio?.sample_rate || 0,
          numberOfChannels: a.audio?.channel_count || 0,
          nbSamples: a.nb_samples,
        }
      : null,
    samples,
  }
}
