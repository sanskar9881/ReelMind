// candidates.js — the selection engine behind the planner.
//
// The old planner walked each clip and took a chunk from near its start. That
// captures framing, lens caps and throat-clearing, and it never sees the good
// bit at 04:12. This replaces that shape entirely:
//
//     generate candidates across ALL footage
//       -> score every one
//         -> select the best that fit the target duration
//           -> order them narratively
//
// Nothing here calls a model. It produces the *shortlist* — either the offline
// plan directly, or the scored menu Claude makes the editorial call from.

// ---- weights ---------------------------------------------------------------
// Tuning happens here. The Candidates panel in the editor exists to show what a
// change to these numbers actually rejects.

/** Top-level mix. Renormalised when a group is unavailable (see scoreCandidate). */
export const WEIGHTS = {
  content: 0.45, // speech — only when a transcript exists
  audio: 0.2,
  visual: 0.2,
  position: 0.15,
}

/** Sub-weights inside the CONTENT group. */
export const CONTENT_WEIGHTS = {
  speechDensity: 0.3,
  informationDensity: 0.3,
  sentenceCompleteness: 0.25,
  isQuestionOrClaim: 0.15,
}

export const AUDIO_WEIGHTS = { energy: 0.65, silence: 0.35 }

/**
 * What the CONTENT group scores for a candidate with no speech, in a project
 * that HAS speech elsewhere.
 *
 * Without this, dropping the group and renormalising hands silent b-roll a
 * perfect content-free score, and it beats every spoken line — the planner then
 * builds a talking-head vlog out of the shots where nobody is talking. B-roll
 * still earns its place on audio and picture; it just no longer wins by default.
 *
 * When NOTHING in the project has a transcript, the group is genuinely
 * inapplicable and is renormalised away instead.
 */
export const NO_SPEECH_CONTENT = 0.45
export const VISUAL_WEIGHTS = { motion: 0.4, contrast: 0.3, exposure: 0.3 }

/** Candidate geometry. */
export const LIMITS = {
  minSeconds: 0.7, // matches the renderer's floor; scaled down on short clips (minSegmentSecondsFor)
  maxSeconds: 30, // a 3-sentence group can run long; past this it is not a "moment"
  maxCandidates: 400, // past this, scoring hundreds of clips gets slow
  sentenceWindow: 3, // 1..3 consecutive sentences
  noSpeechMin: 2, // sliding window bounds without a transcript
  noSpeechMax: 8,
  noSpeechStep: 1,
  snapTolerance: 0.5, // how far a boundary may move to reach an onset
  absoluteMinSeconds: 0.4, // the segment length nothing goes below, however short the clip
}

/** The first slice of any clip is setup. This is where the old planner lived. */
export const POSITION = {
  headFraction: 0.08,
  headScore: 0.12, // strong penalty
  tailFraction: 0.97,
  tailScore: 0.6, // mild — reaching for the stop button
  bodyScore: 1,
}

/**
 * How much of the footage an unstated-length edit keeps.
 *
 * A flat ratio is wrong at both ends of the scale: short footage is already
 * dense (a 15s clip is one moment, and keeping a fifth of it returns a
 * fragment), long footage is mostly filler. These are anchor points, linearly
 * interpolated, so 29s and 31s of footage behave the same instead of stepping.
 *
 * The anchors are placed so each band stated in the spec holds inside its own
 * range: <30s ≈ .85, 30s-2min ≈ .60, 2-10min ≈ .35, 10-30min ≈ .22, >30min .15.
 */
export const KEEP_RATIO_ANCHORS = [
  [30, 0.85],
  [120, 0.6],
  [360, 0.35],
  [600, 0.22],
  [1800, 0.15],
]

/** Interpolated keep ratio for a given amount of raw footage. */
export function keepRatioFor(footageSeconds) {
  const f = Number.isFinite(footageSeconds) ? Math.max(0, footageSeconds) : 0
  const A = KEEP_RATIO_ANCHORS
  if (f <= A[0][0]) return A[0][1]
  for (let i = 1; i < A.length; i++) {
    const [x0, y0] = A[i - 1]
    const [x1, y1] = A[i]
    if (f <= x1) return y0 + ((f - x0) / (x1 - x0)) * (y1 - y0)
  }
  return A[A.length - 1][1]
}

/**
 * A clip shorter than this is ONE moment, not a reel of them. Fragmenting a
 * 15-second clip into 3-second cuts destroys it, so the default is a single
 * continuous segment with the setup trimmed off the head and the reach-for-the-
 * stop-button off the tail. Fragmenting is opt-in: the prompt asks for fast
 * cutting, or analysis found an internal silence long enough to be worth cutting.
 */
