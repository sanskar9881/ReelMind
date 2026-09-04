// ai.js — edit-plan generation.
//
// The pipeline is: generate candidates across all footage (candidates.js) ->
// score them -> either let Claude make the editorial call over the scored menu,
// or select greedily offline. The model never sees raw footage inventory any
// more; it sees moments that already passed a quality bar, and its job is the
// one thing a heuristic genuinely cannot do — decide what is interesting.

import { findRetakes, extendTakeRange } from './retakes.js'
import { applyProfile, describePacing } from './styleProfile.js'
import {
  generateCandidates,
  scoreAll,
  selectCandidates,
  orderSegments,
  buildContext,
  totalFootageSeconds,
} from './candidates.js'

// Live. /api/plan holds ANTHROPIC_API_KEY; the key never reaches this bundle.
// mockPlan() stays as the offline fallback when that endpoint errors — see
// generateEditPlan, which reports which path produced the plan.
export const USE_MOCK = false

/** Candidates sent to the model. Above this the payload stops paying for itself. */
export const PROMPT_CANDIDATE_CAP = 150

/** Editing is mostly removal: keep about a fifth of the footage by default. */
export const DEFAULT_KEEP_RATIO = 0.2
export const TARGET_MIN_SECONDS = 60
export const TARGET_MAX_SECONDS = 600

/**
 * Build the Claude prompt string. Lists the clip inventory as JSON, states the
 * user's request, and demands ONLY the plan JSON back (no markdown fences).
 */
// Sentence sampling for the prompt.
//
// This replaced a blunt `slice(0, 40)` that silently discarded everything past
// the first 40 sentences — on a 30-minute clip the model saw 10% of the video,
// all from the opening, and had no way to know. Sampling keeps coverage across
// the whole clip and stays far under any token concern (measured: 60 minutes of
// footage across 6 clips is ~44KB / ~12k tokens).
const SAMPLE_OVER_SECONDS = 180 // clips under 3 minutes are sent whole
const SAMPLE_HEAD_TAIL = 15
const SAMPLE_STRIDE = 3

export function sampleSentences(sentences, durationSec) {
  if ((durationSec ?? 0) < SAMPLE_OVER_SECONDS || sentences.length <= SAMPLE_HEAD_TAIL * 2) {
    return { list: sentences, sampled: false }
  }
  const head = sentences.slice(0, SAMPLE_HEAD_TAIL)
  const tail = sentences.slice(-SAMPLE_HEAD_TAIL)
  const middle = sentences
    .slice(SAMPLE_HEAD_TAIL, sentences.length - SAMPLE_HEAD_TAIL)
    .filter((_, i) => i % SAMPLE_STRIDE === 0)
  return { list: [...head, ...middle, ...tail], sampled: true }
}

/**
 * Build the Claude prompt.
 *
 * This used to send a clip inventory and ask the model to invent timestamps.
 * It now sends SCORED CANDIDATES — moments already filtered for audio, visual
 * and speech quality — and asks for the editorial judgement instead, which is
 * the only part of this a heuristic cannot do. Segments come back referencing
 * candidate ids, so a hallucinated timestamp is not expressible.
 *
 * @param {Array} clips
 * @param {string} userPrompt
 * @param {Map} transcripts
 * @param {object|null} profile
 * @param {{candidates: Array, targetDuration: number, footageSeconds: number}} sel
 */
