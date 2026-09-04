// storage.js — project persistence in IndexedDB.
//
// Not localStorage: clip metadata + analysis + transcripts + style profiles blow
// past the ~5MB localStorage ceiling almost immediately (one 10-minute
// transcript with word timings is already hundreds of KB).
//
// THE HARD LIMIT: a File object cannot be persisted across sessions. The browser
// hands the page a live handle to the user's disk and revokes it on unload. So
// this stores everything EXPENSIVE — metadata, analysis, transcripts, plan,
// settings — and on reopen asks the user to re-select the same files. The
// analysis and transcripts are then restored without recomputing, which is the
// difference between a 20-minute reopen and a 10-second one.
//
// Where the File System Access API exists (Chrome/Edge) a FileSystemFileHandle
// is stored too — those ARE structured-cloneable — and re-selection is skipped
// entirely after a permission prompt. Feature-detected, never depended on.

const DB_NAME = 'reelmind'
const DB_VERSION = 2
const STORE_PROJECTS = 'projects'
const STORE_CLIPREFS = 'clipRefs'
const STORE_PROFILES = 'profiles'
const STORE_FEEDBACK = 'feedback'
const LEGACY_PROFILE_KEY = 'reelmind.styleProfiles'

let _db = null

function openDB() {
  if (_db) return Promise.resolve(_db)
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_CLIPREFS)) {
        const s = db.createObjectStore(STORE_CLIPREFS, { keyPath: 'id' })
        s.createIndex('projectId', 'projectId', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORE_PROFILES)) {
        db.createObjectStore(STORE_PROFILES, { keyPath: 'id' })
      }
      // v2: edit-quality signal. Local only — nothing is transmitted.
      if (!db.objectStoreNames.contains(STORE_FEEDBACK)) {
        const s = db.createObjectStore(STORE_FEEDBACK, { keyPath: 'planId' })
        s.createIndex('projectId', 'projectId', { unique: false })
      }
    }
    req.onsuccess = () => {
      _db = req.result
      resolve(_db)
    }
    req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'))
  })
}

function tx(store, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode)
        const s = t.objectStore(store)
        let out
        try {
          out = fn(s)
        } catch (e) {
          reject(e)
          return
        }
        t.oncomplete = () => resolve(out?.result !== undefined ? out.result : out)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error || new Error('transaction aborted'))
      }),
  )
}

const newId = (p) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

// ---- file handles (Chrome/Edge only) ------------------------------------

export const supportsFileHandles =
  typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function'

/** Re-grant read access to a stored handle, if the browser still allows it. */
export async function reacquireFile(handle) {
  if (!handle?.queryPermission) return null
  try {
    let perm = await handle.queryPermission({ mode: 'read' })
    if (perm === 'prompt') perm = await handle.requestPermission({ mode: 'read' })
    if (perm !== 'granted') return null
    return await handle.getFile()
  } catch {
    return null // handle went stale (file moved/deleted)
  }
}

// ---- projects -----------------------------------------------------------

/**
 * @param {object} project { id?, name, prompt, plan, settings }
 * @param {object[]} clips live clip objects — only metadata is written
 * @param {{analysis?:Map, transcripts?:object, handles?:object}} extras
 */
export async function saveProject(project, clips = [], extras = {}) {
  const id = project.id || newId('proj')
  const now = new Date().toISOString()
  const analysis = extras.analysis instanceof Map ? extras.analysis : new Map()
  const transcripts = extras.transcripts || {}
  const handles = extras.handles || {}

  const record = {
    id,
    name: project.name || 'Untitled project',
    createdAt: project.createdAt || now,
    updatedAt: now,
    prompt: project.prompt ?? '',
    plan: project.plan ?? null,
    settings: project.settings ?? {},
    clipCount: clips.length,
    thumb: clips.find((c) => c.thumb)?.thumb || null,
  }

  await tx(STORE_PROJECTS, 'readwrite', (s) => s.put(record))

  // Replace this project's clip refs wholesale — simpler and always consistent.
  await tx(STORE_CLIPREFS, 'readwrite', (s) => {
    const idx = s.index('projectId')
    const cursorReq = idx.openCursor(IDBKeyRange.only(id))
    cursorReq.onsuccess = () => {
      const cur = cursorReq.result
      if (cur) {
        cur.delete()
        cur.continue()
        return
      }
      // Analysis carries a `transcript` back-reference; strip it so the blob is
      // not written twice.
      for (const c of clips) {
        const a = analysis.get(c.id)
        const slim = a ? { ...a, transcript: undefined } : null
        s.put({
          id: `${id}:${c.id}`,
          projectId: id,
          clipId: c.id,
          name: c.name,
          size: c.size,
          duration: c.duration,
          width: c.width,
          height: c.height,
          thumb: c.thumb || null,
          analysis: slim,
          transcript: transcripts[c.id] || null,
          fileHandle: handles[c.id] || null,
        })
      }
    }
  })

  return record
}

