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
- src/utils/videoProcessor.js — render(): WebCodecs (GPU) path with FFmpeg.wasm fallback; renderVideo() is the FFmpeg two-pass; estimateRenderSeconds()
- src/utils/webcodecs/support.js — capability gate (VideoEncoder/AudioEncoder isConfigSupported)
- src/utils/webcodecs/demuxer.js — mp4box.js wrapper; returns samples with MICROSECOND timestamps + avcC description
- src/utils/webcodecs/renderer.js — decode → canvas composite (transitions) → encode → mp4-muxer. Close EVERY VideoFrame immediately; queue backpressure

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
- Palette: bg #05050A, panels #0B0B14, cyan #09F6FF, purple #9B5DFF, muted #6464A0
- Fonts: Syne (headings), DM Sans (body)
