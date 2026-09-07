import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Landing from './pages/Landing.jsx'
import Editor from './pages/Editor.jsx'
import Projects from './pages/Projects.jsx'
import QuickEdit from './pages/QuickEdit.jsx'
import { ToastProvider, useToast } from './ui/Toast.jsx'
import { useQuickEditGate } from './ui/useResponsive.js'
import { ErrorBoundary } from './ui/ErrorBoundary.jsx'
import { useEffect } from 'react'

/**
 * The editor route is gated on viewport AND capability. A narrow screen gets
 * Quick Edit; so does a wide screen on a device reporting under 4GB, which
 * would OOM in the middle of a render. `?full=1` opts back into the editor.
 */
function EditorRoute() {
  const { quick, reason } = useQuickEditGate()
  // The boundary wraps BOTH: Quick Edit renders on the lowest-memory devices in
  // the fleet, which is exactly where a crash is most likely.
  return (
    <ErrorBoundary>{quick ? <QuickEdit reason={reason} /> : <Editor />}</ErrorBoundary>
  )
}

/**
 * An unhandled rejection is a real failure that nobody sees: it prints one line
 * to a console the user does not have open, and the UI just quietly stops doing
 * what it was asked to do. Surface every one of them.
 */
function GlobalErrorReporter() {
  const toast = useToast()
  useEffect(() => {
    const onRejection = (e) => {
      const err = e.reason
      const msg = err?.message || String(err ?? 'Unknown error')
      // Aborts are how cancellation is expressed, not a failure to report.
      if (/AbortError|The user aborted|cancelled/i.test(msg)) return
      console.error('[unhandled rejection]', err)
      toast.error('Something failed in the background', msg.slice(0, 300))
    }
    const onError = (e) => {
      // Resource load errors (an <img> or <video> that 404s) are not app errors
      // and would otherwise fire a toast on every missing thumbnail.
      if (e.target && e.target !== window) return
      console.error('[uncaught error]', e.error || e.message)
      toast.error('Something went wrong', String(e.message || e.error).slice(0, 300))
    }
    window.addEventListener('unhandledrejection', onRejection)
    window.addEventListener('error', onError, true)
    return () => {
      window.removeEventListener('unhandledrejection', onRejection)
      window.removeEventListener('error', onError, true)
    }
  }, [toast])
  return null
}

export default function App() {
  return (
    <ToastProvider>
      <GlobalErrorReporter />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/editor" element={<EditorRoute />} />
          <Route path="/projects" element={<Projects />} />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  )
}