export async function listProjects() {
  const all = await tx(STORE_PROJECTS, 'readonly', (s) => s.getAll())
  return (all || []).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

export async function loadProject(id) {
  const project = await tx(STORE_PROJECTS, 'readonly', (s) => s.get(id))
  if (!project) return null
  const db = await openDB()
  const clipRefs = await new Promise((resolve, reject) => {
    const t = db.transaction(STORE_CLIPREFS, 'readonly')
    const r = t.objectStore(STORE_CLIPREFS).index('projectId').getAll(IDBKeyRange.only(id))
    r.onsuccess = () => resolve(r.result || [])
    r.onerror = () => reject(r.error)
  })
  return { project, clipRefs }
}

export async function deleteProject(id) {
  await tx(STORE_PROJECTS, 'readwrite', (s) => s.delete(id))
  await tx(STORE_CLIPREFS, 'readwrite', (s) => {
    const cursorReq = s.index('projectId').openCursor(IDBKeyRange.only(id))
    cursorReq.onsuccess = () => {
      const cur = cursorReq.result
      if (cur) {
        cur.delete()
        cur.continue()
      }
    }
  })
}

export async function duplicateProject(id, name) {
  const loaded = await loadProject(id)
  if (!loaded) return null
  const newProjectId = newId('proj')
  const now = new Date().toISOString()
  const record = {
    ...loaded.project,
    id: newProjectId,
    name: name || `${loaded.project.name} (copy)`,
    createdAt: now,
    updatedAt: now,
  }
  await tx(STORE_PROJECTS, 'readwrite', (s) => s.put(record))
  await tx(STORE_CLIPREFS, 'readwrite', (s) => {
    for (const r of loaded.clipRefs) {
      s.put({ ...r, id: `${newProjectId}:${r.clipId}`, projectId: newProjectId })
    }
  })
  return record
}

// ---- reopen: matching re-selected files to stored metadata --------------

const sig = (name, size) => `${name}::${size}`

/**
 * Match user-re-selected Files against stored clip refs. Name + size is a strong
 * enough signature that re-probing (~1s per clip) can be skipped entirely, which
 * is the whole point — duration is checked only to break ties.
 *
 * @returns {{matched:{ref,file}[], missing:object[], extra:File[]}}
 */
export function matchFiles(files, clipRefs) {
  const pool = new Map()
  for (const f of Array.from(files || [])) {
    const k = sig(f.name, f.size)
    if (!pool.has(k)) pool.set(k, [])
    pool.get(k).push(f)
  }
  const matched = []
  const missing = []
  for (const ref of clipRefs) {
    const bucket = pool.get(sig(ref.name, ref.size))
    if (bucket?.length) matched.push({ ref, file: bucket.shift() })
    else missing.push(ref)
  }
  const extra = [...pool.values()].flat()
  return { matched, missing, extra }
}

/**
 * Rebuild live clip objects + analysis + transcripts from matched refs, with no
 * probing, analysis or transcription rerun.
 */
export function restoreFromMatches(matched) {
  const clips = []
  const analysis = new Map()
  const transcripts = {}
  for (const { ref, file } of matched) {
    const clip = {
      id: ref.clipId,
      file,
      url: URL.createObjectURL(file),
      name: ref.name,
      size: ref.size,
      duration: ref.duration,
      width: ref.width,
      height: ref.height,
      thumb: ref.thumb || '',
    }
    clips.push(clip)
    if (ref.transcript) transcripts[ref.clipId] = ref.transcript
    if (ref.analysis) {
      // Re-attach the transcript the save path stripped out.
      analysis.set(ref.clipId, { ...ref.analysis, transcript: ref.transcript || null })
    }
  }
  return { clips, analysis, transcripts }
}

/** Try to reopen every clip via stored file handles. Returns matches it got. */
export async function restoreViaHandles(clipRefs) {
  if (!supportsFileHandles) return { matched: [], missing: clipRefs }
  const matched = []
  const missing = []
  for (const ref of clipRefs) {
    const file = ref.fileHandle ? await reacquireFile(ref.fileHandle) : null
    if (file && file.size === ref.size) matched.push({ ref, file })
    else missing.push(ref)
  }
  return { matched, missing }
}

// ---- autosave -----------------------------------------------------------

/**
 * Debounced autosave. `onState` reports 'saving' | 'saved' | 'error' — and
 * 'saved' only fires after the write actually resolves, so the indicator never
 * claims something that has not happened.
 */
export function createAutosave(delay = 2000, onState = () => {}) {
  let timer = null
  let inflight = false
  let queued = null

  const run = async (args) => {
    inflight = true
    onState('saving')
    try {
      await saveProject(...args)
      onState(queued ? 'saving' : 'saved')
    } catch (err) {
      console.warn('[storage] autosave failed:', err?.message || err)
      onState('error')
    } finally {
      inflight = false
      if (queued) {
        const next = queued
        queued = null
        run(next)
      }
    }
  }

  return {
    schedule(...args) {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (inflight) queued = args
        else run(args)
      }, delay)
    },
    async flush(...args) {
      clearTimeout(timer)
      if (args.length) await run(args)
    },
    cancel() {
      clearTimeout(timer)
    },
  }
}

