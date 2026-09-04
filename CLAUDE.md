# ReelMind
Browser-based AI vlog editor. Vite + React. No backend yet.

## Architecture
- All video processing happens client-side via FFmpeg.wasm — never upload footage
- src/utils/videoMeta.js  — probes real File objects for duration/resolution/thumbnail
- src/utils/analyzer.js   — client-side content analysis (audio energy, motion, silences); withTranscript() folds in speech data
- src/workers/transcribe.worker.js — Whisper (transformers.js) in a Web Worker; MUST stay off the main thread
- src/utils/transcribe.js — main-thread wrapper: 16kHz mono audio extraction + words/sentences/fillers
- src/utils/retakes.js — literal-retake detection via weighted token-overlap (no model); findRetakes / pickBestTake. withTranscript() attaches analysis.retakes
- src/utils/ai.js         — edit planner. USE_MOCK = true, no API key spend yet
- src/utils/videoProcessor.js — render(): WebCodecs (GPU) path with FFmpeg.wasm fallback; renderVideo() is the FFmpeg two-pass; estimateRenderSeconds(); coalesceRanges() + countCuts()
- src/utils/audioSplice.js — cut hygiene: SPLICE_MS, applyEdgeFades (equal-power), concatWithSplice, findZeroCrossing. For butt-joined audio, NOT crossfades
- src/utils/captions.js — buildCaptions(transcript) → cues from word timings; remapToOutputTimeline(cuesByClip, plan) → output-time cues (handles reorder + excludeRanges); toSRT/toVTT
- src/utils/styleProfile.js — learns editing rhythm from the creator's own finished uploads: analyzeEditedVideo (4fps luma diffing, cuts found against a ROLLING MEDIAN not a fixed threshold), buildProfile, applyProfile, localStorage persistence. Hard cuts are IMPULSES (dominant local peak), crossfades are PLATEAUS — that distinction is what keeps transitionRatio honest
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
- Palette: bg #05050A, panels #0B0B14, cyan #09F6FF, purple #9B5DFF, muted #6464A0
- Fonts: Syne (headings), DM Sans (body)
