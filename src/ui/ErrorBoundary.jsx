import { Component } from 'react'

/**
 * Error boundary for the Editor.
 *
 * The failure this exists for is specific and expensive: a user transcribes six
 * clips over twenty minutes, a render-time exception escapes a component, React
 * unmounts the tree, and they are left looking at a white page with all of that
 * work apparently gone. It is not gone — the project autosaves to IndexedDB on
 * every meaningful change — so the recovery is simply to say so and reload.
 *
 * Deliberately a class: React has no hook equivalent of componentDidCatch.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, info: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // The console trace is what a bug report needs; the panel is what the user
    // needs. Both, always.
    console.error('[ErrorBoundary] Editor crashed:', error, info)
    this.setState({ info })
    this.props.onError?.(error, info)
  }

  render() {
    const { error, info } = this.state
    if (!error) return this.props.children

    const detail = [error?.stack || String(error), info?.componentStack].filter(Boolean).join('\n\n')

    return (
      <div className="eb-wrap">
        <div className="eb-card">
          <h1 className="eb-title">The editor hit an error</h1>
          <p className="eb-lead">
            Your project is saved. ReelMind writes every change to this browser as you work —
            clips, transcripts, struck lines and the plan — so reloading picks up where you
            left off. Footage itself never leaves your machine, so you may be asked to
            re-select the files.
          </p>

          <p className="eb-msg">{error?.message || String(error)}</p>

          <div className="eb-actions">
            <button className="eb-btn is-primary" onClick={() => window.location.reload()}>
              Reload and restore project
            </button>
            <button className="eb-btn" onClick={() => this.setState({ error: null, info: null })}>
              Try to continue
            </button>
            <button
              className="eb-btn"
              onClick={() => navigator.clipboard?.writeText(detail).catch(() => {})}
            >
              Copy error details
            </button>
          </div>

          <details className="eb-details">
            <summary>Technical detail</summary>
            <pre>{detail}</pre>
          </details>

          <p className="eb-note">
            “Try to continue” re-renders the same component that just failed. If it crashes
            again immediately, reload — that path is the reliable one.
          </p>
        </div>

        <style>{`
          .eb-wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg, #05050A); color: var(--text, #EDEDFF); }
          .eb-card { max-width: 620px; width: 100%; background: var(--panel, #0B0B14); border: 1px solid var(--border, #23233a); border-left: 3px solid var(--pink, #FF2566); border-radius: 14px; padding: 24px; }
          .eb-title { font-size: 20px; margin-bottom: 10px; }
          .eb-lead { font-size: 13.5px; line-height: 1.6; color: var(--muted, #8484C0); }
          .eb-msg { margin-top: 14px; padding: 10px 12px; background: rgba(255,37,102,.09); border: 1px solid rgba(255,37,102,.35); border-radius: 8px; font-family: ui-monospace, monospace; font-size: 12px; word-break: break-word; }
          .eb-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
          .eb-btn { min-height: 40px; padding: 0 14px; border-radius: 9px; border: 1px solid var(--border, #23233a); background: var(--surface, #12121f); color: inherit; font-weight: 600; font-size: 13px; cursor: pointer; }
          .eb-btn.is-primary { background: var(--cyan, #09F6FF); border-color: var(--cyan, #09F6FF); color: #04040A; }
          .eb-details { margin-top: 16px; font-size: 12px; color: var(--muted, #8484C0); }
          .eb-details pre { margin-top: 8px; padding: 10px; max-height: 240px; overflow: auto; background: var(--bg, #05050A); border: 1px solid var(--border, #23233a); border-radius: 8px; font-size: 11px; line-height: 1.5; white-space: pre-wrap; }
          .eb-note { margin-top: 14px; font-size: 11.5px; color: var(--muted, #8484C0); font-style: italic; }
        `}</style>
      </div>
    )
  }
}
