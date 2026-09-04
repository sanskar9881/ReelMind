import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { probeAll, fmtTime, fmtSize } from '../utils/videoMeta.js'
import { analyzeAll, withTranscript } from '../utils/analyzer.js'
import { transcribeClip } from '../utils/transcribe.js'
import { extendTakeRange } from '../utils/retakes.js'
import { generateEditPlan, USE_MOCK, buildPrompt } from '../utils/ai.js'
import { render, estimateRenderSeconds, applyCutRanges } from '../utils/videoProcessor.js'
import { checkWebCodecsSupport } from '../utils/webcodecs/support.js'
import { verifyRender, measureSync } from '../utils/verify.js'
import { buildCaptions, remapToOutputTimeline, toSRT, toVTT } from '../utils/captions.js'
import { analyzeEditedVideo, buildProfile, describeProfile } from '../utils/styleProfile.js'
import {
  createAutosave,
  loadProject,
  matchFiles,
  restoreFromMatches,
  restoreViaHandles,
  migrateLegacyProfiles,
  supportsFileHandles,
  listProfilesDB,
  saveProfileDB,
  deleteProfileDB,
  getActiveProfileId,
  setActiveProfileId as persistActiveProfileId,
  saveFeedback,
  recordCorrection,
  listFeedback,
} from '../utils/storage.js'
import { useLayoutMode } from '../ui/useResponsive.js'
import { useToast } from '../ui/Toast.jsx'
import { EmptyState, SkeletonRows } from '../ui/Empty.jsx'
import { ConfirmButton } from '../ui/Confirm.jsx'
import { RenderProgress } from '../ui/RenderProgress.jsx'

const PX_PER_SEC = 26

/** Left-hand panels, in tab order. In single-panel mode Export joins them. */
const LEFT_TABS = ['clips', 'transcript', 'style', 'music', 'fx']
const MOBILE_TABS = ['clips', 'transcript', 'style', 'export']
const TAB_ICON = { clips: '🎞', transcript: '💬', style: '✦', music: '♪', fx: '✧', edit: '✂', grade: '◑', export: '⬇' }
const TAB_LABEL = { fx: 'FX', edit: 'Edit', grade: 'Grade', export: 'Export' }
const tabLabel = (t) => TAB_LABEL[t] || t[0].toUpperCase() + t.slice(1)

