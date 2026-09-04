import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Fails the build if a secret could reach the client.
 *
 * Two independent checks, because they catch different mistakes:
 *  1. Config-time — any VITE_-prefixed variable whose name looks like a secret.
 *     Vite inlines every VITE_* var into the bundle, so this ships the key to
 *     every visitor. The correct name is ANTHROPIC_API_KEY (no prefix), read
 *     server-side in api/plan.js.
 *  2. Bundle-time — an actual Anthropic key literal anywhere in the emitted
 *     assets, which catches a hardcoded string that no env check would see.
 */
function secretGuard() {
  const SUSPECT = /^VITE_.*(ANTHROPIC|API_?KEY|SECRET|TOKEN|PASSWORD|PRIVATE)/i
  return {
    name: 'reelmind-secret-guard',
    enforce: 'pre',
    config() {
      const bad = Object.keys(process.env).filter((k) => SUSPECT.test(k))
      if (bad.length) {
        throw new Error(
          `\n\n[secret-guard] These environment variables would be inlined into the client bundle:\n` +
            bad.map((k) => `  - ${k}`).join('\n') +
            `\n\nVite exposes every VITE_* variable to the browser. Rename to a non-VITE name ` +
            `(e.g. ANTHROPIC_API_KEY) and read it server-side in api/plan.js.\n`,
        )
      }
    },
    generateBundle(_options, bundle) {
      const KEY_LITERAL = /sk-ant-[A-Za-z0-9_-]{8,}/
      for (const [file, chunk] of Object.entries(bundle)) {
        const source = chunk.type === 'asset' ? chunk.source : chunk.code
        if (typeof source !== 'string') continue
        if (KEY_LITERAL.test(source)) {
          this.error(
            `[secret-guard] An Anthropic API key literal was found in "${file}". ` +
              `Never hardcode keys — read them server-side in api/plan.js.`,
          )
        }
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [secretGuard(), react()],
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    // Production preview must carry the same isolation headers as Vercel, or
    // FFmpeg.wasm and WebCodecs die silently when verifying a real build.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  // @huggingface/transformers pulls onnxruntime-web (wasm); pre-bundling it with
  // esbuild breaks the worker build, so exclude it like the ffmpeg packages.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@huggingface/transformers'] },
})