export const SHORT_CLIP = {
  thresholdSeconds: 20,
  headFraction: 0.12,
  headMaxSeconds: 3,
  tailFraction: 0.08,
  tailMaxSeconds: 2,
  minKeepFraction: 0.5, // never trim a short clip below half of itself
  silenceSeconds: 1.5, // an internal gap this long justifies cutting it out
}

/** Head/tail trim for a short clip's single continuous segment. */
export function shortClipTrim(duration) {
  const head = Math.min(duration * SHORT_CLIP.headFraction, SHORT_CLIP.headMaxSeconds)
  const tail = Math.min(duration * SHORT_CLIP.tailFraction, SHORT_CLIP.tailMaxSeconds)
  let start = head
  let end = duration - tail
  const floor = duration * SHORT_CLIP.minKeepFraction
  if (end - start < floor) {
    const mid = duration / 2
    start = Math.max(0, mid - floor / 2)
    end = Math.min(duration, mid + floor / 2)
  }
  return { start: +start.toFixed(3), end: +end.toFixed(3) }
}

/** Selection constraints, so one strong clip cannot become the whole edit. */
export const SELECTION = {
  secondsPerClipSlot: 20, // maxPerClip = ceil(target / 20) on long clips
  minGapWithinClip: 3,
  fillRatio: 0.9, // below this fraction of target, start relaxing
  /**
   * Quality floor, as a fraction of the best candidate's score. Selection stops
   * here even when the target length is unmet.
   *
   * Footage that is mostly dead air genuinely cannot fill 20% of its own
   * runtime with good material, and the alternative to stopping is padding the
   * edit with "um, so, like, basically" until the clock says 3:00. Coming in
   * short is the correct answer, and it is the same rule the prompt gives
   * Claude: being under is better than padding with weak material.
   */
  minScoreRatio: 0.7,
  /** What minGapWithinClip relaxes DOWN to, never to zero. See mergeAbutting. */
  relaxedGap: 1,
}

/**
 * Per-clip constraints. All three used to be flat numbers tuned for hours of
 * footage, and on a 15-second clip they collectively allowed exactly one
 * segment: ceil(target/20) == 1 slot, a 3s gap wider than anything that fits,
 * and a 0.7s floor sized for a long take.
 */
export function maxPerClipFor(clipDuration, targetDuration) {
  const d = Number.isFinite(clipDuration) ? clipDuration : Infinity
  if (d < 20) return 3
  if (d <= 60) return 4
  return Math.max(2, Math.ceil((targetDuration || 0) / SELECTION.secondsPerClipSlot))
}

/** Minimum spacing between two selections inside one clip. */
export function minGapFor(clipDuration) {
  const d = Number.isFinite(clipDuration) ? clipDuration : Infinity
  return Math.min(SELECTION.minGapWithinClip, d * 0.12)
}

/** Shortest usable segment for a clip of this length — never below 0.4s. */
export function minSegmentSecondsFor(clipDuration) {
  const d = Number.isFinite(clipDuration) ? clipDuration : Infinity
  return Math.max(LIMITS.absoluteMinSeconds, Math.min(LIMITS.minSeconds, d * 0.06))
}

/**
 * Does this short clip earn being cut into pieces? Only if the prompt asked for
 * fast cutting, or there is an internal silence long enough that removing it is
 * the point of the cut. Otherwise it stays one continuous shot.
 */
export function shouldFragmentShortClip(cx, opts = {}) {
  if (opts.fastCut) return true
  const d = cx?.duration || 0
  return (cx?.silences || []).some(
    (sil) =>
      sil.end - sil.start >= SHORT_CLIP.silenceSeconds && sil.start > 0.5 && sil.end < d - 0.5,
  )
}

/**
 * Two selected windows that abut in the same clip are one continuous shot, not
 * two cuts — the renderer plays them back to back with nothing between. Merging
 * them keeps the shot count honest (11 "shots" that are really one 55-second
 * take is a lie the timeline then repeats) and keeps the cut list clean.
 */
export const ABUT_GAP = 0.3

/**
 * Below this information density, the CONTENT group is gated down hard rather
 * than merely scoring one of its four signals at zero. A run of words that are
 * ALL filler and stopwords is not a low-value moment, it is a non-moment — but
 * it still has healthy audio, picture and position, which between them were
 * enough to carry it into the edit.
 */
export const INFO_GATE = { floor: 0.25, minMultiplier: 0.25 }

const clamp01 = (n) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0)

// ---- language tables -------------------------------------------------------

const STOPWORDS = new Set(
  ('a an the and or but so if then than that this these those there here it its it\'s ' +
    'i me my we our you your he she they them his her their of in on at to for with from ' +
    'by as is am are was were be been being do does did doing have has had having will ' +
    'would can could should may might must just really very much some any all no not ' +
    'about into over under out up down off again more most other into')
    .split(' '),
)

