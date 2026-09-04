/**
 * Every empty panel says what belongs there and offers exactly one way to fill
 * it. A blank panel reads as broken; this reads as a next step.
 */
export function EmptyState({ icon, title, children, action, compact }) {
  return (
    <div className={`emp${compact ? ' is-compact' : ''}`}>
      <style>{CSS}</style>
      {icon && (
        <div className="emp-icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <h4 className="emp-title">{title}</h4>
      {children && <p className="emp-body">{children}</p>}
      {action && <div className="emp-action">{action}</div>}
    </div>
  )
}

/** Skeleton rows for the clip library — a shape that matches what is coming,
 *  rather than a spinner that says only "something is happening". */
export function SkeletonRows({ count = 3, height = 56 }) {
  return (
    <div className="skl" aria-hidden="true">
      <style>{CSS}</style>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skl-row" style={{ height }}>
          <div className="skl-thumb" />
          <div className="skl-lines">
            <span className="skl-line" style={{ width: '72%' }} />
            <span className="skl-line" style={{ width: '44%' }} />
          </div>
        </div>
      ))}
    </div>
  )
}

const CSS = `
.emp { text-align: center; padding: var(--s8) var(--s4); border: 1px dashed var(--border); border-radius: var(--r-lg); background: rgba(255,255,255,.012); }
.emp.is-compact { padding: var(--s6) var(--s3); }
.emp-icon { font-size: 30px; line-height: 1; margin-bottom: var(--s3); opacity: .9; }
.emp.is-compact .emp-icon { font-size: 24px; margin-bottom: var(--s2); }
.emp-title { font-size: 14px; margin: 0 0 var(--s2); }
.emp-body { color: var(--muted); font-size: 12.5px; line-height: 1.6; margin: 0 auto; max-width: 34ch; }
.emp-action { margin-top: var(--s4); display: flex; justify-content: center; gap: var(--s2); flex-wrap: wrap; }

.skl { display: flex; flex-direction: column; gap: var(--s2); }
.skl-row { display: flex; gap: var(--s2); align-items: center; padding: var(--s2); border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); }
.skl-thumb { width: 58px; height: 34px; border-radius: var(--r-sm); flex: none; }
.skl-lines { flex: 1; display: flex; flex-direction: column; gap: var(--s2); }
.skl-line { display: block; height: 8px; border-radius: 999px; }
.skl-thumb, .skl-line { background: linear-gradient(90deg, #14142260 25%, #23233a 50%, #14142260 75%); background-size: 300% 100%; animation: skl-shim 1.4s ease-in-out infinite; }
@keyframes skl-shim { from { background-position: 150% 0; } to { background-position: -150% 0; } }
@media (prefers-reduced-motion: reduce) { .skl-thumb, .skl-line { animation: none; background: #17172a; } }
`
