// transcribe.js — main-thread wrapper around transcribe.worker.js.
//
// Handles: audio extraction (video → 16kHz mono Float32), worker lifecycle,
// and turning Whisper's flat word list into words / sentences / fillers.

// ---- audio extraction ----------------------------------------------------

/**
 * Whisper wants a 16kHz mono Float32Array. Video audio is 44.1/48kHz stereo,
 * so decode then resample through an OfflineAudioContext.
 * @param {File} file
 * @returns {Promise<Float32Array>} channel-0 samples at 16kHz
 */
export async function extractAudioForWhisper(file) {
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) throw new Error('This browser has no Web Audio API — cannot extract audio.')

  let decoded
  try {
    const bytes = await file.arrayBuffer()
    const tmp = new AC()
    decoded = await tmp.decodeAudioData(bytes)
    tmp.close()
  } catch {
    throw new Error(`Could not decode audio from "${file.name}". The codec is likely unsupported for decoding.`)
  }

  const RATE = 16000
  const length = Math.ceil(decoded.duration * RATE)
  if (!length) throw new Error(`"${file.name}" has no audio track to transcribe.`)

  const off = new OfflineAudioContext(1, length, RATE)
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start(0)
  const rendered = await off.startRendering()
  return rendered.getChannelData(0)
}

// ---- worker plumbing ---------------------------------------------------

let _worker = null
const _pending = new Map() // id -> { resolve, reject, onProgress }

function getWorker() {
  if (_worker) return _worker
  _worker = new Worker(new URL('../workers/transcribe.worker.js', import.meta.url), { type: 'module' })

  _worker.onmessage = (e) => {
    const m = e.data || {}
    if (m.type === 'progress' || m.type === 'ready') {
      const entry = m.id ? _pending.get(m.id) : null
      if (entry) entry.onProgress?.(m)
      else for (const p of _pending.values()) p.onProgress?.(m) // model-download phase has no id
      return
    }
    const entry = _pending.get(m.id)
    if (!entry) return
    _pending.delete(m.id)
    if (m.type === 'result') entry.resolve(m)
    else if (m.type === 'error') entry.reject(new Error(m.message || 'Transcription failed.'))
  }

  _worker.onerror = (e) => {
    for (const [id, p] of _pending) {
      p.reject(new Error(e.message || 'Transcription worker crashed.'))
      _pending.delete(id)
    }
  }

  return _worker
}

// ---- filler vocabulary -----------------------------------------------

const FILLER_SINGLE = new Set([
  'um', 'uh', 'er', 'ah', 'like', 'basically', 'literally', 'actually', 'right',
])
const FILLER_INITIAL = new Set(['so']) // only counts sentence-initially
const FILLER_PHRASE = [
  ['you', 'know'],
  ['i', 'mean'],
  ['sort', 'of'],
  ['kind', 'of'],
]

