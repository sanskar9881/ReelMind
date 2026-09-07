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

// ---- languages and models ---------------------------------------------

/**
 * Languages offered in the UI.
 *
 * `whisper` is the name passed to the pipeline; null means auto-detect, which
 * Whisper does badly under ~10s of audio — too little signal to identify a
 * language from — so it is offered but never the default.
 */
export const LANGUAGES = [
  { code: 'en', label: 'English', native: 'English', whisper: 'english', script: 'latin' },
  { code: 'hi', label: 'Hindi', native: 'हिन्दी', whisper: 'hindi', script: 'devanagari' },
  { code: 'mr', label: 'Marathi', native: 'मराठी', whisper: 'marathi', script: 'devanagari' },
  { code: 'auto', label: 'Auto-detect', native: 'Auto-detect', whisper: null, script: null },
]

export const DEFAULT_LANGUAGE = 'en'

/**
 * Model tiers, mirrored from transcribe.worker.js. Deliberately duplicated
 * rather than imported: importing anything from the worker file would pull
 * transformers.js into the main bundle, and Whisper staying off the main thread
 * is a hard rule of this codebase.
 */
export const MODEL_TIERS = [
  { id: 'fast', label: 'Fast', model: 'Xenova/whisper-base', sizeMB: 145, note: 'Multilingual. Good for English and clear Hindi.' },
  { id: 'accurate', label: 'Accurate', model: 'Xenova/whisper-small', sizeMB: 460, note: 'Noticeably better on Indic languages. Larger download, slower.' },
]

export const DEFAULT_TIER = 'fast'

/**
 * Whisper's Marathi is measurably weaker than its Hindi — there was far less
 * Marathi in training — and the small model closes much of that gap. This is a
 * RECOMMENDATION surfaced in the UI, never a silent substitution: a 460MB
 * download is the user's decision to make.
 */
export function recommendTier(languageCode) {
  return languageCode === 'mr' ? 'accurate' : DEFAULT_TIER
}

export const getLanguage = (code) =>
  LANGUAGES.find((l) => l.code === code) || LANGUAGES.find((l) => l.code === DEFAULT_LANGUAGE)

// ---- script detection --------------------------------------------------

const DEVANAGARI = /[\u0900-\u097F]/
const LATIN = /[A-Za-z]/

/**
 * Which script did Whisper actually return? Compared against the script the
 * chosen language is written in, this is what catches the failure this whole
 * change exists to prevent: an English-only model handed Hindi returns fluent
 * Latin nonsense, and nothing downstream can tell that from a real transcript.
 */
