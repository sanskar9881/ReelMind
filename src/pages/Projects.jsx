import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { listProjects, deleteProject, duplicateProject } from '../utils/storage.js'
import { fmtTime } from '../utils/videoMeta.js'

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

  const onDelete = useCallback(
    async (p) => {
      if (!window.confirm(`Delete “${p.name}”? This cannot be undone.`)) return
      await deleteProject(p.id)
      refresh()
    },
    [refresh],
  )

  const onDuplicate = useCallback(
    async (p) => {
      await duplicateProject(p.id)
      refresh()
    },
    [refresh],
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
          <p className="pj-dim">Loading…</p>
        ) : !projects.length ? (
          <div className="pj-empty">
            <div className="pj-empty-icon">🎬</div>
            <h3>No saved projects yet</h3>
            <p>Open the editor and drop in some footage — it saves automatically as you work.</p>
            <Link to="/editor" className="pj-btn pj-btn-primary">
              Open the editor
            </Link>
          </div>
        ) : (
          <div className="pj-grid">
            {projects.map((p) => (
              <div key={p.id} className="pj-card">
                <button className="pj-thumb" onClick={() => navigate(`/editor?project=${p.id}`)}>
                  {p.thumb ? <img src={p.thumb} alt="" /> : <span className="pj-thumb-x">🎬</span>}
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
                    <button className="pj-btn pj-btn-sm pj-danger" onClick={() => onDelete(p)}>
                      Delete
                    </button>
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
.pj-top { display: flex; align-items: center; justify-content: space-between; height: 64px; padding: 0 24px; border-bottom: 1px solid var(--border); background: var(--panel); }
.pj-logo { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 18px; }
.pj-logo span { background: linear-gradient(90deg, var(--cyan), var(--purple)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.pj-wrap { max-width: 1000px; margin: 0 auto; padding: 40px 24px 80px; }
.pj-h1 { font-size: clamp(26px, 4vw, 38px); margin-bottom: 10px; }
.pj-sub { color: var(--muted); font-size: 14px; line-height: 1.65; max-width: 620px; margin: 0 0 32px; }
.pj-dim { color: var(--muted); font-size: 14px; }
.pj-error { color: var(--pink); border: 1px solid rgba(255,37,102,.35); background: rgba(255,37,102,.08); border-radius: 10px; padding: 10px 12px; margin-bottom: 20px; font-size: 13px; }

.pj-btn { display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 9px; padding: 9px 16px; font-size: 13px; font-weight: 600; transition: transform .12s, border-color .12s; }
.pj-btn:hover { transform: translateY(-1px); border-color: #2a2a42; }
.pj-btn-primary { background: linear-gradient(90deg, var(--cyan), var(--purple)); color: #05050a; border-color: transparent; }
.pj-btn-sm { padding: 6px 11px; font-size: 12px; }
.pj-danger:hover { border-color: var(--pink); color: var(--pink); }

.pj-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 18px; }
.pj-card { border: 1px solid var(--border); border-radius: 14px; background: var(--panel); overflow: hidden; display: flex; flex-direction: column; }
.pj-card:hover { border-color: #2a2a42; }
.pj-thumb { display: block; width: 100%; aspect-ratio: 16/9; background: #000; border: none; padding: 0; cursor: pointer; }
.pj-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pj-thumb-x { display: grid; place-items: center; width: 100%; height: 100%; font-size: 30px; }
.pj-card-body { padding: 13px; display: flex; flex-direction: column; gap: 4px; }
.pj-card-name { font-family: 'Syne', sans-serif; font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pj-card-meta { color: var(--muted); font-size: 11.5px; }
.pj-card-actions { display: flex; gap: 6px; margin-top: 10px; }
.pj-card-actions .pj-btn { flex: 1; }

.pj-empty { text-align: center; padding: 56px 20px; border: 1px dashed var(--border); border-radius: 16px; }
.pj-empty-icon { font-size: 42px; }
.pj-empty h3 { margin: 14px 0 8px; }
.pj-empty p { color: var(--muted); font-size: 14px; margin-bottom: 20px; }
`
