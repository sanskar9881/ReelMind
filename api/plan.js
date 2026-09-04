// api/plan.js — Vercel serverless function: the ONLY place an Anthropic key
// ever exists. The browser never sees it.
//
// ─────────────────────────────────────────────────────────────────────────────
// ENVIRONMENT VARIABLE — set this in Vercel → Project → Settings → Environment
// Variables:
//
//     Name:  ANTHROPIC_API_KEY
//     Value: sk-ant-...
//     Scope: Production, Preview, Development
//
// It MUST NOT be named VITE_ANTHROPIC_API_KEY, or prefixed with VITE_ at all.
// Vite inlines every VITE_* variable into the client bundle at build time, so a
// VITE_-prefixed key ships to every visitor in plain text. `npm run build` runs
// a guard (see vite.config.js) that fails the build if such a variable exists.
//
// Nothing here runs until USE_MOCK is flipped in src/utils/ai.js — see the
// marked line there. This endpoint exists so the switch is a one-line change,
// not a project.
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = 'claude-sonnet-4-5'
const MAX_BODY_BYTES = 200 * 1024 // transcripts get large; an unbounded body is an easy way to run up a bill
const RATE_LIMIT = 20 // requests
const RATE_WINDOW_MS = 60 * 60 * 1000 // per hour, per IP

// In-memory and therefore per-instance — good enough while this is one region
// and low traffic. Swap for Upstash/KV before it matters.
const hits = new Map()

function rateLimit(ip) {
  const now = Date.now()
  const bucket = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS)
  if (bucket.length >= RATE_LIMIT) {
    const retryAfter = Math.ceil((RATE_WINDOW_MS - (now - bucket[0])) / 1000)
    hits.set(ip, bucket)
    return { ok: false, retryAfter }
  }
  bucket.push(now)
  hits.set(ip, bucket)
  // Opportunistic cleanup so the map cannot grow without bound.
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.some((t) => now - t < RATE_WINDOW_MS)) hits.delete(k)
  }
  return { ok: true, remaining: RATE_LIMIT - bucket.length }
}

function fail(res, status, code, message) {
  // Structured, displayable — never a raw stack trace.
  res.status(status).json({ error: { code, message } })
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return fail(res, 405, 'method_not_allowed', 'Use POST.')
  }

  const key = process.env.ANTHROPIC_API_KEY
  if (!key) {
    return fail(
      res,
      500,
      'not_configured',
      'The planning service is not configured. Set ANTHROPIC_API_KEY in the deployment environment.',
    )
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  const limit = rateLimit(ip)
  if (!limit.ok) {
    res.setHeader('Retry-After', String(limit.retryAfter))
    return fail(
      res,
      429,
      'rate_limited',
      `Too many planning requests. Try again in ${Math.ceil(limit.retryAfter / 60)} minute(s).`,
    )
  }

  // Body size guard. Vercel parses JSON for us, so measure the parsed payload
  // (content-length is checked too when the platform provides it).
  const declared = Number(req.headers['content-length'] || 0)
  if (declared > MAX_BODY_BYTES) {
    return fail(res, 413, 'payload_too_large', 'That project is too large to plan in one request.')
  }
  let body = req.body
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body)
    } catch {
      return fail(res, 400, 'bad_json', 'Request body was not valid JSON.')
    }
  }
  if (!body || typeof body !== 'object') {
    return fail(res, 400, 'bad_request', 'Request body was missing.')
  }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
    return fail(res, 413, 'payload_too_large', 'That project is too large to plan in one request.')
  }

  // `prompt` is buildPrompt()'s output. clips/analysis/transcripts/profile are
  // accepted so the client can send raw context instead once buildPrompt moves
  // server-side; today the assembled prompt is what gets used.
  const { prompt } = body
  if (typeof prompt !== 'string' || prompt.trim().length < 20) {
    return fail(res, 400, 'bad_request', 'No usable prompt was supplied.')
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    })

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '')
      console.error('[api/plan] upstream error', upstream.status, detail.slice(0, 500))
      if (upstream.status === 401) {
        return fail(res, 500, 'bad_key', 'The planning service key was rejected.')
      }
      if (upstream.status === 429) {
        return fail(res, 429, 'upstream_rate_limited', 'The planning service is busy. Try again shortly.')
      }
      return fail(res, 502, 'upstream_error', 'The planning service could not complete this request.')
    }

    const data = await upstream.json()
    const text = (data?.content || [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim()

    if (!text) return fail(res, 502, 'empty_response', 'The planner returned nothing usable.')

    res.setHeader('X-RateLimit-Remaining', String(limit.remaining))
    return res.status(200).json({ text })
  } catch (err) {
    console.error('[api/plan]', err)
    return fail(res, 502, 'upstream_unreachable', 'Could not reach the planning service.')
  }
}