export function buildPrompt(clips, userPrompt, transcripts, profile, sel = {}) {
  const target = Math.round(sel.targetDuration || 0)
  const footage = Math.round(sel.footageSeconds || totalFootageSeconds(clips))
  const all = sel.candidates || []
  const shown = all.slice(0, PROMPT_CANDIDATE_CAP)
  const anySpeech = shown.some((c) => c.text)

  const menu = shown.map((c) => {
    const row = {
      id: c.id,
      clip: c.clip,
      start: +c.start.toFixed(2),
      end: +c.end.toFixed(2),
      seconds: +(c.end - c.start).toFixed(1),
      score: +c.score.toFixed(3),
    }
    if (c.text) row.text = c.text
    return row
  })

  // Retake groups — repeated attempts at one line — so the model uses just one.
  const T = transcripts instanceof Map ? transcripts : null
  const retakeBlocks = []
  if (T) {
    for (const c of clips) {
      const tr = T.get(c.id)
      if (!tr || tr.error || !tr.sentences?.length) continue
      const groups = tr.retakes || findRetakes(tr.sentences, {})
      for (const g of groups) {
        const rec = tr.sentences[g.recommended]
        retakeBlocks.push({
          clip: c.name,
          recommended: { text: rec?.text || '', start: Number((rec?.start || 0).toFixed(2)) },
          takes: g.takes.map((t) => ({ text: t.text, start: Number(t.start.toFixed(2)), end: Number(t.end.toFixed(2)) })),
        })
      }
    }
  }

  return `You are a professional vlog editor.

Below are candidate moments from the raw footage, already scored for audio,
visual and speech quality. Your job is EDITORIAL: choose which moments belong
in the video and in what order. Prioritise moments that make a point, tell a
story beat, or hook attention. Skip setup, repetition and filler even when the
score is high. Aim for roughly ${target} seconds total. Open with the strongest
moment. Keep the body roughly chronological so the story holds.

The score is a floor, not a ranking to follow. It measures whether a moment is
technically usable — audible, well exposed, not dead air, not the first eight
percent of a clip. It cannot tell whether the moment is interesting. That is
what you are for.

FOOTAGE: ${footage}s across ${clips.length} clip${clips.length === 1 ? '' : 's'}.
CANDIDATES: ${menu.length} shown${all.length > menu.length ? ` (top ${menu.length} of ${all.length} by score)` : ''}.

CANDIDATE MOMENTS (JSON):
${JSON.stringify(menu, null, 1)}
${retakeBlocks.length ? `\nRETAKE GROUPS (JSON):\n${JSON.stringify(retakeBlocks, null, 1)}\n` : ''}
USER REQUEST:
"${userPrompt || 'Make a tight, engaging vlog.'}"

Return ONLY this JSON object. No markdown fences, no commentary before or after:

{
  "title": "...",
  "reasoning": "one sentence on the structure chosen",
  "music": "upbeat" | "chill" | "cinematic" | "none",
  "segments": [
    { "candidateId": "exact id from the list above",
      "transition": "cut|fade|wipe|zoom|dissolve", "role": "hook|body|outro" }
  ]
}

RULES:
- Every segment MUST reference a "candidateId" copied exactly from the list.
  Never invent an id, a filename or a timestamp. Ids not in the list are dropped.
- Use each candidate at most once, and never two candidates that overlap in time
  within the same clip.
- Aim for roughly ${target} seconds total across all chosen segments. Being 20%
  under is much better than padding with weak material.
- Not every clip must be used. Most footage should NOT make the cut.
- The first segment is the hook: role "hook". The last is role "outro".
- Order the middle roughly by clip order and timestamp so the story still reads.${
    anySpeech
      ? `
- Candidates with "text" are whole spoken thoughts on sentence boundaries. Do
  not choose two candidates that repeat the same point. Prefer a candidate that
  states something over one that merely sets it up.`
      : ''
  }${
    retakeBlocks.length
      ? `
- Sentences listed under the same retake group are repeated attempts at one
  line. Use exactly one. Prefer the recommended take.`
      : ''
  }${
    profile
      ? `
- The creator's own editing rhythm, measured from their past videos: median
  shot length ${profile.medianShotLength.toFixed(1)}s, opening shot
  ${profile.openingShotLength.toFixed(1)}s, ${Math.round((1 - (profile.transitionRatio || 0)) * 100)}% hard cuts,
  pacing — ${describePacing(profile.pacingCurve)}. Match this rhythm unless the
  request explicitly asks otherwise.`
      : ''
  }`
}

const RX_FAST = /fast|energetic|upbeat|punchy|hype/i
const RX_SLOW = /slow|calm|chill|cinematic|moody/i
const RX_FILLERS = /(remove|cut|kill|no)\s+(filler|um|uh|filler words)/i
const RX_KEEP_TAKES = /keep all takes|all takes|don'?t remove retakes/i
const RX_NO_STYLE = /ignore my style|default style|no style/i

/**
 * If the prompt asks for filler removal and we have transcripts, flag the plan
 * and attach every filler range. Used by BOTH the mock and real paths so the
 * behaviour is identical. Ranges carry clipId so the renderer resolves by id.
 */
