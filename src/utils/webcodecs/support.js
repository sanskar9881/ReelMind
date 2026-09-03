// support.js — capability gate for the WebCodecs render path.
//
// Chrome/Edge: full support. Safari: partial (improving). Firefox: partial and
// mostly software. This probe decides whether renderWithWebCodecs() runs or the
// FFmpeg.wasm path is used instead.

const VIDEO_PROBE = {
  codec: 'avc1.42001f', // H.264 Baseline 3.1 — the widest-supported profile
  width: 1280,
  height: 720,
  bitrate: 5_000_000,
  framerate: 30,
}

const AUDIO_PROBE = {
  codec: 'mp4a.40.2', // AAC-LC
  sampleRate: 44100,
  numberOfChannels: 2,
  bitrate: 128000,
}

/**
 * @returns {Promise<{supported: boolean, hardwareAccelerated: boolean, reason: string}>}
 */
export async function checkWebCodecsSupport() {
  if (typeof window === 'undefined' || typeof window.VideoEncoder === 'undefined') {
    return { supported: false, hardwareAccelerated: false, reason: 'This browser has no WebCodecs VideoEncoder.' }
  }
  if (
    typeof window.VideoDecoder === 'undefined' ||
    typeof window.AudioEncoder === 'undefined' ||
    typeof window.VideoFrame === 'undefined' ||
    typeof window.OffscreenCanvas === 'undefined'
  ) {
    return {
      supported: false,
      hardwareAccelerated: false,
      reason: 'WebCodecs is only partially implemented here (missing decoder, audio encoder or OffscreenCanvas).',
    }
  }

  try {
    const [video, audio] = await Promise.all([
      VideoEncoder.isConfigSupported(VIDEO_PROBE),
      AudioEncoder.isConfigSupported(AUDIO_PROBE),
    ])

    if (!video?.supported) {
      return { supported: false, hardwareAccelerated: false, reason: 'H.264 encoding is not supported by this browser.' }
    }
    if (!audio?.supported) {
      return { supported: false, hardwareAccelerated: false, reason: 'AAC encoding is not supported by this browser.' }
    }

    // isConfigSupported() rarely reports acceleration directly — probe explicitly.
    let hardwareAccelerated = false
    try {
      const hw = await VideoEncoder.isConfigSupported({ ...VIDEO_PROBE, hardwareAcceleration: 'prefer-hardware' })
      hardwareAccelerated = !!hw?.supported
    } catch {
      hardwareAccelerated = false
    }

    return { supported: true, hardwareAccelerated, reason: '' }
  } catch (err) {
    return { supported: false, hardwareAccelerated: false, reason: err?.message || 'WebCodecs capability probe threw.' }
  }
}