// ---- style profiles (migrated out of localStorage) ---------------------

export async function listProfilesDB() {
  const all = await tx(STORE_PROFILES, 'readonly', (s) => s.getAll())
  return all || []
}

export async function saveProfileDB(profile) {
  await tx(STORE_PROFILES, 'readwrite', (s) => s.put(profile))
  return profile
}

export async function deleteProfileDB(id) {
  await tx(STORE_PROFILES, 'readwrite', (s) => s.delete(id))
}

// Which profile is active is a single string — localStorage is the right size
// for it, and keeping it out of IndexedDB means it can be read synchronously.
const ACTIVE_PROFILE_KEY = 'reelmind.activeProfileId'

export function getActiveProfileId() {
  try {
    return localStorage.getItem(ACTIVE_PROFILE_KEY) || null
  } catch {
    return null
  }
}

export function setActiveProfileId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_PROFILE_KEY, id)
    else localStorage.removeItem(ACTIVE_PROFILE_KEY)
  } catch {
    /* private mode — active selection just will not persist */
  }
  return id
}

/**
 * One-time move of style profiles from localStorage into IndexedDB, then clear
 * the old key. Safe to call on every boot.
 */
export async function migrateLegacyProfiles() {
  let raw
  try {
    raw = localStorage.getItem(LEGACY_PROFILE_KEY)
  } catch {
    return { migrated: 0 }
  }
  if (!raw) return { migrated: 0 }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    localStorage.removeItem(LEGACY_PROFILE_KEY)
    return { migrated: 0 }
  }

  const profiles = parsed?.profiles || []
  let migrated = 0
  for (const p of profiles) {
    if (!p?.id) continue
    try {
      await saveProfileDB(p)
      migrated++
    } catch {
      /* keep going — a single bad record must not block the rest */
    }
  }
  // Only clear the legacy key once every profile is safely in IndexedDB —
  // clearing it while the reader still pointed at localStorage would have made
  // a user's profiles silently vanish.
  if (migrated === profiles.length) {
    if (parsed?.activeId && !getActiveProfileId()) setActiveProfileId(parsed.activeId)
    try {
      localStorage.removeItem(LEGACY_PROFILE_KEY)
    } catch {
      /* ignore */
    }
  }
  if (migrated) console.info(`[storage] migrated ${migrated} style profile(s) from localStorage`)
  return { migrated, activeId: parsed?.activeId ?? null }
}

// ---- edit-quality signal (local only, never transmitted) ---------------
//
// The pipeline is verified; the EDITS are not. A rating alone is too coarse —
// what actually says whether the planner is good is how much the user had to
// fix afterwards. Corrections per edit is the honest metric, and it is the raw
// material for improving mockPlan and the Claude prompt.

/**
 * Record or update the signal for one generated plan.
 * @param {object} entry { planId, projectId, rating?, prompt, profileName, engine,
 *   segmentCount, corrections?, sampledPrompt? }
 */
export async function saveFeedback(entry) {
  if (!entry?.planId) return null
  const existing = await tx(STORE_FEEDBACK, 'readonly', (s) => s.get(entry.planId))
  const record = {
    corrections: [],
    createdAt: new Date().toISOString(),
    ...(existing || {}),
    ...entry,
    updatedAt: new Date().toISOString(),
  }
  await tx(STORE_FEEDBACK, 'readwrite', (s) => s.put(record))
  return record
}

/** Append one correction to a plan's record, creating it if needed. */
export async function recordCorrection(planId, correction, seed = {}) {
  if (!planId) return null
  const existing = await tx(STORE_FEEDBACK, 'readonly', (s) => s.get(planId))
  const record = {
    planId,
    corrections: [],
    createdAt: new Date().toISOString(),
    ...(existing || seed),
    ...(existing ? {} : seed),
  }
  record.corrections = [
    ...(record.corrections || []),
    { ...correction, at: new Date().toISOString() },
  ]
  record.updatedAt = new Date().toISOString()
  await tx(STORE_FEEDBACK, 'readwrite', (s) => s.put(record))
  return record
}

export async function listFeedback() {
  const all = await tx(STORE_FEEDBACK, 'readonly', (s) => s.getAll())
  return (all || []).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
}

export async function clearFeedback() {
  await tx(STORE_FEEDBACK, 'readwrite', (s) => s.clear())
}

/** True when IndexedDB is usable at all (private modes can refuse). */
export async function storageAvailable() {
  try {
    await openDB()
    return true
  } catch {
    return false
  }
}