export function detectScript(text) {
  const t = text || ''
  let dev = 0
  let lat = 0
  for (const ch of t) {
    if (DEVANAGARI.test(ch)) dev++
    else if (LATIN.test(ch)) lat++
  }
  const total = dev + lat
  if (!total) return 'unknown'
  // Code-mixing is normal Hindi and Marathi speech — "आज हम camera setup कर रहे
  // हैं" is one sentence, not a failure. Only call it a single script when one
  // clearly dominates; otherwise 'mixed', which never raises a mismatch warning.
  const minority = Math.min(dev, lat) / total
  if (minority >= 0.25) return 'mixed'
  return dev > lat ? 'devanagari' : 'latin'
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

/**
 * Devanagari fillers, Hindi and Marathi. Kept deliberately short and to the
 * unambiguous cases: मतलब / म्हणजे ("meaning", "that is") and अच्छा / बरं are
 * discourse markers, but तो and वो are also ordinary words, so they count only
 * sentence-initially. Over-listing here would strike real speech, and fillers
 * feed a user-facing "remove all fillers" action.
 */
const FILLER_SINGLE_DEV = new Set([
  'मतलब', 'यानी', 'म्हणजे', 'अच्छा', 'बरं', 'बरे', 'ऐसा', 'असं', 'वगैरे',
  // Romanised, for the mixed-script transcripts Whisper often produces
  'matlab', 'yaani', 'mhanje', 'achha', 'arre', 'yaar',
])
const FILLER_INITIAL_DEV = new Set(['तो', 'वो', 'तर', 'आता', 'हां', 'हाँ'])
const FILLER_PHRASE_DEV = [
  ['क्या', 'कहते'],
  ['काय', 'म्हणतात'],
  ['ऐसा', 'है'],
]

/**
 * Strip punctuation for comparison while KEEPING the Devanagari block. The old
 * `[^a-z']` version erased every Hindi and Marathi word to an empty string,
 * which silently disabled filler detection for both languages.
 */
const bare = (t) => (t || '').toLowerCase().replace(/[^a-z'\u0900-\u097F]/g, '')

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

/**
 * Sentence-terminal punctuation, all scripts we support.
 *
 * Devanagari ends a sentence with the danda । (U+0964), and a verse or formal
 * passage with the double danda ॥ (U+0965). Splitting on [.!?] alone gave Hindi
 * and Marathi ONE sentence per clip, which then broke everything built on
 * sentence boundaries: candidate generation, retake detection, caption lines
 * and the cut-on-a-sentence-edge rule.
 */
export const TERMINAL_PUNCT = /[.!?।॥]["')\]]?$/

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
    const terminal = TERMINAL_PUNCT.test(w.text)
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
      for (const ph of [...FILLER_PHRASE, ...FILLER_PHRASE_DEV]) {
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

      if (FILLER_SINGLE.has(b) || FILLER_SINGLE_DEV.has(b)) {
        fillers.push({ text: ws[i].text, start: ws[i].start, end: ws[i].end })
      } else if ((FILLER_INITIAL.has(b) || FILLER_INITIAL_DEV.has(b)) && i === 0) {
        fillers.push({ text: ws[i].text, start: ws[i].start, end: ws[i].end })
      }
    }
  }
  return fillers
}

function normalize(chunks, fullText, duration, meta = {}) {
  const words = toWords(chunks, duration)
  const sentences = toSentences(words)
  const fillers = findFillers(sentences)
  const text = (fullText || words.map((w) => w.text).join(' ')).trim()

  // Did we get back the script we asked for? Reported, never acted on — the
  // transcript may still be usable, and silently discarding it would be worse.
  const script = detectScript(text)
  const lang = getLanguage(meta.language)
  const expected = lang?.script || null
  const scriptMismatch =
    expected && script !== 'unknown' && script !== 'mixed' && script !== expected
      ? { expected, got: script, language: lang.code }
      : null

  return {
    words,
    sentences,
    fillers,
    text,
    language: meta.language || DEFAULT_LANGUAGE,
    model: meta.model || null,
    tier: meta.tier || DEFAULT_TIER,
    script,
    scriptMismatch,
  }
}

// ---- public API -----------------------------------------------------

/**
 * Transcribe one clip.
 *
 * @param {object} clip
 * @param {(p:{pct:number,msg:string})=>void} onProgress
 * @param {{language?:string, tier?:string}} [opts]  language is a code from
 *        LANGUAGES ('en'|'hi'|'mr'|'auto'); tier is 'fast'|'accurate'.
 * @returns {Promise<{words,sentences,fillers,text,language,model,tier,script,scriptMismatch}>}
 *          Fillers are surfaced, never auto-removed.
 */
export async function transcribeClip(clip, onProgress = () => {}, opts = {}) {
  onProgress({ pct: 0, msg: 'Extracting audio…' })
  const audio = await extractAudioForWhisper(clip.file)

  const worker = getWorker()
  const id = `${clip.id}:${Date.now().toString(36)}`
  const langCode = opts.language || clip.language || DEFAULT_LANGUAGE
  const lang = getLanguage(langCode)
  const tier = MODEL_TIERS.some((t) => t.id === opts.tier) ? opts.tier : DEFAULT_TIER
  const tierInfo = MODEL_TIERS.find((t) => t.id === tier)
  onProgress({ pct: 6, msg: `Loading ${tierInfo.label.toLowerCase()} speech model…` })

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
            msg: `Downloading ${tierInfo.label.toLowerCase()} speech model (~${tierInfo.sizeMB}MB, one time)…`,
          })
        } else if (m.message) {
          onProgress({ pct: 8, msg: m.message })
        }
      },
    })
    // transfer the PCM buffer so it isn't copied
    worker.postMessage(
      // lang.whisper is null for auto-detect, and the worker omits the option
      // entirely in that case rather than passing a null through to Whisper.
      { type: 'transcribe', id, audio, language: lang.whisper, tier },
      [audio.buffer],
    )
  })

  onProgress({ pct: 94, msg: 'Formatting transcript…' })
  const out = normalize(result.chunks, result.text, clip.duration, {
    language: langCode,
    model: result.model,
    tier,
  })
  onProgress({ pct: 100, msg: 'Transcript ready' })
  return out
}

/**
 * Transcribe many clips ONE AT A TIME. Same memory reason as analyzeAll —
 * parallel decode + model inference blows the tab.
 * @returns {Promise<Map<string, object>>} clipId -> transcript (or { error })
 */
export async function transcribeAll(clips, onProgress = () => {}, opts = {}) {
  const out = new Map()
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]
    try {
      out.set(
        c.id,
        await transcribeClip(
          c,
          (p) => onProgress({ ...p, clipId: c.id, index: i, total: clips.length }),
          opts,
        ),
      )
    } catch (err) {
      out.set(c.id, {
        error: err.message,
        words: [],
        sentences: [],
        fillers: [],
        text: '',
        language: opts.language || DEFAULT_LANGUAGE,
      })
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
