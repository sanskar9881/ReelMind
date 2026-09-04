// Ceilings the mobile Quick Edit flow enforces rather than merely advises.
/** Mobile browsers OOM decoding much past this. Enforced, not just advised. */
export const MOBILE_MAX_SECONDS = 180

/**
 * Trim a plan to the mobile render ceiling by dropping whole shots from the
 * end, then trimming the last surviving shot. Whole shots first so the result
 * is still a real edit rather than a hard stop mid-sentence.
 */
export function capPlanDuration(plan, maxSeconds = MOBILE_MAX_SECONDS) {
  if (!plan?.segments?.length) return { plan, trimmed: false, seconds: 0 }
  const kept = []
  let total = 0
  let trimmed = false
  for (const s of plan.segments) {
    const len = s.end - s.start
    if (total + len <= maxSeconds) {
      kept.push(s)
      total += len
      continue
    }
    const room = maxSeconds - total
    // Only keep a partial shot if what remains is still a usable shot.
    if (room >= 0.7) {
      kept.push({ ...s, end: +(s.start + room).toFixed(3) })
      total += room
    }
    trimmed = true
    break
  }
  if (!trimmed) return { plan, trimmed: false, seconds: total }
  return { plan: { ...plan, segments: kept }, trimmed: true, seconds: total }
}