function attachFillerRemoval(plan, clips, userPrompt, transcripts) {
  if (!RX_FILLERS.test(userPrompt || '')) return plan
  const T = transcripts instanceof Map ? transcripts : null
  if (!T) return plan

  const fillerRanges = []
  for (const c of clips) {
    const tr = T.get(c.id)
    if (!tr || tr.error) continue
    for (const f of tr.fillers || []) {
      fillerRanges.push({ clipId: c.id, clip: c.name, start: f.start, end: f.end })
    }
  }
  if (!fillerRanges.length) return plan

  plan.removeFillers = true
  plan.fillerRanges = fillerRanges
  return plan
}

/**
 * Drop every retake attempt except the recommended one. Ranges go onto
 * plan.excludeRanges (merged) — the renderers split each segment around them,
 * exactly like fillers and struck sentences. Non-destructive: the takes still
 * exist in the transcript; only these time spans are skipped.
 *
 * `/(keep all takes|all takes|don't remove retakes)/` opts out entirely.
 */
function attachRetakeRemoval(plan, clips, userPrompt, transcripts) {
  if (RX_KEEP_TAKES.test(userPrompt || '')) return plan
  const T = transcripts instanceof Map ? transcripts : null
  if (!T) return plan

  const discard = []
  for (const c of clips) {
    const tr = T.get(c.id)
    if (!tr || tr.error || !tr.sentences?.length) continue
    const groups = tr.retakes || findRetakes(tr.sentences, {})
    for (const g of groups) {
      for (const take of g.takes) {
        if (take.sentenceIndex === g.recommended) continue
        // Extend past the last word so the trailing breath / "ugh, again" pause
        // is removed with the take, not left dangling before the next line.
        const r = extendTakeRange(take, tr.sentences)
        discard.push({ clipId: c.id, clip: c.name, start: r.start, end: r.end })
      }
    }
  }
  if (!discard.length) return plan

  plan.retakeRanges = discard
  plan.excludeRanges = [...(plan.excludeRanges || []), ...discard]
  return plan
}

/**
 * Preferred shot length from the prompt's pacing words. Candidates now have
 * natural lengths (a whole spoken thought, or an onset-to-onset window), so
 * this is a PREFERENCE applied as a selection bias — never a hard trim, which
 * would put the cut back in the middle of a sentence.
 */
function pickSegLen(p) {
  if (RX_FAST.test(p)) return 2.5
  if (RX_SLOW.test(p)) return 7
  return 4.5
}

/**
 * Re-rank for pacing without touching the reported score. A candidate near the
 * preferred length sorts ahead of an equally-good one that fights the rhythm.
 */
function applyPacingBias(scored, preferSeconds) {
  return scored
    .map((c) => {
      const len = c.end - c.start
      const ratio = len / preferSeconds
      // 1.0 at the preferred length, tapering both ways; never below 0.75, so
      // pacing nudges the order and cannot override a genuinely better moment.
      const fit = 1 - Math.min(0.25, Math.abs(Math.log2(Math.max(0.25, ratio))) * 0.12)
      return { cand: c, rank: c.score * fit }
    })
    .sort((a, b) => b.rank - a.rank)
    .map((x) => x.cand)
}

function pickTransition(p) {
  if (/cut|snappy/i.test(p)) return 'cut'
  if (/zoom|punch/i.test(p)) return 'zoom'
  if (/wipe|slide/i.test(p)) return 'wipe'
  return 'fade'
}

function pickMusic(p) {
  if (RX_FAST.test(p)) return 'upbeat'
  if (/cinematic|epic|dramatic/i.test(p)) return 'cinematic'
  if (RX_SLOW.test(p)) return 'chill'
  if (/no music|silent|no soundtrack/i.test(p)) return 'none'
  return 'upbeat'
}

function parseTargetSeconds(p) {
  const min = p.match(/(\d+(?:\.\d+)?)\s*min/i)
  if (min) return parseFloat(min[1]) * 60
  const sec = p.match(/(\d+(?:\.\d+)?)\s*sec/i)
  if (sec) return parseFloat(sec[1])
  return null
}

/**
 * Target output length. Stated in the prompt if the user said so; otherwise a
 * fifth of the footage, clamped.
 *
 * The default matters more than it looks. The old planner used nearly all of
 * the footage, which is exactly why its output felt raw — editing is mostly
 * removal, and a plan that keeps everything has not edited anything.
 */
