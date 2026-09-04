import { useEffect, useState } from 'react'

/**
 * Breakpoints, named once. Everything else — CSS media queries, the editor's
 * layout mode, the Quick Edit gate — reads off these numbers.
 *
 *   >= 1280  full    three panels + timeline
 *   1024..   rail    right sidebar collapses to a 48px icon rail
 *    768..   single  one panel at a time, left sidebar becomes a bottom tab bar
 *    < 768   quick   Quick Edit
 */
export const BP = { rail: 1024, single: 768, full: 1280 }

/** Below this the device will OOM decoding video, whatever its screen size. */
export const LOW_MEMORY_GB = 4

function query(w) {
  if (w >= BP.full) return 'full'
  if (w >= BP.rail) return 'rail'
  if (w >= BP.single) return 'single'
  return 'quick'
}

/** navigator.deviceMemory is Chromium-only and coarse (0.25–8). Absent means
 *  "unknown", which we treat as capable — never downgrade a desktop on a guess. */
export function lowMemoryDevice() {
  if (typeof navigator === 'undefined') return false
  const gb = navigator.deviceMemory
  return typeof gb === 'number' && gb > 0 && gb < LOW_MEMORY_GB
}

/**
 * Current layout mode plus the raw width. Listens to resize, so rotating a
 * tablet re-lays out rather than waiting for a reload.
 */
export function useLayoutMode() {
  const [state, setState] = useState(() => {
    const w = typeof window === 'undefined' ? 1440 : window.innerWidth
    return { width: w, mode: query(w) }
  })

  useEffect(() => {
    let frame = 0
    const onResize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const w = window.innerWidth
        setState((prev) => {
          const mode = query(w)
          if (prev.width === w && prev.mode === mode) return prev
          return { width: w, mode }
        })
      })
    }
    window.addEventListener('resize', onResize, { passive: true })
    window.addEventListener('orientationchange', onResize)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])

  return state
}

/**
 * Quick Edit is gated on viewport AND capability: a narrow screen gets it, and
 * so does a wide screen on a device that reports under 4GB of RAM — a 1366px
 * 2GB Chromebook cannot run the full editor's decode + render path either.
 *
 * `?full=1` forces the desktop editor for anyone who wants to try anyway.
 */
export function useQuickEditGate() {
  const { mode, width } = useLayoutMode()
  const [override] = useState(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('full') === '1',
  )
  const [lowMem] = useState(lowMemoryDevice)

  return {
    mode,
    width,
    lowMemory: lowMem,
    override,
    quick: !override && (mode === 'quick' || lowMem),
    /** Why we downgraded, for the "open on desktop" line. */
    reason: mode === 'quick' ? 'viewport' : lowMem ? 'memory' : null,
  }
}

/** True when the user has asked the OS to reduce motion. */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const on = () => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduced
}
