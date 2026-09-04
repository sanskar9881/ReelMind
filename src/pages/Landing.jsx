import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'

const STEPS = [
  { n: '01', t: 'Drop your clips', d: 'Drag in phone footage, drone shots, screen recordings — anything. Everything stays on your machine.' },
  { n: '02', t: 'Describe the vibe', d: 'Type "fast energetic 60 sec travel montage" and let the planner cut, order and pace it.' },
  { n: '03', t: 'Render & download', d: 'A real MP4 is stitched in your browser with FFmpeg.wasm. No queue, no upload, no watermark.' },
]

const FEATURES = [
  { t: '100% in-browser', d: 'Video never leaves your device. FFmpeg compiled to WebAssembly does the encoding locally.' },
  { t: 'AI edit planning', d: 'Keyword-aware planner picks segment length, order, transitions and music mood from your prompt.' },
  { t: 'Mixed-source safe', d: 'Two-pass normalize means phone + drone + screen recordings concat cleanly every time.' },
  { t: 'Real metadata', d: 'Clips are probed locally for true duration, resolution and thumbnails before you cut.' },
  { t: 'Hallucination guard', d: 'Every plan is validated — unknown clips dropped, ranges clamped, micro-cuts removed.' },
  { t: 'Zero install', d: 'Open a URL and edit. Works on any modern Chromium or Firefox with cross-origin isolation.' },
]

const TIERS = [
  { name: 'Free', price: '$0', tag: 'forever', feats: ['720p exports', 'Up to 10 clips / project', 'Mock AI planner', 'Local render'], cta: 'Start editing' },
  { name: 'Creator', price: '$12', tag: 'per month', feats: ['1080p exports', 'Unlimited clips', 'Claude-powered planning', 'Music library', 'Priority core CDN'], cta: 'Go Creator', hot: true },
  { name: 'Studio', price: '$39', tag: 'per month', feats: ['4K exports', 'Team projects', 'Custom brand kits', 'API access', 'Dedicated support'], cta: 'Contact sales' },
]

const STATS = [
  ['60s', 'typical render'],
  ['0', 'bytes uploaded'],
  ['2-pass', 'normalize pipeline'],
  ['∞', 'projects'],
]