export function resolveTargetDuration(userPrompt, clips) {
  const stated = parseTargetSeconds(userPrompt || '')
  const footage = totalFootageSeconds(clips)
  if (stated != null) return Math.max(LIMIT_FLOOR, Math.min(stated, footage))
  const ratio = footage * DEFAULT_KEEP_RATIO
  return Math.max(
    LIMIT_FLOOR,
    Math.min(Math.max(ratio, Math.min(TARGET_MIN_SECONDS, footage)), TARGET_MAX_SECONDS, footage),
  )
}

/** Never target less than a single usable shot. */
const LIMIT_FLOOR = 3

/**
 * Run generation + scoring once. Both planner paths start here: the offline one
 * selects from this, and the Claude one sends it as the menu.
 */
export function buildCandidateSet(clips, userPrompt, analysis, transcripts, opts = {}) {
  const context = buildContext(clips, analysis, transcripts)
  const { candidates, generated } = generateCandidates(clips, analysis, transcripts, {
    ...opts,
    context,
  })
  const scored = scoreAll(candidates, clips, analysis, transcripts, context)
  return {
    scored,
    generated,
    kept: scored.length,
    footageSeconds: totalFootageSeconds(clips),
    targetDuration: resolveTargetDuration(userPrompt, clips),
  }
}

/**
 * Offline planner — candidate generation, scoring, greedy selection with
 * diversity constraints, then narrative ordering. No model, no network.
 *
 * This is a real planner, not a stub: it is what runs when /api/plan is
 * unreachable or unconfigured. What it cannot do is judge whether a moment is
 * *interesting* — it only knows whether one is technically good. That gap is
 * the entire reason the Claude path exists.
 */
export function mockPlan(clips, userPrompt, analysis, transcripts, opts = {}) {
  const p = userPrompt || ''
  const transition = pickTransition(p)

  const set = opts.candidateSet || buildCandidateSet(clips, userPrompt, analysis, transcripts, opts)
  const { scored, generated, targetDuration, footageSeconds } = set

  const selection = selectCandidates(applyPacingBias(scored, pickSegLen(p)), targetDuration, {})
  const ordered = orderSegments(selection.selected, { clipOrder: clips.map((c) => c.id) })

  const segments = ordered.segments.map((c) => ({
    clip: c.clip,
    clipId: c.clipId,
    candidateId: c.id,
    start: +c.start.toFixed(3),
    end: +c.end.toFixed(3),
    transition: c.role === 'hook' ? 'cut' : transition,
    role: c.role,
    score: c.score,
    breakdown: c.breakdown,
    text: c.text,
  }))

  const outSec = segments.reduce((a, s2) => a + (s2.end - s2.start), 0)
  const pct = footageSeconds ? Math.round((outSec / footageSeconds) * 100) : 0

  const plan = {
    title:
      (p.trim().split(/\s+/).slice(0, 6).join(' ') || 'My Vlog').replace(/^\w/, (c) => c.toUpperCase()),
    reasoning: `Scored ${generated} candidate moments and kept ${segments.length} — ${fmtSecs(outSec)} from ${fmtSecs(footageSeconds)} of footage (${pct}%). Strongest moment opens${
      selection.relaxed.length ? `; relaxed ${selection.relaxed.join(' then ')} to fill the target` : ''
    }${
      selection.underTarget
        ? `. Came in under the ${fmtSecs(targetDuration)} target — the rest of the footage scored below the quality floor, and padding with it would have made a worse edit`
        : ''
    }.`,
    music: pickMusic(p),
    segments,
    plannedBy: 'offline',
    candidateStats: {
      generated,
      scored: scored.length,
      selected: segments.length,
      targetDuration: +targetDuration.toFixed(1),
      outputSeconds: +outSec.toFixed(1),
      footageSeconds: +footageSeconds.toFixed(1),
      relaxed: selection.relaxed,
      maxPerClip: selection.maxPerClip,
      minGapWithinClip: selection.minGap,
      scoreFloor: selection.scoreFloor,
      underTarget: selection.underTarget,
      merged: selection.mergedCount,
    },
  }

  attachRetakeRemoval(plan, clips, p, transcripts)
  return attachFillerRemoval(plan, clips, p, transcripts)
}

