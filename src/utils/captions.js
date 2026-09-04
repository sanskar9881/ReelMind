// captions.js — build caption cues from transcript word timings, remap them
// onto the rendered output timeline, and export SRT / VTT.
//
// The transcript already carries word-level timestamps, so this is almost free.
// The load-bearing step is remapToOutputTimeline: source timestamps are per-clip
// and pre-edit; the render reorders segments and drops cut ranges. Captions
// built on raw source time are badly out of sync with the finished video.

const DEFAULTS = {
  maxCharsPerLine: 38,
  maxLines: 2,
  minDurationS: 0.8,
  maxDurationS: 4,
}

// Greedy word-wrap into at most `maxLines` lines of `maxChars`. Never splits a
// word. Returns the lines actually used (may be fewer than maxLines).
function wrapLines(words, maxChars, maxLines) {
  const lines = []
  let cur = ''
  for (const w of words) {
    const t = w.text
    if (!cur) {
      cur = t
    } else if ((cur + ' ' + t).length <= maxChars) {
      cur += ' ' + t
    } else {
      lines.push(cur)
      cur = t
      if (lines.length === maxLines) break
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur)
  return lines
}

const isTerminal = (t) => /[.!?…]["')\]]?$/.test(String(t || ''))

/**
 * @param {{words?:{text,start,end}[], sentences?:object[]}} transcript
 * @param {object} [opts]
 * @returns {{start:number,end:number,lines:string[],words:{text,start,end}[]}[]}
 */
export function buildCaptions(transcript, opts = {}) {
  const o = { ...DEFAULTS, ...opts }
  const words = (transcript?.words || []).filter(
    (w) => w && typeof w.start === 'number' && typeof w.end === 'number' && w.text,
  )
  if (!words.length) return []

  // Word indices that close a sentence (by transcript.sentences timing).
  const sentenceEnd = new Set()
  for (const s of transcript?.sentences || []) {
    const sw = s.words || []
    const last = sw[sw.length - 1]
    if (!last) continue
    const gi = words.findIndex((w) => w.start === last.start && w.text === last.text)
    if (gi >= 0) sentenceEnd.add(gi)
  }

  const budget = o.maxCharsPerLine * o.maxLines
  const cues = []
  let group = []

  const flush = () => {
    if (!group.length) return
    const lines = wrapLines(group, o.maxCharsPerLine, o.maxLines)
    const start = group[0].start
    let end = group[group.length - 1].end
    if (end - start > o.maxDurationS) end = start + o.maxDurationS
    cues.push({
      start,
      end,
      lines,
      words: group.map((w) => ({ text: w.text, start: w.start, end: w.end })),
    })
    group = []
  }

  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const prev = words[i - 1]

    // Break BEFORE this word: a gap in speech, or this word would overflow.
    if (group.length) {
      const gap = prev ? w.start - prev.end : 0
      const projected = group.map((g) => g.text).concat(w.text).join(' ').length
      if (gap > 0.5 || projected > budget) flush()
    }

    group.push(w)

    // Break AFTER this word: sentence end, or the cue has run long enough.
    if (isTerminal(w.text) || sentenceEnd.has(i)) flush()
    else if (w.end - group[0].start >= o.maxDurationS) flush()
  }
  flush()

  // Enforce minimum duration by extending into the following gap only — never
  // over the next cue's start.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]
    if (c.end - c.start < o.minDurationS) {
      const nextStart = i + 1 < cues.length ? cues[i + 1].start : Infinity
      c.end = Math.min(c.start + o.minDurationS, nextStart)
    }
  }

  return cues
}

/**
 * Map per-clip, source-time cues onto the rendered output timeline.
 *
 * @param {Object<string,object[]>} cuesByClip   clipId -> cues (from buildCaptions)
 * @param {{segments:object[], excludeRanges?:object[]}} plan
 * @param {{transitionDuration?:number}} [opts]  0 for the FFmpeg concat path
 * @returns {{start:number,end:number,lines:string[],words:object[]}[]}  output-time cues, sorted
 */
export function remapToOutputTimeline(cuesByClip, plan, opts = {}) {
  const transitionSec = opts.transitionDuration ?? 0.5
  const segs = plan?.segments || []
  const excludes = plan?.excludeRanges || []
  const out = []
  let outCursor = 0

  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si]
    const segLen = Math.max(0, seg.end - seg.start)
    if (si > 0 && seg.transition && seg.transition !== 'cut') {
      outCursor -= Math.min(transitionSec, segLen / 2)
    }

    // Kept sub-intervals of [seg.start, seg.end] after removing this clip's
    // exclude ranges, each with the output time it begins at.
    const inside = excludes
      .filter((e) => (e.clipId != null ? e.clipId === seg.clipId : true))
      .map((e) => [Math.max(seg.start, +e.start), Math.min(seg.end, +e.end)])
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0])

    const kept = []
    let cur = seg.start
    for (const [a, b] of inside) {
      if (a > cur) kept.push([cur, a])
      cur = Math.max(cur, b)
    }
    if (cur < seg.end) kept.push([cur, seg.end])
    if (!kept.length && !inside.length) kept.push([seg.start, seg.end])

    let acc = outCursor
    const mapped = kept.map(([a, b]) => {
      const m = { a, b, outStart: acc }
      acc += b - a
      return m
    })

    for (const cue of cuesByClip[seg.clipId] || []) {
      for (const k of mapped) {
        const s = Math.max(cue.start, k.a)
        const e = Math.min(cue.end, k.b)
        if (e - s < 0.05) continue // no meaningful overlap — dropped or clipped away
        out.push({
          start: k.outStart + (s - k.a),
          end: k.outStart + (e - k.a),
          lines: cue.lines,
          words: (cue.words || [])
            .filter((w) => w.end > k.a && w.start < k.b)
            .map((w) => ({
              text: w.text,
              start: k.outStart + (Math.max(w.start, k.a) - k.a),
              end: k.outStart + (Math.min(w.end, k.b) - k.a),
            })),
        })
      }
    }

    outCursor = acc // advance by the KEPT length, not the raw segment length
  }

  out.sort((x, y) => x.start - y.start)
  return out
}

// ---- export --------------------------------------------------------------

function stamp(t, sep) {
  const ms = Math.max(0, Math.round(t * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const rem = ms % 1000
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(rem, 3)}`
}

export function toSRT(cues) {
  return (
    cues
      .map(
        (c, i) =>
          `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${c.lines.join('\n')}\n`,
      )
      .join('\n') || ''
  )
}

export function toVTT(cues) {
  return (
    'WEBVTT\n\n' +
    cues
      .map((c) => `${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.lines.join('\n')}\n`)
      .join('\n')
  )
}
