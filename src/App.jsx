import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Landing from './pages/Landing.jsx'
import Editor from './pages/Editor.jsx'
import Projects from './pages/Projects.jsx'
import QuickEdit from './pages/QuickEdit.jsx'
import { ToastProvider } from './ui/Toast.jsx'
import { useQuickEditGate } from './ui/useResponsive.js'

/**
 * The editor route is gated on viewport AND capability. A narrow screen gets
 * Quick Edit; so does a wide screen on a device reporting under 4GB, which
 * would OOM in the middle of a render. `?full=1` opts back into the editor.
 */
function EditorRoute() {
  const { quick, reason } = useQuickEditGate()
  return quick ? <QuickEdit reason={reason} /> : <Editor />
}

export default function App() {
  return (
    <ToastProvider>
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
