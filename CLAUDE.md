# ReelMind
Browser-based AI vlog editor. Vite + React. No backend yet.

## Architecture
- All video processing happens client-side via FFmpeg.wasm — never upload footage
- src/utils/videoMeta.js  — probes real File objects for duration/resolution/thumbnail
- src/utils/analyzer.js   — client-side content analysis (audio energy, motion, silences); withTranscript() folds in speech data
- src/workers/transcribe.worker.js — Whisper (transformers.js) in a Web Worker; MUST stay off the main thread
- src/utils/transcribe.js — main-thread wrapper: 16kHz mono audio extraction + words/sentences/fillers
- src/utils/retakes.js — literal-retake detection via weighted token-overlap (no model); findRetakes / pickBestTake. withTranscript() attaches analysis.retakes
- src/utils/candidates.js — THE planner's engine: generateCandidates (1-3 sentences on a sliding window with a transcript; 2-8s onset-snapped windows without) → scoreCandidate (content .45 / audio .2 / visual .2 / position .15, every signal relative to the clip's OWN baseline) → selectCandidates (greedy + diversity constraints) → orderSegments. All weights are exported constants at the top of the file — that is the tuning surface
- src/utils/ai.js         — edit planner. USE_MOCK = false: /api/plan is live, and mockPlan() is the OFFLINE FALLBACK, not a stub
- src/utils/videoProcessor.js — render(): WebCodecs (GPU) path with FFmpeg.wasm fallback; renderVideo() is the FFmpeg two-pass; estimateRenderSeconds(); coalesceRanges() + countCuts()
- src/utils/audioSplice.js — cut hygiene: SPLICE_MS, applyEdgeFades (equal-power), concatWithSplice, findZeroCrossing. For butt-joined audio, NOT crossfades
- src/utils/captions.js — buildCaptions(transcript) → cues from word timings; remapToOutputTimeline(cuesByClip, plan) → output-time cues (handles reorder + excludeRanges); toSRT/toVTT
- src/utils/styleProfile.js — learns editing rhythm from the creator's own finished uploads: analyzeEditedVideo (4fps luma diffing, cuts found against a ROLLING MEDIAN not a fixed threshold), buildProfile, applyProfile. Profiles now live in IndexedDB (migrated out of localStorage on first run). Hard cuts are IMPULSES (dominant local peak), crossfades are PLATEAUS — that distinction is what keeps transitionRatio honest
- The two engines JOIN differently: WebCodecs crossfades (timeline SHORTER by 0.5s per non-cut boundary), FFmpeg concat-demuxes (no xfade, every boundary a hard cut). resolveJoinPath(plan, engine) is the single source of truth — caption remap AND countCuts' totalDuration both read it, so they can't disagree with what renders. A 3-fade plan is 3.2s on WebCodecs vs 4.2s on FFmpeg
- @ffmpeg/core@0.12.6 DOES ship libass; it has no fontconfig, so burn-in needs a TTF written to the FS and `fontsdir=` passed to the subtitles filter. ffmpeg.exec returns 0 even when the filter drew nothing — trust the log (`fontselect:`), never the exit code
- The ~85ms WebCodecs container overshoot is AAC-priming timebase, NOT transition-offset math: renderer's own "[renderer] timeline" debug shows video & audio tracks land dead-on the plan; both shift equally so A/V sync = 0. Left alone deliberately (see smoke test cut-only run)
- src/utils/webcodecs/support.js — capability gate (VideoEncoder/AudioEncoder isConfigSupported)
- src/utils/webcodecs/demuxer.js — mp4box.js wrapper; returns samples with MICROSECOND timestamps + avcC description. Arms extraction (setExtractionOptions+start) INSIDE onReady — a fragmented MP4 (MediaRecorder, some phones) carries moov+all moof in one appendBuffer
- FFmpeg core is the ESM build (dist/esm), not UMD: @ffmpeg/ffmpeg 0.12 always spawns a type:module worker where importScripts is absent, so it needs a real ES module with a default export
- src/utils/webcodecs/renderer.js — decode → canvas composite (transitions, burned captions via opts.captions) → encode → mp4-muxer. Close EVERY VideoFrame immediately; queue backpressure; frame tracker asserts drained per segment. Caption cue lookup is binary-searched per frame
- src/utils/memoryGuard.js — createFrameTracker(): track/release/openCount/peak/assertDrained. Leak = throw naming the segment, not a dead tab
- src/utils/verify.js — verifyRender(blobUrl, {totalDuration,width,height}) + measureSync(). Post-render harness: duration, resolution, seekable, non-uniform frame, audio present/non-silent
- src/utils/smokeTest.js — dev-only runSmokeTest(): canvas+MediaRecorder test clips → full pipeline → verifyRender, run once per forced engine. Reports the container MediaRecorder actually produced (WebM ⇒ WebCodecs untestable, mp4box can't demux it)
- render() opts.forceEngine ('webcodecs'|'ffmpeg') bypasses the capability check; a forced 'webcodecs' failure is THROWN, not silently fallen back

- src/utils/storage.js — IndexedDB project persistence (projects / clipRefs / profiles). A File CANNOT be persisted across sessions: store metadata+analysis+transcript+plan, then match re-selected files by name+size and restore without recomputing. FileSystemFileHandle path (Chrome/Edge) skips re-selection; feature-detected
- src/ui/useResponsive.js — the ONE place breakpoints live: >=1280 full / >=1024 rail / >=768 single / below quick. useQuickEditGate() ORs the viewport with navigator.deviceMemory < 4GB, so a wide low-RAM device also gets Quick Edit; `?full=1` overrides. App.jsx routes /editor through it
- src/pages/QuickEdit.jsx — mobile flow: upload → prompt → render → download. 720p only, and capPlanDuration() (src/utils/mobileLimits.js) HARD-CAPS output at 180s — whole shots dropped first, then the last one trimmed. Not a "desktop only" wall; it renders a real MP4
- src/ui/ — Toast (bottom-right desktop / top mobile, errors never auto-dismiss), ConfirmButton (inline two-step; window.confirm blocks the tab and mobile Safari can suppress it), EmptyState + SkeletonRows, RenderProgress (stage label + live elapsed — a silent bar on a 3-minute render reads as hung)
- api/plan.js — the ONLY place ANTHROPIC_API_KEY exists. Never VITE_-prefixed (Vite inlines VITE_* into the client bundle). vite.config.js secretGuard fails the build on a VITE_*SECRET-ish var or an sk-ant- literal in the bundle

## Rules
- Never use dangerouslyAllowBrowser. Real Claude calls go through /api/plan
- Never delete the FFmpeg.wasm path — it is the fallback when WebCodecs is absent or throws mid-render
- WebCodecs: any error must fall back to FFmpeg, never fail the render
- vite.config.js COOP/COEP headers are load-bearing — FFmpeg dies without them
- Analysis, probing and transcription run sequentially, not in parallel — memory ceiling
- Whisper runs in a Web Worker only. Never call the pipeline on the main thread
- Transcription is opt-in per clip (Transcribe / Transcribe all). Never auto-transcribe on upload
- Fillers are surfaced, never auto-removed — the user approves via "Remove all fillers" or the prompt
- Retake detection is non-destructive — nothing is deleted, non-chosen takes are excluded as time ranges the user can re-include
- Style profiles never override hard constraints. applyProfile biases durations/transitions, then RE-CLAMPS against sentence boundaries, excludeRanges, the 0.7s floor and the source clip's real duration. Profile confidence is the MIN across sources, and low confidence must be surfaced, not hidden
- Cut detection is measured, not assumed: smoke test asserts against a synthetic edit with known shot lengths. Real rendered edits measure 4/4 hard cuts (0% err); back-to-back crossfades around a sub-1.5s shot merge into one boundary (3/4) — a documented limit, not a bug to tune away
- Every internal cut needs splice hygiene: coalesce exclude ranges (<0.12s gap), merge sub-0.25s survivors, snap audio to zero crossings, equal-power edge-fade. Splices are butt-joins; transitions are overlaps — keep both code paths
- A/V SYNC: audio slice length per segment MUST equal round(round(segDur*FPS)/FPS*RATE) samples — snap the in-point to a zero crossing for the click, then force the length back. Never let the zero-crossing snap change segment length (it accumulates). FFmpeg path uses `-t <dur>` on the output, not `-shortest`
- Every render is auto-verified (verifyRender + measureSync). A "real render confirmed correct" bar, not "looks done"
- Palette: bg #05050A, panels #0B0B14, cyan #09F6FF, purple #9B5DFF. --muted is #8484C0 (5.6:1 on --panel); the old #6464A0 measured 3.6:1 and survives only as --muted-line for borders and dots, which carry no text
- Spacing, radii, --side-w/--rail-w/--timeline-h and --tap all come from :root in index.css. --tap is 32px on a mouse and 44px under (pointer: coarse) — use it instead of hard-coding a control height
- Editor layout is one derived string: `layout` ('full' | 'rail' | 'single'), which sets both the `mode-*` class and the singleMode/railMode booleans. 'quick' collapses into 'single' so a forced editor on a phone degrades instead of stacking three panes. Nothing about layout is stored in state — a resize must not strand a panel over a layout with no room for it
- [hidden] is `display: none !important` globally: .ed-side sets its own display, which would otherwise beat the UA's [hidden] rule and leave a hidden panel on screen
- Fonts: Syne (headings), DM Sans (body)
- The planner is candidate-based, not chunk-based. The old shape ("take a chunk from near the start of each clip") captured setup footage and missed the content; POSITION.headScore now makes the first 8% of any clip near-ineligible on purpose
- Editing is REMOVAL, but the ratio SCALES with the footage — keepRatioFor() interpolates between anchors (30s .85 / 2min .60 / 6min .35 / 10min .22 / 30min+ .15), because short footage is already dense and long footage is mostly filler. There is NO minimum target: the old 60s floor was unsatisfiable on a 15s clip and returned a single 3s fragment. Target = stated length in the prompt, else footage × keepRatioFor, capped at 600s and never above the footage itself
- Selection constraints are PER CLIP, not per project: maxPerClipFor (3 under 20s / 4 under 60s / ceil(target/20) above), minGapFor (min(3s, dur×0.12)) and minSegmentSecondsFor (min(0.7, dur×0.06), never under 0.4s). The flat versions of those three together allowed exactly one segment on a 15s clip
- A clip under 20s is ONE moment: generateCandidates emits a `continuous` candidate (head/tail trimmed, sentence-snapped when there is a transcript) and selectCandidates takes it first, exempt from the score floor. Fragmenting a short clip is opt-in — the prompt asks for fast cutting, or analysis found a ≥1.5s internal silence worth removing
- planScaleCheck() in smokeTest.js asserts the selection math at three scales with no footage and no render (15s → 10-14s, 3×15s → 25-38s, 10min → 2-2.5min). It runs on synthetic analysis on purpose: with none, every body candidate ties on position and mergeAbutting folds the clip into one block
- buildPrompt sends SCORED CANDIDATES, not a clip inventory, capped at the top 150 (PROMPT_CANDIDATE_CAP). The model's job is editorial only; segments come back as `candidateId` references, so a hallucinated timestamp is not expressible. resolveCandidateSegments drops unknown and duplicate ids before validatePlan. Measured: 2 clips / 30 candidates = 5.3KB / ~1.5k tokens
- Two scoring traps, both measured and fixed — do not undo them. (1) Renormalising the CONTENT group away for silent clips gave b-roll a perfect content-free score and it beat every spoken line; NO_SPEECH_CONTENT scores it 0.45 instead whenever ANY clip in the project has speech. (2) Ranking sentence candidates against sliding windows under the 400 cap left 19 of 400 with text — the cap now keeps sentence candidates whole and bounds only the windows
- selectCandidates comes in UNDER target rather than padding: SELECTION.minScoreRatio (0.7 × the best score) is a hard floor, and the same rule is stated in the prompt. Relaxation order is minGap (to relaxedGap, never 0) then maxPerClip, and what was relaxed is reported, never hidden. mergeAbutting folds same-clip pieces the relaxation squeezed together back into one shot — 11 "shots" that are really one continuous take is a lie the timeline then repeats
- api/plan.js runs claude-opus-5 with adaptive thinking: choosing between 150 scored moments is reasoning work. A failure there falls back to the offline planner and the UI says which one ran and why — an outage costs plan quality, never the edit
- Edit-quality signal is local-only (IndexedDB `feedback` store): rating + corrections per plan. Correction logging must stay OUTSIDE state updaters — React can invoke an updater twice and double-count the exact metric this exists to produce
