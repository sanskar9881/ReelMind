// renderReport.js — every way the output differs from what was asked for.
//
// This file exists because of a specific failure pattern: each stage of the
// pipeline degrades GRACEFULLY and independently, which is correct behaviour —
// captions fall back, WebCodecs falls back to FFmpeg, the planner relaxes a
// constraint, a clip fails to probe — and the sum of all that graceful
// degradation is a user watching an output they cannot explain.
//
// Nothing here changes behaviour. It collects what already happened and states
// it plainly. A degradation the user was never told about is a bug in the UI,
// not a feature of the renderer.

/** Severity ladder. 'error' = something was lost; 'warn' = something changed. */
const RANK = { error: 0, warn: 1, info: 2 }

const item = (severity, area, title, detail, hint) => ({ severity, area, title, detail, hint })

/**
 * Confidence below which a style profile is describing noise rather than the
 * creator's rhythm. Mirrors the threshold the Style panel uses.
 */
export const LOW_PROFILE_CONFIDENCE = 0.4

/**
 * @param {object} ctx
 *   - out: the render result (method, fellBack, fallbackReason, captionsBurned,
 *     captionsSkippedReason, music, musicSkippedReason)
 *   - requestedCaptions: boolean — did the user ask for burned-in captions
 *   - plan: the plan that was rendered (candidateStats, plannedBy)
 *   - clips, transcripts, probeErrors, analysisErrors
 *   - profile: applied style profile, or null
 *   - verify: { report, sync } from verifyRender / measureSync
 * @returns {{ok:boolean, items:Array, counts:{error:number,warn:number,info:number}}}
 */