export default function Editor() {
  const toast = useToast()
  const { mode } = useLayoutMode() // 'full' | 'rail' | 'single'

  // Layout state that only exists below 1280px.
  const [railOpen, setRailOpen] = useState(false) // right panel slid over the stage
  const [sheetOpen, setSheetOpen] = useState(false) // timeline expanded into a sheet
  const [tlFocus, setTlFocus] = useState(0) // keyboard cursor within the timeline

  // Project persistence
  const [searchParams] = useSearchParams()
  // A ref, not state: nothing renders it, and assigning it inside the autosave
  // effect as state would kick off a cascading render on every save.
  const projectIdRef = useRef(null)
  const [projectName, setProjectName] = useState('Untitled project')
  const [saveState, setSaveState] = useState('idle') // idle | saving | saved | error
  const [restoreRefs, setRestoreRefs] = useState(null) // clipRefs awaiting re-selection
  const [restoreBusy, setRestoreBusy] = useState(false)
  const restoreInputRef = useRef(null)
  const hydrating = useRef(false)
  const fileHandlesRef = useRef({}) // clipId -> FileSystemFileHandle (Chrome/Edge)

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

  // Style profiles — the creator's own editing rhythm, learned from past uploads.
  const [profiles, setProfiles] = useState([]) // loaded from IndexedDB on mount
  const [activeProfileId, setActiveProfileId] = useState(null)
  const [applyStyle, setApplyStyle] = useState(true)
  const [styleAnalyzing, setStyleAnalyzing] = useState(null) // { index, total, pct, msg }
  const [styleError, setStyleError] = useState('')
  const styleInputRef = useRef(null)
  const [styleDragging, setStyleDragging] = useState(false)

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
  const [renderStartedAt, setRenderStartedAt] = useState(null)
  const [result, setResult] = useState(null) // { url, size, method, fellBack, ... }
  const [renderError, setRenderError] = useState('')
  const [engine, setEngine] = useState(null) // checkWebCodecsSupport() result
  const [verifyState, setVerifyState] = useState(null) // { running, report, sync } | null
  const [verifyOpen, setVerifyOpen] = useState(false)

  // Edit-quality signal (local only, never transmitted)
  const [rating, setRating] = useState(null) // null until the user answers
  const [qualityView, setQualityView] = useState(null) // dev-only feedback list
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

  const activeProfile = useMemo(
    () => profiles.find((p) => p.id === activeProfileId) || null,
    [profiles, activeProfileId],
  )

  // Dev-only: exactly what buildPrompt would send for this project, so the real
  // token cost is a known number before USE_MOCK is ever flipped.
  // Must stay AFTER activeProfile — a useMemo body runs during render, so
  // reading a later-declared const here is a TDZ crash, not a lint nit.
  const promptStats = useMemo(() => {
    if (!import.meta.env.DEV || !clips.length) return null
    try {
      const text = buildPrompt(clips, prompt, transcriptsMap, applyStyle ? activeProfile : null)
      const bytes = new TextEncoder().encode(text).length
      const totalSentences = Object.values(transcripts).reduce(
        (a, t) => a + (t?.sentences?.length || 0),
        0,
      )
      return {
        bytes,
        kb: bytes / 1024,
        tokens: Math.round(text.length / 3.6), // chars/3.6 ≈ Claude tokens
        sampled: /"sentencesSampled": true/.test(text),
        sentInPrompt: (text.match(/"text":/g) || []).length,
        totalSentences,
      }
    } catch {
      return null
    }
  }, [clips, prompt, transcriptsMap, transcripts, applyStyle, activeProfile])

  // Analyze 1-5 finished past uploads into a profile.
  const ingestStyleVideos = useCallback(
    async (fileList) => {
      const files = Array.from(fileList || [])
        .filter((f) => f.type.startsWith('video/'))
        .slice(0, 5)
      if (!files.length) return
      setStyleError('')
      const analyses = []
      try {
        for (let i = 0; i < files.length; i++) {
          setStyleAnalyzing({ index: i, total: files.length, pct: 0, msg: `Loading ${files[i].name}…` })
          const a = await analyzeEditedVideo(files[i], (p) =>
            setStyleAnalyzing({ index: i, total: files.length, pct: p.pct, msg: p.msg }),
          )
          analyses.push(a)
        }
        const profile = buildProfile(analyses, `Style ${profiles.length + 1}`)
        await saveProfileDB(profile)
        setProfiles(await listProfilesDB())
        setActiveProfileId(persistActiveProfileId(profile.id))
        toast.success('Style profile built', `From ${files.length} video${files.length === 1 ? '' : 's'}`)
      } catch (err) {
        setStyleError(err?.message || 'Could not analyze those videos.')
        toast.error('Style analysis failed', err?.message)
      } finally {
        setStyleAnalyzing(null)
      }
    },
    [profiles.length, toast],
  )

  const chooseProfile = useCallback((id) => {
    setActiveProfileId(persistActiveProfileId(id))
  }, [])

  const doRenameProfile = useCallback(
    async (id) => {
      const current = profiles.find((p) => p.id === id)
      const next = window.prompt('Rename this style profile', current?.name || '')
      if (next == null || !current) return
      await saveProfileDB({ ...current, name: next.trim() || current.name })
      setProfiles(await listProfilesDB())
    },
    [profiles],
  )

  const doDeleteProfile = useCallback(
    async (id) => {
      const gone = profiles.find((p) => p.id === id)
      await deleteProfileDB(id)
      const list = await listProfilesDB()
      setProfiles(list)
      setActiveProfileId(persistActiveProfileId(list[0]?.id ?? null))
      toast.info(`Deleted “${gone?.name || 'profile'}”`)
    },
    [profiles, toast],
  )

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

  // ---- edit-quality signal (local only, never transmitted) --------------
  // Held in a ref and synced from an effect so logCorrection can stay stable and
  // be called from handlers declared anywhere in the component.
  const feedbackCtxRef = useRef({})
  useEffect(() => {
    feedbackCtxRef.current = {
      planId: plan?.planId ?? null,
      projectId: projectIdRef.current,
      projectName,
      prompt,
      profileName: applyStyle && activeProfile ? activeProfile.name : null,
      segmentCount: plan?.segments?.length ?? 0,
    }
  })

  /** A manual fix to a generated plan — corrections per edit is the honest
   *  measure of whether the planner is any good. */
  const logCorrection = useCallback((field, segmentIndex, before, after) => {
    const ctx = feedbackCtxRef.current
    if (!ctx.planId) return // nothing generated yet — not a correction
    recordCorrection(ctx.planId, { field, segmentIndex, before, after }, ctx).catch(() => {})
  }, [])

  // NOTE for all correction-logging handlers below: the logging happens OUTSIDE
  // the state updater. React can invoke an updater more than once (StrictMode
  // does), and a side effect inside one double-counts corrections — which would
  // silently corrupt the exact metric this instrumentation exists to produce.
  const chooseTake = useCallback(
    (clipId, groupId, sentenceIndex) => {
      const before = retakeChoice[clipId]?.[groupId]
      if (before === sentenceIndex) return
      logCorrection('retakeChoice', null, before ?? 'recommended', sentenceIndex)
      setRetakeChoice({
        ...retakeChoice,
        [clipId]: { ...(retakeChoice[clipId] || {}), [groupId]: sentenceIndex },
      })
    },
    [retakeChoice, logCorrection],
  )

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

  // Migrate any legacy localStorage style profiles into IndexedDB, then load
  // from IndexedDB — the migration clears the old key, so the read must happen
  // after it and against the new store.
  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        await migrateLegacyProfiles()
        const list = await listProfilesDB()
        if (!live) return
        setProfiles(list)
        const stored = getActiveProfileId()
        setActiveProfileId(list.some((p) => p.id === stored) ? stored : (list[0]?.id ?? null))
      } catch (err) {
        console.warn('[editor] could not load style profiles:', err?.message || err)
      }
    })()
    return () => {
      live = false
    }
  }, [])

  // ---- open a saved project -------------------------------------------
  useEffect(() => {
    const id = searchParams.get('project')
    if (!id) return
    let live = true
    hydrating.current = true
    ;(async () => {
      try {
        const loaded = await loadProject(id)
        if (!live || !loaded) return
        projectIdRef.current = loaded.project.id
        setProjectName(loaded.project.name)
        setPrompt(loaded.project.prompt || '')
        if (loaded.project.plan) {
          setPlan(loaded.project.plan)
          setAiState('done')
        }
        const s = loaded.project.settings || {}
        if (s.resolution) setResolution(s.resolution)
        if (typeof s.removeFillers === 'boolean') setRemoveFillers(s.removeFillers)
        if (typeof s.keepAllTakes === 'boolean') setKeepAllTakes(s.keepAllTakes)
        if (s.struck) setStruck(s.struck)
        if (s.retakeChoice) setRetakeChoice(s.retakeChoice)
        if (typeof s.burnCaptions === 'boolean') setBurnCaptions(s.burnCaptions)
        if (s.captionSize) setCaptionSize(s.captionSize)
        if (s.captionPos) setCaptionPos(s.captionPos)
        if (typeof s.captionBg === 'boolean') setCaptionBg(s.captionBg)
        if (typeof s.applyStyle === 'boolean') setApplyStyle(s.applyStyle)

        // Chrome/Edge can hand the files straight back via stored handles.
        const viaHandles = await restoreViaHandles(loaded.clipRefs)
        if (!live) return
        if (viaHandles.matched.length) {
          const r = restoreFromMatches(viaHandles.matched)
          setClips(r.clips)
          setAnalysis(r.analysis)
          setTranscripts(r.transcripts)
          setSelectedId(r.clips[0]?.id ?? null)
        }
        // Anything the browser could not re-open needs the user to re-select.
        setRestoreRefs(viaHandles.missing.length ? viaHandles.missing : null)
      } catch (err) {
        console.warn('[editor] could not open project:', err?.message || err)
      } finally {
        // Let a tick pass so the hydration writes do not immediately re-save.
        setTimeout(() => {
          hydrating.current = false
        }, 0)
      }
    })()
    return () => {
      live = false
    }
  }, [searchParams])

  // ---- autosave ---------------------------------------------------------
  // Only a failed save is worth a toast — a successful one already shows in the
  // top bar, and a toast on every keystroke's save would be noise.
  const onSaveState = useCallback(
    (st) => {
      setSaveState(st)
      if (st === 'error') toast.error('Project not saved', 'Browser storage rejected the write.')
    },
    [toast],
  )
  const autosave = useMemo(() => createAutosave(2000, onSaveState), [onSaveState])
  useEffect(() => () => autosave.cancel(), [autosave])

  // Re-select files for a reopened project and restore their work untouched.
  const restoreFiles = useCallback(
    (fileList) => {
      if (!restoreRefs) return
      setRestoreBusy(true)
      try {
        const { matched, missing } = matchFiles(fileList, restoreRefs)
        if (matched.length) {
          const r = restoreFromMatches(matched)
          setClips((prev) => [...prev, ...r.clips])
          setAnalysis((prev) => {
            const next = new Map(prev)
            for (const [k, v] of r.analysis) next.set(k, v)
            return next
          })
          setTranscripts((prev) => ({ ...prev, ...r.transcripts }))
          setSelectedId((cur) => cur || r.clips[0]?.id || null)
        }
        setRestoreRefs(missing.length ? missing : null)
      } finally {
        setRestoreBusy(false)
      }
    },
    [restoreRefs],
  )

  const ingest = useCallback(async (fileList, handles) => {
    setProbing(true)
    setProbeErrors([])
    let newClips = []
    // Handles arrive only from the File System Access picker; map them back onto
    // clips by name+size once probing has assigned ids.
    const handleByKey = new Map(
      (handles || []).filter(Boolean).map((h) => [`${h.__name}::${h.__size}`, h.handle]),
    )
    try {
      const res = await probeAll(fileList)
      newClips = res.clips
      if (newClips.length) {
        for (const c of newClips) {
          const h = handleByKey.get(`${c.name}::${c.size}`)
          if (h) fileHandlesRef.current[c.id] = h
        }
        setClips((prev) => [...prev, ...newClips])
        setSelectedId((cur) => cur || newClips[0].id)
      }
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
        toast.success(
          `Analysis finished · ${newClips.length} clip${newClips.length === 1 ? '' : 's'}`,
          'Audio energy, motion and silences are ready for the planner.',
        )
      } finally {
        setAnalyzing(false)
        setAnalyzeMsg('')
      }
    }
  }, [toast])

  const onDrop = useCallback(
    (e) => {
      e.preventDefault()
      setDragging(false)
      if (e.dataTransfer?.files?.length) ingest(e.dataTransfer.files)
    },
    [ingest],
  )

  // Chrome/Edge: pick through the File System Access API so a handle can be
  // stored. That is what lets a reopened project skip re-selection entirely.
  // Everywhere else this falls back to the plain <input type=file>.
  const pickClips = useCallback(async () => {
    if (!supportsFileHandles) {
      fileInputRef.current?.click()
      return
    }
    try {
      const picked = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.mov', '.webm', '.m4v'] } }],
      })
      const files = []
      const handles = []
      for (const handle of picked) {
        const f = await handle.getFile()
        files.push(f)
        handles.push({ handle, __name: f.name, __size: f.size })
      }
      if (files.length) await ingest(files, handles)
    } catch (err) {
      if (err?.name !== 'AbortError') fileInputRef.current?.click()
    }
  }, [ingest])

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
        toast.success(`Transcribed ${clip.name}`, `${res.sentences.length} sentences`)
      } catch (err) {
        setTranscripts((prev) => ({
          ...prev,
          [clip.id]: { error: err.message, name: clip.name, words: [], sentences: [], fillers: [], text: '' },
        }))
        toast.error(`Could not transcribe ${clip.name}`, err.message)
      } finally {
        setTranscribing(null)
      }
    },
    [transcribing, mergeTranscript, toast],
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
    toast.success(`Transcribed ${pending.length} clip${pending.length === 1 ? '' : 's'}`)
  }, [transcribing, clips, transcripts, mergeTranscript, toast])

  const toggleStruck = useCallback(
    (clipId, idx) => {
      const cur = struck[clipId] || []
      const has = cur.includes(idx)
      logCorrection(has ? 'lineRestored' : 'lineStruck', null, idx, has ? 'kept' : 'excluded')
      setStruck({ ...struck, [clipId]: has ? cur.filter((i) => i !== idx) : [...cur, idx] })
    },
    [struck, logCorrection],
  )

  // ---- AI plan -----------------------------------------------------------
  const runGenerate = useCallback(async () => {
    if (!clips.length || aiState === 'thinking') return
    setAiState('thinking')
    setAiError('')
    setPlan(null)
    try {
      const p = await generateEditPlan(
        clips,
        prompt,
        analysis,
        transcriptsMap,
        applyStyle ? activeProfile : null,
      )
      applyTextEdits(p)
      // Every generated plan gets an id so ratings and corrections attach to a
      // specific edit rather than to the project as a whole.
      p.planId = `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
      setPlan(p)
      setRating(null) // a new plan is unrated
      setAiState('done')
      saveFeedback({
        planId: p.planId,
        projectId: projectIdRef.current,
        projectName,
        prompt,
        profileName: applyStyle && activeProfile ? activeProfile.name : null,
        segmentCount: p.segments.length,
        planDuration: p.segments.reduce((a, s) => a + (s.end - s.start), 0),
        usedMock: USE_MOCK,
      }).catch(() => {})
    } catch (err) {
      setAiError(err.message || 'Planning failed.')
      setAiState('error')
    }
  }, [clips, prompt, aiState, analysis, transcriptsMap, applyTextEdits, applyStyle, activeProfile, projectName])

  const rateEdit = useCallback(
    (value) => {
      setRating(value)
      const ctx = feedbackCtxRef.current
      if (!ctx.planId) return
      saveFeedback({ ...ctx, rating: value, engine: result?.method ?? null }).catch(() => {})
    },
    [result],
  )

  // Trim or drop a shot from the generated plan, recording each change.
  const adjustSegment = useCallback(
    (index, field, deltaSec) => {
      const seg = plan?.segments?.[index]
      if (!seg) return
      const clip = clips.find((c) => c.id === seg.clipId)
      const before = seg[field]
      const next =
        field === 'start'
          ? Math.max(0, Math.min(seg.end - 0.7, before + deltaSec))
          : Math.min(clip?.duration ?? Infinity, Math.max(seg.start + 0.7, before + deltaSec))
      if (Math.abs(next - before) < 0.01) return // clamped to a no-op — not a correction
      const segs = plan.segments.map((s, i) =>
        i === index ? { ...s, [field]: +next.toFixed(3) } : { ...s },
      )
      logCorrection(field, index, +before.toFixed(3), +next.toFixed(3))
      setPlan({ ...plan, segments: segs })
    },
    [plan, clips, logCorrection],
  )

  const dropSegment = useCallback(
    (index) => {
      const removed = plan?.segments?.[index]
      if (!removed) return
      logCorrection('removed', index, `${removed.clip} ${removed.start}–${removed.end}`, null)
      setPlan({ ...plan, segments: plan.segments.filter((_, i) => i !== index) })
    },
    [plan, logCorrection],
  )

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
    setRenderStartedAt(Date.now())
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
      toast.success('Render complete', `${fmtSize(out.size)} · ${out.method === 'webcodecs' ? 'GPU' : 'software'}`)

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
      toast.error('Render failed', err.message)
    } finally {
      setRendering(false)
    }
  }, [
    toast,
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
        index: i,
        clipId: s.clipId,
        name: s.clip,
        len: s.end - s.start,
        start: s.start,
        role: s.role,
        transition: s.transition,
      }))
    }
    return clips.map((c, i) => ({
      key: c.id,
      index: i,
      clipId: c.id,
      name: c.name,
      len: c.duration,
      start: 0,
      role: 'clip',
    }))
  }, [plan, clips])

  const totalPlanLen = videoBlocks.reduce((a, b) => a + b.len, 0)

  // ---- autosave trigger -------------------------------------------------
  // Fires on any change worth not losing: clips, plan, transcripts, struck
  // lines, retake picks, caption and render settings, the prompt, the name.
  useEffect(() => {
    if (hydrating.current) return
    if (!clips.length && !plan) return // nothing worth a record yet
    if (!projectIdRef.current) {
      projectIdRef.current = `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    }
    autosave.schedule(
      {
        id: projectIdRef.current,
        name: projectName,
        prompt,
        plan,
        settings: {
          resolution,
          removeFillers,
          keepAllTakes,
          struck,
          retakeChoice,
          burnCaptions,
          captionSize,
          captionPos,
          captionBg,
          applyStyle,
        },
      },
      clips,
      { analysis, transcripts, handles: fileHandlesRef.current },
    )
  }, [
    autosave,
    projectName,
    prompt,
    plan,
    clips,
    analysis,
    transcripts,
    struck,
    retakeChoice,
    removeFillers,
    keepAllTakes,
    burnCaptions,
    captionSize,
    captionPos,
    captionBg,
    applyStyle,
    resolution,
  ])

  // ---- layout mode -------------------------------------------------------
  // Derived, not stored: a resize must not leave a panel floating over a
  // layout that no longer has anywhere to put it.
  const singleMode = mode === 'single'
  const railMode = mode === 'rail'
  const rightOverlayOpen = railMode && railOpen
  const timelineSheet = singleMode && sheetOpen
  // 'export' is a left tab only when there is a single panel to put it in.
  const activeLeftTab = !singleMode && leftTab === 'export' ? 'clips' : leftTab
  const showLeftPanel = !singleMode || activeLeftTab !== 'export'
  const showRightPanel = singleMode ? activeLeftTab === 'export' : true

  // ---- timeline keyboard access -----------------------------------------
  // The lane is a listbox: arrows move the cursor, Enter selects the shot
  // (seeking the preview to it), Delete removes it from the edit.
  const tlRef = useRef(null)
  const focusedBlock = videoBlocks[Math.min(tlFocus, videoBlocks.length - 1)] || null

  const selectBlock = useCallback(
    (b) => {
      if (!b) return
      if (b.clipId) setSelectedId(b.clipId)
      // Seeking has to wait for the <video> to swap sources when the clip changed.
      const t = b.start || 0
      requestAnimationFrame(() => seekPreview(t))
    },
    [seekPreview],
  )

  const removeBlock = useCallback(
    (b) => {
      if (!b) return
      if (plan?.segments?.length && typeof b.index === 'number') dropSegment(b.index)
      else if (b.clipId) removeClip(b.clipId)
    },
    [plan, dropSegment, removeClip],
  )

  const onTimelineKey = useCallback(
    (e) => {
      if (!videoBlocks.length) return
      const last = videoBlocks.length - 1
      let next = null
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(last, tlFocus + 1)
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, tlFocus - 1)
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = last
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        selectBlock(videoBlocks[Math.min(tlFocus, last)])
        return
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        const b = videoBlocks[Math.min(tlFocus, last)]
        removeBlock(b)
        setTlFocus((i) => Math.max(0, Math.min(i, videoBlocks.length - 2)))
        toast.info('Shot removed from the edit')
        return
      } else return

      e.preventDefault()
      setTlFocus(next)
      // Keep the cursor in view — the lane scrolls horizontally.
      tlRef.current?.querySelector(`[data-tl-index="${next}"]`)?.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      })
    },
    [videoBlocks, tlFocus, selectBlock, removeBlock, toast],
  )

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

  // Timeline lanes, built once and placed either inline or inside the mobile
  // sheet — the same nodes, so keyboard state does not fork between layouts.
  const timelineLanes = (
    <>
      <div className="ed-tl-track">
        <div className="ed-tl-label" id="ed-tl-video-label">
          Video
        </div>
        <div
          className="ed-tl-lane"
          ref={tlRef}
          role="listbox"
          tabIndex={videoBlocks.length ? 0 : -1}
          aria-labelledby="ed-tl-video-label"
          aria-activedescendant={focusedBlock ? `tl-opt-${focusedBlock.key}` : undefined}
          onKeyDown={onTimelineKey}
        >
          {videoBlocks.length ? (
            videoBlocks.map((b, i) => (
              <div
                key={b.key}
                id={`tl-opt-${b.key}`}
                data-tl-index={i}
                role="option"
                aria-selected={i === tlFocus}
                className={`ed-block role-${b.role}${i === tlFocus ? ' is-cursor' : ''}`}
                style={{ width: Math.max(56, b.len * PX_PER_SEC) }}
                title={`${b.name} · ${b.len.toFixed(1)}s${b.transition ? ` · ${b.transition}` : ''}`}
                onClick={() => {
                  setTlFocus(i)
                  selectBlock(b)
                }}
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
          <div className="ed-tl-hint">
            {hasCaptions
              ? `${Object.values(captionCuesByClip).reduce((a, c) => a + c.length, 0)} cues ready${burnCaptions ? ' · burning in' : ' · SRT/VTT only'}`
              : 'Transcribe a clip to generate captions'}
          </div>
        </div>
      </div>
      {!!videoBlocks.length && (
        <p className="ed-tl-help">
          Timeline is keyboard accessible: <kbd>←</kbd> <kbd>→</kbd> move between shots,{' '}
          <kbd>Enter</kbd> selects, <kbd>Delete</kbd> removes.
        </p>
      )}
    </>
  )

  return (
    <div className={`ed mode-${mode}`}>
      <style>{CSS}</style>

      {/* Reopen: the browser cannot keep file access between sessions. */}
      {restoreRefs && (
        <div className="ed-restore ed-sheet-host">
          <div className="ed-restore-card ed-sheet" role="dialog" aria-modal="true" aria-labelledby="ed-restore-h">
            <h3 id="ed-restore-h">Reselect your clips</h3>
            <p className="ed-dim">
              Browsers cannot keep access to your files between sessions. Your edit is saved —
              reselect the same clips to continue. Transcripts, analysis and your take choices are
              restored without redoing any of the work.
            </p>
            <ul className="ed-restore-list">
              {restoreRefs.map((r) => (
                <li key={r.id}>
                  {r.thumb ? <img src={r.thumb} alt="" /> : <span className="ed-restore-noimg" />}
                  <span className="ed-restore-meta">
                    <strong>{r.name}</strong>
                    <span className="ed-dim">
                      {fmtTime(r.duration)} · {fmtSize(r.size)}
                      {r.transcript ? ' · transcript saved' : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <button
              className="ed-btn ed-btn-primary ed-btn-block"
              onClick={() => restoreInputRef.current?.click()}
              disabled={restoreBusy}
            >
              {restoreBusy ? 'Matching…' : 'Choose files'}
            </button>
            <button className="ed-btn ed-btn-block" onClick={() => setRestoreRefs(null)}>
              Skip — continue without them
            </button>
            <input
              ref={restoreInputRef}
              type="file"
              multiple
              accept="video/*"
              hidden
              onChange={(e) => {
                if (e.target.files?.length) restoreFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </div>
        </div>
      )}

      {/* TOP BAR */}
      <div className="ed-top">
        <Link to="/" className="ed-logo">
          Reel<span>Mind</span>
        </Link>
        <div className="ed-top-mid">
          <input
            className="ed-project-name"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            onBlur={(e) => setProjectName(e.target.value.trim() || 'Untitled project')}
            aria-label="Project name"
            spellCheck={false}
          />
          <span className="ed-top-sub">
            {clips.length} clip{clips.length === 1 ? '' : 's'}
            {totalPlanLen > 0 && ` · ${fmtTime(totalPlanLen)} timeline`}
            {USE_MOCK && ' · mock AI'}
            {saveState === 'saving' && ' · Saving…'}
            {saveState === 'saved' && ' · Saved'}
            {saveState === 'error' && ' · Not saved'}
          </span>
        </div>
        <Link to="/projects" className="ed-btn ed-top-projects">
          Projects
        </Link>
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
        <aside className="ed-side ed-side-left" hidden={!showLeftPanel} aria-label="Editing panels">
          {/* In single-panel mode the bottom tab bar is the tab strip. */}
          {!singleMode && (
            <div className="ed-tabs" role="tablist" aria-label="Left panel">
              {LEFT_TABS.map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={activeLeftTab === t}
                  className={`ed-tab${activeLeftTab === t ? ' is-active' : ''}`}
                  onClick={() => setLeftTab(t)}
                >
                  {tabLabel(t)}
                </button>
              ))}
            </div>
          )}

          {activeLeftTab === 'clips' && (
            <div className="ed-side-scroll">
              <div
                className={`ed-drop${dragging ? ' is-drag' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault()
                  setDragging(true)
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                onClick={pickClips}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    pickClips()
                  }
                }}
                role="button"
                tabIndex={0}
                aria-label="Add video files"
              >
                <div className="ed-drop-icon" aria-hidden="true">▶</div>
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
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        setSelectedId(c.id)
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-pressed={selectedId === c.id}
                    aria-label={`Select ${c.name}`}
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
                    {/* Removing a transcribed clip throws away minutes of local
                        Whisper work, so that case asks first. */}
                    {transcripts[c.id] && !transcripts[c.id].error ? (
                      <ConfirmButton
                        className="ed-x"
                        confirmLabel="✓"
                        title="Remove clip"
                        ariaLabel={`Remove ${c.name} and discard its transcript`}
                        onConfirm={() => removeClip(c.id)}
                      >
                        ×
                      </ConfirmButton>
                    ) : (
                      <button
                        className="ed-x"
                        title="Remove clip"
                        aria-label={`Remove ${c.name}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          removeClip(c.id)
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))}
                {probing && !clips.length && <SkeletonRows count={3} />}
                {!clips.length && !probing && (
                  <EmptyState icon="🎞" title="No clips yet" compact>
                    Drop footage on the zone above — phone video, drone shots, screen recordings.
                    ReelMind probes each file locally for its real duration and resolution.
                  </EmptyState>
                )}
              </div>
            </div>
          )}

          {activeLeftTab === 'transcript' && (
            <div className="ed-side-scroll">
              {!selected ? (
                <EmptyState
                  icon="💬"
                  title="No clip selected"
                  compact
                  action={
                    clips.length ? (
                      <button className="ed-btn ed-btn-sm" onClick={() => setLeftTab('clips')}>
                        Go to clips
                      </button>
                    ) : null
                  }
                >
                  {clips.length
                    ? 'Pick a clip in the Clips panel to read, strike and re-take its lines.'
                    : 'Add footage first — transcripts are built per clip from its own audio.'}
                </EmptyState>
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
                            aria-label={`${isStruck ? 'Include' : 'Exclude'} line at ${fmtTime(s.start)}`}
                            aria-pressed={isStruck}
                            onClick={() => toggleStruck(selected.id, i)}
                          >
                            <span aria-hidden="true">{isStruck ? '↺' : 'S'}</span>
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

          {activeLeftTab === 'style' && (
            <div className="ed-side-scroll">
              {styleAnalyzing ? (
                <div className="ed-style-progress">
                  <p className="ed-style-lead">
                    Analyzing video {styleAnalyzing.index + 1} of {styleAnalyzing.total}
                  </p>
                  <div className="ed-prog-bar">
                    <div className="ed-prog-fill" style={{ width: `${styleAnalyzing.pct}%` }} />
                  </div>
                  <p className="ed-dim ed-mt">{styleAnalyzing.msg}</p>
                  <p className="ed-dim">
                    Frames are sampled 4× a second, so a long video takes a while. This is working,
                    not stuck.
                  </p>
                </div>
              ) : !profiles.length ? (
                <>
                  <p className="ed-style-lead">Teach ReelMind your editing rhythm.</p>
                  <p className="ed-dim">
                    Drop in a few videos you have already edited and published. ReelMind measures how
                    long you hold a shot, how long your opening hook runs, how often you cut hard
                    versus transition, and whether you speed up or settle as the video goes on — then
                    edits new footage to match.
                  </p>
                  <p className="ed-dim ed-mt">
                    Nothing is uploaded. The videos are read locally and only the rhythm numbers are
                    kept.
                  </p>
                  <div
                    className={`ed-drop ed-mt${styleDragging ? ' is-drag' : ''}`}
                    onDragOver={(e) => {
                      e.preventDefault()
                      setStyleDragging(true)
                    }}
                    onDragLeave={() => setStyleDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault()
                      setStyleDragging(false)
                      if (e.dataTransfer?.files?.length) ingestStyleVideos(e.dataTransfer.files)
                    }}
                    onClick={() => styleInputRef.current?.click()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        styleInputRef.current?.click()
                      }
                    }}
                    role="button"
                    tabIndex={0}
                    aria-label="Add past edited videos to learn your style"
                  >
                    <div className="ed-drop-icon" aria-hidden="true">✦</div>
                    <div className="ed-drop-t">Add 1-5 of your past edited videos</div>
                    <div className="ed-drop-d">drop here or click to browse</div>
                    <input
                      ref={styleInputRef}
                      type="file"
                      multiple
                      accept="video/*"
                      hidden
                      onChange={(e) => {
                        if (e.target.files?.length) ingestStyleVideos(e.target.files)
                        e.target.value = ''
                      }}
                    />
                  </div>
                  {styleError && <div className="ed-bad ed-mt">{styleError}</div>}
                </>
              ) : (
                <>
                  {profiles.length > 1 && (
                    <label className="ed-field">
                      <span>Profile</span>
                      <select value={activeProfileId || ''} onChange={(e) => chooseProfile(e.target.value)}>
                        {profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}

                  {activeProfile && (
                    <>
                      <div className="ed-style-card">
                        <div className="ed-style-name">{activeProfile.name}</div>
                        <p className="ed-style-desc">Your style: {describeProfile(activeProfile)}</p>
                        <p className="ed-dim">
                          From {activeProfile.sourceCount} video
                          {activeProfile.sourceCount === 1 ? '' : 's'} ·{' '}
                          {Math.round((1 - activeProfile.transitionRatio) * 100)}% hard cuts · shots
                          usually {activeProfile.p25ShotLength.toFixed(1)}–
                          {activeProfile.p75ShotLength.toFixed(1)}s
                        </p>
                      </div>

                      {activeProfile.confidence < 0.35 && (
                        <div className="ed-warn">
                          Low confidence — the cut detector struggled with this footage. The profile
                          may not reflect your real rhythm.
                        </div>
                      )}

                      <label className="ed-toggle ed-mt">
                        <input
                          type="checkbox"
                          checked={applyStyle}
                          onChange={(e) => setApplyStyle(e.target.checked)}
                        />
                        <span>Apply my style to new edits</span>
                      </label>
                      <p className="ed-dim">
                        Say “ignore my style” in the prompt to skip it for one edit.
                      </p>

                      <div className="ed-style-actions">
                        <button className="ed-btn ed-btn-sm" onClick={() => styleInputRef.current?.click()}>
                          Rebuild
                        </button>
                        <button className="ed-btn ed-btn-sm" onClick={() => doRenameProfile(activeProfile.id)}>
                          Rename
                        </button>
                        <ConfirmButton
                          className="ed-btn ed-btn-sm"
                          confirmLabel="Delete?"
                          ariaLabel={`Delete style profile ${activeProfile.name}`}
                          onConfirm={() => doDeleteProfile(activeProfile.id)}
                        >
                          Delete
                        </ConfirmButton>
                      </div>
                      <input
                        ref={styleInputRef}
                        type="file"
                        multiple
                        accept="video/*"
                        hidden
                        onChange={(e) => {
                          if (e.target.files?.length) ingestStyleVideos(e.target.files)
                          e.target.value = ''
                        }}
                      />
                      {styleError && <div className="ed-bad ed-mt">{styleError}</div>}
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {activeLeftTab === 'music' && (
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

          {activeLeftTab === 'fx' && (
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
                  <button className="ed-play" onClick={togglePlay} aria-label={playing ? 'Pause preview' : 'Play preview'}>
                    <span aria-hidden="true">{playing ? '❚❚' : '▶'}</span>
                  </button>
                  <span className="ed-time">
                    {fmtTime(currentTime)} / {fmtTime(selected.duration)}
                  </span>
                  <span className="ed-preview-name">{selected.name}</span>
                </div>
              </>
            ) : (
              <div className="ed-empty">
                <div className="ed-empty-icon" aria-hidden="true">🎬</div>
                <h3>No clips loaded</h3>
                <p>
                  {singleMode
                    ? 'Open the Clips tab below and add video files. Your footage never leaves this browser.'
                    : 'Add video files from the Clips panel on the left — drag them onto the drop zone or click to browse. Your footage never leaves this browser.'}
                </p>
                <button
                  className="ed-btn ed-btn-primary"
                  onClick={() => {
                    setLeftTab('clips')
                    pickClips()
                  }}
                >
                  Add footage
                </button>
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

          {/* TIMELINE
              Full and rail layouts show the lanes inline. Single-panel mode
              collapses them to a tappable summary strip that opens a sheet —
              a 3-lane timeline is unusable at 800px, but hiding it outright
              loses the only view of what will actually render. */}
          {singleMode ? (
            <button
              type="button"
              className="ed-tl-summary"
              onClick={() => setSheetOpen(true)}
              aria-expanded={timelineSheet}
            >
              <span className="ed-tl-summary-main">
                {videoBlocks.length
                  ? `${videoBlocks.length} shot${videoBlocks.length === 1 ? '' : 's'} · ${fmtTime(totalPlanLen)}`
                  : 'Timeline empty'}
              </span>
              <span className="ed-tl-summary-sub">
                {plan && plan.music !== 'none' ? `${plan.music} bed` : 'no music'} · tap to open
              </span>
            </button>
          ) : (
            <div className="ed-timeline">{timelineLanes}</div>
          )}

          {timelineSheet && (
            <div className="ed-sheet-host" onClick={() => setSheetOpen(false)}>
              <div
                className="ed-sheet ed-tl-sheet"
                role="dialog"
                aria-modal="true"
                aria-label="Timeline"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="ed-sheet-head">
                  <h3>Timeline</h3>
                  <button className="ed-icon-btn" onClick={() => setSheetOpen(false)} aria-label="Close timeline">
                    ×
                  </button>
                </div>
                <div className="ed-timeline">{timelineLanes}</div>
              </div>
            </div>
          )}
        </main>

        {/* ICON RAIL — 1024-1279px. The right panel has no room to sit beside
            the stage, so it collapses to icons and slides over it on demand. */}
        {railMode && (
          <nav className="ed-rail" aria-label="Right panel">
            {['edit', 'grade', 'export'].map((t) => (
              <button
                key={t}
                className={`ed-rail-btn${rightOverlayOpen && rightTab === t ? ' is-active' : ''}`}
                aria-label={tabLabel(t)}
                aria-expanded={rightOverlayOpen && rightTab === t}
                title={tabLabel(t)}
                onClick={() => {
                  if (rightOverlayOpen && rightTab === t) setRailOpen(false)
                  else {
                    setRightTab(t)
                    setRailOpen(true)
                  }
                }}
              >
                <span aria-hidden="true">{TAB_ICON[t]}</span>
              </button>
            ))}
          </nav>
        )}

        {/* RIGHT SIDEBAR */}
        <aside
          className={`ed-side ed-side-right${rightOverlayOpen ? ' is-open' : ''}`}
          hidden={!showRightPanel}
          inert={railMode && !rightOverlayOpen ? '' : undefined}
          aria-label="Export and plan panels"
        >
          {railMode && (
            <div className="ed-overlay-head">
              <span>{tabLabel(rightTab)}</span>
              <button className="ed-icon-btn" onClick={() => setRailOpen(false)} aria-label="Close panel">
                ×
              </button>
            </div>
          )}
          {!singleMode && (
            <div className="ed-tabs" role="tablist" aria-label="Right panel">
              {['edit', 'grade', 'export'].map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={rightTab === t}
                  className={`ed-tab${rightTab === t ? ' is-active' : ''}`}
                  onClick={() => setRightTab(t)}
                >
                  {tabLabel(t)}
                </button>
              ))}
            </div>
          )}

          {!singleMode && rightTab === 'edit' && (
            <div className="ed-side-scroll ed-placeholder">
              {plan ? (
                <>
                  <p className="ed-dim">Plan segments — trim or drop a shot to fix the edit.</p>
                  {plan.segments.map((s, i) => (
                    <div key={i} className="ed-seg">
                      <div className="ed-seg-top">
                        <span>{s.clip}</span>
                        <span className={`ed-role role-${s.role}`}>{s.role}</span>
                      </div>
                      <div className="ed-seg-sub">
                        {s.start.toFixed(1)}s – {s.end.toFixed(1)}s · {(s.end - s.start).toFixed(1)}s · {s.transition}
                      </div>
                      <div className="ed-seg-ctl">
                        <span className="ed-dim" aria-hidden="true">in</span>
                        <button onClick={() => adjustSegment(i, 'start', -0.5)} title="Start 0.5s earlier" aria-label={`Shot ${i + 1}: start 0.5 seconds earlier`}>−</button>
                        <button onClick={() => adjustSegment(i, 'start', 0.5)} title="Start 0.5s later" aria-label={`Shot ${i + 1}: start 0.5 seconds later`}>+</button>
                        <span className="ed-dim" aria-hidden="true">out</span>
                        <button onClick={() => adjustSegment(i, 'end', -0.5)} title="End 0.5s earlier" aria-label={`Shot ${i + 1}: end 0.5 seconds earlier`}>−</button>
                        <button onClick={() => adjustSegment(i, 'end', 0.5)} title="End 0.5s later" aria-label={`Shot ${i + 1}: end 0.5 seconds later`}>+</button>
                        <ConfirmButton
                          className="ed-seg-drop"
                          confirmLabel="✓"
                          title="Remove this shot from the edit"
                          ariaLabel={`Remove shot ${i + 1} (${s.clip}) from the edit`}
                          onConfirm={() => dropSegment(i)}
                        >
                          ×
                        </ConfirmButton>
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                <EmptyState icon="✂" title="No plan yet" compact>
                  Describe the edit under the preview and hit Generate. Each shot then shows up here
                  with its in/out points, ready to trim or drop.
                </EmptyState>
              )}
            </div>
          )}

          {!singleMode && rightTab === 'grade' && (
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

          {(singleMode || rightTab === 'export') && (
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

              {import.meta.env.DEV && promptStats && (
                <div className={`ed-promptsize${promptStats.kb > 150 ? ' is-over' : ''}`}>
                  <div className="ed-promptsize-head">
                    Prompt payload · {promptStats.kb.toFixed(1)} KB ·{' '}
                    ~{promptStats.tokens.toLocaleString()} tokens
                  </div>
                  <div className="ed-dim">
                    {promptStats.totalSentences > 0
                      ? `${promptStats.sentInPrompt} of ${promptStats.totalSentences} sentences${promptStats.sampled ? ' (sampled across full clip length)' : ''}`
                      : 'no transcripts yet'}
                    {promptStats.kb > 150 && ' · over the 150KB budget'}
                  </div>
                </div>
              )}

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
                <RenderProgress progress={progress} startedAt={renderStartedAt} running={rendering} />
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

                  {/* Edit-quality signal. Local only — nothing leaves the browser. */}
                  {plan?.planId && (
                    <div className="ed-rate">
                      {rating ? (
                        <span className="ed-dim">
                          Thanks — logged as “{rating}”. It stays on this machine.
                        </span>
                      ) : (
                        <>
                          <span>How was this edit?</span>
                          <div className="ed-rate-row">
                            {[
                              ['good', 'Good'],
                              ['needs-work', 'Needs work'],
                              ['unusable', 'Unusable'],
                            ].map(([v, label]) => (
                              <button key={v} className="ed-btn ed-btn-sm" onClick={() => rateEdit(v)}>
                                {label}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {import.meta.env.DEV && (
                <button
                  className="ed-btn ed-btn-block ed-mt"
                  onClick={async () => setQualityView(qualityView ? null : await listFeedback())}
                >
                  {qualityView ? 'Hide edit quality' : 'Edit quality'}
                </button>
              )}

              {import.meta.env.DEV && qualityView && (
                <div className="ed-quality">
                  {!qualityView.length ? (
                    <div className="ed-dim">
                      No rated edits yet. Generate a plan, render it, and answer “How was this
                      edit?”.
                    </div>
                  ) : (
                    <>
                      <div className="ed-quality-sum">
                        {qualityView.filter((f) => f.rating).length} rated ·{' '}
                        {(
                          qualityView.reduce((a, f) => a + (f.corrections?.length || 0), 0) /
                          Math.max(1, qualityView.length)
                        ).toFixed(1)}{' '}
                        corrections per edit
                      </div>
                      {qualityView.map((f) => (
                        <div key={f.planId} className="ed-quality-row">
                          <div className="ed-quality-top">
                            <span className={`ed-quality-dot r-${f.rating || 'none'}`} />
                            <strong>{f.rating || 'unrated'}</strong>
                            <span className="ed-dim">
                              {f.corrections?.length || 0} correction
                              {(f.corrections?.length || 0) === 1 ? '' : 's'}
                            </span>
                          </div>
                          <div className="ed-dim ed-quality-meta">
                            “{f.prompt || '(no prompt)'}” · {f.segmentCount ?? '?'} shots ·{' '}
                            {f.profileName ? `style: ${f.profileName}` : 'no style'} ·{' '}
                            {f.engine || 'not rendered'}
                            {f.usedMock ? ' · mock' : ''}
                          </div>
                          {!!f.corrections?.length && (
                            <div className="ed-quality-fixes">
                              {f.corrections.slice(-6).map((c, i) => (
                                <span key={i}>
                                  {c.field}
                                  {c.segmentIndex != null ? ` #${c.segmentIndex}` : ''}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </aside>

        {/* Tapping outside the slid-over panel closes it. */}
        {rightOverlayOpen && (
          <div className="ed-scrim" onClick={() => setRailOpen(false)} aria-hidden="true" />
        )}
      </div>

      {/* BOTTOM TAB BAR — single-panel mode only. */}
      {singleMode && (
        <nav className="ed-tabbar" role="tablist" aria-label="Panels">
          {MOBILE_TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={activeLeftTab === t}
              className={`ed-tabbar-btn${activeLeftTab === t ? ' is-active' : ''}`}
              onClick={() => {
                setLeftTab(t)
                if (t === 'export') setRightTab('export')
              }}
            >
              <span className="ed-tabbar-icon" aria-hidden="true">
                {TAB_ICON[t]}
              </span>
              <span className="ed-tabbar-label">{tabLabel(t)}</span>
            </button>
          ))}
        </nav>
      )}

      {/* Render outcome is announced, not just shown — a long render finishing
          while the user is in another tab should reach a screen reader. */}
      <span className="sr-only" role="status" aria-live="polite">
        {rendering
          ? ''
          : result
            ? `Render complete. ${result.shots ?? ''} shots, ${fmtSize(result.size)}.`
            : renderError
              ? `Render failed. ${renderError}`
              : ''}
      </span>
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
.ed { position: fixed; inset: 0; display: flex; flex-direction: column; background: var(--bg); color: var(--text); font-size: 14px;
  --ed-side: var(--side-w); --ed-stage-pad: var(--s4); --ed-tl-h: var(--timeline-h); }

.ed-top { display: flex; align-items: center; gap: var(--s3); min-height: 54px; padding: var(--s2) var(--s4); background: var(--panel); border-bottom: 1px solid var(--border); flex: none; }
.ed-logo { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 17px; }
.ed-logo span { background: linear-gradient(90deg, var(--cyan), var(--purple)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.ed-top-mid { margin: 0 auto; text-align: center; font-family: 'Syne', sans-serif; font-weight: 600; display: flex; flex-direction: column; line-height: 1.3; }
.ed-top-sub { font-family: 'DM Sans', sans-serif; font-weight: 400; font-size: 11.5px; color: var(--muted); }

.ed-btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--s2); min-height: var(--tap); border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: var(--r-md); padding: var(--s2) var(--s4); font-weight: 600; font-size: 13px; transition: transform .12s, box-shadow .12s, opacity .12s; }
.ed-btn:hover:not(:disabled) { transform: translateY(-1px); }
.ed-btn:disabled { opacity: .4; cursor: not-allowed; }
.ed-btn-primary { background: linear-gradient(90deg, var(--cyan), var(--purple)); color: #05050a; border-color: transparent; }
.ed-btn-primary:hover:not(:disabled) { box-shadow: 0 6px 22px -6px rgba(155,93,255,.6); }
.ed-btn-block { width: 100%; margin-top: var(--s3); }

.ed-body { flex: 1; display: flex; min-height: 0; }
.ed-side { width: var(--ed-side); flex: none; background: var(--panel); display: flex; flex-direction: column; min-height: 0; }
.ed-side-left { border-right: 1px solid var(--border); }
.ed-side-right { border-left: 1px solid var(--border); }
.ed-side-scroll { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: var(--s4); display: flex; flex-direction: column; }

.ed-tabs { display: flex; border-bottom: 1px solid var(--border); flex: none; }
.ed-tab { flex: 1; min-height: var(--tap); background: none; border: none; color: var(--muted); padding: var(--s3) var(--s1); font-size: 12.5px; font-weight: 600; border-bottom: 2px solid transparent; }
.ed-tab.is-active { color: var(--text); border-bottom-color: var(--purple); }

.ed-drop { border: 1.5px dashed var(--border); border-radius: var(--r-lg); padding: var(--s6) var(--s3); text-align: center; background: var(--surface); transition: border-color .15s, background .15s; cursor: pointer; }
.ed-drop.is-drag { border-color: var(--cyan); background: rgba(9,246,255,.06); }
.ed-drop-icon { width: 34px; height: 34px; margin: 0 auto 10px; border-radius: 50%; display: grid; place-items: center; background: linear-gradient(90deg, var(--cyan), var(--purple)); color: #05050a; font-size: 13px; }
.ed-drop-t { font-weight: 600; font-size: 13px; }
.ed-drop-d { color: var(--muted); font-size: 11.5px; margin-top: 4px; }

.ed-errs { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.ed-err { background: rgba(255,37,102,.08); border: 1px solid rgba(255,37,102,.35); border-radius: 8px; padding: 8px 10px; font-size: 11.5px; color: #ffb3c6; }
.ed-err strong { display: block; color: var(--pink); margin-bottom: 2px; word-break: break-all; }

.ed-lib { margin-top: var(--s4); display: flex; flex-direction: column; gap: var(--s2); }
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

.ed-btn-sm { padding: var(--s2) var(--s3); font-size: 12px; border-radius: var(--r-sm); min-height: var(--tap); }
.ed-transcribe-all { margin-top: 12px; }
.ed-prog-tight { margin-top: 8px; }
.ed-row-actions { margin-top: 6px; }
.ed-linkbtn { background: none; border: none; padding: var(--s1) 0; min-height: 24px; font-size: 11px; font-weight: 600; color: var(--cyan); text-align: left; }
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
.ed-tx-strike { flex: none; min-width: var(--tap); min-height: var(--tap); display: grid; place-items: center; border-radius: var(--r-sm);
  border: 1px solid var(--border); background: var(--surface); color: var(--muted); font-size: 10px; margin-top: var(--s1); }
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
.ed-x { background: none; border: none; color: var(--muted); font-size: 17px; line-height: 1; flex: none; border-radius: var(--r-sm);
  min-width: var(--tap); min-height: var(--tap); display: grid; place-items: center; }
.ed-x:hover { color: var(--pink); }
.ed-lib-empty, .ed-tl-hint { color: var(--muted); font-size: 12px; }
.ed-lib-empty { padding: 14px 4px; }

.ed-placeholder p { color: var(--text); font-size: 12.5px; margin: 0 0 10px; }
.ed-dim { color: var(--muted); font-size: 11.5px; }
.ed-mt { margin-top: 10px; }
.ed-chip-row { display: flex; flex-wrap: wrap; gap: var(--s2); margin-bottom: var(--s4); }
.ed-chip { font-size: 11px; padding: 4px 9px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); color: var(--muted); }
.ed-chip.is-on { border-color: var(--cyan); color: var(--cyan); }

.ed-slider { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; font-size: 11.5px; color: var(--muted); }
.ed-slider input { width: 100%; accent-color: var(--purple); }

.ed-stage { flex: 1; display: flex; flex-direction: column; min-width: 0; padding: var(--ed-stage-pad); gap: var(--s3); overflow: hidden; }
.ed-preview { flex: 1; min-height: 140px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); position: relative; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.ed-video { max-width: 100%; max-height: 100%; background: #000; cursor: pointer; }
.ed-preview-bar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: linear-gradient(transparent, rgba(0,0,0,.7)); font-size: 12px; }
.ed-play { width: var(--tap); height: var(--tap); min-width: 32px; min-height: 32px; display: grid; place-items: center; border-radius: 50%; border: none; background: var(--text); color: #05050a; font-size: 11px; flex: none; }
.ed-time { font-variant-numeric: tabular-nums; }
.ed-preview-name { margin-left: auto; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }

.ed-empty { text-align: center; max-width: 380px; padding: 20px; }
.ed-empty-icon { font-size: 40px; }
.ed-empty h3 { margin: 14px 0 8px; }
.ed-empty p { color: var(--muted); font-size: 13px; line-height: 1.6; margin-bottom: var(--s4); }

.ed-ai { background: var(--panel); border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--s3); flex: none; }
.ed-ai-row { display: flex; gap: var(--s2); flex-wrap: wrap; }
.ed-ai-input { flex: 1; min-width: 160px; min-height: var(--tap); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-sm); padding: var(--s2) var(--s3); color: var(--text); font-size: 13px; }
.ed-ai-input:focus { outline: none; border-color: var(--purple); }
.ed-ai-status { margin-top: 8px; font-size: 12px; line-height: 1.5; }
.ed-ok { color: var(--cyan); }
.ed-bad { color: var(--pink); font-size: 12px; }

.ed-timeline { flex: none; background: var(--panel); border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--s2); display: flex; flex-direction: column; gap: var(--s2); max-height: var(--ed-tl-h); overflow-y: auto; }
.ed-tl-track { display: flex; align-items: stretch; gap: 8px; }
.ed-tl-label { width: 64px; flex: none; font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); display: flex; align-items: center; }
.ed-tl-lane { flex: 1; min-height: 44px; min-width: 0; background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-sm); display: flex; align-items: stretch; gap: 3px; padding: 3px;
  overflow-x: auto; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; scroll-behavior: smooth; }
.ed-block { flex: none; min-width: 44px; border-radius: var(--r-sm); padding: var(--s1) var(--s2); display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; cursor: pointer;
  background: linear-gradient(160deg, rgba(9,246,255,.18), rgba(155,93,255,.18)); border: 1px solid rgba(155,93,255,.4); }
.ed-block.is-cursor { box-shadow: inset 0 0 0 2px var(--cyan); }
.ed-tl-lane:focus-visible { box-shadow: var(--ring); }
.ed-block.role-hook { background: linear-gradient(160deg, rgba(9,246,255,.28), rgba(9,246,255,.1)); border-color: var(--cyan); }
.ed-block.role-outro { background: linear-gradient(160deg, rgba(255,37,102,.24), rgba(255,37,102,.08)); border-color: rgba(255,37,102,.5); }
.ed-block.role-music { background: linear-gradient(160deg, rgba(155,93,255,.24), rgba(155,93,255,.06)); border-color: rgba(155,93,255,.5); }
.ed-block-name { font-size: 10.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ed-block-len { font-size: 9.5px; color: var(--muted); }
.ed-tl-hint { padding: 0 8px; display: flex; align-items: center; }

.ed-field { display: flex; flex-direction: column; gap: var(--s1); font-size: 12px; color: var(--muted); }
.ed-field select { min-height: var(--tap); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-sm); padding: var(--s2) var(--s3); color: var(--text); font-size: 13px; }

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

.ed-toggle { display: flex; align-items: center; gap: var(--s2); min-height: var(--tap); font-size: 11.5px; color: var(--muted); cursor: pointer; }
.ed-toggle input { accent-color: var(--purple); width: 17px; height: 17px; flex: none; }

/* captions */
.ed-caps { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 9px; }
.ed-caps-head { font-weight: 600; }
/* prompt size + edit-quality signal (both dev-only) */
.ed-promptsize { margin-top: 10px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); }
.ed-promptsize.is-over { border-color: var(--pink); }
.ed-promptsize-head { font-size: 11.5px; font-weight: 600; color: var(--cyan); margin-bottom: 3px; font-variant-numeric: tabular-nums; }
.ed-promptsize.is-over .ed-promptsize-head { color: var(--pink); }

.ed-rate { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 12px; display: flex; flex-direction: column; gap: 8px; }
.ed-rate-row { display: flex; gap: var(--s2); flex-wrap: wrap; }
.ed-rate-row .ed-btn { flex: 1; padding: 6px 4px; }

.ed-quality { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; max-height: 300px; overflow-y: auto; }
.ed-quality-sum { font-size: 11.5px; font-weight: 600; color: var(--cyan); font-variant-numeric: tabular-nums; }
.ed-quality-row { border: 1px solid var(--border); border-radius: 8px; padding: 8px; background: var(--surface); }
.ed-quality-top { display: flex; align-items: center; gap: 6px; font-size: 11.5px; }
.ed-quality-top strong { text-transform: capitalize; }
.ed-quality-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--muted); }
.ed-quality-dot.r-good { background: #7CFFB2; }
.ed-quality-dot.r-needs-work { background: #ffcf8a; }
.ed-quality-dot.r-unusable { background: var(--pink); }
.ed-quality-meta { margin-top: 3px; line-height: 1.5; }
.ed-quality-fixes { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.ed-quality-fixes span { font-size: 9.5px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }

.ed-seg-ctl { display: flex; align-items: center; gap: var(--s1); margin-top: var(--s2); flex-wrap: wrap; }
.ed-seg-ctl > .ed-dim { font-size: 9.5px; text-transform: uppercase; letter-spacing: .05em; }
.ed-seg-ctl button { min-width: var(--tap); min-height: var(--tap); display: inline-grid; place-items: center; border-radius: var(--r-sm);
  border: 1px solid var(--border); background: var(--bg); color: var(--muted); font-size: 13px; line-height: 1; padding: 0; }
.ed-seg-ctl button:hover { border-color: var(--cyan); color: var(--cyan); }
.ed-seg-drop { margin-left: auto; }
.ed-seg-drop:hover { border-color: var(--pink) !important; color: var(--pink) !important; }

/* project persistence */
.ed-project-name { background: none; border: 1px solid transparent; border-radius: var(--r-sm); color: var(--text); font-family: 'Syne', sans-serif; font-weight: 600; font-size: 14px; text-align: center; padding: var(--s1) var(--s2); width: clamp(120px, 32vw, 260px); }
.ed-project-name:hover { border-color: var(--border); }
.ed-project-name:focus { outline: none; border-color: var(--purple); background: var(--bg); }
.ed-top-projects { padding: 7px 13px; font-size: 12.5px; }

.ed-restore { position: fixed; inset: 0; z-index: 60; background: rgba(5,5,10,.86); backdrop-filter: blur(6px); display: grid; place-items: center; padding: 24px; }
.ed-restore-card { width: min(520px, 100%); max-height: 84vh; overflow-y: auto; background: var(--panel); border: 1px solid var(--border); border-radius: var(--r-xl); padding: var(--s6); display: flex; flex-direction: column; gap: var(--s3); }
.ed-restore-card h3 { font-size: 19px; }
.ed-restore-list { list-style: none; margin: 6px 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.ed-restore-list li { display: flex; gap: 10px; align-items: center; padding: 8px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.ed-restore-list img, .ed-restore-noimg { width: 62px; height: 36px; border-radius: 6px; object-fit: cover; background: #000; flex: none; }
.ed-restore-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ed-restore-meta strong { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.ed-mobile-gate { display: none; }

/* style profiles */
.ed-style-lead { font-size: 13px; font-weight: 600; color: var(--text); margin: 0 0 8px; }
.ed-style-progress { display: flex; flex-direction: column; gap: 4px; }
.ed-style-card { margin-top: 12px; padding: 11px; border-radius: 10px; border: 1px solid var(--purple); background: rgba(155,93,255,.08); }
.ed-style-name { font-family: 'Syne', sans-serif; font-weight: 700; font-size: 13px; margin-bottom: 5px; }
.ed-style-desc { font-size: 12px; line-height: 1.55; color: var(--text); margin: 0 0 6px; }
.ed-style-actions { display: flex; gap: var(--s2); margin-top: var(--s3); flex-wrap: wrap; }
.ed-style-actions .ed-btn { flex: 1; padding: 6px 4px; }

.ed-caps-note { margin: 5px 0 0; font-size: 10.5px; line-height: 1.5; color: #ffcf8a; }
.ed-caps-note.is-info { color: var(--muted); }
.ed-toggle.is-disabled { opacity: .55; cursor: not-allowed; }
.ed-toggle.is-disabled input { cursor: not-allowed; }
.ed-warn { font-size: 11px; line-height: 1.5; color: #ffcf8a; background: rgba(255,190,90,.09); border: 1px solid rgba(255,190,90,.35); border-radius: 8px; padding: 8px 10px; }
.ed-caps-row { display: flex; align-items: center; gap: 6px; }
.ed-caps-row > .ed-dim { width: 58px; flex: none; }
.ed-seg-btn { min-height: var(--tap); min-width: var(--tap); border: 1px solid var(--border); background: var(--surface); color: var(--muted); border-radius: var(--r-sm); padding: var(--s1) var(--s3); font-size: 11px; font-weight: 600; text-transform: capitalize; }
.ed-seg-btn.is-on { border-color: var(--cyan); color: var(--cyan); }
.ed-caps-preview { position: relative; height: 74px; border-radius: 8px; background: linear-gradient(120deg, #1a1a28, #0f0f1b); border: 1px solid var(--border); display: flex; justify-content: center; overflow: hidden; }
.ed-caps-preview.pos-bottom { align-items: flex-end; padding-bottom: 8px; }
.ed-caps-preview.pos-top { align-items: flex-start; padding-top: 8px; }
.ed-caps-preview-text { font-family: 'DM Sans', sans-serif; font-weight: 700; color: #fff; text-align: center; -webkit-text-stroke: 3px #000; paint-order: stroke fill; }
.ed-caps-preview-text.sz-S { font-size: 12px; }
.ed-caps-preview-text.sz-M { font-size: 15px; }
.ed-caps-preview-text.sz-L { font-size: 19px; }
.ed-caps-preview.has-bg .ed-caps-preview-text { background: rgba(0,0,0,.55); padding: 2px 8px; border-radius: 5px; -webkit-text-stroke: 0; }
.ed-caps-dl { display: flex; gap: var(--s2); flex-wrap: wrap; }

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

/* ---------------------------------------------------------------------
   Shared chrome for the smaller layouts
   ------------------------------------------------------------------ */
.ed-icon-btn { min-width: var(--tap); min-height: var(--tap); display: grid; place-items: center; border-radius: var(--r-sm);
  border: 1px solid var(--border); background: var(--surface); color: var(--muted); font-size: 18px; line-height: 1; }
.ed-icon-btn:hover { color: var(--text); }

.ed-scrim { position: absolute; inset: 0; z-index: 15; background: rgba(5,5,10,.6); backdrop-filter: blur(2px); }

.ed-overlay-head { display: none; align-items: center; justify-content: space-between; gap: var(--s3);
  padding: var(--s2) var(--s2) var(--s2) var(--s4); border-bottom: 1px solid var(--border); font-weight: 600; font-size: 13px; flex: none; }

/* Timeline: cursor help line + the collapsed mobile summary */
.ed-tl-help { margin: var(--s1) 0 0; font-size: 10.5px; color: var(--muted); }
.ed-tl-help kbd { font-family: ui-monospace, Menlo, monospace; font-size: 10px; border: 1px solid var(--border);
  border-radius: var(--r-sm); padding: 0 4px; background: var(--bg); }

.ed-tl-summary { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; min-height: 56px;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--r-lg); padding: var(--s3) var(--s4); color: var(--text); text-align: left; flex: none; }
.ed-tl-summary-main { font-weight: 600; font-size: 13px; }
.ed-tl-summary-sub { font-size: 11.5px; color: var(--muted); }

/* Full-screen sheets. Under 768px every modal is a sheet, not a centered card
   — a centered dialog on a phone leaves unreachable content behind the fold. */
.ed-sheet-host { position: fixed; inset: 0; z-index: 60; background: rgba(5,5,10,.86); backdrop-filter: blur(6px);
  display: grid; place-items: center; padding: var(--s6); }
.ed-sheet-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); flex: none; margin-bottom: var(--s3); }
.ed-sheet-head h3 { font-size: 16px; }
.ed-tl-sheet { width: min(720px, 100%); max-height: 80vh; overflow-y: auto; background: var(--panel);
  border: 1px solid var(--border); border-radius: var(--r-xl); padding: var(--s4); }
.ed-tl-sheet .ed-timeline { max-height: none; }

/* ---------------------------------------------------------------------
   1024-1279px — right sidebar collapses to a 48px icon rail
   ------------------------------------------------------------------ */
.ed-rail { display: none; }

.ed.mode-rail { --ed-side: clamp(200px, 20vw, 240px); --ed-tl-h: 120px; }
.ed.mode-rail .ed-body { position: relative; }
.ed.mode-rail .ed-rail { display: flex; flex-direction: column; gap: var(--s2); width: var(--rail-w); flex: none;
  padding: var(--s2) 0; background: var(--panel); border-left: 1px solid var(--border); align-items: center; z-index: 25; }
.ed.mode-rail .ed-rail-btn { width: 36px; height: 36px; display: grid; place-items: center; border-radius: var(--r-md);
  border: 1px solid transparent; background: none; color: var(--muted); font-size: 15px; }
.ed.mode-rail .ed-rail-btn:hover { color: var(--text); background: var(--surface); }
.ed.mode-rail .ed-rail-btn.is-active { color: var(--cyan); border-color: var(--cyan); background: rgba(9,246,255,.1); }

/* The panel slides over the stage rather than squeezing it. */
.ed.mode-rail .ed-side-right { position: absolute; top: 0; bottom: 0; right: var(--rail-w); z-index: 20;
  width: min(320px, 62vw); border-left: 1px solid var(--border); box-shadow: -18px 0 44px -20px rgba(0,0,0,.9);
  transform: translateX(calc(100% + var(--rail-w))); visibility: hidden; transition: transform .22s ease, visibility .22s; }
.ed.mode-rail .ed-side-right.is-open { transform: none; visibility: visible; }
.ed.mode-rail .ed-overlay-head { display: flex; }
@media (prefers-reduced-motion: reduce) {
  .ed.mode-rail .ed-side-right { transition: none; }
}

/* ---------------------------------------------------------------------
   768-1023px — one panel at a time, tab bar along the bottom
   ------------------------------------------------------------------ */
.ed-tabbar { display: none; }

.ed.mode-single { --ed-stage-pad: var(--s3); }
.ed.mode-single .ed-body { flex-direction: column; }
.ed.mode-single .ed-stage { flex: none; height: clamp(280px, 44vh, 420px); order: 0; }
.ed.mode-single .ed-side { width: 100%; flex: 1; min-height: 0; order: 1;
  border-top: 1px solid var(--border); border-left: none; border-right: none; }
.ed.mode-single .ed-side-right { position: static; transform: none; visibility: visible; box-shadow: none; }
.ed.mode-single .ed-tabbar { display: flex; flex: none; background: var(--panel); border-top: 1px solid var(--border);
  padding-bottom: env(safe-area-inset-bottom, 0px); }
.ed-tabbar-btn { flex: 1; min-height: 56px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  background: none; border: none; border-top: 2px solid transparent; color: var(--muted); font-size: 11px; font-weight: 600; }
.ed-tabbar-btn.is-active { color: var(--cyan); border-top-color: var(--cyan); background: rgba(9,246,255,.06); }
.ed-tabbar-icon { font-size: 17px; line-height: 1; }

/* ---------------------------------------------------------------------
   Below 768px the route renders Quick Edit instead, but the editor can
   still be forced with ?full=1 — make sure it degrades rather than breaks.
   ------------------------------------------------------------------ */
@media (max-width: 767px) {
  .ed-top { flex-wrap: wrap; row-gap: var(--s2); }
  .ed-top-mid { margin: 0; text-align: left; align-items: flex-start; order: 3; width: 100%; }
  .ed-project-name { text-align: left; padding-left: 0; width: 100%; max-width: none; }
  .ed-top-projects { display: none; }
  .ed-sheet-host { padding: 0; place-items: stretch; }
  .ed-sheet { width: 100% !important; max-width: none; max-height: 100dvh; height: 100dvh; border-radius: 0 !important;
    border: none !important; overflow-y: auto; }
  .ed-stage { height: auto; min-height: 240px; }
}
`