export default function Landing() {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className="lp">
      <style>{CSS}</style>

      <nav className={`lp-nav${scrolled ? ' is-scrolled' : ''}`}>
        <div className="lp-wrap lp-nav-inner">
          <div className="lp-logo">
            Reel<span>Mind</span>
          </div>
          <div className="lp-nav-links">
            <a href="#how">How it works</a>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
          </div>
          <Link to="/projects" className="lp-btn lp-btn-ghost lp-btn-sm lp-nav-projects">
            Projects
          </Link>
          <Link to="/editor" className="lp-btn lp-btn-sm">
            Open editor
          </Link>
        </div>
      </nav>

      <header className="lp-hero">
        <div className="lp-orb lp-orb-a" aria-hidden="true" />
        <div className="lp-orb lp-orb-b" aria-hidden="true" />
        <div className="lp-orb lp-orb-c" aria-hidden="true" />
        <div className="lp-grid-overlay" aria-hidden="true" />
        <div className="lp-wrap lp-hero-inner">
          <div className="lp-pill">AI vlog editor · runs entirely in your browser</div>
          <h1 className="lp-h1">
            Edit vlogs in 60 seconds.
            <br />
            <span className="lp-grad">Not 6 hours.</span>
          </h1>
          <p className="lp-sub">
            Drop your raw footage, describe the vibe, and ReelMind plans the cut and renders a
            finished MP4 locally with FFmpeg.wasm. Nothing is ever uploaded.
          </p>
          <div className="lp-cta-row">
            <Link to="/editor" className="lp-btn lp-btn-lg">
              Try in Browser
            </Link>
            <a href="#how" className="lp-btn lp-btn-ghost lp-btn-lg">
              See how it works
            </a>
          </div>
          <div className="lp-stats">
            {STATS.map(([v, l]) => (
              <div key={l} className="lp-stat">
                <div className="lp-stat-v">{v}</div>
                <div className="lp-stat-l">{l}</div>
              </div>
            ))}
          </div>
        </div>
      </header>

      <section id="how" className="lp-section">
        <div className="lp-wrap">
          <h2 className="lp-h2">Three steps. One browser tab.</h2>
          <div className="lp-steps">
            {STEPS.map((s) => (
              <div key={s.n} className="lp-step">
                <div className="lp-step-n">{s.n}</div>
                <h3>{s.t}</h3>
                <p>{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="features" className="lp-section lp-section-alt">
        <div className="lp-wrap">
          <h2 className="lp-h2">Built for real, messy footage.</h2>
          <div className="lp-features">
            {FEATURES.map((f) => (
              <div key={f.t} className="lp-feature">
                <div className="lp-feature-dot" aria-hidden="true" />
                <h3>{f.t}</h3>
                <p>{f.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="pricing" className="lp-section">
        <div className="lp-wrap">
          <h2 className="lp-h2">Simple pricing.</h2>
          <div className="lp-tiers">
            {TIERS.map((t) => (
              <div key={t.name} className={`lp-tier${t.hot ? ' is-hot' : ''}`}>
                {t.hot && <div className="lp-tier-badge">Most popular</div>}
                <div className="lp-tier-name">{t.name}</div>
                <div className="lp-tier-price">
                  {t.price} <span>/ {t.tag}</span>
                </div>
                <ul>
                  {t.feats.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
                <Link to="/editor" className={`lp-btn ${t.hot ? 'lp-btn-lg' : 'lp-btn-ghost lp-btn-lg'}`}>
                  {t.cta}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="lp-section lp-closing">
        <div className="lp-wrap lp-closing-inner">
          <h2 className="lp-h2">
            Your next upload is <span className="lp-grad">one prompt away.</span>
          </h2>
          <Link to="/editor" className="lp-btn lp-btn-lg">
            Open the editor
          </Link>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-wrap lp-footer-inner">
          <div className="lp-logo">
            Reel<span>Mind</span>
          </div>
          <div className="lp-footer-cols">
            <a href="#how">How it works</a>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <Link to="/editor">Editor</Link>
          </div>
          <div className="lp-footer-fine">© {new Date().getFullYear()} ReelMind. Everything local.</div>
        </div>
      </footer>
    </div>
  )
}

const CSS = `
.lp { --maxw: 1140px; overflow-x: clip; max-width: 100vw; }
.lp-wrap { max-width: var(--maxw); margin: 0 auto; padding: 0 clamp(var(--s4), 4vw, var(--s6)); }

.lp-nav { position: fixed; inset: 0 0 auto 0; z-index: 50; transition: background .3s, border-color .3s, backdrop-filter .3s; border-bottom: 1px solid transparent; }
.lp-nav.is-scrolled { background: rgba(5,5,10,.72); backdrop-filter: blur(14px); border-bottom-color: var(--border); }
.lp-nav-inner { display: flex; align-items: center; gap: clamp(var(--s2), 2vw, var(--s6)); min-height: 68px; }
.lp-logo { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 20px; letter-spacing: -.03em; }
.lp-logo span { background: linear-gradient(90deg, var(--cyan), var(--purple)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.lp-nav-links { display: flex; gap: var(--s6); margin-left: auto; margin-right: var(--s2); font-size: 14px; color: var(--muted); }
.lp-nav-links a:hover { color: var(--text); }

.lp-btn { display: inline-flex; align-items: center; justify-content: center; min-height: var(--tap); border-radius: var(--r-md); font-weight: 600; font-size: 14px;
  padding: var(--s3) var(--s4); border: 1px solid transparent; background: linear-gradient(90deg, var(--cyan), var(--purple)); color: #05050a;
  transition: transform .15s, box-shadow .15s, background .15s; white-space: nowrap; }
.lp-btn:hover { transform: translateY(-1px); box-shadow: 0 8px 30px -8px rgba(155,93,255,.6); }
.lp-btn-sm { padding: var(--s2) var(--s3); font-size: 13px; }
.lp-btn-lg { padding: var(--s4) var(--s6); font-size: 15px; border-radius: var(--r-lg); }
.lp-btn-ghost { background: transparent; color: var(--text); border-color: var(--border); }
.lp-btn-ghost:hover { border-color: var(--purple); box-shadow: none; }

.lp-hero { position: relative; padding: clamp(110px, 16vw, 168px) 0 clamp(56px, 9vw, 100px); overflow: hidden; }
.lp-hero-inner { position: relative; z-index: 2; text-align: center; }
.lp-orb { position: absolute; border-radius: 50%; filter: blur(90px); opacity: .5; z-index: 1; }
.lp-orb-a { width: min(480px, 90vw); height: min(480px, 90vw); background: var(--purple); top: -120px; left: -80px; animation: lp-float 17s ease-in-out infinite; }
.lp-orb-b { width: min(420px, 80vw); height: min(420px, 80vw); background: var(--cyan); top: 40px; right: -100px; opacity: .35; animation: lp-float 21s ease-in-out infinite reverse; }
.lp-orb-c { width: min(360px, 70vw); height: min(360px, 70vw); background: var(--pink); bottom: -160px; left: 40%; opacity: .28; animation: lp-float 25s ease-in-out infinite; }
@keyframes lp-float { 0%, 100% { transform: none; } 50% { transform: translate3d(3%, -4%, 0) scale(1.06); } }
/* Three blurred 480px orbs drifting behind text is exactly the motion this
   setting exists to stop. */
@media (prefers-reduced-motion: reduce) { .lp-orb { animation: none !important; } }
.lp-grid-overlay { position: absolute; inset: 0; z-index: 1; background-image: linear-gradient(var(--border) 1px, transparent 1px), linear-gradient(90deg, var(--border) 1px, transparent 1px); background-size: 56px 56px; mask-image: radial-gradient(circle at 50% 40%, #000 0%, transparent 70%); opacity: .35; }

.lp-pill { display: inline-block; font-size: clamp(11.5px, 2.6vw, 13px); color: var(--muted); border: 1px solid var(--border); background: var(--surface); border-radius: 999px; padding: var(--s2) var(--s4); margin-bottom: var(--s6); }
.lp-h1 { font-size: clamp(38px, 7vw, 76px); line-height: 1.03; font-weight: 800; }
.lp-grad { background: linear-gradient(90deg, var(--cyan), var(--purple) 55%, var(--pink)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.lp-sub { max-width: 620px; margin: var(--s6) auto 0; color: var(--muted); font-size: clamp(15px, 1.6vw, 18px); line-height: 1.6; }
.lp-cta-row { display: flex; gap: var(--s3); justify-content: center; margin-top: var(--s8); flex-wrap: wrap; }

.lp-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: var(--s3); margin-top: clamp(var(--s8), 6vw, 64px); max-width: 620px; margin-inline: auto; }
.lp-stat { border: 1px solid var(--border); background: var(--panel); border-radius: var(--r-lg); padding: var(--s4) var(--s3); text-align: center; }
.lp-stat-v { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 26px; }
.lp-stat-l { color: var(--muted); font-size: 13px; margin-top: 4px; }

.lp-section { padding: clamp(56px, 9vw, 96px) 0; }
.lp-section-alt { background: var(--panel); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.lp-h2 { font-size: clamp(26px, 4.5vw, 44px); text-align: center; margin-bottom: clamp(var(--s8), 5vw, 56px); }

.lp-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--s6); }
.lp-step { border: 1px solid var(--border); background: var(--surface); border-radius: var(--r-xl); padding: clamp(var(--s4), 3vw, var(--s8)); }
.lp-step-n { font-family: 'Syne', sans-serif; font-weight: 800; font-size: 30px; background: linear-gradient(90deg, var(--cyan), var(--purple)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.lp-step h3 { margin: 16px 0 10px; font-size: 20px; }
.lp-step p, .lp-feature p { color: var(--muted); font-size: 14.5px; line-height: 1.6; margin: 0; }

.lp-features { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--s6); }
.lp-feature { border: 1px solid var(--border); background: var(--surface); border-radius: var(--r-xl); padding: clamp(var(--s4), 3vw, var(--s6)); }
.lp-feature-dot { width: 12px; height: 12px; border-radius: 50%; background: linear-gradient(90deg, var(--cyan), var(--purple)); box-shadow: 0 0 16px var(--purple); }
.lp-feature h3 { margin: 16px 0 10px; font-size: 18px; }

.lp-tiers { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--s6); align-items: start; }
.lp-tier { position: relative; border: 1px solid var(--border); background: var(--surface); border-radius: var(--r-xl); padding: clamp(var(--s4), 3vw, var(--s8)); }
.lp-tier.is-hot { border-color: var(--purple); box-shadow: 0 0 0 1px var(--purple), 0 20px 60px -20px rgba(155,93,255,.45); transform: translateY(-8px); }
.lp-tier-badge { position: absolute; top: -12px; left: 50%; transform: translateX(-50%); font-size: 12px; font-weight: 600; padding: 5px 14px; border-radius: 999px; background: linear-gradient(90deg, var(--cyan), var(--purple)); color: #05050a; }
.lp-tier-name { font-family: 'Syne', sans-serif; font-weight: 700; font-size: 18px; }
.lp-tier-price { font-size: 34px; font-family: 'Syne', sans-serif; font-weight: 800; margin: 10px 0 20px; }
.lp-tier-price span { font-size: 14px; font-family: 'DM Sans', sans-serif; font-weight: 400; color: var(--muted); }
.lp-tier ul { list-style: none; padding: 0; margin: 0 0 26px; }
.lp-tier li { color: var(--muted); font-size: 14px; padding: 9px 0 9px 22px; position: relative; border-bottom: 1px solid var(--border); }
.lp-tier li:before { content: '→'; position: absolute; left: 0; color: var(--cyan); }
.lp-tier .lp-btn { width: 100%; }

.lp-closing { text-align: center; }
.lp-closing-inner .lp-h2 { margin-bottom: 34px; }

.lp-footer { border-top: 1px solid var(--border); padding: 44px 0; background: var(--panel); }
.lp-footer-inner { display: flex; align-items: center; gap: var(--s4); flex-wrap: wrap; }
.lp-footer-cols { display: flex; gap: var(--s4); font-size: 14px; color: var(--muted); flex-wrap: wrap; }
.lp-footer-cols a:hover { color: var(--text); }
.lp-footer-fine { margin-left: auto; color: var(--muted); font-size: 13px; }

/* 3 columns at desktop, 2 at tablet, 1 on a phone — the same ladder the
   projects grid uses, so the site reflows predictably. */
@media (max-width: 1023px) {
  .lp-nav-links { display: none; }
  .lp-steps, .lp-features { grid-template-columns: repeat(2, 1fr); }
  .lp-tiers { grid-template-columns: 1fr; }
  .lp-tier.is-hot { transform: none; }
}
@media (max-width: 767px) {
  .lp-steps, .lp-features { grid-template-columns: 1fr; }
  .lp-footer-inner { flex-direction: column; align-items: flex-start; }
  .lp-footer-fine { margin-left: 0; }
}
/* At 320px the logo plus two buttons will not fit on one line; the Projects
   link is reachable from the editor and the footer, so it is the one to drop. */
@media (max-width: 400px) {
  .lp-nav-projects { display: none; }
  .lp-cta-row .lp-btn { width: 100%; }
}
`
