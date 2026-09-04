# ReelMind

AI vlog editor that runs entirely in the browser. Footage is never uploaded — probing, analysis, transcription and rendering all happen on the user's machine.

- **Landing** `/` · **Editor** `/editor` · **Projects** `/projects`

---

## Requirements

- Node 18+
- **Chrome or Edge** for the full feature set. The editor needs `SharedArrayBuffer` (FFmpeg.wasm) and ideally WebCodecs; Safari and Firefox fall back to the software renderer and lose some paths.
- Desktop only. The editor shows a "needs a desktop" message below 860px rather than a broken layout. The landing page stays responsive.

## Setup

```bash
npm install
npm run dev          # http://localhost:5173
```

`npm run build` → `dist/` · `npm run preview` serves that build with the same isolation headers Vercel sends.

### Cross-origin isolation is load-bearing

FFmpeg.wasm and WebCodecs both die **silently** without these two headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

They are set in three places and all three must stay in sync:

| Where | File |
|---|---|
| dev server | `vite.config.js` → `server.headers` |
| production preview | `vite.config.js` → `preview.headers` |
| deployed site | `vercel.json` → `headers` |

Verify in the browser console — this must be `true`:

```js
self.crossOriginIsolated
```

### SPA routing

`vercel.json` rewrites everything except `/api/*` to `index.html`, so `/editor`
and `/projects` work as direct URLs while the serverless function still resolves.
Static assets are served before rewrites apply, so they are unaffected.
(`vercel.json` is strict JSON — no comment keys; Vercel rejects unknown fields
inside a rewrite.)

---

## The Anthropic key

`src/utils/ai.js` ships with `USE_MOCK = true`, so the planner runs a local
keyword-driven mock and **nothing spends money**. The real path is built and
ready; flipping one line turns it on.

1. In Vercel → Project → Settings → Environment Variables, add:

   | Name | Value | Scope |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | `sk-ant-…` | Production, Preview, Development |

2. Flip `USE_MOCK` to `false` in `src/utils/ai.js` (the line is marked with a banner comment).

### It must NOT be `VITE_`-prefixed

Vite inlines every `VITE_*` variable into the client bundle at build time — a
`VITE_ANTHROPIC_API_KEY` would ship to every visitor in plain text. The key is
read server-side only, in `api/plan.js`.

`npm run build` runs a guard (`secretGuard` in `vite.config.js`) that **fails the
build** if either:

- an env var matches `VITE_*(ANTHROPIC|API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE)`, or
- an `sk-ant-…` literal appears anywhere in the emitted bundle.

Confirm it works:

```bash
VITE_ANTHROPIC_API_KEY=sk-ant-test npm run build   # must fail
```

### `api/plan.js`

Vercel serverless function. POST `{ prompt, clips, profile }` → `{ text }`.

- Rate limited to **20 requests/hour per IP** (in-memory; swap for KV before it matters)
- Rejects bodies over **200KB** — transcripts get large and an unbounded body is an easy way to run up a bill
- Returns structured `{ error: { code, message } }`, never a raw stack trace

---

## Persistence

Projects autosave to **IndexedDB** (not localStorage — clip metadata plus
transcripts plus profiles blow past the ~5MB ceiling immediately), debounced 2s.

**A `File` object cannot be persisted across sessions.** The browser revokes disk
access on unload. So ReelMind stores everything expensive to recompute —
metadata, analysis, transcripts, plan, take choices, settings — and on reopen
asks you to reselect the same files, matching them by name + size and restoring
the saved work without recomputing. A 20-minute reopen becomes ~10 seconds.

On Chrome/Edge a `FileSystemFileHandle` is stored alongside, and reopening skips
reselection entirely after a permission prompt. Feature-detected, never required.

Style profiles created before this existed are migrated out of localStorage into
IndexedDB on first run, and the old key is cleared.

---

## Verification

### Smoke test

Dev-only. Open `/editor` → **Export** tab → **Run smoke test**. It generates its
own test clips (canvas + MediaRecorder + oscillator tones), so it needs no
footage, and takes a few minutes.

It covers:

- render on **both** engines (`forceEngine: 'webcodecs'` and `'ffmpeg'`), each verified for duration, resolution, seekability, a non-uniform mid-frame and a non-silent audio track
- A/V sync delta (fails over 100ms)
- a cut-only run, to attribute any duration overshoot to the muxer rather than transition math
- caption timeline alignment on both engines, which join differently — WebCodecs crossfades and shortens, FFmpeg concats and does not
- style-profile **cut-detection accuracy** against a synthetic edit with known shot lengths

Enable **Diagnostics** next to it for per-segment console logging: source in/out, snapped audio in/out, frames encoded, audio samples written, peak open `VideoFrame` count.

### Persistence check

1. `npm run dev`, drop in a clip, transcribe it, pick a retake
2. Hard-refresh
3. Open `/projects` → the project is listed → open it → reselect the same file
4. Transcript and take choices are restored without re-transcribing

### Before deploying

```bash
npm run lint
npm run build
grep -rEl 'sk-ant-|ANTHROPIC' dist/    # must print nothing
```

---

## Architecture

See `CLAUDE.md` for the full map and the invariants that are easy to break
(A/V sync, splice hygiene, memory rules for `VideoFrame`, the engines' differing
join paths). The short version:

| Concern | File |
|---|---|
| Probe real File metadata | `src/utils/videoMeta.js` |
| Audio energy / motion / silences | `src/utils/analyzer.js` |
| Whisper transcription (Web Worker) | `src/workers/transcribe.worker.js`, `src/utils/transcribe.js` |
| Retake detection | `src/utils/retakes.js` |
| Captions | `src/utils/captions.js` |
| Style profiles | `src/utils/styleProfile.js` |
| Edit planning | `src/utils/ai.js` |
| Render (GPU + FFmpeg fallback) | `src/utils/videoProcessor.js`, `src/utils/webcodecs/*` |
| Persistence | `src/utils/storage.js` |
| Post-render verification | `src/utils/verify.js` |
