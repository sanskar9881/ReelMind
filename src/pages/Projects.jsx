import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { listProjects, deleteProject, duplicateProject } from '../utils/storage.js'
import { fmtTime } from '../utils/videoMeta.js'
import { useToast } from '../ui/Toast.jsx'
import { ConfirmButton } from '../ui/Confirm.jsx'
import { EmptyState } from '../ui/Empty.jsx'

function relTime(iso) {
  if (!iso) return ''
  const d = (Date.now() - new Date(iso).getTime()) / 1000
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  if (d < 604800) return `${Math.floor(d / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}

export default function Projects() {
  const [projects, setProjects] = useState(null) // null = loading
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const toast = useToast()

  const liveRef = useRef(true)
  const refresh = useCallback(async () => {
    try {
      const list = await listProjects()
      if (liveRef.current) setProjects(list)
    } catch (err) {
      if (!liveRef.current) return
      setError(err?.message || 'Could not read saved projects.')
      setProjects([])
    }
  }, [])

  useEffect(() => {
    liveRef.current = true
    refresh()
    return () => {
      liveRef.current = false
    }
  }, [refresh])

  // Confirmation is inline on the button itself (see ConfirmButton) rather than
  // a window.confirm — that dialog blocks the tab and can be suppressed outright
  // on mobile Safari, which would make Delete look broken.
  const onDelete = useCallback(
    async (p) => {
      try {
        await deleteProject(p.id)
        toast.info(`Deleted “${p.name}”`)
      } catch (err) {
        toast.error('Could not delete that project', err?.message)
      }
      refresh()
    },
    [refresh, toast],
  )

  const onDuplicate = useCallback(
    async (p) => {
      try {
        await duplicateProject(p.id)
        toast.success(`Duplicated “${p.name}”`)
      } catch (err) {
        toast.error('Could not duplicate that project', err?.message)
      }
      refresh()
    },
    [refresh, toast],
  )

  return (
    <div className="pj">
      <style>{CSS}</style>

      <div className="pj-top">
        <Link to="/" className="pj-logo">
          Reel<span>Mind</span>
        </Link>
        <Link to="/editor" className="pj-btn pj-btn-primary">
          New project
        </Link>
      </div>

      <div className="pj-wrap">
        <h1 className="pj-h1">Your projects</h1>
        <p className="pj-sub">
          Saved in this browser. Edits, transcripts and take choices persist; the source video files
          do not — browsers cannot keep access to them between sessions, so reopening asks you to
          reselect the same clips.
        </p>

        {error && <div className="pj-error">{error}</div>}

        {projects === null ? (
          <div className="pj-grid" aria-busy="true" aria-label="Loading projects">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="pj-card pj-skel" aria-hidden="true">
                <div className="pj-skel-thumb" />
                <div className="pj-card-body">
                  <span className="pj-skel-line" style={{ width: '70%' }} />
                  <span className="pj-skel-line" style={{ width: '45%' }} />
                </div>
              </div>
            ))}
          </div>
        ) : !projects.length ? (
          <EmptyState
            icon="🎬"
            title="No saved projects yet"
            action={
              <Link to="/editor" className="pj-btn pj-btn-primary">
                Open the editor
              </Link>
            }
          >
            Open the editor and drop in some footage — it saves automatically as you work, so a
            project appears here the moment you add a clip.
          </EmptyState>
        ) : (
          <div className="pj-grid">
            {projects.map((p) => (
              <div key={p.id} className="pj-card">
                <button
                  className="pj-thumb"
                  onClick={() => navigate(`/editor?project=${p.id}`)}
                  aria-label={`Open ${p.name}`}
                >
                  {p.thumb ? (
                    <img src={p.thumb} alt="" />
                  ) : (
                    <span className="pj-thumb-x" aria-hidden="true">
                      🎬
                    </span>
                  )}
                </button>
                <div className="pj-card-body">
                  <div className="pj-card-name" title={p.name}>
                    {p.name}
                  </div>
                  <div className="pj-card-meta">
                    {p.clipCount || 0} clip{p.clipCount === 1 ? '' : 's'}
                    {p.plan?.segments?.length
                      ? ` · ${p.plan.segments.length} shots · ${fmtTime(
                          p.plan.segments.reduce((a, s) => a + (s.end - s.start), 0),
                        )}`
                      : ''}
                  </div>
                  <div className="pj-card-meta">Edited {relTime(p.updatedAt)}</div>
                  <div className="pj-card-actions">
                    <Link className="pj-btn pj-btn-sm" to={`/editor?project=${p.id}`}>
                      Open
                    </Link>
                    <button className="pj-btn pj-btn-sm" onClick={() => onDuplicate(p)}>
                      Duplicate
                    </button>
                    <ConfirmButton
                      className="pj-btn pj-btn-sm pj-danger"
                      confirmLabel="Delete?"
                      ariaLabel={`Delete project ${p.name}`}
                      onConfirm={() => onDelete(p)}
                    >
                      Delete
                    </ConfirmButton>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const CSS = `
.pj { min-height: 100vh; background: var(--bg); color: var(--text); }
.pj-top { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); min-height: 64px; padding: var(--s3) clamp(var(--s4), 4vw, var(--s6)); border-bottom: 1px solid var(--border); background: var(--panel); }
.pj-logo { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 18px; }
.pj-logo span { background: linear-gradient(90deg, var(--cyan), var(--purple)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.pj-wrap { max-width: 1140px; margin: 0 auto; padding: clamp(var(--s6), 5vw, var(--s8)) clamp(var(--s4), 4vw, var(--s6)) var(--s12); }
.pj-h1 { font-size: clamp(26px, 4vw, 38px); margin-bottom: 10px; }
.pj-sub { color: var(--muted); font-size: 14px; line-height: 1.65; max-width: 620px; margin: 0 0 var(--s8); }
.pj-dim { color: var(--muted); font-size: 14px; }
.pj-error { color: var(--pink); border: 1px solid rgba(255,37,102,.35); background: rgba(255,37,102,.08); border-radius: 10px; padding: 10px 12px; margin-bottom: 20px; font-size: 13px; }

.pj-btn { display: inline-flex; align-items: center; justify-content: center; min-height: var(--tap); border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: var(--r-md); padding: var(--s2) var(--s4); font-size: 13px; font-weight: 600; transition: transform .12s, border-color .12s; }
.pj-btn:hover { transform: translateY(-1px); border-color: #2a2a42; }
.pj-btn-primary { background: linear-gradient(90deg, var(--cyan), var(--purple)); color: #05050a; border-color: transparent; }
.pj-btn-sm { padding: var(--s2) var(--s3); font-size: 12px; min-height: var(--tap); }
.pj-danger:hover { border-color: var(--pink); color: var(--pink); }

/* 3 / 2 / 1 columns — pinned to the app's breakpoints rather than left to
   auto-fill, so the grid matches the rest of the layout at every width. */
.pj-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s4); }
@media (max-width: 1279px) { .pj-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 767px) { .pj-grid { grid-template-columns: minmax(0, 1fr); } }
.pj-card { border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--panel); overflow: hidden; display: flex; flex-direction: column; min-width: 0; }
.pj-card:hover { border-color: #2a2a42; }
.pj-thumb { display: block; width: 100%; aspect-ratio: 16/9; background: #000; border: none; padding: 0; cursor: pointer; }
.pj-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pj-thumb-x { display: grid; place-items: center; width: 100%; height: 100%; font-size: 30px; }
.pj-card-body { padding: var(--s3); display: flex; flex-direction: column; gap: var(--s1); }
.pj-card-name { font-family: 'Syne', sans-serif; font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pj-card-meta { color: var(--muted); font-size: 11.5px; }
.pj-card-actions { display: flex; gap: var(--s2); margin-top: var(--s3); flex-wrap: wrap; }
.pj-card-actions .pj-btn { flex: 1; }

.pj-skel { pointer-events: none; }
.pj-skel-thumb { width: 100%; aspect-ratio: 16/9; }
.pj-skel-line { display: block; height: 9px; border-radius: 999px; }
.pj-skel-thumb, .pj-skel-line { background: linear-gradient(90deg, #14142260 25%, #23233a 50%, #14142260 75%); background-size: 300% 100%; animation: pj-shim 1.4s ease-in-out infinite; }
@keyframes pj-shim { from { background-position: 150% 0; } to { background-position: -150% 0; } }
@media (prefers-reduced-motion: reduce) { .pj-skel-thumb, .pj-skel-line { animation: none; background: #17172a; } }
`