function fmtSecs(n) {
  const s = Math.round(n || 0)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Turn a model response's candidateId references back into real time ranges.
 * An id that is not in the menu is dropped — a hallucinated timestamp is simply
 * not expressible in this shape, which is the point of sending ids at all.
 */
export function resolveCandidateSegments(plan, scored) {
  if (!plan || !Array.isArray(plan.segments)) return plan
  const byId = new Map(scored.map((c) => [c.id, c]))
  const used = new Set()
  const segments = []
  let dropped = 0

  for (const s2 of plan.segments) {
    const cand = s2.candidateId ? byId.get(s2.candidateId) : null
    if (!cand) {
      // No id, but explicit clip+times: let validatePlan judge it.
      if (s2.clip && Number.isFinite(Number(s2.start)) && Number.isFinite(Number(s2.end))) {
        segments.push(s2)
      } else {
        dropped++
      }
      continue
    }
    if (used.has(cand.id)) {
      dropped++
      continue
    }
    used.add(cand.id)
    segments.push({
      clip: cand.clip,
      clipId: cand.clipId,
      candidateId: cand.id,
      start: cand.start,
      end: cand.end,
      transition: s2.transition || 'cut',
      role: s2.role || 'body',
      score: cand.score,
      breakdown: cand.breakdown,
      text: cand.text,
    })
  }

  plan.segments = segments
  if (dropped) plan.droppedSegments = dropped
  return plan
}

/**
 * Validate + normalize any plan (mock or real). Guards against hallucinated
 * clips, out-of-range times, and micro-segments. Attaches clipId so the
 * renderer resolves by id, not by name.
 */
export function validatePlan(plan, clips) {
  if (!plan || !Array.isArray(plan.segments)) {
    throw new Error('Plan has no segments array.')
  }
  const byName = new Map(clips.map((c) => [c.name, c]))

  const segments = []
  for (const s of plan.segments) {
    const clip = byName.get(s.clip)
    if (!clip) continue // hallucination guard
    let start = Math.max(0, Number(s.start) || 0)
    let end = Math.min(clip.duration, Number(s.end) || 0)
    if (!(end > start)) continue
    if (end - start < 0.4) continue // drop micro-segments
    segments.push({
      clip: clip.name,
      clipId: clip.id,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
      transition: s.transition || 'fade',
      role: s.role || 'body',
      // Provenance from the candidate set — the timeline shows the score and
      // its breakdown on hover, so it has to survive validation.
      ...(s.candidateId ? { candidateId: s.candidateId } : {}),
      ...(Number.isFinite(s.score) ? { score: s.score } : {}),
      ...(s.breakdown ? { breakdown: s.breakdown } : {}),
      ...(s.text ? { text: s.text } : {}),
    })
  }

  if (!segments.length) {
    throw new Error('No valid segments survived validation — every segment referenced an unknown clip or an invalid range.')
  }

  const validClipIds = new Set(clips.map((c) => c.id))
  const keepRanges = (ranges) =>
    (Array.isArray(ranges) ? ranges : [])
      .filter((r) => r && Number(r.end) > Number(r.start))
      .map((r) => ({
        clipId: r.clipId,
        clip: r.clip,
        start: Number(r.start),
        end: Number(r.end),
      }))
      .filter((r) => !r.clipId || validClipIds.has(r.clipId))

  const out = {
    title: plan.title || 'Untitled Vlog',
    reasoning: plan.reasoning || '',
    music: ['upbeat', 'chill', 'cinematic', 'none'].includes(plan.music) ? plan.music : 'none',
    segments,
  }

  // Which planner ran, and what it chose from — both are shown in the UI.
  if (plan.plannedBy) out.plannedBy = plan.plannedBy
  if (plan.candidateStats) out.candidateStats = plan.candidateStats
  if (plan.fallbackReason) out.fallbackReason = plan.fallbackReason
  if (plan.droppedSegments) out.droppedSegments = plan.droppedSegments

  // Carry text-editing decisions through validation.
  if (plan.removeFillers) {
    out.removeFillers = true
    out.fillerRanges = keepRanges(plan.fillerRanges)
  }
  if (plan.excludeRanges?.length) {
    out.excludeRanges = keepRanges(plan.excludeRanges)
  }
  if (plan.retakeRanges?.length) {
    out.retakeRanges = keepRanges(plan.retakeRanges)
  }

  return out
}

function stripFences(text) {
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()
}

/**
 * Generate an edit plan. Mock path awaits ~900ms then validates mockPlan().
 * Real path POSTs to /api/plan (a serverless function that holds the key) and
 * parses the returned text. The key never reaches the client bundle.
 *
 * `profile` is optional. It reaches BOTH paths: as context inside buildPrompt so
 * the model can reason about the rhythm, and as a post-validation bias so it
 * still works in mock mode with no API. `/(ignore my style|default style|no
 * style)/` opts out of both.
 */
export async function generateEditPlan(clips, userPrompt, analysis, transcripts, profile) {
  if (!clips || !clips.length) throw new Error('Add at least one clip before generating a plan.')

  const styleOn = profile && !RX_NO_STYLE.test(userPrompt || '')
  const ctx = { analysis, clips }

  // Generate and score ONCE. Both paths use the same candidate set, so the
  // Candidates panel shows exactly what the planner actually chose from — and
  // an offline fallback does not have to redo the expensive part.
  const set = buildCandidateSet(clips, userPrompt, analysis, transcripts)

  const finish = (plan) => {
    plan.candidates = set.scored
    const validated = validatePlan(plan, clips)
    validated.candidates = set.scored
    return styleOn ? applyProfile(validated, profile, ctx) : validated
  }

  const offline = (reason) => {
    const plan = mockPlan(clips, userPrompt, analysis, transcripts, { candidateSet: set })
    if (reason) plan.fallbackReason = reason
    return finish(plan)
  }

  if (USE_MOCK) return offline(null)

  let parsed
  try {
    // Deliberately slim: buildPrompt has already embedded the scored candidates
    // the model needs, so re-sending raw transcripts would double the payload
    // for no gain and trip the endpoint's 200KB guard on real projects.
    // api/plan.js accepts the fuller shape so buildPrompt can move server-side
    // later without a contract change.
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: buildPrompt(clips, userPrompt, transcripts, styleOn ? profile : null, {
          candidates: set.scored,
          targetDuration: set.targetDuration,
          footageSeconds: set.footageSeconds,
        }),
        clips: clips.map((c) => ({ name: c.name, duration: c.duration, width: c.width, height: c.height })),
        profile: styleOn ? profile : null,
      }),
    })

    const data = await res.json().catch(() => null)
    if (!res.ok) {
      // The endpoint returns { error: { code, message } } — show the message.
      throw new Error(data?.error?.message || `Planning service failed (${res.status}).`)
    }
    const raw = typeof data === 'string' ? data : data?.text || ''
    parsed = JSON.parse(stripFences(raw))
  } catch (err) {
    // A planning outage must not cost the user their edit. The offline planner
    // produces a real plan from the same scored candidates; the UI says which
    // one ran and why, rather than passing the degraded result off as Claude's.
    console.warn('[ai] planning service unavailable, using the offline planner:', err?.message || err)
    return offline(err?.message || 'Planning service unavailable.')
  }

  // Candidate ids back to real time ranges. Anything not in the menu is dropped.
  resolveCandidateSegments(parsed, set.scored)
  if (!parsed.segments?.length) {
    return offline('The planner returned no usable moments.')
  }

  parsed.plannedBy = 'claude'
  parsed.candidateStats = {
    generated: set.generated,
    scored: set.scored.length,
    selected: parsed.segments.length,
    targetDuration: +set.targetDuration.toFixed(1),
    outputSeconds: +parsed.segments.reduce((a, s2) => a + (s2.end - s2.start), 0).toFixed(1),
    footageSeconds: +set.footageSeconds.toFixed(1),
    promptCandidates: Math.min(set.scored.length, PROMPT_CANDIDATE_CAP),
    relaxed: [],
  }

  // Filler + retake removal are deterministic — apply them to the model's plan
  // too, not just the offline one.
  attachRetakeRemoval(parsed, clips, userPrompt, transcripts)
  attachFillerRemoval(parsed, clips, userPrompt, transcripts)
  // The model already saw the profile in the prompt; applyProfile inside finish()
  // is the safety net that pulls a drifting response onto the measured rhythm.
  return finish(parsed)
}

