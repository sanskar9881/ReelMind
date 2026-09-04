import { useEffect, useState } from 'react'

const STAGE_LABELS = {
  engine: 'Loading render engine',
  webcodecs: 'Encoding on GPU',
  normalize: 'Normalizing clips',
  concat: 'Joining shots',
  fallback: 'Falling back to software',
  captions: 'Burning captions',
  done: 'Finished',
}

function elapsedLabel(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/**
 * A three-minute render behind a bar that only says "62%" reads as hung. This
 * shows what the renderer is actually doing plus how long it has been doing it,
 * and announces completion to assistive tech via aria-live.
 */
export function RenderProgress({ progress, startedAt, running, label = 'Render' }) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // The interval stops when the render does, so its last tick IS the final
    // elapsed time — hence 250ms rather than 1s: at a 1s cadence a render that
    // finished at 3.9s would freeze the readout showing 3s.
    if (!running || !startedAt) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [running, startedAt])

  const pct = Math.max(0, Math.min(100, Math.round(progress?.pct || 0)))
  const stage = STAGE_LABELS[progress?.stage] || progress?.stage || 'Working'
  const elapsed = startedAt ? elapsedLabel(now - startedAt) : null

  return (
    <div className="rp">
      <style>{CSS}</style>
      <div
        className="rp-bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} progress`}
      >
        <div className="rp-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="rp-line">
        <span className="rp-stage">{stage}</span>
        <span className="rp-nums">
          {elapsed && <span className="rp-elapsed">{elapsed}</span>}
          <span>{pct}%</span>
        </span>
      </div>
      {progress?.msg && <div className="rp-msg">{progress.msg}</div>}
      {/* Completion is announced separately so it is spoken once, not on every tick. */}
      <span className="sr-only" role="status" aria-live="polite">
        {!running && pct >= 100 ? `${label} complete.` : ''}
      </span>
    </div>
  )
}

const CSS = `
.rp { display: flex; flex-direction: column; gap: var(--s2); margin-top: var(--s3); }
.rp-bar { height: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 999px; overflow: hidden; }
.rp-fill { height: 100%; background: linear-gradient(90deg, var(--cyan), var(--purple)); transition: width .3s; }
.rp-line { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s3); font-size: 12px; }
.rp-stage { font-weight: 600; }
.rp-nums { display: flex; gap: var(--s2); color: var(--muted); font-variant-numeric: tabular-nums; flex: none; }
.rp-elapsed { color: var(--muted); }
.rp-msg { font-size: 11.5px; color: var(--muted); line-height: 1.5; }
`
