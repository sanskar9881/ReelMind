import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

const ToastCtx = createContext(null)

const AUTO_DISMISS_MS = 4200

/**
 * Background events — saved, analysis finished, render complete — announce
 * themselves here instead of silently. Errors stay until dismissed; everything
 * else auto-dismisses.
 *
 * The stack is also the app's aria-live region: role="status" for ordinary
 * events, role="alert" for errors, so a screen reader hears a render finish
 * without the user hunting for it.
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timers = useRef(new Map())

  const dismiss = useCallback((id) => {
    const t = timers.current.get(id)
    if (t) {
      clearTimeout(t)
      timers.current.delete(id)
    }
    setToasts((prev) => prev.filter((x) => x.id !== id))
  }, [])

  const push = useCallback(
    (toast) => {
      const id = `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
      const t = { id, tone: 'info', ...toast }
      setToasts((prev) => [...prev.slice(-2), t])
      if (t.tone !== 'error') {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), t.duration ?? AUTO_DISMISS_MS),
        )
      }
      return id
    },
    [dismiss],
  )

  useEffect(() => {
    const map = timers.current
    return () => {
      map.forEach(clearTimeout)
      map.clear()
    }
  }, [])

  const api = useMemo(
    () => ({
      push,
      dismiss,
      info: (title, detail) => push({ title, detail, tone: 'info' }),
      success: (title, detail) => push({ title, detail, tone: 'success' }),
      error: (title, detail) => push({ title, detail, tone: 'error' }),
    }),
    [push, dismiss],
  )

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <style>{CSS}</style>
      <div className="tst-wrap">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`tst tone-${t.tone}`}
            role={t.tone === 'error' ? 'alert' : 'status'}
            aria-live={t.tone === 'error' ? 'assertive' : 'polite'}
          >
            <span className="tst-dot" aria-hidden="true" />
            <div className="tst-body">
              <div className="tst-title">{t.title}</div>
              {t.detail && <div className="tst-detail">{t.detail}</div>}
            </div>
            <button className="tst-x" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

/** Safe outside a provider (returns no-ops) so a page can be rendered alone. */
export function useToast() {
  const ctx = useContext(ToastCtx)
  return (
    ctx || {
      push: () => {},
      dismiss: () => {},
      info: () => {},
      success: () => {},
      error: () => {},
    }
  )
}

const CSS = `
.tst-wrap { position: fixed; z-index: 200; display: flex; flex-direction: column; gap: var(--s2); pointer-events: none;
  right: var(--s4); bottom: var(--s4); width: min(360px, calc(100vw - var(--s8))); }
.tst { pointer-events: auto; display: flex; align-items: flex-start; gap: var(--s3); padding: var(--s3) var(--s3) var(--s3) var(--s4);
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--r-lg); box-shadow: 0 18px 44px -18px rgba(0,0,0,.9);
  animation: tst-in .22s ease-out; }
.tst-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; margin-top: 5px; background: var(--cyan); }
.tst.tone-success .tst-dot { background: var(--green); }
.tst.tone-error .tst-dot { background: var(--pink); }
.tst.tone-error { border-color: rgba(255,37,102,.45); }
.tst-body { flex: 1; min-width: 0; }
.tst-title { font-size: 13px; font-weight: 600; line-height: 1.4; }
.tst-detail { font-size: 11.5px; color: var(--muted); line-height: 1.5; margin-top: 2px; word-break: break-word; }
.tst-x { flex: none; background: none; border: none; color: var(--muted); font-size: 18px; line-height: 1; padding: 0 var(--s1);
  min-width: var(--tap); min-height: var(--tap); display: grid; place-items: center; border-radius: var(--r-sm); }
.tst-x:hover { color: var(--text); }

@keyframes tst-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

/* On mobile toasts come from the top — the bottom edge belongs to the tab bar
   and the browser chrome. */
@media (max-width: 767px) {
  .tst-wrap { top: var(--s3); bottom: auto; left: var(--s3); right: var(--s3); width: auto; }
  @keyframes tst-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
}
`