/** Verbal filler that carries no information even when Whisper transcribes it. */
const FILLER_WORDS = new Set([
  'um', 'uh', 'erm', 'ah', 'eh', 'hmm', 'mm', 'like', 'basically', 'literally',
  'actually', 'obviously', 'anyway', 'okay', 'ok', 'yeah', 'yep', 'right',
])

/** Hook language — a claim or a question is worth more than a description. */
const HOOK_PHRASES = [
  'the thing is', 'what i found', "here's why", 'heres why', 'turns out',
  'the problem is', "here's the thing", 'the trick is', 'what surprised me',
  'the reason', 'i realised', 'i realized', 'nobody tells you', 'the truth is',
]

/** Closing language — used to find an outro, never to score a candidate up. */
const CLOSING_PHRASES = [
  'thanks for watching', 'thank you for watching', 'see you', 'see ya',
  "that's it", 'thats it', 'let me know', 'subscribe', 'next video',
  'catch you', 'until next time', 'wrap', 'in the comments',
]

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim()

const hasAny = (text, phrases) => {
  const t = norm(text)
  return phrases.some((p) => t.includes(p))
}

const median = (nums) => {
  if (!nums.length) return 0
  const a = [...nums].sort((x, y) => x - y)
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

const overlaps = (a, b) => a.clipId === b.clipId && a.start < b.end && a.end > b.start

// ---- per-clip baselines ----------------------------------------------------

/**
 * Everything a candidate is scored *relative to* — its own clip, never an
 * absolute. Quietly-recorded footage and a shouty vlog both get a fair reading.
 *
 * @returns {Map<string, object>} clipId -> baselines
 */
export function buildContext(clips, analysis, transcripts) {
  const A = analysis instanceof Map ? analysis : new Map(Object.entries(analysis || {}))
  const T = transcripts instanceof Map ? transcripts : new Map(Object.entries(transcripts || {}))
  const ctx = new Map()
  // Whether ANY clip in the project has speech — see NO_SPEECH_CONTENT.
  const projectHasSpeech = clips.some((c) => {
    const tr = T.get(c.id)
    return !!(tr && !tr.error && tr.sentences?.length)
  })

  for (const c of clips) {
    const a = A.get(c.id)
    const tr = T.get(c.id)
    const ok = a && !a.error

    // Median words-per-second across sentences, so "dense for this speaker" is
    // measurable. A mean would be dragged around by one long pause.
    let medianWps = 0
    if (tr && !tr.error && tr.sentences?.length) {
      medianWps = median(
        tr.sentences
          .map((s) => (s.words?.length || 0) / Math.max(0.25, s.end - s.start))
          .filter((n) => Number.isFinite(n) && n > 0),
      )
    }

    const audioWindows = ok ? a.audio?.windows || [] : []
    const motionWindows = ok ? a.motion?.windows || [] : []

    ctx.set(c.id, {
      duration: c.duration,
      projectHasSpeech,
      medianWps,
      hasTranscript: !!(tr && !tr.error && tr.sentences?.length),
      // Mean audio level of the whole clip — a candidate is "loud" only against this.
      baselineLevel: audioWindows.length
        ? audioWindows.reduce((s, w) => s + (w.level || 0), 0) / audioWindows.length
        : 0,
      baselineMotion: ok ? a.motionAvg || 0 : 0,
      // Older persisted analyses predate the luma pass; 0.5/0.5 reads as neutral
      // rather than as a bad picture.
      lumaAvg: ok && Number.isFinite(a.lumaAvg) ? a.lumaAvg : 0.5,
      contrastAvg: ok && Number.isFinite(a.contrastAvg) ? a.contrastAvg : 0.5,
      hasVisual: ok && motionWindows.length > 0,
      hasAudio: ok && !!a.audio?.hasAudio && audioWindows.length > 0,
      audioWindows,
      motionWindows,
      silences: ok ? a.audio?.silences || [] : [],
      onsets: ok ? findOnsets(audioWindows, motionWindows) : [],
    })
  }
  return ctx
}

/**
 * Timestamps where the footage changes character — an audio level step up, or a
 * motion spike. Without a transcript these are the only honest cut points.
 */
export function findOnsets(audioWindows, motionWindows) {
  const out = []
  for (let i = 1; i < audioWindows.length; i++) {
    const prev = audioWindows[i - 1].level || 0
    const cur = audioWindows[i].level || 0
    if (cur - prev > 0.18 && cur > 0.2) out.push(audioWindows[i].t)
  }
  for (let i = 1; i < motionWindows.length; i++) {
    const prev = motionWindows[i - 1].score || 0
    const cur = motionWindows[i].score || 0
    if (cur - prev > 0.04) out.push(motionWindows[i].t)
  }
  return [...new Set(out.map((t) => +t.toFixed(2)))].sort((a, b) => a - b)
}

const snap = (t, onsets, tol = LIMITS.snapTolerance) => {
  let best = t
  let bestD = tol + 1e-9
  for (const o of onsets) {
    const d = Math.abs(o - t)
    if (d < bestD) {
      bestD = d
      best = o
    }
  }
  return best
}

const insideExcluded = (clipId, start, end, excludeRanges) =>
  excludeRanges.some(
    (r) => r.clipId === clipId && start >= r.start - 0.01 && end <= r.end + 0.01,
  )

// ---- generation ------------------------------------------------------------

/**
 * Every plausible moment across ALL footage. Hundreds is expected and correct —
 * selection is what makes the edit, and it can only choose from what it sees.
 *
 * With a transcript: 1-3 consecutive sentences on a sliding window, so a strong
 * line is offered alone AND inside its surrounding thought. Boundaries land on
 * sentence edges, never mid-word.
 *
 * Without one: 2-8s windows stepping 1s, with edges snapped to audio onsets and
 * motion changes so a good moment is not missed by window alignment.
 *
 * @param {Array} clips
 * @param {Map|object} analysis  analyzer.js output keyed by clip id
 * @param {Map|object} transcripts
 * @param {{excludeRanges?: Array, maxCandidates?: number, context?: Map}} [opts]
 * @returns {{ candidates: Array, generated: number, context: Map }}
 */
export function generateCandidates(clips, analysis, transcripts, opts = {}) {
  const T = transcripts instanceof Map ? transcripts : new Map(Object.entries(transcripts || {}))
  const excludeRanges = opts.excludeRanges || []
  const cap = opts.maxCandidates ?? LIMITS.maxCandidates
  const context = opts.context || buildContext(clips, analysis, transcripts)

  const out = []

  for (const clip of clips) {
    const cx = context.get(clip.id)
    const tr = T.get(clip.id)
    const minLen = minSegmentSecondsFor(clip.duration)
    const isShort = clip.duration < SHORT_CLIP.thresholdSeconds
    const preferContinuous = isShort && !shouldFragmentShortClip(cx, opts)
    const tag = (c) => ({
      ...c,
      clipDuration: clip.duration,
      ...(preferContinuous ? { preferContinuous: true } : null),
    })

    // A short clip is one moment. Offer it whole (setup trimmed off the head,
    // the reach for the stop button off the tail) alongside its fragments —
    // selection prefers this one unless the clip earned being cut up.
    if (isShort) {
      let { start, end } = shortClipTrim(clip.duration)
      if (cx?.hasTranscript) {
        // Do not cut a sentence in half to save 0.4s of setup.
        const sents = tr.sentences
        const firstIn = sents.find((x) => x.end > start)
        const lastIn = [...sents].reverse().find((x) => x.start < end)
        if (firstIn && lastIn && lastIn.end > firstIn.start) {
          start = Math.max(0, Math.min(firstIn.start, start))
          end = Math.min(clip.duration, Math.max(lastIn.end, end))
        }
      }
      if (end - start >= minLen && !insideExcluded(clip.id, start, end, excludeRanges)) {
        out.push(
          tag({
            id: `${clip.id}:cont`,
            clipId: clip.id,
            clip: clip.name,
            start: +start.toFixed(3),
            end: +Math.min(end, clip.duration).toFixed(3),
            continuous: true,
            ...(cx?.hasTranscript
              ? {
                  text: tr.sentences
                    .filter((x) => x.start < end && x.end > start)
                    .map((x) => x.text)
                    .join(' ')
                    .trim(),
                }
              : null),
          }),
        )
      }
    }

    if (cx?.hasTranscript) {
      const sents = tr.sentences
      for (let i = 0; i < sents.length; i++) {
        for (let k = 1; k <= LIMITS.sentenceWindow && i + k <= sents.length; k++) {
          const group = sents.slice(i, i + k)
          const start = group[0].start
          const end = group[group.length - 1].end
          const len = end - start
          if (len < minLen || len > LIMITS.maxSeconds) continue
          if (insideExcluded(clip.id, start, end, excludeRanges)) continue
          out.push(tag({
            id: `${clip.id}:s${i}:${k}`,
            clipId: clip.id,
            clip: clip.name,
            start: +start.toFixed(3),
            end: +Math.min(end, clip.duration).toFixed(3),
            text: group.map((s) => s.text).join(' ').trim(),
            sentenceIndices: group.map((_, j) => i + j),
          }))
        }
      }
      continue
    }

    // No speech to cut on — slide a window and let the onsets place the edges.
    const onsets = cx?.onsets || []
    // On a short clip the 2s floor is most of the clip; scale the shortest
    // window down with it so a 6-second clip still offers real choices.
    const winMin = Math.max(minLen, Math.min(LIMITS.noSpeechMin, clip.duration * 0.15))
    for (
      let len = winMin;
      len <= LIMITS.noSpeechMax;
      len += LIMITS.noSpeechStep
    ) {
      for (let t = 0; t + len <= clip.duration + 1e-6; t += LIMITS.noSpeechStep) {
        let start = snap(t, onsets)
        let end = snap(t + len, onsets)
        if (end - start < minLen) {
          start = t
          end = Math.min(clip.duration, t + len)
        }
        end = Math.min(end, clip.duration)
        if (end - start < minLen || end - start > LIMITS.maxSeconds) continue
        if (insideExcluded(clip.id, start, end, excludeRanges)) continue
        out.push(tag({
          id: `${clip.id}:w${t.toFixed(0)}:${len.toFixed(1)}`,
          clipId: clip.id,
          clip: clip.name,
          start: +start.toFixed(3),
          end: +end.toFixed(3),
        }))
      }
    }
  }

  // Dedupe identical spans produced by different windows after snapping.
  const seen = new Set()
  const unique = []
  for (const c of out) {
    const key = `${c.clipId}|${c.start}|${c.end}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(c)
  }

  const generated = unique.length
  if (generated <= cap) return { candidates: unique, generated, context }

  // Over the cap. Sentence candidates are kept FIRST and whole: there are only
  // ~3 per sentence, they are the highest-value moments in the set, and ranking
  // them against sliding windows on a cheap proxy evicts almost all of them —
  // measured at 19 survivors out of 400 before this split, which quietly turned
  // a talking vlog into a b-roll reel.
  //
  // The sliding windows are the combinatorial part, so they are what the cap
  // actually bounds. They are ranked by a CHEAP proxy — position and mean audio
  // level, no per-word work — because the full score is the expensive pass this
  // cap exists to keep affordable.
  // Continuous short-clip candidates ride along with the sentence group: there
  // is at most one per clip, and it is the whole point of a short clip.
  const sentenceBased = unique.filter((c) => c.sentenceIndices || c.continuous)
  const windowed = unique.filter((c) => !c.sentenceIndices && !c.continuous)
  const rank = (list) =>
    list
      .map((c) => ({ c, p: prescore(c, context.get(c.clipId)) }))
      .sort((a, b) => b.p - a.p)
      .map((x) => x.c)

  if (sentenceBased.length >= cap) {
    return { candidates: rank(sentenceBased).slice(0, cap), generated, context }
  }
  const room = cap - sentenceBased.length
  return {
    candidates: [...sentenceBased, ...rank(windowed).slice(0, room)],
    generated,
    context,
  }
}

/** O(1)-ish stand-in for the real score, used only to enforce maxCandidates. */
function prescore(cand, cx) {
  if (!cx) return 0
  const pos = positionScore(cand, cx.duration)
  const level = meanOver(cx.audioWindows, cand.start, cand.end, 'level')
  const words = cand.text ? cand.text.split(/\s+/).length : 0
  return pos * 0.5 + clamp01(level / Math.max(0.05, cx.baselineLevel || 0.2)) * 0.3 + clamp01(words / 30) * 0.2
}

function meanOver(windows, start, end, key) {
  if (!windows?.length) return 0
  let sum = 0
  let n = 0
  for (const w of windows) {
    if (w.t < start) continue
    if (w.t > end) break
    sum += w[key] || 0
    n++
  }
  return n ? sum / n : 0
}

// ---- scoring ---------------------------------------------------------------

function positionScore(cand, duration) {
  if (!duration) return POSITION.bodyScore
  const rel = cand.start / duration
  if (rel < POSITION.headFraction) return POSITION.headScore
  if (rel > POSITION.tailFraction) return POSITION.tailScore
  return POSITION.bodyScore
}

function contentSignals(cand, transcript, cx) {
  const sents = transcript?.sentences || []
  const idxs = cand.sentenceIndices || []
  const group = idxs.map((i) => sents[i]).filter(Boolean)
  const words = group.flatMap((s) => s.words || [])
  const dur = Math.max(0.25, cand.end - cand.start)

  // 1. speech density, against this clip's own median rate.
  const wps = words.length / dur
  const speechDensity = cx.medianWps > 0 ? clamp01(wps / (cx.medianWps * 1.1)) : clamp01(wps / 2.5)

  // 2. information density — content words vs filler and stopwords.
  let content = 0
  for (const w of words) {
    const t = norm(w.text)
    if (!t) continue
    if (FILLER_WORDS.has(t) || STOPWORDS.has(t)) continue
    content++
  }
  const informationDensity = words.length ? clamp01(content / words.length / 0.55) : 0

  // 3. completeness. A lowercase opening word with no pause in front of it means
  //    the candidate starts mid-thought — the single clearest "do not cut here".
  const first = group[0]
  const firstWord = first?.words?.[0]?.text || ''
  const startsLower = /^[a-z]/.test(firstWord)
  const prev = idxs.length ? sents[idxs[0] - 1] : null
  const precedingPause = prev ? cand.start - prev.end : Infinity
  let sentenceCompleteness = 1
  if (startsLower && precedingPause < 0.35) sentenceCompleteness = 0.1
  else if (startsLower) sentenceCompleteness = 0.55
  // A group that ends without terminal punctuation is also a dangling thought.
  const lastText = group[group.length - 1]?.text || ''
  if (!/[.!?]["')\]]?$/.test(lastText.trim())) sentenceCompleteness *= 0.75

  // 4. hook language.
  const text = cand.text || ''
  const isQuestionOrClaim = /\?\s*$/.test(text.trim()) || hasAny(text, HOOK_PHRASES) ? 1 : 0.35

  return { speechDensity, informationDensity, sentenceCompleteness, isQuestionOrClaim }
}

function audioSignals(cand, cx) {
  const level = meanOver(cx.audioWindows, cand.start, cand.end, 'level')
  const base = Math.max(0.03, cx.baselineLevel || 0.15)
  const energy = clamp01(level / (base * 1.25))

  // Internal dead air: what fraction of the candidate the analyzer called silent.
  const dur = Math.max(0.01, cand.end - cand.start)
  let quiet = 0
  for (const s of cx.silences) {
    const a = Math.max(s.start, cand.start)
    const b = Math.min(s.end, cand.end)
    if (b > a) quiet += b - a
  }
  const silence = clamp01(1 - (quiet / dur) * 1.6)

  return { energy, silence, silentFraction: +(quiet / dur).toFixed(3) }
}

function visualSignals(cand, cx) {
  const motionRaw = meanOver(cx.motionWindows, cand.start, cand.end, 'score')
  const motion = clamp01((motionRaw * 4) / Math.max(0.15, cx.baselineMotion * 4 + 0.35))

  const lumaRaw = cx.motionWindows.length
    ? meanOver(cx.motionWindows, cand.start, cand.end, 'luma') || cx.lumaAvg
    : cx.lumaAvg
  const contrastRaw = cx.motionWindows.length
    ? meanOver(cx.motionWindows, cand.start, cand.end, 'contrast') || cx.contrastAvg
    : cx.contrastAvg

  // Contrast: more is better up to ~0.28 SD, then it stops helping.
  const contrast = clamp01(contrastRaw / 0.28)

  // Exposure: full marks in the usable middle, falling off into crush and clip.
  let exposure = 1
  let verdict = 'ok'
  if (lumaRaw < 0.18) {
    exposure = clamp01(lumaRaw / 0.18) * 0.5
    verdict = 'dark'
  } else if (lumaRaw > 0.82) {
    exposure = clamp01((1 - lumaRaw) / 0.18) * 0.5
    verdict = 'bright'
  }

  return { motion, contrast, exposure, luma: +lumaRaw.toFixed(3), verdict }
}

/**
 * Score one candidate, 0-1. Every signal is relative to the candidate's own
 * clip, so a quiet clip is not uniformly beaten by a loud one.
 *
 * The CONTENT group only exists when there is a transcript; without one its
 * 0.45 is redistributed across the remaining groups rather than scored as zero,
 * which would make every b-roll clip look bad next to any talking one.
 *
 * @returns {{score:number, breakdown:object}} — breakdown is kept; the UI shows it.
 */
export function scoreCandidate(candidate, clip, analysis, transcript, context) {
  const cx =
    (context instanceof Map ? context.get(candidate.clipId) : context) || {
      duration: clip?.duration || 0,
      audioWindows: [],
      motionWindows: [],
      silences: [],
      baselineLevel: 0,
      baselineMotion: 0,
      lumaAvg: 0.5,
      contrastAvg: 0.5,
      medianWps: 0,
    }

  const hasContent = !!(candidate.sentenceIndices && transcript && !transcript.error)
  const groups = {}
  const parts = {}

  if (hasContent) {
    const c = contentSignals(candidate, transcript, cx)
    const gate =
      INFO_GATE.minMultiplier +
      (1 - INFO_GATE.minMultiplier) * clamp01(c.informationDensity / INFO_GATE.floor)
    c.infoGate = +gate.toFixed(3)
    parts.content = c
    groups.content =
      (c.speechDensity * CONTENT_WEIGHTS.speechDensity +
        c.informationDensity * CONTENT_WEIGHTS.informationDensity +
        c.sentenceCompleteness * CONTENT_WEIGHTS.sentenceCompleteness +
        c.isQuestionOrClaim * CONTENT_WEIGHTS.isQuestionOrClaim) *
      gate
  } else if (cx.projectHasSpeech) {
    groups.content = NO_SPEECH_CONTENT
    parts.content = { noSpeech: true, value: NO_SPEECH_CONTENT }
  }

  const a = audioSignals(candidate, cx)
  parts.audio = a
  groups.audio = a.energy * AUDIO_WEIGHTS.energy + a.silence * AUDIO_WEIGHTS.silence

  const v = visualSignals(candidate, cx)
  parts.visual = v
  groups.visual =
    v.motion * VISUAL_WEIGHTS.motion + v.contrast * VISUAL_WEIGHTS.contrast + v.exposure * VISUAL_WEIGHTS.exposure

  const position = positionScore(candidate, cx.duration)
  groups.position = position
  parts.position = { value: position, relative: cx.duration ? +(candidate.start / cx.duration).toFixed(3) : 0 }

  // Renormalise over the groups that actually applied.
  const active = Object.keys(groups)
  const totalWeight = active.reduce((s, k) => s + WEIGHTS[k], 0) || 1
  const score = clamp01(active.reduce((s, k) => s + groups[k] * WEIGHTS[k], 0) / totalWeight)

  return {
    score: +score.toFixed(4),
    breakdown: {
      groups: Object.fromEntries(active.map((k) => [k, +groups[k].toFixed(3)])),
      weights: Object.fromEntries(active.map((k) => [k, +(WEIGHTS[k] / totalWeight).toFixed(3)])),
      signals: parts,
      hasContent,
    },
  }
}

/** Score a whole candidate list. Returns a new array sorted by score desc. */
export function scoreAll(candidates, clips, analysis, transcripts, context) {
  const byId = new Map(clips.map((c) => [c.id, c]))
  const T = transcripts instanceof Map ? transcripts : new Map(Object.entries(transcripts || {}))
  const ctx = context || buildContext(clips, analysis, transcripts)
  return candidates
    .map((cand) => {
      const { score, breakdown } = scoreCandidate(
        cand,
        byId.get(cand.clipId),
        analysis,
        T.get(cand.clipId),
        ctx,
      )
      return { ...cand, score, breakdown }
    })
    .sort((a, b) => b.score - a.score)
}

// ---- selection -------------------------------------------------------------

/**
 * Greedy fill with diversity constraints — deliberately not top-N. Top-N picks
 * ten overlapping variants of the same great sentence and calls it an edit.
 *
 * Relaxation order matters: a stuttery double-cut inside one shot (minGap) is a
 * smaller sin than an edit that is 80% one clip (maxPerClip), so the gap goes
 * first. Whatever was relaxed is reported, never hidden.
 *
 * @returns {{selected:Array, totalDuration:number, relaxed:string[], maxPerClip:number, minGap:number}}
 */
export function selectCandidates(scored, targetDuration, opts = {}) {
  const durationOf = (cand) => (Number.isFinite(cand.clipDuration) ? cand.clipDuration : Infinity)

  // Per-clip now, not one number for the whole project: the constraints that
  // keep an hour of footage diverse are the ones that reduce a 15-second clip
  // to a single fragment.
  const slotsFor = (cand) => {
    if (opts.maxPerClip != null) return opts.maxPerClip
    if (cand.preferContinuous) return 1
    return maxPerClipFor(durationOf(cand), targetDuration)
  }
  const gapFor = (cand) => opts.minGapWithinClip ?? minGapFor(durationOf(cand))

  // Reported constraints — the flat numbers the panel used to show, resolved
  // against the longest clip in play so they still mean something.
  const maxPerClipBase = Math.max(1, ...scored.map(slotsFor).filter(Number.isFinite), 1)
  const minGapBase = scored.length ? Math.max(...scored.map(gapFor)) : SELECTION.minGapWithinClip

  // Relative, not absolute: a clip shot in a dim room scores lower across the
  // board, and an absolute floor would reject all of it.
  const best = scored.reduce((m, c) => Math.max(m, c.score || 0), 0)
  const floor = best * (opts.minScoreRatio ?? SELECTION.minScoreRatio)

  // A short clip's continuous take goes first, whatever the pacing bias did to
  // the order and regardless of the quality floor: the alternative to it is not
  // a better segment, it is the same clip chopped into fragments.
  const ordered = [
    ...scored.filter((c) => c.continuous && c.preferContinuous),
    ...scored.filter((c) => !(c.continuous && c.preferContinuous)),
  ]

  const attempt = (relaxGap, unlimited) => {
    const taken = []
    const perClip = new Map()
    let total = 0
    for (const cand of ordered) {
      if (total >= targetDuration) break
      const exempt = cand.continuous && cand.preferContinuous
      if (!exempt && (cand.score || 0) < floor) continue
      const len = cand.end - cand.start
      if (len < minSegmentSecondsFor(durationOf(cand))) continue
      if (taken.some((t) => overlaps(t, cand))) continue

      const mine = perClip.get(cand.clipId) || []
      const maxPerClip = unlimited && !cand.preferContinuous ? Infinity : slotsFor(cand)
      if (mine.length >= maxPerClip) continue
      const minGap = relaxGap ? Math.min(gapFor(cand), SELECTION.relaxedGap) : gapFor(cand)
      if (minGap > 0 && mine.some((t) => cand.start < t.end + minGap && cand.end + minGap > t.start)) {
        continue
      }

      taken.push(cand)
      mine.push(cand)
      perClip.set(cand.clipId, mine)
      total += len
    }
    return { taken, total }
  }

  const relaxed = []
  let { taken, total } = attempt(false, false)

  if (total < targetDuration * SELECTION.fillRatio) {
    relaxed.push('minGapWithinClip')
    ;({ taken, total } = attempt(true, false))
  }
  if (total < targetDuration * SELECTION.fillRatio) {
    relaxed.push('maxPerClip')
    ;({ taken, total } = attempt(true, true))
  }

  // When the gap constraint had to be relaxed to fill the target, the pieces it
  // let through sit a second apart inside one continuous take. Ten hard cuts
  // inside one unbroken b-roll shot is a stutter, not an edit — so fold across
  // the relaxed gap too, and the result is the single long shot it always was.
  const mergeGap = relaxed.includes('minGapWithinClip') ? SELECTION.relaxedGap : ABUT_GAP
  const merged = mergeAbutting(taken, mergeGap)

  return {
    selected: merged,
    totalDuration: +total.toFixed(3),
    mergedCount: taken.length - merged.length,
    relaxed,
    maxPerClip: maxPerClipBase,
    minGap: minGapBase,
    scoreFloor: +floor.toFixed(3),
    // True when the footage simply did not contain enough good material. The
    // planner reports this rather than padding to hit the number.
    underTarget: total < targetDuration * SELECTION.fillRatio,
  }
}

/**
 * Fold same-clip selections separated by less than ABUT_GAP into one segment.
 * The merged segment keeps the best member's id, score and breakdown — that is
 * the moment that earned the selection.
 */
export function mergeAbutting(selected, gap = ABUT_GAP) {
  const byClip = new Map()
  for (const c of selected) {
    if (!byClip.has(c.clipId)) byClip.set(c.clipId, [])
    byClip.get(c.clipId).push(c)
  }
  const out = []
  for (const list of byClip.values()) {
    list.sort((a, b) => a.start - b.start)
    let cur = null
    for (const c of list) {
      if (cur && c.start - cur.end <= gap) {
        const best = c.score > cur.score ? c : cur
        cur = { ...best, start: cur.start, end: Math.max(cur.end, c.end) }
        continue
      }
      if (cur) out.push(cur)
      cur = { ...c }
    }
    if (cur) out.push(cur)
  }
  return out
}

// ---- ordering --------------------------------------------------------------

/**
 * Hook first, body chronological, outro last.
 *
 * The body is NOT shuffled. A scrambled vlog reads worse than a raw one — the
 * only reordering that earns its keep is lifting the single strongest moment to
 * the front, which is the one decision that changes whether anyone keeps watching.
 *
 * @param {Array} selected  scored candidates
 * @param {{clipOrder?: string[]}} [opts]  clip ids in upload order
 */
export function orderSegments(selected, opts = {}) {
  if (!selected.length) return { segments: [], hookId: null, outroId: null }

  const order = new Map((opts.clipOrder || []).map((id, i) => [id, i]))
  const rank = (c) => (order.has(c.clipId) ? order.get(c.clipId) : 999)
  const chronological = (a, b) => rank(a) - rank(b) || a.start - b.start

  // Hook: the single best-scoring moment, wherever it came from.
  const hook = selected.reduce((best, c) => (c.score > best.score ? c : best), selected[0])
  const rest = selected.filter((c) => c !== hook).sort(chronological)

  // Outro: closing language, if any of it scored reasonably. Otherwise the last
  // chronological segment simply ends the video, which is what raw footage does.
  let outro = null
  if (rest.length) {
    const meanScore = rest.reduce((s, c) => s + c.score, 0) / rest.length
    const closers = rest.filter((c) => c.text && hasAny(c.text, CLOSING_PHRASES))
    outro = closers.find((c) => c.score >= meanScore * 0.75) || null
    if (!outro) outro = rest[rest.length - 1]
  }

  const body = rest.filter((c) => c !== outro)
  const ordered = [hook, ...body, ...(outro ? [outro] : [])]

  return {
    segments: ordered.map((c, i) => ({
      ...c,
      role: i === 0 ? 'hook' : outro && c === outro ? 'outro' : 'body',
    })),
    hookId: hook.id,
    outroId: outro?.id ?? null,
  }
}

/** Total seconds of raw footage — the denominator of the selection ratio. */
export function totalFootageSeconds(clips) {
  return clips.reduce((a, c) => a + (c.duration || 0), 0)
}
