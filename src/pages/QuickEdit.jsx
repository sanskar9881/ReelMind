import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { probeAll, fmtTime, fmtSize } from '../utils/videoMeta.js'
import { analyzeAll } from '../utils/analyzer.js'
import { generateEditPlan } from '../utils/ai.js'
import { render, estimateRenderSeconds } from '../utils/videoProcessor.js'
import { useToast } from '../ui/Toast.jsx'
import { SkeletonRows } from '../ui/Empty.jsx'
import { ConfirmButton } from '../ui/Confirm.jsx'
import { RenderProgress } from '../ui/RenderProgress.jsx'
import { capPlanDuration, MOBILE_MAX_SECONDS } from '../utils/mobileLimits.js'

const PRESETS = [
  { label: 'Fast and punchy', prompt: 'fast energetic edit, snappy quick cuts, best moments first' },
  { label: 'Calm and cinematic', prompt: 'calm cinematic pacing, longer holds, smooth transitions' },
  { label: '2 minute highlight', prompt: '2 minute highlight reel of the strongest moments' },
  { label: 'Remove dead air', prompt: 'remove dead air and long silences, keep it tight' },
]

export default function QuickEdit({ reason }) {
  const toast = useToast()

  const [clips, setClips] = useState([])
  const [probing, setProbing] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [probeErrors, setProbeErrors] = useState([])
  const [analysis, setAnalysis] = useState(() => new Map())

  const [prompt, setPrompt] = useState('')
  const [aiState, setAiState] = useState('idle') // idle | thinking | done | error
  const [plan, setPlan] = useState(null)
  const [aiError, setAiError] = useState('')

  const [rendering, setRendering] = useState(false)
  const [progress, setProgress] = useState({ stage: '', pct: 0, msg: '' })
  const [renderStartedAt, setRenderStartedAt] = useState(null)
  const [result, setResult] = useState(null)
  const [renderError, setRenderError] = useState('')

  const fileRef = useRef(null)
  const clipsRef = useRef(clips)
  useEffect(() => {
    clipsRef.current = clips
  }, [clips])
  useEffect(() => () => clipsRef.current.forEach((c) => URL.revokeObjectURL(c.url)), [])

  const rawSeconds = useMemo(() => clips.reduce((a, c) => a + (c.duration || 0), 0), [clips])

  // What actually renders: the plan when there is one, otherwise a straight
  // cut of every clip — both put through the same 3-minute ceiling.
  const effective = useMemo(() => {
    const base =
      plan ||
      (clips.length
        ? {
            title: 'Straight cut',
            reasoning: '',
            music: 'none',
            segments: clips.map((c) => ({
              clip: c.name,
              clipId: c.id,
              start: 0,
              end: c.duration,
              transition: 'cut',
              role: 'body',
            })),
          }
        : null)
    if (!base) return null
    return capPlanDuration(base)
  }, [plan, clips])

  const ingest = useCallback(
    async (fileList) => {
      setProbing(true)
      setProbeErrors([])
      let fresh = []
      try {
        const res = await probeAll(fileList)
        fresh = res.clips
        if (fresh.length) setClips((prev) => [...prev, ...fresh])
        if (res.errors.length) {
          setProbeErrors(res.errors)
          toast.error(
            `${res.errors.length} file${res.errors.length === 1 ? '' : 's'} could not be read`,
            res.errors[0].message,
          )
        }
      } finally {
        setProbing(false)
      }
      // Sequential, exactly as on desktop — a phone has even less headroom.
      if (fresh.length) {
        setAnalyzing(true)
        try {
          const map = await analyzeAll(fresh, () => {})
          setAnalysis((prev) => {
            const merged = new Map(prev)
            for (const [k, v] of map) merged.set(k, v)
            return merged
          })
          toast.success(`Analyzed ${fresh.length} clip${fresh.length === 1 ? '' : 's'}`)
        } finally {
          setAnalyzing(false)
        }
      }
    },
    [toast],
  )

  const removeClip = useCallback((id) => {
    setClips((prev) => {
      const t = prev.find((c) => c.id === id)
      if (t) URL.revokeObjectURL(t.url)
      return prev.filter((c) => c.id !== id)
    })
    setAnalysis((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
    setPlan(null)
    setAiState('idle')
  }, [])

  const runGenerate = useCallback(async () => {
    if (!clips.length || aiState === 'thinking') return
    setAiState('thinking')
    setAiError('')
    setPlan(null)
    try {
      const full = await generateEditPlan(clips, prompt, analysis, new Map(), null)
      // The candidate menu is large and mobile has nowhere to show it — keep it
      // out of state rather than holding 400 scored objects on a phone.
      const { candidates: _menu, ...p } = full
      p.planId = `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
      setPlan(p)
      setAiState('done')
      toast.success(
        p.plannedBy === 'claude' ? 'Planned by Claude' : 'Planned offline',
        `${p.segments.length} moments kept`,
      )
    } catch (err) {
      setAiError(err.message || 'Planning failed.')
      setAiState('error')
      toast.error('Could not plan the edit', err.message)
    }
  }, [clips, prompt, aiState, analysis, toast])

  const runRender = useCallback(async () => {
    if (rendering || !effective?.plan?.segments?.length) return
    setRendering(true)
    setRenderError('')
    setResult(null)
    setRenderStartedAt(Date.now())
    setProgress({ stage: 'engine', pct: 0, msg: 'Preparing…' })
    try {
      const out = await render(clips, effective.plan, { resolution: '720p' }, (p) => setProgress(p))
      setResult(out)
      toast.success('Render complete', fmtSize(out.size))
    } catch (err) {
      setRenderError(err.message || 'Render failed.')
      toast.error('Render failed', err.message)
    } finally {
      setRendering(false)
    }
  }, [rendering, effective, clips, toast])

  const shots = effective?.plan?.segments?.length || 0
  const outSeconds = effective?.seconds || 0

  return (
    <div className="qe">
      <style>{CSS}</style>

      <header className="qe-top">
        <Link to="/" className="qe-logo" aria-label="ReelMind home">
          Reel<span>Mind</span>
        </Link>
        <span className="qe-badge">Quick Edit</span>
      </header>

      <main className="qe-col">
        {reason === 'memory' && (
          <div className="qe-note" role="status">
            This device reports under 4GB of memory, so ReelMind is running the lightweight flow —
            the full editor would run out of memory mid-render.
          </div>
        )}

        {/* 1 — FOOTAGE */}
        <section className="qe-sec" aria-labelledby="qe-h-clips">
          <h2 className="qe-h" id="qe-h-clips">
            1 · Add footage
          </h2>

          <button
            type="button"
            className="qe-drop"
            onClick={() => fileRef.current?.click()}
            disabled={probing}
          >
            <span className="qe-drop-icon" aria-hidden="true">
              ▶
            </span>
            <span className="qe-drop-t">{probing ? 'Reading video…' : 'Tap to add video'}</span>
            <span className="qe-drop-d">mp4, mov, webm · stays on your phone</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="video/*"
            hidden
            onChange={(e) => {
              if (e.target.files?.length) ingest(e.target.files)
              e.target.value = ''
            }}
          />

          {probing && !clips.length && (
            <div className="qe-mt">
              <SkeletonRows count={2} height={64} />
            </div>
          )}

          {!!probeErrors.length && (
            <div className="qe-errs">
              {probeErrors.map((er, i) => (
                <div key={i} className="qe-err">
                  <strong>{er.name}</strong>
                  {er.message}
                </div>
              ))}
            </div>
          )}

          {clips.length > 0 && (
            <>
              <ul className="qe-strip" aria-label="Added clips">
                {clips.map((c) => (
                  <li key={c.id} className="qe-clip">
                    <ConfirmButton
                      className="qe-clip-btn"
                      confirmLabel=""
                      ariaLabel={`Remove ${c.name}`}
                      onConfirm={() => removeClip(c.id)}
                    >
                      {c.thumb ? (
                        <img src={c.thumb} alt="" />
                      ) : (
                        <span className="qe-clip-x" aria-hidden="true">
                          🎬
                        </span>
                      )}
                      <span className="qe-clip-dur">{fmtTime(c.duration)}</span>
                      <span className="qe-clip-rm" aria-hidden="true">
                        ×
                      </span>
                    </ConfirmButton>
                    <span className="qe-clip-name" title={c.name}>
                      {c.name}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="qe-dim">
                {clips.length} clip{clips.length === 1 ? '' : 's'} · {fmtTime(rawSeconds)} of footage
                {analyzing && ' · analyzing…'} · tap a clip twice to remove it
              </p>
            </>
          )}

          {!clips.length && !probing && (
            <p className="qe-dim">
              Nothing is uploaded — the video is decoded, planned and rendered on this device. Up to
              3 minutes of finished edit.
            </p>
          )}
        </section>

        {/* 2 — PROMPT */}
        <section className="qe-sec" aria-labelledby="qe-h-prompt">
          <h2 className="qe-h" id="qe-h-prompt">
            2 · Describe the edit
          </h2>
          <div className="qe-chips">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                className={`qe-chip${prompt === p.prompt ? ' is-on' : ''}`}
                onClick={() => setPrompt(p.prompt)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <textarea
            className="qe-ta"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. fast energetic 60 second travel montage, snappy cuts"
            aria-label="Describe the edit you want"
          />
          <button
            type="button"
            className="qe-btn qe-btn-primary qe-block"
            onClick={runGenerate}
            disabled={!clips.length || aiState === 'thinking'}
          >
            {aiState === 'thinking' ? 'Planning…' : 'Generate edit'}
          </button>

          <div className="qe-planout" role="status" aria-live="polite">
            {aiState === 'error' && <span className="qe-bad">{aiError}</span>}
            {aiState === 'done' && plan && effective && (
              <>
                <strong className="qe-plan-title">{plan.title}</strong>
                <p className="qe-plan-reason">{plan.reasoning}</p>
                <p className="qe-dim">
                  {shots} shot{shots === 1 ? '' : 's'} · {fmtTime(outSeconds)} total ·{' '}
                  {plan.music === 'none' ? 'no music' : `${plan.music} music`}
                </p>
                {plan.candidateStats && (
                  <p className="qe-dim">
                    Selected from {plan.candidateStats.generated} candidate moments ·{' '}
                    {fmtTime(plan.candidateStats.outputSeconds)} from{' '}
                    {fmtTime(plan.candidateStats.footageSeconds)} of footage
                  </p>
                )}
                <p className="qe-dim">
                  <span className={`qe-planby${plan.plannedBy === 'claude' ? ' is-claude' : ''}`}>
                    {plan.plannedBy === 'claude' ? 'Planned by Claude' : 'Offline planner'}
                  </span>
                  {plan.plannedBy !== 'claude' && plan.fallbackReason ? ` — ${plan.fallbackReason}` : ''}
                </p>
                {effective.trimmed && (
                  <p className="qe-warn">
                    Trimmed to {fmtTime(MOBILE_MAX_SECONDS)} — the mobile renderer caps output at 3
                    minutes because phone browsers run out of memory past that. Open on desktop for
                    the full-length edit.
                  </p>
                )}
              </>
            )}
          </div>
        </section>

        {/* 3 — RENDER */}
        <section className="qe-sec" aria-labelledby="qe-h-render">
          <h2 className="qe-h" id="qe-h-render">
            3 · Render
          </h2>
          <dl className="qe-facts">
            <div>
              <dt>Resolution</dt>
              <dd>720p — 1280×720 (mobile only)</dd>
            </div>
            <div>
              <dt>Length cap</dt>
              <dd>3 minutes max on mobile</dd>
            </div>
            {!!clips.length && (
              <div>
                <dt>Output</dt>
                <dd>
                  {shots} shot{shots === 1 ? '' : 's'} · {fmtTime(outSeconds)} · ~
                  {estimateRenderSeconds(effective?.plan || { segments: [] }, {
                    resolution: '720p',
                  })}
                  s estimated
                </dd>
              </div>
            )}
          </dl>

          <button
            type="button"
            className="qe-btn qe-btn-primary qe-block"
            onClick={runRender}
            disabled={rendering || !clips.length}
          >
            {rendering ? 'Rendering…' : plan ? 'Render this edit' : 'Render straight cut'}
          </button>

          {(rendering || progress.pct > 0) && (
            <RenderProgress progress={progress} startedAt={renderStartedAt} running={rendering} />
          )}

          {renderError && <div className="qe-bad qe-mt">{renderError}</div>}

          {result && (
            <div className="qe-result">
              <video src={result.url} controls playsInline className="qe-vid" />
              <a
                className="qe-btn qe-btn-primary qe-block"
                href={result.url}
                download={`${(plan?.title || 'reelmind').replace(/\s+/g, '_').toLowerCase()}_720p.mp4`}
              >
                Download MP4 · {fmtSize(result.size)}
              </a>
              <p className="qe-dim">
                {result.method === 'webcodecs'
                  ? 'Rendered on GPU (WebCodecs).'
                  : 'Rendered with FFmpeg (software).'}
              </p>
            </div>
          )}
        </section>

        <p className="qe-footer">
          Open on desktop for timeline editing, transcripts and retake removal.
        </p>
      </main>
    </div>
  )
}

const CSS = `
.qe { min-height: 100vh; min-height: 100dvh; background: var(--bg); color: var(--text); }
.qe-top { display: flex; align-items: center; gap: var(--s3); height: 56px; padding: 0 var(--s4); background: var(--panel); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
.qe-logo { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 18px; display: inline-flex; align-items: center; min-height: var(--tap); }
.qe-logo span { background: linear-gradient(90deg, var(--cyan), var(--purple)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.qe-badge { margin-left: auto; font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--cyan); border: 1px solid rgba(9,246,255,.4); background: rgba(9,246,255,.08); border-radius: 999px; padding: var(--s1) var(--s2); }

.qe-col { max-width: 640px; margin: 0 auto; padding: var(--s4) var(--s4) var(--s12); display: flex; flex-direction: column; gap: var(--s4); }
.qe-sec { background: var(--panel); border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--s4); display: flex; flex-direction: column; gap: var(--s3); }
.qe-h { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 700; }
.qe-note { border: 1px solid rgba(255,190,90,.35); background: rgba(255,190,90,.08); color: var(--amber); border-radius: var(--r-md); padding: var(--s3); font-size: 12.5px; line-height: 1.55; }
.qe-dim { color: var(--muted); font-size: 12.5px; line-height: 1.55; margin: 0; }
.qe-mt { margin-top: var(--s1); }
.qe-bad { color: var(--pink); font-size: 13px; }
.qe-warn { font-size: 12.5px; line-height: 1.55; color: var(--amber); background: rgba(255,190,90,.09); border: 1px solid rgba(255,190,90,.35); border-radius: var(--r-md); padding: var(--s3); margin: var(--s2) 0 0; }

.qe-drop { width: 100%; min-height: 132px; border: 1.5px dashed var(--border); border-radius: var(--r-lg); background: var(--surface); color: var(--text); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--s2); padding: var(--s6) var(--s4); }
.qe-drop:active { border-color: var(--cyan); background: rgba(9,246,255,.06); }
.qe-drop-icon { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: linear-gradient(90deg, var(--cyan), var(--purple)); color: #05050a; font-size: 16px; }
.qe-drop-t { font-weight: 600; font-size: 15px; }
.qe-drop-d { color: var(--muted); font-size: 12.5px; }

.qe-errs { display: flex; flex-direction: column; gap: var(--s2); }
.qe-err { background: rgba(255,37,102,.08); border: 1px solid rgba(255,37,102,.35); border-radius: var(--r-md); padding: var(--s2) var(--s3); font-size: 12px; color: #ffb3c6; }
.qe-err strong { display: block; color: var(--pink); word-break: break-all; margin-bottom: 2px; }

.qe-strip { list-style: none; margin: 0; padding: 0 0 var(--s2); display: flex; gap: var(--s3); overflow-x: auto; scroll-snap-type: x proximity; -webkit-overflow-scrolling: touch; overscroll-behavior-x: contain; }
.qe-clip { flex: none; width: 132px; scroll-snap-align: start; display: flex; flex-direction: column; gap: var(--s1); }
.qe-clip-btn { position: relative; display: block; width: 132px; height: 76px; padding: 0; border: 1px solid var(--border); border-radius: var(--r-md); overflow: hidden; background: #000; }
.qe-clip-btn img { width: 100%; height: 100%; object-fit: cover; display: block; }
.qe-clip-x { display: grid; place-items: center; width: 100%; height: 100%; font-size: 22px; }
.qe-clip-dur { position: absolute; left: var(--s1); bottom: var(--s1); background: rgba(0,0,0,.78); font-size: 10px; padding: 1px 5px; border-radius: var(--r-sm); font-variant-numeric: tabular-nums; }
.qe-clip-rm { position: absolute; right: var(--s1); top: var(--s1); width: 24px; height: 24px; border-radius: 50%; background: rgba(0,0,0,.7); display: grid; place-items: center; font-size: 16px; line-height: 1; }
.qe-clip-btn.is-armed .qe-clip-rm { background: var(--pink); color: #05050a; }
.qe-clip-name { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.qe-chips { display: flex; flex-wrap: wrap; gap: var(--s2); }
.qe-chip { min-height: var(--tap); padding: var(--s2) var(--s3); border-radius: 999px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); font-size: 13px; font-weight: 600; }
.qe-chip.is-on { border-color: var(--cyan); color: var(--cyan); background: rgba(9,246,255,.08); }
.qe-ta { width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-md); padding: var(--s3); color: var(--text); font-size: 16px; line-height: 1.5; resize: vertical; }
.qe-ta:focus { outline: none; border-color: var(--purple); }

.qe-btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--s2); min-height: var(--tap); border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: var(--r-md); padding: var(--s3) var(--s4); font-weight: 600; font-size: 15px; }
.qe-btn:disabled { opacity: .45; cursor: not-allowed; }
.qe-btn-primary { background: linear-gradient(90deg, var(--cyan), var(--purple)); color: #05050a; border-color: transparent; }
.qe-block { width: 100%; min-height: 50px; }

.qe-planout { font-size: 13px; line-height: 1.6; }
.qe-planout:empty { display: none; }
.qe-plan-title { display: block; font-family: 'Syne', sans-serif; font-size: 15px; }
.qe-plan-reason { margin: var(--s1) 0 var(--s2); color: var(--text); font-size: 13px; line-height: 1.6; }
.qe-planby { display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
  padding: 2px var(--s2); border-radius: 999px; border: 1px solid var(--muted-line); color: var(--muted); }
.qe-planby.is-claude { border-color: var(--cyan); color: var(--cyan); background: rgba(9,246,255,.1); }

.qe-facts { margin: 0; display: flex; flex-direction: column; gap: var(--s2); }
.qe-facts > div { display: flex; justify-content: space-between; gap: var(--s3); font-size: 12.5px; padding-bottom: var(--s2); border-bottom: 1px solid var(--border); }
.qe-facts > div:last-child { border-bottom: none; padding-bottom: 0; }
.qe-facts dt { color: var(--muted); flex: none; }
.qe-facts dd { margin: 0; text-align: right; }

.qe-result { display: flex; flex-direction: column; gap: var(--s3); margin-top: var(--s2); }
.qe-vid { width: 100%; border-radius: var(--r-md); background: #000; }

.qe-footer { text-align: center; color: var(--muted); font-size: 12.5px; line-height: 1.6; margin: var(--s4) 0 0; }

@media (min-width: 768px) {
  .qe-col { padding: var(--s8) var(--s6) var(--s12); gap: var(--s6); }
  .qe-sec { padding: var(--s6); }
}
`
