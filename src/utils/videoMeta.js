// videoMeta.js — read REAL metadata from a local video File. No uploads.

let _uid = 0
const nextId = () => `clip_${Date.now().toString(36)}_${(_uid++).toString(36)}`

export function fmtTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function fmtSize(bytes) {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const val = bytes / Math.pow(1024, i)
  return `${val >= 100 || i === 0 ? Math.round(val) : val.toFixed(1)} ${units[i]}`
}

/**
 * Probe a single video File locally.
 * Loads it into a detached <video>, reads duration/dimensions, grabs a thumbnail.
 * Rejects with a readable, file-named message on error or 15s timeout.
 * @param {File} file
 * @returns {Promise<{id,file,url,name,size,duration,width,height,thumb}>}
 */
export function probeVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true
    video.crossOrigin = 'anonymous'
    video.src = url

    let done = false
    const cleanup = () => {
      video.removeAttribute('src')
      video.load()
    }

    const fail = (msg) => {
      if (done) return
      done = true
      clearTimeout(timer)
      cleanup()
      URL.revokeObjectURL(url)
      reject(new Error(msg))
    }

    const timer = setTimeout(
      () => fail(`Timed out reading "${file.name}" (15s). The codec may be unsupported in this browser.`),
      15000,
    )

    video.onerror = () => {
      const code = video.error && video.error.code
      fail(`Could not decode "${file.name}"${code ? ` (media error ${code})` : ''}. Unsupported codec or corrupt file.`)
    }

    video.onloadedmetadata = () => {
      const width = video.videoWidth
      const height = video.videoHeight
      if (!width || !height) {
        fail(`"${file.name}" has no readable video track (dimensions missing).`)
        return
      }

      // Grab the thumbnail frame and resolve, given a known-good duration.
      const proceed = (duration) => {
        if (done) return
        if (!isFinite(duration) || duration <= 0) {
          fail(`"${file.name}" still reports a non-finite duration — cannot use it.`)
          return
        }

        const seekTo = Math.min(duration * 0.1, 2)

        video.onseeked = () => {
          if (done) return
          let thumb = ''
          try {
            const cw = 160
            const ch = Math.max(1, Math.round((cw * height) / width))
            const canvas = document.createElement('canvas')
            canvas.width = cw
            canvas.height = ch
            const ctx = canvas.getContext('2d')
            ctx.drawImage(video, 0, 0, cw, ch)
            thumb = canvas.toDataURL('image/jpeg', 0.6)
          } catch {
            thumb = '' // tainted canvas or draw failure — not fatal
          }
          done = true
          clearTimeout(timer)
          cleanup()
          resolve({
            id: nextId(),
            file,
            url,
            name: file.name,
            size: file.size,
            duration,
            width,
            height,
            thumb,
          })
        }

        try {
          video.currentTime = seekTo
        } catch {
          fail(`Could not seek within "${file.name}".`)
        }
      }

      // MediaRecorder WebM reports duration: Infinity until the element is
      // seeked past the end. Force it, read the real duration on the next
      // timeupdate, rewind, then carry on.
      if (!isFinite(video.duration)) {
        const onTimeUpdate = () => {
          video.removeEventListener('timeupdate', onTimeUpdate)
          const real = video.duration
          const afterRewind = () => {
            video.removeEventListener('seeked', afterRewind)
            proceed(real)
          }
          video.addEventListener('seeked', afterRewind)
          try {
            video.currentTime = 0
          } catch {
            proceed(real)
          }
        }
        video.addEventListener('timeupdate', onTimeUpdate)
        try {
          video.currentTime = 1e101
        } catch {
          fail(`Could not resolve the duration of "${file.name}".`)
        }
      } else {
        proceed(video.duration)
      }
    }
  })
}

/**
 * Probe many files. Filters to video/* types, probes each independently so one
 * bad file doesn't kill the batch.
 * @param {FileList|File[]} fileList
 * @returns {Promise<{clips: object[], errors: {name: string, message: string}[]}>}
 */
export async function probeAll(fileList) {
  const files = Array.from(fileList || []).filter((f) => f.type.startsWith('video/'))
  const clips = []
  const errors = []
  // Sequential, not Promise.all — decoding several videos at once blows the
  // browser memory ceiling. One bad file still doesn't kill the batch.
  for (const f of files) {
    try {
      clips.push(await probeVideo(f))
    } catch (err) {
      errors.push({ name: f.name, message: err.message })
    }
  }
  return { clips, errors }
}
