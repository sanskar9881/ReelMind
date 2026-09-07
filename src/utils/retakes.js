// retakes.js — detect literal retakes: a line said, disliked, and said again.
//
// No model. Weighted token-overlap (Jaccard with rare-token weighting) is enough
// for word-for-word-ish retakes and needs no extra download. It will NOT catch a
// paraphrased second attempt — that is deliberate; paraphrase detection needs an
// embedding model and produces false positives across a normal monologue.

const FILLER_SINGLE = new Set([
  'um', 'uh', 'er', 'ah', 'like', 'basically', 'literally', 'actually', 'right', 'so',
])
const FILLER_BIGRAMS = [
  ['you', 'know'],
  ['i', 'mean'],
  ['sort', 'of'],
  ['kind', 'of'],
]

/**
 * lowercase, strip punctuation, collapse whitespace, drop filler words.
 * @returns {string[]} token array
 */
export function normalize(text) {
  const raw = String(text || '')
    .toLowerCase()
    // Keep the Devanagari block: stripping it left Hindi and Marathi sentences
    // as empty token lists, so every pair scored 0 overlap and retake detection
    // quietly did nothing for those languages.
    .replace(/[^a-z0-9'\s\u0900-\u097F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)

  const out = []
  for (let i = 0; i < raw.length; i++) {
    let bigram = false
    for (const [a, b] of FILLER_BIGRAMS) {
      if (raw[i] === a && raw[i + 1] === b) {
        i++ // consume both
        bigram = true
        break
      }
    }
    if (bigram) continue
    if (FILLER_SINGLE.has(raw[i])) continue
    out.push(raw[i])
  }
  return out
}

/**
 * Token-level Jaccard on normalized tokens, weighting rare tokens higher:
 * each token contributes 1 / log(1 + df). Two sentences that only share "the"
 * and "and" score near zero.
 *
 * @param {string|string[]} a
 * @param {string|string[]} b
 * @param {Map<string,number>} [df]  token -> document frequency across the clip.
 *   When omitted, every token is weighted equally (plain Jaccard).
 * @returns {number} 0..1
 */
export function similarity(a, b, df) {
  const ta = Array.isArray(a) ? a : normalize(a)
  const tb = Array.isArray(b) ? b : normalize(b)
  if (!ta.length || !tb.length) return 0

  const sa = new Set(ta)
  const sb = new Set(tb)
  const weight = (tok) => (df ? 1 / Math.log(1 + Math.max(1, df.get(tok) || 1)) : 1)

  let inter = 0
  let union = 0
  const seen = new Set()
  for (const tok of [...sa, ...sb]) {
    if (seen.has(tok)) continue
    seen.add(tok)
    const w = weight(tok)
    union += w
    if (sa.has(tok) && sb.has(tok)) inter += w
  }
  return union ? inter / union : 0
}

function documentFrequency(normSentences) {
  const df = new Map()
  for (const toks of normSentences) {
    for (const tok of new Set(toks)) df.set(tok, (df.get(tok) || 0) + 1)
  }
  return df
}

// Fillers derived from the sentence's own words — findRetakes only gets
// `sentences`, not the full transcript, so it can't rely on transcript.fillers.
function deriveFillers(sentences) {
  const out = []
  for (const s of sentences) {
    for (const w of s.words || []) {
      const bare = String(w.text).toLowerCase().replace(/[^a-z'\u0900-\u097F]/g, '')
      if (FILLER_SINGLE.has(bare)) out.push({ text: w.text, start: w.start, end: w.end })
    }
  }
  return out
}

/**
 * @param {{text,start,end,words?}[]} sentences  clip sentences, sorted by start
 * @param {{window?:number, threshold?:number, minWords?:number}} [opts]
 * @returns {{id:string, takes:{sentenceIndex,text,start,end,score}[], recommended:number}[]}
 */
export function findRetakes(sentences, opts = {}) {
  const { window = 90, threshold = 0.62, minWords = 4 } = opts
  if (!Array.isArray(sentences) || sentences.length < 2) return []

  const norm = sentences.map((s) => normalize(s.text))
  const df = documentFrequency(norm)

  const n = sentences.length
  const parent = Array.from({ length: n }, (_, i) => i)
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const union = (i, j) => {
    const ri = find(i)
    const rj = find(j)
    if (ri !== rj) parent[rj] = ri
  }

  const pairScore = new Map() // "i:j" (i<j) -> similarity

  for (let i = 0; i < n; i++) {
    if (norm[i].length < minWords) continue
    for (let j = i + 1; j < n; j++) {
      // Retakes are adjacent in time — stop once we leave the window. This also
      // keeps the comparison from going O(n^2) across unrelated topics.
      if (sentences[j].start - sentences[i].start > window) break
      if (norm[j].length < minWords) continue
      const sc = similarity(norm[i], norm[j], df)
      if (sc >= threshold) {
        union(i, j)
        pairScore.set(`${i}:${j}`, sc)
      }
    }
  }

  const clusters = new Map() // root -> indices[]
  for (let i = 0; i < n; i++) {
    const r = find(i)
    if (!clusters.has(r)) clusters.set(r, [])
    clusters.get(r).push(i)
  }

  const fillers = deriveFillers(sentences)
  const groups = []
  let gid = 0
  for (const members of clusters.values()) {
    if (members.length < 2) continue
    members.sort((x, y) => sentences[x].start - sentences[y].start)

    const takes = members.map((idx) => {
      let best = 0
      for (const other of members) {
        if (other === idx) continue
        const key = idx < other ? `${idx}:${other}` : `${other}:${idx}`
        best = Math.max(best, pairScore.get(key) ?? similarity(norm[idx], norm[other], df))
      }
      return {
        sentenceIndex: idx,
        text: sentences[idx].text,
        start: sentences[idx].start,
        end: sentences[idx].end,
        score: Number(best.toFixed(3)),
      }
    })

    const best = pickBestTake(takes, { sentences, fillers })
    groups.push({ id: `retake_${gid++}`, takes, recommended: best ? best.sentenceIndex : takes[takes.length - 1].sentenceIndex })
  }

  groups.sort((a, b) => a.takes[0].start - b.takes[0].start)
  return groups
}

/**
 * Score each take and return the best.
 * +0.4 last take · +0.3·(1 - fillerRatio) · +0.2 no stumble · +0.1 longest.
 *
 * @param {{sentenceIndex,text,start,end,score}[]} takes
 * @param {{sentences?:object[], fillers?:{start,end}[], words?:object[]}} [transcript]
 */
export function pickBestTake(takes, transcript = {}) {
  if (!takes || !takes.length) return null
  if (takes.length === 1) return takes[0]

  const sentences = transcript.sentences || []
  const fillers = transcript.fillers || []

  const wordsOf = (t) => sentences[t.sentenceIndex]?.words || null

  const wordCount = (t) => {
    const ws = wordsOf(t)
    if (ws?.length) return ws.length
    return Math.max(1, normalize(t.text).length)
  }

  const fillerCount = (t) => {
    if (fillers.length) {
      return fillers.filter((f) => f.start >= t.start - 0.05 && f.end <= t.end + 0.05).length
    }
    const ws = wordsOf(t)
    if (ws) {
      return ws.filter((w) =>
        FILLER_SINGLE.has(String(w.text).toLowerCase().replace(/[^a-z'\u0900-\u097F]/g, '')),
      ).length
    }
    return (t.text.toLowerCase().match(/\b(um|uh|er|ah|like|basically|literally|actually|right|so)\b/g) || []).length
  }

  const maxGap = (t) => {
    const ws = wordsOf(t)
    if (!ws || ws.length < 2) return 0
    let g = 0
    for (let i = 1; i < ws.length; i++) g = Math.max(g, ws[i].start - ws[i - 1].end)
    return g
  }

  const lastStart = Math.max(...takes.map((t) => t.start))
  const longest = Math.max(...takes.map((t) => t.end - t.start))

  let winner = takes[0]
  let winnerScore = -Infinity
  for (const t of takes) {
    let s = 0
    if (t.start === lastStart) s += 0.4 // people redo until satisfied
    s += 0.3 * (1 - fillerCount(t) / wordCount(t))
    if (maxGap(t) <= 0.8) s += 0.2 // no stumbling
    if (t.end - t.start >= longest - 1e-6) s += 0.1 // most complete
    if (s > winnerScore) {
      winnerScore = s
      winner = t
    }
  }
  return winner
}

/**
 * A take's own range stops at its last word — the breath and the "ugh, again"
 * pause that follow are still there. When a take is being *excluded*, extend its
 * end to the start of the next sentence so that dead air goes with it.
 *
 * @param {{start:number,end:number,sentenceIndex:number}} take
 * @param {{start:number,end:number}[]} sentences  the clip's full sentence list
 * @param {number} [maxExtend]  cap on how much trailing air to absorb (seconds)
 * @returns {{start:number,end:number}}  the widened range
 */
export function extendTakeRange(take, sentences, maxExtend = 1.5) {
  const next = Array.isArray(sentences) ? sentences[take.sentenceIndex + 1] : null
  const hardEnd = take.end + maxExtend
  const end = next ? Math.min(next.start, hardEnd) : hardEnd
  return { start: take.start, end: Math.max(take.end, end) }
}
