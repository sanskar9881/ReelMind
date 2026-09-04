// ai.js — edit-plan generation. Mock-only for now (no API spend until tested).

import { findRetakes, extendTakeRange } from './retakes.js'
import { applyProfile, describePacing } from './styleProfile.js'

// ⇩⇩⇩ FLIP THIS TO false TO GO LIVE ⇩⇩⇩
// Requires ANTHROPIC_API_KEY set in the deployment environment (see api/plan.js).
// Nothing spends money while this is true.
export const USE_MOCK = true
// ⇧⇧⇧ FLIP THIS TO false TO GO LIVE ⇧⇧⇧

/**
 * Build the Claude prompt string. Lists the clip inventory as JSON, states the
 * user's request, and demands ONLY the plan JSON back (no markdown fences).
 */
export function buildPrompt(clips, userPrompt, transcripts, profile) {
  const T = transcripts instanceof Map ? transcripts : null

  const inventory = clips.map((c) => {
    const entry = {
      name: c.name,
      duration: Number(c.duration.toFixed(2)),
      resolution: `${c.width}x${c.height}`,
    }
    const tr = T && T.get(c.id)
    if (tr && !tr.error && tr.sentences?.length) {
      // Cap sentences per clip to keep the token count sane on long footage.
      entry.sentences = tr.sentences.slice(0, 40).map((s) => ({
        text: s.text,
        start: Number(s.start.toFixed(2)),
        end: Number(s.end.toFixed(2)),
      }))
    }
    return entry
  })

  const hasTranscripts = inventory.some((c) => c.sentences)

  // Retake groups — repeated attempts at one line — so the model uses just one.
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

  return `You are a professional vlog editor. Build an edit plan from the clips below.

CLIP INVENTORY (JSON):
${JSON.stringify(inventory, null, 2)}
${retakeBlocks.length ? `\nRETAKE GROUPS (JSON):\n${JSON.stringify(retakeBlocks, null, 2)}\n` : ''}
USER REQUEST:
"${userPrompt || 'Make a tight, engaging vlog.'}"

Return ONLY this JSON object. No markdown fences, no commentary before or after:

{
  "title": "...",
  "reasoning": "one sentence on the structure chosen",
  "music": "upbeat" | "chill" | "cinematic" | "none",
  "segments": [
    { "clip": "exact_filename.mp4", "start": 0, "end": 4.5,
      "transition": "cut|fade|wipe|zoom|dissolve", "role": "hook|body|outro" }
  ]
}

RULES:
- Use filenames exactly as given in the inventory. Never invent a filename.
- Every segment's start and end must fall inside that clip's duration (0 <= start < end <= duration).
- Not every clip must be used.
- Order segments to tell a story: hook first, body in the middle, outro last.${
    hasTranscripts
      ? `
- You can now read what is being said. Cut on sentence boundaries, never
  mid-sentence. Choose segments for narrative meaning — the hook should be
  the most compelling thing actually said, not merely the loudest moment.
  Keep a spoken thought intact even if it runs longer than the target pace.`
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
const RX_SORT = /best|longest|scenic|hook/i
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

function pickSegLen(p) {
  if (RX_FAST.test(p)) return 2.5
  if (RX_SLOW.test(p)) return 7
  return 4.5
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
 * Real keyword-driven mock planner.
 *
 * @param {Map<string,object>} [analysis] optional analyzer.js output keyed by
 *   clip id. When present, segment starts snap to analyzed highlights and known
 *   silence runs are skipped.
 */
export function mockPlan(clips, userPrompt, analysis, transcripts) {
  const p = userPrompt || ''
  const segLen = pickSegLen(p)
  const transition = pickTransition(p)
  const target = parseTargetSeconds(p)
  const A = analysis instanceof Map ? analysis : null

  // Nearest sentence end within 2s of `end`, or null. Sentence boundaries beat
  // the silence-snap logic below — a silence can land mid-thought.
  const snapToSentence = (a, start, end) => {
    const bounds = a && a.sentenceBoundaries
    if (!bounds || !bounds.length) return null
    let best = null
    let bestD = 2.0001
    for (const b of bounds) {
      const d = Math.abs(b - end)
      if (d < bestD && b > start + 0.4) {
        bestD = d
        best = b
      }
    }
    return best
  }

  const scoreOf = (c) => {
    const a = A && A.get(c.id)
    if (!a || a.error) return 0
    return (a.energy || 0) * 0.5 + (a.motionAvg || 0) * 4 * 0.5
  }

  let ordered = clips.slice()
  if (RX_SORT.test(p)) {
    // "best" → rank by analyzed interestingness when we have it, else by length.
    ordered.sort((a, b) => (A ? scoreOf(b) - scoreOf(a) : b.duration - a.duration))
  }

  const inSilence = (a, t, len) =>
    !!a && !!a.audio && a.audio.silences.some((s) => t < s.end && t + len > s.start)

  const segments = []
  let total = 0

  for (const c of ordered) {
    if (target != null && total >= target) break
    const a = A && A.get(c.id)
    const hasBounds = !!(a && a.sentenceBoundaries?.length)
    // Highlight-aware start when analyzed, otherwise skip the roll-in head.
    const starts = a && !a.error && a.highlights?.length
      ? a.highlights.map((h) => h.start).sort((x, y) => x - y)
      : [Math.min(c.duration * 0.08, 1.5)]

    let hi = 0
    let start = starts[0]
    while (start + 0.6 < c.duration) {
      if (target != null && total >= target) break
      let end = Math.min(start + segLen, c.duration)
      if (end - start < 0.6) break
      if (target != null && total + (end - start) > target) {
        end = Math.min(c.duration, start + (target - total))
      }
      // Sentence-boundary snap takes priority over the silence nudge.
      if (hasBounds) {
        const snapped = snapToSentence(a, start, end)
        if (snapped != null) end = Math.min(c.duration, snapped)
      } else if (inSilence(a, start, end - start) && start + 1.2 < c.duration) {
        // Nudge past a silent stretch if the analyzer flagged one here.
        start += 1
        continue
      }
      if (end - start < 0.4) break
      const role = segments.length === 0 ? 'hook' : total + (end - start) >= (target || Infinity) ? 'outro' : 'body'
      segments.push({
        clip: c.name,
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        transition,
        role,
      })
      total += end - start
      if (target == null) break // one segment per clip when no target length given
      hi++
      start = hi < starts.length ? Math.max(starts[hi], end + 0.3) : end + 0.5
    }
  }

  if (segments.length) segments[segments.length - 1].role = 'outro'

  const anyBounds = [...(A?.values() || [])].some((a) => a && a.sentenceBoundaries?.length)

  const plan = {
    title: (p.trim().split(/\s+/).slice(0, 6).join(' ') || 'My Vlog').replace(/^\w/, (c) => c.toUpperCase()),
    reasoning: `Cut ${segments.length} ${segLen}s${target ? `-ish` : ''} segments with ${transition} transitions${
      RX_SORT.test(p) ? (A ? ', liveliest clips first' : ', longest clips first') : ' in capture order'
    }${anyBounds ? ', ends snapped to sentence boundaries' : A ? ', starts snapped to analyzed highlights' : ''}${
      target ? `, targeting ~${Math.round(target)}s` : ''
    }.`,
    music: pickMusic(p),
    segments,
  }

  attachRetakeRemoval(plan, clips, p, transcripts)
  return attachFillerRemoval(plan, clips, p, transcripts)
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

  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 900))
    const plan = validatePlan(mockPlan(clips, userPrompt, analysis, transcripts), clips)
    return styleOn ? applyProfile(plan, profile, ctx) : plan
  }

  // Deliberately slim: buildPrompt has already embedded the sentences and clip
  // inventory the model needs, so re-sending raw transcripts would double the
  // payload for no gain and trip the endpoint's 200KB guard on real projects.
  // api/plan.js accepts the fuller shape so buildPrompt can move server-side
  // later without a contract change.
  const res = await fetch('/api/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: buildPrompt(clips, userPrompt, transcripts, styleOn ? profile : null),
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
  let parsed
  try {
    parsed = JSON.parse(stripFences(raw))
  } catch {
    throw new Error('Planning service returned malformed JSON.')
  }
  // Filler + retake removal are deterministic — apply them to the model's plan
  // too, not just the mock's.
  attachRetakeRemoval(parsed, clips, userPrompt, transcripts)
  attachFillerRemoval(parsed, clips, userPrompt, transcripts)
  const plan = validatePlan(parsed, clips)
  // The model already saw the profile in the prompt; this is the safety net that
  // pulls a drifting response back onto the creator's measured rhythm.
  return styleOn ? applyProfile(plan, profile, ctx) : plan
}
