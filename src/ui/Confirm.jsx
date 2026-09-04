import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Inline two-step confirm for destructive actions. Replaces window.confirm(),
 * which blocks the whole tab, cannot be styled, and on mobile Safari can be
 * suppressed entirely — leaving a delete button that silently does nothing.
 *
 * First click arms it, second click commits; blur, Escape or 4s of inactivity
 * disarms. The button keeps its own DOM node so focus is never lost.
 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = 'Sure?',
  className = '',
  title,
  ariaLabel,
  disabled,
  timeout = 4000,
}) {
  const [armed, setArmed] = useState(false)
  const timer = useRef(0)

  const disarm = useCallback(() => {
    clearTimeout(timer.current)
    setArmed(false)
  }, [])

  useEffect(() => () => clearTimeout(timer.current), [])

  const onClick = useCallback(
    (e) => {
      e.stopPropagation()
      if (!armed) {
        setArmed(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setArmed(false), timeout)
        return
      }
      disarm()
      onConfirm(e)
    },
    [armed, disarm, onConfirm, timeout],
  )

  return (
    <button
      type="button"
      className={`cfm${armed ? ' is-armed' : ''} ${className}`}
      onClick={onClick}
      onBlur={disarm}
      onKeyDown={(e) => e.key === 'Escape' && disarm()}
      disabled={disabled}
      title={armed ? 'Click again to confirm' : title}
      aria-label={armed ? `${ariaLabel || title || 'Action'} — click again to confirm` : ariaLabel || title}
    >
      {armed ? confirmLabel : children}
      <style>{CSS}</style>
    </button>
  )
}

const CSS = `
.cfm.is-armed { border-color: var(--pink) !important; color: var(--pink) !important; background: rgba(255,37,102,.12) !important; }
`
