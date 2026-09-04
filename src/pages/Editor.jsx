import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { probeAll, fmtTime, fmtSize } from '../utils/videoMeta.js'
import { analyzeAll, withTranscript } from '../utils/analyzer.js'
import { transcribeClip } from '../utils/transcribe.js'
import { extendTakeRange } from '../utils/retakes.js'
import { generateEditPlan, USE_MOCK } from '../utils/ai.js'
import { render, estimateRenderSeconds, applyCutRanges } from '../utils/videoProcessor.js'
import { checkWebCodecsSupport } from '../utils/webcodecs/support.js'
import { verifyRender, measureSync } from '../utils/verify.js'
import { buildCaptions, remapToOutputTimeline, toSRT, toVTT } from '../utils/captions.js'

const PX_PER_SEC = 26

export default function Editor() {
  const [clips, setClips] = useState([])
  const [probeErrors, setProbeErrors] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [leftTab, setLeftTab] = useState('clips')
  const [rightTab, setRightTab] = useState('export')
  const [dragging, setDragging] = useState(false)
  const [probing, setProbing] = useState(false)
  const [analysis, setAnalysis] = useState(() => new Map())
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeMsg, setAnalyzeMsg] = useState('')

  // Speech-to-text. Opt-in per clip — b-roll has nothing to say.
  const [transcripts, setTranscripts] = useState({}) // { [clipId]: result | { error } }
  const [transcribing, setTranscribing] = useState(null) // { clipId, pct, msg } | null
  const [struck, setStruck] = useState({}) // { [clipId]: number[] } excluded sentence indices
  const [removeFillers, setRemoveFillers] = useState(false)
  const [retakeChoice, setRetakeChoice] = useState({}) // { [clipId]: { [groupId]: sentenceIndex } }
  const [keepAllTakes, setKeepAllTakes] = useState(false)

  // Captions — built from transcript word timings, optionally burned into video.
  const [burnCaptions, setBurnCaptions] = useState(false)
  const [captionSize, setCaptionSize] = useState('M') // S | M | L
  const [captionPos, setCaptionPos] = useState('bottom') // bottom | top
  const [captionBg, setCaptionBg] = useState(false)

  const [prompt, setPrompt] = useState('')
  const [aiState, setAiState] = useState('idle') // idle | thinking | done | error
  const [plan, setPlan] = useState(null)
  const [aiError, setAiError] = useState('')

  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)

  const [resolution, setResolution] = useState('720p')
  const [rendering, setRendering] = useState(false)
  const [progress, setProgress] = useState({ stage: '', pct: 0, msg: '' })
  const [result, setResult] = useState(null) // { url, size, method, fellBack, ... }
  const [renderError, setRenderError] = useState('')
  const [engine, setEngine] = useState(null) // checkWebCodecsSupport() result
  const [verifyState, setVerifyState] = useState(null) // { running, report, sync } | null
  const [verifyOpen, setVerifyOpen] = useState(false)
  const [diagnostics, setDiagnostics] = useState(false)
  const [smoke, setSmoke] = useState(null) // { running, log[], ok } | null

  const fileInputRef = useRef(null)
  const videoRef = useRef(null)
  const clipsRef = useRef(clips)
  useEffect(() => {
    clipsRef.current = clips
  }, [clips])

  const selected = useMemo(() => clips.find((c) => c.id === selectedId) || null, [clips, selectedId])

  const transcriptsMap = useMemo(() => new Map(Object.entries(transcripts)), [transcripts])

  // Source-time caption cues per clip, straight from word timings.
  const captionCuesByClip = useMemo(() => {
    const out = {}
    for (const [cid, tr] of Object.entries(transcripts)) {
      if (!tr || tr.error || !tr.words?.length) continue
      const cues = buildCaptions(tr, {})
      if (cues.length) out[cid] = cues
    }
    return out
  }, [transcripts])

  const captionStyle = useMemo(
    () => ({
      size: captionSize,
      position: captionPos,
      background: captionBg,
      sizeScale: captionSize === 'S' ? 0.035 : captionSize === 'L' ? 0.058 : 0.045,
      marginScale: 0.08,
    }),
    [captionSize, captionPos, captionBg],
  )

  const hasCaptions = Object.keys(captionCuesByClip).length > 0

  // Burn-in works on both engines: the GPU compositor draws captions on canvas,
  // and the FFmpeg core does ship libass (it just needs a font handed to it).
  // Kept as a hook in case a future engine genuinely cannot burn in.
  const burnInUnavailable = false

  // Caption cue active at the current preview time (selected clip, source time).
  const previewCue = useMemo(() => {
    const cues = selected && captionCuesByClip[selected.id]
    if (!cues) return null
    return cues.find((c) => currentTime >= c.start && currentTime < c.end) || null
  }, [selected, captionCuesByClip, currentTime])

  // Time ranges of struck sentences — dropped at render time like fillers.
  const excludeRanges = useMemo(() => {
    const out = []
    for (const [cid, idxs] of Object.entries(struck)) {
      const tr = transcripts[cid]
      if (!tr || tr.error || !tr.sentences) continue
      for (const idx of idxs) {
        const s = tr.sentences[idx]
        if (s) out.push({ clipId: cid, clip: tr.name || '', start: s.start, end: s.end })
      }
    }
    return out
  }, [struck, transcripts])

  const allFillerRanges = useMemo(() => {
    const out = []
    for (const [cid, tr] of Object.entries(transcripts)) {
      if (!tr || tr.error) continue
      for (const f of tr.fillers || []) out.push({ clipId: cid, clip: tr.name || '', start: f.start, end: f.end })
    }
    return out
  }, [transcripts])

  const fillerCount = allFillerRanges.length

  // Retake groups per clip, straight off the analysis object.
  const retakesByClip = useMemo(() => {
    const m = {}
    for (const c of clips) {
      const g = analysis.get(c.id)?.retakes
      if (g?.length) m[c.id] = g
    }
    return m
  }, [clips, analysis])

  const chosenTakeIndex = useCallback(
    (clipId, group) => retakeChoice[clipId]?.[group.id] ?? group.recommended,
    [retakeChoice],
  )

  // Every non-chosen take across every clip — excluded at render time, exactly
  // like fillers and struck sentences. Nothing is deleted.
  const retakeExcludeRanges = useMemo(() => {
    if (keepAllTakes) return []
    const out = []
    for (const [cid, groups] of Object.entries(retakesByClip)) {
      const tr = transcripts[cid]
      if (!tr || tr.error) continue
      for (const g of groups) {
        const keep = retakeChoice[cid]?.[g.id] ?? g.recommended
        for (const take of g.takes) {
          if (take.sentenceIndex === keep) continue
          // Absorb the trailing breath / pause after the take.
          const r = extendTakeRange(take, tr.sentences)
          out.push({ clipId: cid, clip: tr.name || '', start: r.start, end: r.end })
        }
      }
    }
    return out
  }, [retakesByClip, transcripts, retakeChoice, keepAllTakes])

  const retakeGroupCount = useMemo(
    () => Object.values(retakesByClip).reduce((a, g) => a + g.length, 0),
    [retakesByClip],
  )
  const retakeSavedSec = useMemo(
    () => retakeExcludeRanges.reduce((a, r) => a + (r.end - r.start), 0),
    [retakeExcludeRanges],
  )

  const chooseTake = useCallback((clipId, groupId, sentenceIndex) => {
    setRetakeChoice((prev) => ({
      ...prev,
      [clipId]: { ...(prev[clipId] || {}), [groupId]: sentenceIndex },
    }))
  }, [])

  // Decorate a fresh plan with the current text-editing decisions.
  const applyTextEdits = useCallback(
    (p) => {
      if (!p) return p
      const combined = [...excludeRanges, ...retakeExcludeRanges]
      if (combined.length) p.excludeRanges = combined
      if (removeFillers && allFillerRanges.length) {
        p.removeFillers = true
        p.fillerRanges = allFillerRanges
      }
      return p
    },
    [excludeRanges, retakeExcludeRanges, removeFillers, allFillerRanges],
  )

  // Revoke every object URL on unmount.
  useEffect(() => {
    return () => {
      clipsRef.current.forEach((c) => URL.revokeObjectURL(c.url))
    }
  }, [])

  // Probe the render engine once.
  useEffect(() => {
    let live = true
    checkWebCodecsSupport().then((r) => live && setEngine(r))
    return () => {
      live = false
    }
  }, [])

  const ingest = useCallback(async (fileList) => {
    setProbing(true)
    setProbeErrors([])
    let newClips = []
    try {
      const res = await probeAll(fileList)
      newClips = res.clips
      if (newClips.length) {
        setClips((prev) => [...prev, ...newClips])
        setSelectedId((cur) => cur || newClips[0].id)
      }
      if (res.errors.length) setProbeErrors(res.errors)
    } finally {
      setProbing(false)
    }

    // Content analysis runs AFTER probing and strictly one clip at a time —
    // decoded PCM + canvas reads would otherwise blow the memory ceiling.
    if (newClips.length) {
      setAnalyzing(true)
      try {
        const map = await analyzeAll(newClips, (p) => setAnalyzeMsg(p.msg || ''))
        setAnalysis((prev) => {
          const merged = new Map(prev)
          for (const [k, v] of map) merged.set(k, v)
          return merged
        })
      } finally {
        setAnalyzing(false)
        setAnalyzeMsg('')
      }
    }
  }, [])

  const onDrop = useCallback(
    (e) => {
      e.preventDefault()
      setDragging(false)
      if (e.dataTransfer?.files?.length) ingest(e.dataTransfer.files)
    },
    [ingest],
  )

  const removeClip = useCallback((id) => {
    setClips((prev) => {
      const target = prev.find((c) => c.id === id)
      if (target) URL.revokeObjectURL(target.url)
      return prev.filter((c) => c.id !== id)
    })
    setSelectedId((cur) => (cur === id ? null : cur))
    setAnalysis((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
    setTranscripts((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setStruck((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setRetakeChoice((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    setPlan(null)
    setAiState('idle')
  }, [])

  // ---- video element wiring -------------------------------------------------
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    setPlaying(false)
    setCurrentTime(0)
  }, [selectedId])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) {
      v.play().then(
        () => setPlaying(true),
        () => setPlaying(false),
      )
    } else {
      v.pause()
      setPlaying(false)
    }
  }, [])

  const seekPreview = useCallback((t) => {
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.max(0, t)
    setCurrentTime(v.currentTime)
  }, [])

  // ---- transcription ---------------------------------------------------
  const mergeTranscript = useCallback((clip, result) => {
    setTranscripts((prev) => ({ ...prev, [clip.id]: { ...result, name: clip.name } }))
    setAnalysis((prev) => {
      const next = new Map(prev)
      const prior = next.get(clip.id) || { id: clip.id, name: clip.name, duration: clip.duration }
      next.set(clip.id, withTranscript(prior, result))
      return next
    })
  }, [])

  const transcribeOne = useCallback(
    async (clip) => {
      if (transcribing) return
      setTranscribing({ clipId: clip.id, pct: 0, msg: 'Starting…' })
      try {
        const res = await transcribeClip(clip, (p) =>
          setTranscribing({ clipId: clip.id, pct: p.pct, msg: p.msg }),
        )
        mergeTranscript(clip, res)
      } catch (err) {
        setTranscripts((prev) => ({
          ...prev,
          [clip.id]: { error: err.message, name: clip.name, words: [], sentences: [], fillers: [], text: '' },
        }))
      } finally {
        setTranscribing(null)
      }
    },
    [transcribing, mergeTranscript],
  )

  const transcribeAllClips = useCallback(async () => {
    if (transcribing) return
    const pending = clips.filter((c) => !transcripts[c.id] || transcripts[c.id].error)
    if (!pending.length) return
    for (let i = 0; i < pending.length; i++) {
      const clip = pending[i]
      setTranscribing({ clipId: clip.id, pct: 0, msg: `Starting ${i + 1}/${pending.length}…` })
      try {
        // eslint-disable-next-line no-await-in-loop -- sequential on purpose (memory)
        const res = await transcribeClip(clip, (p) =>
          setTranscribing({ clipId: clip.id, pct: p.pct, msg: `${p.msg} · ${i + 1}/${pending.length}` }),
        )
        mergeTranscript(clip, res)
      } catch (err) {
        setTranscripts((prev) => ({
          ...prev,
          [clip.id]: { error: err.message, name: clip.name, words: [], sentences: [], fillers: [], text: '' },
        }))
      }
    }
    setTranscribing(null)
  }, [transcribing, clips, transcripts, mergeTranscript])

  const toggleStruck = useCallback((clipId, idx) => {
    setStruck((prev) => {
      const cur = prev[clipId] || []
      const has = cur.includes(idx)
      return { ...prev, [clipId]: has ? cur.filter((i) => i !== idx) : [...cur, idx] }
    })
  }, [])

  // ---- AI plan -----------------------------------------------------------
  const runGenerate = useCallback(async () => {
    if (!clips.length || aiState === 'thinking') return
    setAiState('thinking')
    setAiError('')
    setPlan(null)
    try {
      const p = await generateEditPlan(clips, prompt, analysis, transcriptsMap)
      applyTextEdits(p)
      setPlan(p)
      setAiState('done')
    } catch (err) {
      setAiError(err.message || 'Planning failed.')
      setAiState('error')
    }
  }, [clips, prompt, aiState, analysis, transcriptsMap, applyTextEdits])

  // ---- render -----------------------------------------------------------
  const diagLog = useCallback((d) => {
    if (d.phase === 'video') {
      console.log(
        `[render:seg ${d.index}] src ${d.srcIn}–${d.srcOut}s · frames encoded ${d.videoFramesEncoded} · outIdx ${d.outIdxRange?.join('→')} · peak open ${d.peakOpenFrames}`,
      )
    } else if (d.phase === 'audio') {
      console.log(
        `[render:seg ${d.index}] audio snapped ${d.snappedAudioIn}–${d.snappedAudioOut}s · samples ${d.audioSamplesWritten}/${d.expectedSamples}`,
      )
    } else if (d.phase === 'ffmpeg-part') {
      console.log(
        `[render:part ${d.index}] ${d.clip} · src ${d.srcIn}–${d.srcOut}s · dur ${d.partDuration}s · audio ${d.audio}`,
      )
    }
  }, [])

  const runRender = useCallback(async () => {
    if (rendering || !clips.length) return
    setRendering(true)
    setRenderError('')
    setResult(null)
    setVerifyState(null)
    setProgress({ stage: 'engine', pct: 0, msg: 'Preparing…' })
    try {
      const base =
        plan || {
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
      // Fresh object so we don't mutate the stored plan with render-time cuts.
      const effectivePlan = applyTextEdits({ ...base, segments: base.segments })
      const out = await render(
        clips,
        effectivePlan,
        {
          resolution,
          onDiag: diagnostics ? diagLog : undefined,
          captions:
            burnCaptions && hasCaptions && !burnInUnavailable
              ? { cuesByClip: captionCuesByClip, style: captionStyle }
              : undefined,
        },
        (p) => setProgress(p),
      )
      setResult(out)

      // Every render is verified — no "looks done" without a check.
      setVerifyState({ running: true, report: null, sync: null })
      try {
        const [report, sync] = await Promise.all([verifyRender(out.url, out), measureSync(out.url)])
        setVerifyState({ running: false, report, sync })
        if (diagnostics) console.log('[verify]', report, sync)
      } catch (e) {
        setVerifyState({ running: false, report: { ok: false, checks: [{ name: 'verify', passed: false, detail: e.message }], warnings: [] }, sync: null })
      }
    } catch (err) {
      setRenderError(err.message || 'Render failed.')
    } finally {
      setRendering(false)
    }
  }, [
    rendering,
    clips,
    plan,
    resolution,
    applyTextEdits,
    diagnostics,
    diagLog,
    burnCaptions,
    hasCaptions,
    burnInUnavailable,
    captionCuesByClip,
    captionStyle,
  ])

  // Download captions matching the finished render (or the selected clip's raw
  // timing when there's no plan yet).
  const downloadCaptions = useCallback(
    (fmt) => {
      let cues = []
      if (plan) {
        const split = applyCutRanges(applyTextEdits({ ...plan, segments: plan.segments }))
        cues = remapToOutputTimeline(captionCuesByClip, split, { transitionDuration: 0.5 })
      } else if (selected && captionCuesByClip[selected.id]) {
        cues = captionCuesByClip[selected.id]
      }
      if (!cues.length) return
      const text = fmt === 'vtt' ? toVTT(cues) : toSRT(cues)
      const blob = new Blob([text], { type: fmt === 'vtt' ? 'text/vtt' : 'application/x-subrip' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(plan?.title || selected?.name || 'reelmind').replace(/\.\w+$/, '').replace(/\s+/g, '_').toLowerCase()}.${fmt}`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
    [plan, applyTextEdits, captionCuesByClip, selected],
  )

  const doSmokeTest = useCallback(async () => {
    if (smoke?.running) return
    const log = []
    setSmoke({ running: true, log: [], ok: null })
    const push = (line) => {
      log.push(line)
      setSmoke({ running: true, log: [...log], ok: null })
    }
    try {
      const { runSmokeTest } = await import('../utils/smokeTest.js')
      const res = await runSmokeTest(push, diagnostics ? diagLog : undefined)
      setSmoke({ running: false, log: [...log], ok: res.ok, results: res.results })
    } catch (e) {
      push(`✗ threw: ${e.message}`)
      setSmoke({ running: false, log: [...log], ok: false })
    }
  }, [smoke, diagnostics, diagLog])

  // Blocks for the timeline video track.
  const videoBlocks = useMemo(() => {
    if (plan?.segments?.length) {
      return plan.segments.map((s, i) => ({
        key: `seg_${i}`,
        name: s.clip,
        len: s.end - s.start,
        role: s.role,
        transition: s.transition,
      }))
    }
    return clips.map((c) => ({ key: c.id, name: c.name, len: c.duration, role: 'clip' }))
  }, [plan, clips])

  const totalPlanLen = videoBlocks.reduce((a, b) => a + b.len, 0)

  const selTranscript = selected ? transcripts[selected.id] : null
  const selStruck = (selected && struck[selected.id]) || []
  // Plan time ranges on the selected clip — sentences overlapping these are "kept".
  const selPlanRanges = useMemo(() => {
    if (!plan || !selected) return []
    return plan.segments.filter((s) => s.clipId === selected.id).map((s) => [s.start, s.end])
  }, [plan, selected])
  const sentenceInPlan = (s) => selPlanRanges.some(([a, b]) => s.start < b && s.end > a)
  const fillerHitsWord = (w) =>
    selTranscript?.fillers?.some((f) => w.start < f.end && w.end > f.start)

  // Retake groups for the selected clip, indexed so the sentence list can drop
  // a grouped card where the first take would sit and skip the other members.
  const selRetakes = useMemo(
    () => (selected ? retakesByClip[selected.id] || [] : []),
    [selected, retakesByClip],
  )
  const retakeIndex = useMemo(() => {
    const byFirst = new Map()
    const members = new Set()
    for (const g of selRetakes) {
      const idxs = g.takes.map((t) => t.sentenceIndex)
      byFirst.set(Math.min(...idxs), g)
      idxs.forEach((ix) => members.add(ix))
    }
    return { byFirst, members }
  }, [selRetakes])

  return (
    <div className="ed">
      <style>{CSS}</style>

      {/* TOP BAR */}
      <div className="ed-top">
        <Link to="/" className="ed-logo">
          Reel<span>Mind</span>
        </Link>
        <div className="ed-top-mid">
          {plan ? plan.title : 'Untitled project'}
          <span className="ed-top-sub">
            {clips.length} clip{clips.length === 1 ? '' : 's'}
            {totalPlanLen > 0 && ` · ${fmtTime(totalPlanLen)} timeline`}
            {USE_MOCK && ' · mock AI'}
          </span>
        </div>
        <button
          className="ed-btn ed-btn-primary"
          onClick={() => {
            setRightTab('export')
            runRender()
          }}
          disabled={rendering || !clips.length}
        >
          {rendering ? 'Rendering…' : 'Render'}
        </button>
      </div>

      <div className="ed-body">
        {/* LEFT SIDEBAR */}
        <aside className="ed-side ed-side-left">
          <div className="ed-tabs">
            {['clips', 'transcript', 'music', 'fx'].map((t) => (
              <button
                key={t}
                className={`ed-tab${leftTab === t ? ' is-active' : ''}`}
                onClick={() => setLeftTab(t)}
              >
                {t === 'fx' ? 'FX' : t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {leftTab === 'clips' && (
            <div className="ed-side-scroll">
              <div
                className={`ed-drop${dragging ? ' is-drag' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
              >
                <div className="ed-drop-icon">▶</div>
                <div className="ed-drop-t">{probing ? 'Reading metadata…' : 'Drop video files'}</div>
                <div className="ed-drop-d">or click to browse · mp4, mov, webm</div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="video/*"
                  hidden
                  onChange={(e) => {
                    if (e.target.files?.length) ingest(e.target.files)
                    e.target.value = ''
                  }}
                />
              </div>

              {probeErrors.length > 0 && (
                <div className="ed-errs">
                  {probeErrors.map((er, i) => (
                    <div key={i} className="ed-err">
                      <strong>{er.name}</strong>
                      {er.message}
                    </div>
                  ))}
                </div>
              )}

              {clips.length > 0 && (
                <div className="ed-transcribe-all">
                  <button
                    className="ed-btn ed-btn-sm"
                    onClick={transcribeAllClips}
                    disabled={!!transcribing || clips.every((c) => transcripts[c.id] && !transcripts[c.id].error)}
                  >
                    {transcribing && transcribing.clipId == null ? 'Transcribing…' : 'Transcribe all'}
                  </button>
                  {transcribing && (
                    <div className="ed-prog ed-prog-tight">
                      <div className="ed-prog-bar">
                        <div className="ed-prog-fill" style={{ width: `${transcribing.pct}%` }} />
                      </div>
                      <div className="ed-dim">{transcribing.msg}</div>
                      {transcribing.pct < 60 && transcribing.msg?.includes('model') && (
                        <div className="ed-dim">Downloading speech model (~75MB, one time)</div>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="ed-lib">
                {clips.map((c) => (
                  <div
                    key={c.id}
                    className={`ed-lib-row${selectedId === c.id ? ' is-sel' : ''}`}
                    onClick={() => setSelectedId(c.id)}
                  >
                    <div className="ed-thumb">
                      {c.thumb ? <img src={c.thumb} alt="" /> : <div className="ed-thumb-x">?</div>}
                      <span className="ed-thumb-dur">{fmtTime(c.duration)}</span>
                    </div>
                    <div className="ed-lib-meta">
                      <div className="ed-lib-name" title={c.name}>
                        {c.name}
                      </div>
                      <div className="ed-lib-sub">
                        {c.width}×{c.height} · {fmtSize(c.size)}
                      </div>
                      {analysis.has(c.id) && !analysis.get(c.id).error && (
                        <div className="ed-meters" title="Analyzed content">
                          <Meter label="NRG" v={analysis.get(c.id).energy} />
                          <Meter label="MOV" v={Math.min(1, analysis.get(c.id).motionAvg * 4)} />
                          {analysis.get(c.id).silenceRatio > 0.05 && (
                            <span className="ed-meter-note">
                              {Math.round(analysis.get(c.id).silenceRatio * 100)}% quiet
                            </span>
                          )}
                        </div>
                      )}
                      <div className="ed-row-actions">
                        {transcribing?.clipId === c.id ? (
                          <span className="ed-mini-note">
                            <span className="ed-spin" /> {transcribing.pct}%
                          </span>
                        ) : transcripts[c.id]?.error ? (
                          <button
                            className="ed-linkbtn is-bad"
                            title={transcripts[c.id].error}
                            onClick={(e) => {
                              e.stopPropagation()
                              transcribeOne(c)
                            }}
                          >
                            transcribe failed — retry
                          </button>
                        ) : transcripts[c.id] ? (
                          <button
                            className="ed-linkbtn is-ok"
                            onClick={(e) => {
                              e.stopPropagation()
                              setSelectedId(c.id)
                              setLeftTab('transcript')
                            }}
                          >
                            ✓ {transcripts[c.id].sentences.length} sentences · view
                          </button>
                        ) : (
                          <button
                            className="ed-linkbtn"
                            disabled={!!transcribing}
                            onClick={(e) => {
                              e.stopPropagation()
                              transcribeOne(c)
                            }}
                          >
                            Transcribe
                          </button>
                        )}
                      </div>
                    </div>
                    <button
                      className="ed-x"
                      title="Remove clip"
                      onClick={(e) => {
                        e.stopPropagation()
                        removeClip(c.id)
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {!clips.length && !probing && (
                  <div className="ed-lib-empty">No clips yet. Add footage above.</div>
                )}
              </div>
            </div>
          )}

          {leftTab === 'transcript' && (
            <div className="ed-side-scroll">
              {!selected ? (
                <p className="ed-dim">Select a clip to see its transcript.</p>
              ) : !selTranscript ? (
                <div className="ed-placeholder">
                  <p>No transcript for “{selected.name}” yet.</p>
                  <button
                    className="ed-btn ed-btn-sm ed-btn-block"
                    onClick={() => transcribeOne(selected)}
                    disabled={!!transcribing}
                  >
                    {transcribing?.clipId === selected.id ? `Transcribing… ${transcribing.pct}%` : 'Transcribe this clip'}
                  </button>
                  {transcribing?.clipId === selected.id && (
                    <div className="ed-prog ed-prog-tight">
                      <div className="ed-prog-bar">
                        <div className="ed-prog-fill" style={{ width: `${transcribing.pct}%` }} />
                      </div>
                      <div className="ed-dim">{transcribing.msg}</div>
                    </div>
                  )}
                  <p className="ed-dim ed-mt">
                    Runs locally with Whisper. First run downloads the speech model (~75MB, one time).
                  </p>
                </div>
              ) : selTranscript.error ? (
                <div className="ed-placeholder">
                  <p className="ed-bad">{selTranscript.error}</p>
                  <button className="ed-btn ed-btn-sm ed-btn-block" onClick={() => transcribeOne(selected)} disabled={!!transcribing}>
                    Retry
                  </button>
                </div>
              ) : (
                <>
                  {retakeGroupCount > 0 && (
                    <div className="ed-retake-badge">
                      <span>
                        {retakeGroupCount} retake group{retakeGroupCount === 1 ? '' : 's'} found
                        {!keepAllTakes && retakeSavedSec > 0.05 &&
                          ` — ${retakeSavedSec < 10 ? retakeSavedSec.toFixed(1) : Math.round(retakeSavedSec)}s saved`}
                      </span>
                      <button
                        className={`ed-linkbtn${keepAllTakes ? '' : ' is-ok'}`}
                        onClick={() => setKeepAllTakes((v) => !v)}
                        title="Retake detection is non-destructive — toggle it off to keep every take"
                      >
                        {keepAllTakes ? 'detect retakes' : 'keep all takes'}
                      </button>
                    </div>
                  )}

                  <div className="ed-tx-head">
                    <span className="ed-dim">
                      {selTranscript.sentences.length} sentences · {selTranscript.fillers.length} fillers
                      {selStruck.length > 0 && ` · ${selStruck.length} cut`}
                    </span>
                    {selTranscript.fillers.length > 0 && (
                      <button
                        className={`ed-linkbtn${removeFillers ? ' is-ok' : ''}`}
                        onClick={() => setRemoveFillers((v) => !v)}
                        title="Toggle filler removal for the whole edit"
                      >
                        {removeFillers ? '✓ Removing fillers' : `Remove all fillers (${fillerCount})`}
                      </button>
                    )}
                  </div>

                  <div className="ed-tx-list">
                    {selTranscript.sentences.map((s, i) => {
                      // Retake group — render the grouped card at its first take,
                      // skip the other members (shown inside the card).
                      if (retakeIndex.members.has(i)) {
                        const g = retakeIndex.byFirst.get(i)
                        if (!g) return null
                        const chosen = chosenTakeIndex(selected.id, g)
                        return (
                          <div className="ed-retake" key={`rt-${g.id}`}>
                            <div className="ed-retake-head">{g.takes.length} takes of this line</div>
                            {g.takes.map((take) => {
                              const isChosen = take.sentenceIndex === chosen
                              const isRec = take.sentenceIndex === g.recommended
                              const cut = !keepAllTakes && !isChosen
                              return (
                                <label
                                  key={take.sentenceIndex}
                                  className={`ed-retake-take${isChosen ? ' is-chosen' : ''}${cut ? ' is-cut' : ''}`}
                                >
                                  <input
                                    type="radio"
                                    name={`rt-${selected.id}-${g.id}`}
                                    checked={isChosen}
                                    onChange={() => {
                                      chooseTake(selected.id, g.id, take.sentenceIndex)
                                      seekPreview(take.start)
                                    }}
                                  />
                                  <span
                                    className="ed-retake-body"
                                    onClick={() => seekPreview(take.start)}
                                  >
                                    <span className="ed-retake-text">{take.text}</span>
                                    <span className="ed-retake-meta">
                                      {fmtTime(take.start)} · {(take.end - take.start).toFixed(1)}s
                                      {isRec && <span className="ed-retake-rec">recommended</span>}
                                    </span>
                                  </span>
                                </label>
                              )
                            })}
                          </div>
                        )
                      }

                      const isStruck = selStruck.includes(i)
                      const kept = sentenceInPlan(s)
                      return (
                        <div
                          key={i}
                          className={`ed-tx-sent${isStruck ? ' is-struck' : ''}${kept ? ' is-kept' : ''}`}
                        >
                          <button
                            className="ed-tx-text"
                            onClick={() => seekPreview(s.start)}
                            title={`Seek to ${fmtTime(s.start)}`}
                          >
                            <span className="ed-tx-time">{fmtTime(s.start)}</span>{' '}
                            {s.words.map((w, wi) => (
                              <span key={wi} className={fillerHitsWord(w) ? 'ed-tx-filler' : undefined}>
                                {w.text}{' '}
                              </span>
                            ))}
                          </button>
                          <button
                            className="ed-tx-strike"
                            title={isStruck ? 'Include this line' : 'Exclude this line from the edit'}
                            onClick={() => toggleStruck(selected.id, i)}
                          >
                            {isStruck ? '↺' : 'S'}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                  <p className="ed-dim ed-mt">
                    Click a line to scrub there. Strike a line to cut it.
                    {retakeGroupCount > 0 && ' Pick one take per retake group; the rest are excluded.'}
                    {plan && ' Accented lines are in the current plan.'}
                  </p>

                  <div className="ed-caps">
                    <div className="ed-caps-head">
                      <label className={`ed-toggle${burnInUnavailable ? ' is-disabled' : ''}`}>
                        <input
                          type="checkbox"
                          checked={burnCaptions && !burnInUnavailable}
                          disabled={burnInUnavailable}
                          onChange={(e) => setBurnCaptions(e.target.checked)}
                        />
                        <span>Burn captions into video</span>
                      </label>
                      {burnCaptions && !burnInUnavailable && (
                        <p className="ed-caps-note is-info">
                          On the software renderer this fetches a caption font (~700KB, once per
                          session). If that fails the video still renders — just without burned-in
                          captions — and the .srt / .vtt below are unaffected.
                        </p>
                      )}
                    </div>

                    <div className="ed-caps-row">
                      <span className="ed-dim">Size</span>
                      {['S', 'M', 'L'].map((s) => (
                        <button
                          key={s}
                          className={`ed-seg-btn${captionSize === s ? ' is-on' : ''}`}
                          onClick={() => setCaptionSize(s)}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                    <div className="ed-caps-row">
                      <span className="ed-dim">Position</span>
                      {['bottom', 'top'].map((p) => (
                        <button
                          key={p}
                          className={`ed-seg-btn${captionPos === p ? ' is-on' : ''}`}
                          onClick={() => setCaptionPos(p)}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                    <label className="ed-toggle ed-caps-row">
                      <input
                        type="checkbox"
                        checked={captionBg}
                        onChange={(e) => setCaptionBg(e.target.checked)}
                      />
                      <span>Background box</span>
                    </label>

                    <div className={`ed-caps-preview pos-${captionPos}${captionBg ? ' has-bg' : ''}`}>
                      <span
                        className={`ed-caps-preview-text sz-${captionSize}`}
                        data-text="The quick brown fox"
                      >
                        The quick brown fox
                      </span>
                    </div>

                    <div className="ed-caps-dl">
                      <button className="ed-btn ed-btn-sm" onClick={() => downloadCaptions('srt')}>
                        Download .srt
                      </button>
                      <button className="ed-btn ed-btn-sm" onClick={() => downloadCaptions('vtt')}>
                        Download .vtt
                      </button>
                    </div>
                    <p className="ed-dim">
                      {hasCaptions
                        ? `${Object.values(captionCuesByClip).reduce((a, c) => a + c.length, 0)} cues from ${Object.keys(captionCuesByClip).length} transcript${Object.keys(captionCuesByClip).length === 1 ? '' : 's'}.`
                        : 'Transcribe a clip to generate captions.'}
                    </p>
                  </div>
                </>
              )}
            </div>
          )}

          {leftTab === 'music' && (
            <div className="ed-side-scroll ed-placeholder">
              <p>Music mood is chosen by the planner.</p>
              <div className="ed-chip-row">
                {['upbeat', 'chill', 'cinematic', 'none'].map((m) => (
                  <span key={m} className={`ed-chip${plan?.music === m ? ' is-on' : ''}`}>
                    {m}
                  </span>
                ))}
              </div>
              <p className="ed-dim">Track library lands in Creator tier.</p>
            </div>
          )}

          {leftTab === 'fx' && (
            <div className="ed-side-scroll ed-placeholder">
              <p>Transitions per segment come from the plan:</p>
              <div className="ed-chip-row">
                {['cut', 'fade', 'wipe', 'zoom', 'dissolve'].map((x) => (
                  <span key={x} className="ed-chip">
                    {x}
                  </span>
                ))}
              </div>
              <p className="ed-dim">Manual FX overrides are on the roadmap.</p>
            </div>
          )}
        </aside>

        {/* CENTER STAGE */}
        <main className="ed-stage">
          <div className="ed-preview">
            {selected ? (
              <>
                <video
                  ref={videoRef}
                  key={selected.id}
                  src={selected.url}
                  className="ed-video"
                  onClick={togglePlay}
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  onEnded={() => setPlaying(false)}
                  onPause={() => setPlaying(false)}
                  onPlay={() => setPlaying(true)}
                  playsInline
                />
                {previewCue && (burnCaptions || leftTab === 'transcript') && (
                  <div
                    className={`ed-cap-overlay pos-${captionPos} sz-${captionSize}${captionBg ? ' has-bg' : ''}`}
                  >
                    {previewCue.lines.map((ln, i) => (
                      <div key={i} className="ed-cap-line">
                        {ln}
                      </div>
                    ))}
                  </div>
                )}
                <div className="ed-preview-bar">
                  <button className="ed-play" onClick={togglePlay}>
                    {playing ? '❚❚' : '▶'}
                  </button>
                  <span className="ed-time">
                    {fmtTime(currentTime)} / {fmtTime(selected.duration)}
                  </span>
                  <span className="ed-preview-name">{selected.name}</span>
                </div>
              </>
            ) : (
              <div className="ed-empty">
                <div className="ed-empty-icon">🎬</div>
                <h3>No clips loaded</h3>
                <p>
                  Add video files from the <strong>Clips</strong> panel on the left — drag them onto
                  the drop zone or click to browse. Your footage never leaves this browser.
                </p>
              </div>
            )}
          </div>

          {/* AI PROMPT BAR */}
          <div className="ed-ai">
            <div className="ed-ai-row">
              <input
                className="ed-ai-input"
                placeholder='e.g. "fast energetic 60 sec travel montage, snappy cuts, best clips first"'
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && runGenerate()}
                disabled={aiState === 'thinking'}
              />
              <button
                className="ed-btn ed-btn-primary"
                onClick={runGenerate}
                disabled={!clips.length || aiState === 'thinking'}
              >
                {aiState === 'thinking' ? 'Thinking…' : 'Generate'}
              </button>
            </div>
            <div className="ed-ai-status">
              {analyzing && (
                <span className="ed-dim">
                  <span className="ed-spin" /> {analyzeMsg || 'Analyzing footage…'} (audio energy · motion · silences)
                </span>
              )}
              {!analyzing && aiState === 'idle' && (
                <span className="ed-dim">
                  Describe the vlog you want. The planner cuts, orders and paces it
                  {Object.keys(transcripts).length > 0
                    ? ' on sentence boundaries from your transcripts.'
                    : analysis.size > 0
                      ? ' around analyzed highlights.'
                      : '.'}
                </span>
              )}
              {aiState === 'thinking' && <span className="ed-dim">Planning the edit…</span>}
              {aiState === 'error' && <span className="ed-bad">{aiError}</span>}
              {aiState === 'done' && plan && (
                <span className="ed-ok">
                  <strong>{plan.title}</strong> — {plan.reasoning}{' '}
                  <span className="ed-dim">
                    ({plan.segments.length} segments · {plan.music} music
                    {plan.removeFillers ? ' · fillers removed' : ''}
                    {excludeRanges.length ? ` · ${excludeRanges.length} lines cut` : ''}
                    {retakeExcludeRanges.length ? ` · ${retakeExcludeRanges.length} retakes dropped` : ''})
                  </span>
                </span>
              )}
            </div>
          </div>

          {/* TIMELINE */}
          <div className="ed-timeline">
            <div className="ed-tl-track">
              <div className="ed-tl-label">Video</div>
              <div className="ed-tl-lane">
                {videoBlocks.length ? (
                  videoBlocks.map((b) => (
                    <div
                      key={b.key}
                      className={`ed-block role-${b.role}`}
                      style={{ width: Math.max(44, b.len * PX_PER_SEC) }}
                      title={`${b.name} · ${b.len.toFixed(1)}s${b.transition ? ` · ${b.transition}` : ''}`}
                    >
                      <span className="ed-block-name">{b.name}</span>
                      <span className="ed-block-len">{b.len.toFixed(1)}s</span>
                    </div>
                  ))
                ) : (
                  <div className="ed-tl-hint">Video track builds from your clips (or the AI plan).</div>
                )}
              </div>
            </div>
            <div className="ed-tl-track">
              <div className="ed-tl-label">Music</div>
              <div className="ed-tl-lane">
                {plan && plan.music !== 'none' ? (
                  <div
                    className="ed-block role-music"
                    style={{ width: Math.max(120, totalPlanLen * PX_PER_SEC) }}
                  >
                    <span className="ed-block-name">{plan.music} bed</span>
                  </div>
                ) : (
                  <div className="ed-tl-hint">No music track</div>
                )}
              </div>
            </div>
            <div className="ed-tl-track">
              <div className="ed-tl-label">Captions</div>
              <div className="ed-tl-lane">
                <div className="ed-tl-hint">Auto-captions coming soon</div>
              </div>
            </div>
          </div>
        </main>

        {/* RIGHT SIDEBAR */}
        <aside className="ed-side ed-side-right">
          <div className="ed-tabs">
            {['edit', 'grade', 'export'].map((t) => (
              <button
                key={t}
                className={`ed-tab${rightTab === t ? ' is-active' : ''}`}
                onClick={() => setRightTab(t)}
              >
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>

          {rightTab === 'edit' && (
            <div className="ed-side-scroll ed-placeholder">
              {plan ? (
                <>
                  <p className="ed-dim">Plan segments</p>
                  {plan.segments.map((s, i) => (
                    <div key={i} className="ed-seg">
                      <div className="ed-seg-top">
                        <span>{s.clip}</span>
                        <span className={`ed-role role-${s.role}`}>{s.role}</span>
                      </div>
                      <div className="ed-seg-sub">
                        {s.start.toFixed(1)}s – {s.end.toFixed(1)}s · {(s.end - s.start).toFixed(1)}s · {s.transition}
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                <p className="ed-dim">Generate a plan to see per-segment edits.</p>
              )}
            </div>
          )}

          {rightTab === 'grade' && (
            <div className="ed-side-scroll ed-placeholder">
              <p>Color grade</p>
              {['Exposure', 'Contrast', 'Saturation', 'Temperature'].map((g) => (
                <label key={g} className="ed-slider">
                  <span>{g}</span>
                  <input type="range" min="-100" max="100" defaultValue="0" />
                </label>
              ))}
              <p className="ed-dim">Grades preview in-editor; baked into render next.</p>
            </div>
          )}

          {rightTab === 'export' && (
            <div className="ed-side-scroll">
              <label className="ed-field">
                <span>Resolution</span>
                <select value={resolution} onChange={(e) => setResolution(e.target.value)} disabled={rendering}>
                  <option value="720p">720p — 1280×720</option>
                  <option value="1080p">1080p — 1920×1080</option>
                </select>
              </label>

              <div className={`ed-engine${engine?.supported ? ' is-gpu' : ''}`}>
                <span className="ed-engine-dot" />
                {engine == null
                  ? 'Checking render engine…'
                  : engine.supported
                    ? `GPU accelerated${engine.hardwareAccelerated ? '' : ' (no HW encoder — may be slower)'}`
                    : 'Software (slower)'}
                {engine && !engine.supported && engine.reason && (
                  <span className="ed-engine-why" title={engine.reason}>
                    ?
                  </span>
                )}
              </div>

              <button
                className="ed-btn ed-btn-primary ed-btn-block"
                onClick={runRender}
                disabled={rendering || !clips.length}
              >
                {rendering ? 'Rendering…' : plan ? 'Render plan' : 'Render straight cut'}
              </button>

              <label className="ed-toggle ed-mt">
                <input
                  type="checkbox"
                  checked={diagnostics}
                  onChange={(e) => setDiagnostics(e.target.checked)}
                />
                <span>Diagnostics (per-segment console log)</span>
              </label>

              {import.meta.env.DEV && (
                <button
                  className="ed-btn ed-btn-block ed-mt"
                  onClick={doSmokeTest}
                  disabled={smoke?.running || rendering}
                >
                  {smoke?.running ? 'Running smoke test…' : 'Run smoke test'}
                </button>
              )}

              {smoke && (
                <div className={`ed-smoke${smoke.ok === false ? ' is-bad' : smoke.ok ? ' is-ok' : ''}`}>
                  {smoke.log.map((line, i) => (
                    <div key={i}>{line}</div>
                  ))}
                </div>
              )}

              {clips.length > 0 && !rendering && (
                <p className="ed-dim ed-mt">
                  {!plan && 'No AI plan yet — this stitches your clips end to end. '}
                  ~{estimateRenderSeconds(
                    plan || { segments: clips.map((c) => ({ start: 0, end: c.duration })) },
                    { resolution, method: engine?.supported ? 'webcodecs' : 'ffmpeg' },
                  )}s estimated.
                  {' · Captions: '}
                  {!hasCaptions
                    ? 'no transcript'
                    : burnCaptions
                      ? `burned (${captionSize}, ${captionPos}${captionBg ? ', box' : ''})`
                      : 'off (SRT/VTT available)'}
                </p>
              )}

              {(rendering || progress.pct > 0) && (
                <div className="ed-prog">
                  <div className="ed-prog-bar">
                    <div className="ed-prog-fill" style={{ width: `${progress.pct}%` }} />
                  </div>
                  <div className="ed-prog-msg">
                    <span>{progress.stage || 'idle'}</span>
                    <span>{progress.pct}%</span>
                  </div>
                  <div className="ed-dim">{progress.msg}</div>
                </div>
              )}

              {renderError && <div className="ed-bad ed-mt">{renderError}</div>}

              {result && (
                <div className="ed-result">
                  <div className="ed-ok">Render complete · {fmtSize(result.size)}</div>
                  {typeof result.shots === 'number' && (
                    <div className="ed-dim">
                      Rendered {result.shots} shot{result.shots === 1 ? '' : 's'}
                      {result.internalCuts > 0
                        ? `, ${result.internalCuts} internal cut${result.internalCuts === 1 ? '' : 's'}`
                        : ', no internal cuts'}
                      {result.captionsBurned
                        ? `, captions burned (${result.captions?.style?.size || 'M'}, ${result.captions?.style?.position || 'bottom'})`
                        : ''}
                    </div>
                  )}
                  <div className="ed-dim">
                    {result.method === 'webcodecs'
                      ? 'Rendered on GPU (WebCodecs).'
                      : 'Rendered with FFmpeg (software).'}
                    {result.fellBack &&
                      ` GPU path hit an error mid-render and finished on FFmpeg${
                        result.fallbackReason ? ` — ${result.fallbackReason}` : ''
                      }.`}
                  </div>

                  {/* Burn-in was asked for but the renderer could not deliver it. */}
                  {result.captions && !result.captionsBurned && (
                    <div className="ed-warn">
                      Captions could not be burned in on the software renderer. The video rendered
                      without them; the .srt file is still available.
                      {result.captionsSkippedReason ? ` — ${result.captionsSkippedReason}` : ''}
                    </div>
                  )}

                  {verifyState && (
                    <div className="ed-verify">
                      {verifyState.running ? (
                        <div className="ed-dim">
                          <span className="ed-spin" /> Verifying render…
                        </div>
                      ) : (
                        <>
                          <button
                            className={`ed-verify-head${verifyState.report?.ok ? ' is-ok' : ' is-bad'}`}
                            onClick={() => setVerifyOpen((v) => !v)}
                          >
                            {verifyState.report?.ok
                              ? `✓ All ${verifyState.report.checks.length} checks passed`
                              : `✗ ${verifyState.report?.checks.filter((c) => !c.passed).length || '?'} check(s) failed`}
                            <span className="ed-verify-caret">{verifyOpen ? '▾' : '▸'}</span>
                          </button>
                          {verifyState.sync && Number.isFinite(verifyState.sync.deltaMs) && (
                            <div className={`ed-sync${verifyState.sync.drift ? ' is-bad' : ''}`}>
                              A/V sync: {verifyState.sync.deltaMs}ms
                              {verifyState.sync.drift && ' — drift'}
                            </div>
                          )}
                          {verifyOpen && (
                            <ul className="ed-verify-list">
                              {verifyState.report?.checks.map((c, i) => (
                                <li key={i} className={c.passed ? 'is-ok' : 'is-bad'}>
                                  <strong>{c.passed ? '✓' : '✗'} {c.name}</strong>
                                  <span>{c.detail}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  <video src={result.url} controls className="ed-result-vid" />
                  <a
                    className="ed-btn ed-btn-primary ed-btn-block"
                    href={result.url}
                    download={`${(plan?.title || 'reelmind').replace(/\s+/g, '_').toLowerCase()}_${resolution}.mp4`}
                  >
                    Download MP4
                  </a>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

function Meter({ label, v }) {
  const pct = Math.round(Math.max(0, Math.min(1, v || 0)) * 100)
  return (
    <span className="ed-meter" title={`${label} ${pct}%`}>
      <span className="ed-meter-label">{label}</span>
      <span className="ed-meter-track">
        <span className="ed-meter-fill" style={{ width: `${pct}%` }} />
      </span>
    </span>
  )
}

const CSS = `
.ed { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--bg); color: var(--text); font-size: 14px; }

.ed-top { display: flex; align-items: center; gap: 16px; height: 54px; padding: 0 16px; background: var(--panel); border-bottom: 1px solid var(--border); flex: none; }
.ed-logo { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 17px; }
.ed-logo span { background: linear-gradient(90deg, var(--cyan), var(--purple)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.ed-top-mid { margin: 0 auto; text-align: center; font-family: 'Syne', sans-serif; font-weight: 600; display: flex; flex-direction: column; line-height: 1.3; }
.ed-top-sub { font-family: 'DM Sans', sans-serif; font-weight: 400; font-size: 11.5px; color: var(--muted); }

.ed-btn { border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: 9px; padding: 8px 16px; font-weight: 600; font-size: 13px; transition: transform .12s, box-shadow .12s, opacity .12s; }
.ed-btn:hover:not(:disabled) { transform: translateY(-1px); }
.ed-btn:disabled { opacity: .4; cursor: not-allowed; }
.ed-btn-primary { background: linear-gradient(90deg, var(--cyan), var(--purple)); color: #05050a; border-color: transparent; }
.ed-btn-primary:hover:not(:disabled) { box-shadow: 0 6px 22px -6px rgba(155,93,255,.6); }
.ed-btn-block { width: 100%; margin-top: 12px; }

.ed-body { flex: 1; display: flex; min-height: 0; }
.ed-side { width: 236px; flex: none; background: var(--panel); display: flex; flex-direction: column; min-height: 0; }
.ed-side-left { border-right: 1px solid var(--border); }
.ed-side-right { border-left: 1px solid var(--border); }
.ed-side-scroll { flex: 1; overflow-y: auto; padding: 14px; }

.ed-tabs { display: flex; border-bottom: 1px solid var(--border); flex: none; }
.ed-tab { flex: 1; background: none; border: none; color: var(--muted); padding: 12px 4px; font-size: 12.5px; font-weight: 600; border-bottom: 2px solid transparent; }
.ed-tab.is-active { color: var(--text); border-bottom-color: var(--purple); }

.ed-drop { border: 1.5px dashed var(--border); border-radius: 12px; padding: 22px 12px; text-align: center; background: var(--surface); transition: border-color .15s, background .15s; cursor: pointer; }
.ed-drop.is-drag { border-color: var(--cyan); background: rgba(9,246,255,.06); }
.ed-drop-icon { width: 34px; height: 34px; margin: 0 auto 10px; border-radius: 50%; display: grid; place-items: center; background: linear-gradient(90deg, var(--cyan), var(--purple)); color: #05050a; font-size: 13px; }
.ed-drop-t { font-weight: 600; font-size: 13px; }
.ed-drop-d { color: var(--muted); font-size: 11.5px; margin-top: 4px; }

.ed-errs { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.ed-err { background: rgba(255,37,102,.08); border: 1px solid rgba(255,37,102,.35); border-radius: 8px; padding: 8px 10px; font-size: 11.5px; color: #ffb3c6; }
.ed-err strong { display: block; color: var(--pink); margin-bottom: 2px; word-break: break-all; }

.ed-lib { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
.ed-lib-row { display: flex; gap: 9px; align-items: center; padding: 7px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); cursor: pointer; transition: border-color .12s; }
.ed-lib-row:hover { border-color: #2a2a42; }
.ed-lib-row.is-sel { border-color: var(--cyan); box-shadow: inset 0 0 0 1px var(--cyan); }
.ed-thumb { position: relative; width: 58px; height: 34px; border-radius: 6px; overflow: hidden; background: #000; flex: none; }
.ed-thumb img { width: 100%; height: 100%; object-fit: cover; }
.ed-thumb-x { width: 100%; height: 100%; display: grid; place-items: center; color: var(--muted); }
.ed-thumb-dur { position: absolute; right: 2px; bottom: 2px; background: rgba(0,0,0,.75); font-size: 9px; padding: 1px 3px; border-radius: 3px; }
.ed-lib-meta { flex: 1; min-width: 0; }
.ed-lib-name { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ed-lib-sub { font-size: 10.5px; color: var(--muted); margin-top: 2px; }
.ed-meters { display: flex; align-items: center; gap: 6px; margin-top: 5px; flex-wrap: wrap; }
.ed-meter { display: flex; align-items: center; gap: 3px; }
.ed-meter-label { font-size: 8px; letter-spacing: .04em; color: var(--muted); }
.ed-meter-track { width: 34px; height: 4px; border-radius: 999px; background: var(--bg); overflow: hidden; }
.ed-meter-fill { display: block; height: 100%; background: linear-gradient(90deg, var(--cyan), var(--purple)); }
.ed-meter-note { font-size: 8.5px; color: var(--muted); }
.ed-spin { display: inline-block; width: 9px; height: 9px; border: 1.5px solid var(--border); border-top-color: var(--cyan); border-radius: 50%; animation: ed-spin .7s linear infinite; vertical-align: -1px; }
@keyframes ed-spin { to { transform: rotate(360deg); } }

.ed-btn-sm { padding: 6px 12px; font-size: 12px; border-radius: 8px; }
.ed-transcribe-all { margin-top: 12px; }
.ed-prog-tight { margin-top: 8px; }
.ed-row-actions { margin-top: 6px; }
.ed-linkbtn { background: none; border: none; padding: 0; font-size: 10.5px; font-weight: 600; color: var(--cyan); }
.ed-linkbtn:hover:not(:disabled) { text-decoration: underline; }
.ed-linkbtn:disabled { color: var(--muted); cursor: not-allowed; }
.ed-linkbtn.is-ok { color: #7CFFB2; }
.ed-linkbtn.is-bad { color: var(--pink); }
.ed-mini-note { font-size: 10px; color: var(--muted); display: inline-flex; align-items: center; gap: 4px; }

.ed-tx-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 0 10px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.ed-tx-list { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
.ed-tx-sent { display: flex; gap: 4px; align-items: flex-start; border-left: 2px solid transparent; padding-left: 6px; border-radius: 2px; }
.ed-tx-sent.is-kept { border-left-color: var(--purple); background: rgba(155,93,255,.06); }
.ed-tx-sent.is-struck .ed-tx-text { text-decoration: line-through; opacity: .45; }
.ed-tx-text { flex: 1; text-align: left; background: none; border: none; color: var(--text); font-size: 12px; line-height: 1.55; padding: 4px 2px; }
.ed-tx-text:hover { color: var(--cyan); }
.ed-tx-time { font-size: 9.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.ed-tx-filler { background: rgba(255,37,102,.22); border-radius: 3px; box-shadow: 0 0 0 1px rgba(255,37,102,.35) inset; }
.ed-tx-strike { flex: none; width: 20px; height: 20px; border-radius: 5px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); font-size: 10px; margin-top: 4px; }
.ed-tx-strike:hover { border-color: var(--pink); color: var(--pink); }

.ed-retake-badge { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; padding: 7px 9px; border-radius: 8px; font-size: 11px; color: var(--cyan); background: rgba(9,246,255,.08); border: 1px solid rgba(9,246,255,.3); }
.ed-retake { margin: 6px 0; border: 1px solid var(--purple); border-radius: 9px; background: rgba(155,93,255,.06); overflow: hidden; }
.ed-retake-head { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--purple); padding: 6px 9px; border-bottom: 1px solid rgba(155,93,255,.25); }
.ed-retake-take { display: flex; gap: 7px; align-items: flex-start; padding: 7px 9px; cursor: pointer; border-bottom: 1px solid rgba(155,93,255,.14); }
.ed-retake-take:last-child { border-bottom: none; }
.ed-retake-take input { margin-top: 3px; accent-color: var(--purple); flex: none; }
.ed-retake-body { flex: 1; min-width: 0; }
.ed-retake-text { display: block; font-size: 12px; line-height: 1.5; color: var(--text); }
.ed-retake-meta { display: flex; align-items: center; gap: 6px; font-size: 9.5px; color: var(--muted); margin-top: 3px; font-variant-numeric: tabular-nums; }
.ed-retake-rec { color: var(--cyan); border: 1px solid var(--cyan); border-radius: 999px; padding: 0 5px; font-variant-numeric: normal; }
.ed-retake-take.is-chosen .ed-retake-text { color: var(--text); }
.ed-retake-take.is-chosen { background: rgba(155,93,255,.14); }
.ed-retake-take.is-cut .ed-retake-text { text-decoration: line-through; opacity: .4; }
.ed-x { background: none; border: none; color: var(--muted); font-size: 17px; line-height: 1; padding: 2px 4px; flex: none; }
.ed-x:hover { color: var(--pink); }
.ed-lib-empty, .ed-tl-hint { color: var(--muted); font-size: 12px; }
.ed-lib-empty { padding: 14px 4px; }

.ed-placeholder p { color: var(--text); font-size: 12.5px; margin: 0 0 10px; }
.ed-dim { color: var(--muted); font-size: 11.5px; }
.ed-mt { margin-top: 10px; }
.ed-chip-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.ed-chip { font-size: 11px; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); }
.ed-chip.is-on { border-color: var(--cyan); color: var(--cyan); }

.ed-slider { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; font-size: 11.5px; color: var(--muted); }
.ed-slider input { width: 100%; accent-color: var(--purple); }

.ed-stage { flex: 1; display: flex; flex-direction: column; min-width: 0; padding: 16px; gap: 14px; overflow: hidden; }
.ed-preview { flex: 1; min-height: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.ed-video { max-width: 100%; max-height: 100%; background: #000; cursor: pointer; }
.ed-preview-bar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: linear-gradient(transparent, rgba(0,0,0,.7)); font-size: 12px; }
.ed-play { width: 30px; height: 30px; border-radius: 50%; border: none; background: var(--text); color: #05050a; font-size: 11px; }
.ed-time { font-variant-numeric: tabular-nums; }
.ed-preview-name { margin-left: auto; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }

.ed-empty { text-align: center; max-width: 380px; padding: 20px; }
.ed-empty-icon { font-size: 40px; }
.ed-empty h3 { margin: 14px 0 8px; }
.ed-empty p { color: var(--muted); font-size: 13px; line-height: 1.6; }

.ed-ai { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 12px; flex: none; }
.ed-ai-row { display: flex; gap: 8px; }
.ed-ai-input { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px; color: var(--text); font-size: 13px; }
.ed-ai-input:focus { outline: none; border-color: var(--purple); }
.ed-ai-status { margin-top: 8px; font-size: 12px; line-height: 1.5; }
.ed-ok { color: var(--cyan); }
.ed-bad { color: var(--pink); font-size: 12px; }

.ed-timeline { flex: none; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.ed-tl-track { display: flex; align-items: stretch; gap: 8px; }
.ed-tl-label { width: 64px; flex: none; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); display: flex; align-items: center; }
.ed-tl-lane { flex: 1; min-height: 42px; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; display: flex; align-items: stretch; gap: 3px; padding: 3px; overflow-x: auto; }
.ed-block { flex: none; border-radius: 6px; padding: 5px 8px; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; background: linear-gradient(160deg, rgba(9,246,255,.18), rgba(155,93,255,.18)); border: 1px solid rgba(155,93,255,.4); }
.ed-block.role-hook { background: linear-gradient(160deg, rgba(9,246,255,.28), rgba(9,246,255,.1)); border-color: var(--cyan); }
.ed-block.role-outro { background: linear-gradient(160deg, rgba(255,37,102,.24), rgba(255,37,102,.08)); border-color: rgba(255,37,102,.5); }
.ed-block.role-music { background: linear-gradient(160deg, rgba(155,93,255,.24), rgba(155,93,255,.06)); border-color: rgba(155,93,255,.5); }
.ed-block-name { font-size: 10.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ed-block-len { font-size: 9.5px; color: var(--muted); }
.ed-tl-hint { padding: 0 8px; display: flex; align-items: center; }

.ed-field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--muted); }
.ed-field select { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; color: var(--text); font-size: 13px; }

.ed-engine { display: flex; align-items: center; gap: 7px; margin-top: 10px; font-size: 11.5px; color: var(--muted); }
.ed-engine-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
.ed-engine.is-gpu { color: var(--cyan); }
.ed-engine.is-gpu .ed-engine-dot { background: var(--cyan); box-shadow: 0 0 8px var(--cyan); }
.ed-engine-why { width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--border); display: inline-grid; place-items: center; font-size: 9px; cursor: help; }

.ed-prog { margin-top: 14px; }
.ed-prog-bar { height: 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 999px; overflow: hidden; }
.ed-prog-fill { height: 100%; background: linear-gradient(90deg, var(--cyan), var(--purple)); transition: width .3s; }
.ed-prog-msg { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-top: 6px; text-transform: capitalize; }

.ed-result { margin-top: 16px; display: flex; flex-direction: column; gap: 10px; }
.ed-result-vid { width: 100%; border-radius: 8px; background: #000; }

.ed-toggle { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--muted); cursor: pointer; }
.ed-toggle input { accent-color: var(--purple); }

/* captions */
.ed-caps { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 9px; }
.ed-caps-head { font-weight: 600; }
.ed-caps-note { margin: 5px 0 0; font-size: 10.5px; line-height: 1.5; color: #ffcf8a; }
.ed-caps-note.is-info { color: var(--muted); }
.ed-toggle.is-disabled { opacity: .55; cursor: not-allowed; }
.ed-toggle.is-disabled input { cursor: not-allowed; }
.ed-warn { font-size: 11px; line-height: 1.5; color: #ffcf8a; background: rgba(255,190,90,.09); border: 1px solid rgba(255,190,90,.35); border-radius: 8px; padding: 8px 10px; }
.ed-caps-row { display: flex; align-items: center; gap: 6px; }
.ed-caps-row > .ed-dim { width: 58px; flex: none; }
.ed-seg-btn { border: 1px solid var(--border); background: var(--surface); color: var(--muted); border-radius: 7px; padding: 4px 10px; font-size: 11px; font-weight: 600; text-transform: capitalize; }
.ed-seg-btn.is-on { border-color: var(--cyan); color: var(--cyan); }
.ed-caps-preview { position: relative; height: 74px; border-radius: 8px; background: linear-gradient(120deg, #1a1a28, #0f0f1b); border: 1px solid var(--border); display: flex; justify-content: center; overflow: hidden; }
.ed-caps-preview.pos-bottom { align-items: flex-end; padding-bottom: 8px; }
.ed-caps-preview.pos-top { align-items: flex-start; padding-top: 8px; }
.ed-caps-preview-text { font-family: 'DM Sans', sans-serif; font-weight: 700; color: #fff; text-align: center; -webkit-text-stroke: 3px #000; paint-order: stroke fill; }
.ed-caps-preview-text.sz-S { font-size: 12px; }
.ed-caps-preview-text.sz-M { font-size: 15px; }
.ed-caps-preview-text.sz-L { font-size: 19px; }
.ed-caps-preview.has-bg .ed-caps-preview-text { background: rgba(0,0,0,.55); padding: 2px 8px; border-radius: 5px; -webkit-text-stroke: 0; }
.ed-caps-dl { display: flex; gap: 8px; }

/* live caption overlay on the center preview */
.ed-cap-overlay { position: absolute; left: 0; right: 0; display: flex; flex-direction: column; align-items: center; gap: 2px; pointer-events: none; padding: 0 6%; text-align: center; z-index: 3; }
.ed-cap-overlay.pos-bottom { bottom: 8%; }
.ed-cap-overlay.pos-top { top: 8%; }
.ed-cap-line { font-family: 'DM Sans', sans-serif; font-weight: 700; color: #fff; -webkit-text-stroke: 3px #000; paint-order: stroke fill; line-height: 1.25; }
.ed-cap-overlay.sz-S .ed-cap-line { font-size: clamp(11px, 3.2vh, 22px); }
.ed-cap-overlay.sz-M .ed-cap-line { font-size: clamp(13px, 4.2vh, 30px); }
.ed-cap-overlay.sz-L .ed-cap-line { font-size: clamp(16px, 5.4vh, 40px); }
.ed-cap-overlay.has-bg { background: none; }
.ed-cap-overlay.has-bg .ed-cap-line { background: rgba(0,0,0,.55); padding: 1px 10px; border-radius: 5px; -webkit-text-stroke: 0; }

.ed-smoke { margin-top: 10px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: #05050e; font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; line-height: 1.5; color: var(--muted); max-height: 220px; overflow-y: auto; white-space: pre-wrap; }
.ed-smoke.is-ok { border-color: rgba(9,246,255,.4); }
.ed-smoke.is-bad { border-color: var(--pink); }

.ed-verify { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.ed-verify-head { display: flex; align-items: center; justify-content: space-between; width: 100%; background: none; border: none; padding: 0; font-size: 12px; font-weight: 600; text-align: left; }
.ed-verify-head.is-ok { color: var(--cyan); }
.ed-verify-head.is-bad { color: var(--pink); }
.ed-verify-caret { color: var(--muted); font-size: 10px; }
.ed-sync { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
.ed-sync.is-bad { color: var(--pink); font-weight: 600; }
.ed-verify-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ed-verify-list li { display: flex; flex-direction: column; gap: 1px; font-size: 10.5px; }
.ed-verify-list li strong { font-size: 11px; }
.ed-verify-list li.is-ok strong { color: var(--cyan); }
.ed-verify-list li.is-bad strong { color: var(--pink); }
.ed-verify-list li span { color: var(--muted); }

.ed-seg { border: 1px solid var(--border); border-radius: 8px; padding: 8px; margin-bottom: 8px; background: var(--surface); }
.ed-seg-top { display: flex; justify-content: space-between; gap: 6px; font-size: 11.5px; font-weight: 600; }
.ed-seg-top span:first-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ed-seg-sub { font-size: 10.5px; color: var(--muted); margin-top: 3px; }
.ed-role { font-size: 9.5px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); flex: none; }
.ed-role.role-hook { color: var(--cyan); border-color: var(--cyan); }
.ed-role.role-outro { color: var(--pink); border-color: rgba(255,37,102,.5); }

@media (max-width: 1080px) {
  .ed-side { width: 200px; }
}
@media (max-width: 860px) {
  .ed { position: static; min-height: 100vh; }
  .ed-body { flex-direction: column; }
  .ed-side { width: 100%; }
}
`