export function buildRenderReport(ctx = {}) {
  const {
    out = {},
    requestedCaptions = false,
    plan = null,
    clips = [],
    transcripts = {},
    probeErrors = [],
    analysisErrors = [],
    profile = null,
    profileApplied = false,
    verify = null,
    music = null,
  } = ctx

  const items = []

  // --- engine ------------------------------------------------------------
  if (out.fellBack) {
    items.push(
      item(
        'warn',
        'Engine',
        'GPU render failed — finished in software',
        out.fallbackReason || 'The WebCodecs path threw mid-render.',
        'The output is complete and verified. Software rendering is slower but produces the same edit; crossfades are rendered as hard cuts on this path.',
      ),
    )
  } else if (out.method === 'ffmpeg' && out.reason) {
    items.push(item('info', 'Engine', 'Rendered in software', out.reason, null))
  }

  // The two engines genuinely join differently, and it changes the duration.
  if (out.method === 'ffmpeg' && out.joinPath === 'concat' && planHasTransitions(plan)) {
    items.push(
      item(
        'info',
        'Transitions',
        'Crossfades rendered as hard cuts',
        'The software path joins segments with the concat demuxer, which has no crossfade. Every boundary in this file is a cut.',
        'The output is longer than the GPU path would produce, by about half a second per crossfade.',
      ),
    )
  }

  // --- captions ----------------------------------------------------------
  if (requestedCaptions && !out.captionsBurned) {
    items.push(
      item(
        'error',
        'Captions',
        'Captions were not burned in',
        out.captionsSkippedReason || 'The renderer could not draw captions on this engine.',
        'Download the .srt or .vtt from the Export tab and add it as a sidecar track instead.',
      ),
    )
  }

  // --- music -------------------------------------------------------------
  if (music?.requested && !out.music?.mixed) {
    items.push(
      item(
        'error',
        'Music',
        'Music was not mixed in',
        out.musicSkippedReason || 'The music bed could not be mixed into this render.',
        'The edit itself is unaffected — only the soundtrack is missing.',
      ),
    )
  } else if (out.music?.mixed && out.music.duckSource === 'none') {
    items.push(
      item(
        'info',
        'Music',
        'Music plays at full level throughout',
        'No speech was found to duck under — no transcript, and the audio analysis found nothing speech-like.',
        'Transcribe a clip for a bed that drops under dialogue.',
      ),
    )
  }

  // --- planning ----------------------------------------------------------
  const stats = plan?.candidateStats
  if (stats?.relaxed?.length) {
    const names = {
      minGapWithinClip: 'allowed cuts closer together inside one clip',
      maxPerClip: 'allowed more segments from a single clip',
    }
    items.push(
      item(
        'warn',
        'Selection',
        `Relaxed ${stats.relaxed.length} constraint${stats.relaxed.length === 1 ? '' : 's'} to reach the target length`,
        stats.relaxed.map((r) => names[r] || r).join(', ') + '.',
        'The footage did not contain enough strong material to fill the target under the normal diversity rules.',
      ),
    )
  }
  if (stats?.underTarget) {
    items.push(
      item(
        'info',
        'Selection',
        'Came in under the target length, deliberately',
        `${fmt(stats.outputSeconds)} against a ${fmt(stats.targetDuration)} target.`,
        'The remaining footage scored below the quality floor. Padding with it would have made a worse edit.',
      ),
    )
  }
  if (plan && plan.plannedBy !== 'claude') {
    items.push(
      item(
        plan.fallbackReason ? 'warn' : 'info',
        'Planner',
        'This edit was planned offline, not by Claude',
        plan.fallbackReason
          ? `The planning service was unreachable: ${plan.fallbackReason}`
          : 'The offline planner chose these moments by score alone.',
        'Scoring can tell whether a moment is technically usable. It cannot tell whether it is interesting.',
      ),
    )
  }

  // --- source material ---------------------------------------------------
  for (const e of probeErrors) {
    items.push(
      item('error', 'Footage', `Could not read ${e.name}`, e.message, 'This file is not in the edit at all.'),
    )
  }
  for (const e of analysisErrors) {
    items.push(
      item(
        'warn',
        'Analysis',
        `Analysis failed for ${e.name}`,
        e.message,
        'This clip was scored on position alone, so it was unlikely to be chosen well.',
      ),
    )
  }

  const usedClipIds = new Set((plan?.segments || []).map((s) => s.clipId))
  for (const [clipId, tr] of Object.entries(transcripts || {})) {
    const name = tr?.name || clips.find((c) => c.id === clipId)?.name || clipId
    if (tr?.error) {
      items.push(
        item(
          usedClipIds.has(clipId) ? 'warn' : 'info',
          'Transcript',
          `Transcription failed for ${name}`,
          tr.error,
          usedClipIds.has(clipId)
            ? 'This clip is in the edit but has no captions and was cut on audio alone, not on sentence boundaries.'
            : 'This clip is not in the edit.',
        ),
      )
      continue
    }
    if (tr?.scriptMismatch) {
      items.push(
        item(
          'error',
          'Transcript',
          `${name}: transcript is not in the expected script`,
          `Asked for ${tr.scriptMismatch.language}, which is written in ${tr.scriptMismatch.expected}, but the text came back in ${tr.scriptMismatch.got} script.`,
          'Whisper very likely mis-transcribed this clip. Check the transcript, and try the Accurate model.',
        ),
      )
    }
  }

  // --- style profile -----------------------------------------------------
  if (profileApplied && profile && profile.confidence < LOW_PROFILE_CONFIDENCE) {
    items.push(
      item(
        'warn',
        'Style',
        'Style profile applied at low confidence',
        `Confidence ${Math.round(profile.confidence * 100)}% — below the ${Math.round(LOW_PROFILE_CONFIDENCE * 100)}% bar.`,
        'The profile was measured from too little material, or from video whose cuts could not be detected reliably. It biased this edit anyway.',
      ),
    )
  }

  // --- verification ------------------------------------------------------
  if (verify?.report && !verify.report.ok) {
    for (const c of verify.report.checks || []) {
      if (c.passed) continue
      items.push(item('error', 'Verification', `Check failed: ${c.name}`, c.detail, null))
    }
  }
  if (verify?.sync?.drift) {
    items.push(
      item(
        'error',
        'Verification',
        'Audio and video drifted apart',
        `${verify.sync.deltaMs}ms between the audio and video track lengths.`,
        'Re-render on the other engine — this is the failure the sync rules exist to prevent.',
      ),
    )
  }

  items.sort((a, b) => RANK[a.severity] - RANK[b.severity])
  const counts = { error: 0, warn: 0, info: 0 }
  for (const i of items) counts[i.severity]++

  return { ok: counts.error === 0 && counts.warn === 0, items, counts }
}

function planHasTransitions(plan) {
  return (plan?.segments || []).some((s, i) => i > 0 && s.transition && s.transition !== 'cut')
}

function fmt(n) {
  const s = Math.round(n || 0)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** One-line summary for a toast or a header. */
export function summarizeReport(report) {
  const { counts } = report
  if (!counts.error && !counts.warn && !counts.info) return 'No issues — the output matches the plan.'
  if (!counts.error && !counts.warn) return `${counts.info} note${counts.info === 1 ? '' : 's'}.`
  const parts = []
  if (counts.error) parts.push(`${counts.error} problem${counts.error === 1 ? '' : 's'}`)
  if (counts.warn) parts.push(`${counts.warn} change${counts.warn === 1 ? '' : 's'}`)
  return parts.join(' · ')
}