const bare = (t) => (t || '').toLowerCase().replace(/[^a-z']/g, '')

// ---- normalization ---------------------------------------------------

function toWords(rawChunks, duration) {
  const words = []
  for (const ch of rawChunks || []) {
    const text = (ch.text || '').trim()
    if (!text) continue
    let [start, end] = ch.timestamp || []
    if (start == null) start = words.length ? words[words.length - 1].end : 0
    if (end == null) end = start + 0.25
    if (duration) end = Math.min(end, duration)
    if (end < start) end = start
    words.push({ text, start: +start, end: +end })
  }
  return words
}

function toSentences(words) {
  const sentences = []
  let cur = []
  const flush = () => {
    if (!cur.length) return
    sentences.push({
      text: cur.map((w) => w.text).join(' ').replace(/\s+([.,!?;:])/g, '$1'),
      start: cur[0].start,
      end: cur[cur.length - 1].end,
      words: cur,
    })
    cur = []
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    cur.push(w)
    const terminal = /[.!?]["')\]]?$/.test(w.text)
    const next = words[i + 1]
    const gap = next ? next.start - w.end : 0
    // Vloggers rarely enunciate clean punctuation — the >0.6s gap does most of
    // the sentence splitting.
    if (terminal || (next && gap > 0.6)) flush()
  }
  flush()
  return sentences
}

function findFillers(sentences) {
  const fillers = []
  for (const s of sentences) {
    const ws = s.words
    for (let i = 0; i < ws.length; i++) {
      const b = bare(ws[i].text)
      if (!b) continue

      // multi-word phrases first
      let phrase = null
      for (const ph of FILLER_PHRASE) {
        if (b === ph[0] && ws[i + 1] && bare(ws[i + 1].text) === ph[1]) {
          phrase = ph
          break
        }
      }
      if (phrase) {
        fillers.push({ text: `${ws[i].text} ${ws[i + 1].text}`, start: ws[i].start, end: ws[i + 1].end })
        i++ // consume the second word
        continue
      }

      if (FILLER_SINGLE.has(b)) fillers.push({ text: ws[i].text, start: ws[i].start, end: ws[i].end })
      else if (FILLER_INITIAL.has(b) && i === 0) fillers.push({ text: ws[i].text, start: ws[i].start, end: ws[i].end })
    }
  }
  return fillers
}

function normalize(chunks, fullText, duration) {
  const words = toWords(chunks, duration)
  const sentences = toSentences(words)
  const fillers = findFillers(sentences)
  const text = (fullText || words.map((w) => w.text).join(' ')).trim()
  return { words, sentences, fillers, text, language: 'en' }
}

// ---- public API -----------------------------------------------------

/**
 * Transcribe one clip. Returns { words, sentences, fillers, text, language }.
 * Fillers are surfaced, never auto-removed.
 * @param {(p:{pct:number,msg:string})=>void} onProgress
 */
export async function transcribeClip(clip, onProgress = () => {}) {
  onProgress({ pct: 0, msg: 'Extracting audio…' })
  const audio = await extractAudioForWhisper(clip.file)

  const worker = getWorker()
  const id = `${clip.id}:${Date.now().toString(36)}`
  onProgress({ pct: 6, msg: 'Loading speech model…' })

  const result = await new Promise((resolve, reject) => {
    _pending.set(id, {
      resolve,
      reject,
      onProgress: (m) => {
        if (m.type === 'ready') {
          onProgress({ pct: 62, msg: `Transcribing (${m.device === 'webgpu' ? 'WebGPU' : 'WASM'})…` })
          return
        }
        if (m.type !== 'progress') return
        if (m.status === 'progress' && typeof m.progress === 'number') {
          // model download is ~0-100 here; hold inference at 60%+
          onProgress({
            pct: Math.min(58, 6 + Math.round(m.progress * 0.52)),
            msg: 'Downloading speech model (~75MB, one time)…',
          })
        } else if (m.message) {
          onProgress({ pct: 8, msg: m.message })
        }
      },
    })
    // transfer the PCM buffer so it isn't copied
    worker.postMessage({ type: 'transcribe', id, audio, language: clip.language || 'english' }, [audio.buffer])
  })

  onProgress({ pct: 94, msg: 'Formatting transcript…' })
  const out = normalize(result.chunks, result.text, clip.duration)
  onProgress({ pct: 100, msg: 'Transcript ready' })
  return out
}

/**
 * Transcribe many clips ONE AT A TIME. Same memory reason as analyzeAll —
 * parallel decode + model inference blows the tab.
 * @returns {Promise<Map<string, object>>} clipId -> transcript (or { error })
 */
export async function transcribeAll(clips, onProgress = () => {}) {
  const out = new Map()
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]
    try {
      out.set(
        c.id,
        await transcribeClip(c, (p) => onProgress({ ...p, clipId: c.id, index: i, total: clips.length })),
      )
    } catch (err) {
      out.set(c.id, { error: err.message, words: [], sentences: [], fillers: [], text: '', language: 'en' })
    }
  }
  return out
}

/** Tear down the worker (frees the loaded model). */
export function disposeTranscriber() {
  if (_worker) {
    _worker.terminate()
    _worker = null
  }
  _pending.clear()
}
