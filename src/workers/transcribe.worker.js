// transcribe.worker.js — Whisper (transformers.js) OFF the main thread.
//
// Whisper blocks its thread for tens of seconds. Run inline and the whole UI
// freezes — dropped frames, dead buttons, the tab looks crashed. This MUST be a
// Web Worker. See src/utils/transcribe.js for the main-thread wrapper.

import { pipeline, env } from '@huggingface/transformers'

// Always pull weights from the HF CDN — there is no local model dir in a browser.
env.allowLocalModels = false

const MODEL = 'Xenova/whisper-base.en'

let _pipePromise = null
let _device = null

function post(msg) {
  self.postMessage(msg)
}

// Lazily build ONE pipeline. Prefer WebGPU (≈5-10× faster), fall back to WASM.
function getPipeline() {
  if (_pipePromise) return _pipePromise

  _pipePromise = (async () => {
    const opts = {
      dtype: 'q8',
      progress_callback: (p) => {
        // p.status: 'initiate' | 'download' | 'progress' | 'done' | 'ready'
        post({
          type: 'progress',
          status: p.status,
          file: p.file,
          progress: typeof p.progress === 'number' ? p.progress : undefined,
          loaded: p.loaded,
          total: p.total,
        })
      },
    }

    try {
      const pipe = await pipeline('automatic-speech-recognition', MODEL, { ...opts, device: 'webgpu' })
      _device = 'webgpu'
      post({ type: 'progress', status: 'info', message: 'Running on WebGPU' })
      return pipe
    } catch (err) {
      post({
        type: 'progress',
        status: 'info',
        message: `WebGPU unavailable (${err?.message || 'no adapter'}) — using WASM`,
      })
      const pipe = await pipeline('automatic-speech-recognition', MODEL, { ...opts, device: 'wasm' })
      _device = 'wasm'
      return pipe
    }
  })()

  return _pipePromise
}

self.addEventListener('message', async (e) => {
  const msg = e.data || {}
  if (msg.type !== 'transcribe') return

  const { id, audio } = msg
  try {
    const transcriber = await getPipeline()
    post({ type: 'ready', id, device: _device })

    const output = await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: 'word',
      // whisper-base.en is English-only — passing `language`/`task` would throw,
      // so `msg.language` is accepted for forward-compat but not forwarded here.
    })

    post({
      type: 'result',
      id,
      chunks: output?.chunks || [],
      text: output?.text || '',
    })
  } catch (err) {
    post({ type: 'error', id, message: err?.message || String(err) })
  }
})
