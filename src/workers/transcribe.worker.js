// transcribe.worker.js — Whisper (transformers.js) OFF the main thread.
//
// Whisper blocks its thread for tens of seconds. Run inline and the whole UI
// freezes — dropped frames, dead buttons, the tab looks crashed. This MUST be a
// Web Worker. See src/utils/transcribe.js for the main-thread wrapper.

import { pipeline, env } from '@huggingface/transformers'

// Always pull weights from the HF CDN — there is no local model dir in a browser.
env.allowLocalModels = false

/**
 * Model tiers. NEITHER carries the `.en` suffix, and that is the whole point:
 * `whisper-base.en` is English-ONLY. Handed Hindi or Marathi it does not fail —
 * it returns confident English-shaped nonsense, which is the worst failure mode
 * available, because every downstream stage treats it as a real transcript.
 *
 * 'accurate' is worth the download for Indic languages generally and Marathi
 * especially: Whisper saw far less Marathi than Hindi in training, and most of
 * that gap closes at small.
 */
// NOT exported for import by main-thread code: importing anything from this
// file would drag transformers.js into the main bundle, which is exactly what
// the worker exists to prevent. transcribe.js keeps its own UI-facing copy.
const MODELS = {
  fast: { id: 'Xenova/whisper-base', label: 'Fast', sizeMB: 145 },
  accurate: { id: 'Xenova/whisper-small', label: 'Accurate', sizeMB: 460 },
}
const DEFAULT_TIER = 'fast'

// One pipeline per model tier — switching tiers must not silently reuse the
// model already in memory.
const _pipes = new Map() // tier -> Promise<pipeline>
let _device = null

function post(msg) {
  self.postMessage(msg)
}

// Lazily build one pipeline per tier. Prefer WebGPU (≈5-10× faster), fall back
// to WASM.
function getPipeline(tier) {
  const model = MODELS[tier] || MODELS[DEFAULT_TIER]
  if (_pipes.has(model.id)) return _pipes.get(model.id)

  const built = (async () => {
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
      const pipe = await pipeline('automatic-speech-recognition', model.id, { ...opts, device: 'webgpu' })
      _device = 'webgpu'
      post({ type: 'progress', status: 'info', message: 'Running on WebGPU' })
      return pipe
    } catch (err) {
      post({
        type: 'progress',
        status: 'info',
        message: `WebGPU unavailable (${err?.message || 'no adapter'}) — using WASM`,
      })
      const pipe = await pipeline('automatic-speech-recognition', model.id, { ...opts, device: 'wasm' })
      _device = 'wasm'
      return pipe
    }
  })()

  _pipes.set(model.id, built)
  // A failed load must not be cached as a permanent failure — the usual cause
  // is a dropped CDN download, and the user's retry deserves a real attempt.
  built.catch(() => _pipes.delete(model.id))
  return built
}

self.addEventListener('message', async (e) => {
  const msg = e.data || {}
  if (msg.type !== 'transcribe') return

  const { id, audio } = msg
  const tier = MODELS[msg.tier] ? msg.tier : DEFAULT_TIER
  try {
    const transcriber = await getPipeline(tier)
    post({ type: 'ready', id, device: _device, model: MODELS[tier].id })

    // `language: undefined` is Whisper's auto-detect. It is genuinely unreliable
    // under ~10s of audio — too little signal — which is why the UI defaults to
    // an explicit choice and labels this option as the gamble it is.
    const output = await transcriber(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: 'word',
      task: 'transcribe', // never 'translate' — we caption what was said
      ...(msg.language ? { language: msg.language } : null),
    })

    post({
      type: 'result',
      id,
      chunks: output?.chunks || [],
      text: output?.text || '',
      model: MODELS[tier].id,
      language: msg.language || null,
    })
  } catch (err) {
    post({ type: 'error', id, message: err?.message || String(err) })
  }
})
