// dsh-rewind-file — restore workspace files when dsh rewinds a session.
//
// The gap this plugin fills: dsh's /rewind (and double-Esc) rewinds the
// *conversation* only — it forks the session back to an earlier message but
// leaves the *files on disk* exactly where they were. This plugin closes that
// gap with opencode's undo/redo mechanism, wired into the rewind itself (no
// new commands):
//
//   1. A dedicated side bare-git repo per workspace (never touches the user's
//      repo / history / index), under $DSH_HOME/rewind-file/<key>/repo.git.
//   2. `git add --all` + `git write-tree` → a content-addressed tree hash that
//      snapshots the whole worktree (tracked AND untracked, .gitignore-aware).
//   3. A snapshot is captured at every `step/end`, keyed by the step's seq.
//   4. When the harness creates a fork/rewind child session (`session/created`
//      with `header.parentSession` + `header.seedLength`), the plugin restores
//      the files to the newest snapshot at or before that boundary — exactly
//      opencode's `revert(patches)` semantics (a true rewind deletes files
//      created after the boundary).
//
// Pure-ESM, zero dependencies, no host storage requirement: snapshot trees
// live in git objects, and the seq→tree index lives in a small JSON file next
// to the repo. Mounts on any profile (tui / web / headless).

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-rewind-file'
export const inject = []

const PLUGIN_NAME = 'dsh-rewind-file'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
  enabled: true,
  gitBin: 'git',
  // Empty → $DSH_HOME/rewind-file (fallback ~/.dsh/rewind-file).
  snapshotDir: '',
  excludeGlobs: ['node_modules', '.git', '.dsh', 'dist', 'build'],
  maxSnapshots: 500,
})

function resolveConfig(config = {}) {
  const source = config && typeof config === 'object' ? config : {}
  return {
    ...DEFAULTS,
    ...source,
    excludeGlobs: Array.isArray(source.excludeGlobs) ? source.excludeGlobs : DEFAULTS.excludeGlobs,
  }
}

// ---------------------------------------------------------------------------
// Workspace keys + snapshot locations
// ---------------------------------------------------------------------------

function workspaceKeyOf(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return ''
  const resolved = path.resolve(cwd)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/** Stable 16-hex workspace id (matches dsh's own rewind/…/<16-hex> convention). */
function workspaceId(key) {
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)
}

function snapshotRoot(dshHome = process.env.DSH_HOME) {
  const home = dshHome ?? path.join(os.homedir(), '.dsh')
  return path.join(home, 'rewind-file')
}

function resolveSnapshotDir(snapshotDir) {
  if (snapshotDir) {
    const base = process.env.DSH_HOME ?? process.cwd()
    return path.isAbsolute(snapshotDir) ? path.normalize(snapshotDir) : path.resolve(base, snapshotDir)
  }
  return snapshotRoot()
}

// ---------------------------------------------------------------------------
// Per-workspace side bare-git repo (opencode's Snapshot service, adapted)
// ---------------------------------------------------------------------------

/** Whitelisted git verbs — a runtime assertion keeps this provider non-destructive. */
const ALLOWED_VERBS = new Set([
  'init', 'config', 'rev-parse', 'add', 'write-tree', 'diff', 'diff-tree',
  'ls-tree', 'ls-files', 'checkout', 'checkout-index', 'read-tree', 'status',
])

const GIT_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
})

function runGit(gitBin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...GIT_ENV },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += String(c) })
    child.stderr.on('data', (c) => { stderr += String(c) })
    child.on('error', (error) => reject(error))
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }))
  })
}

class WorkspaceRepo {
  constructor(cwd, gitBin, snapshotDir) {
    this.cwd = cwd
    this.key = workspaceKeyOf(cwd)
    this.id = workspaceId(this.key)
    this.gitBin = gitBin
    this.root = resolveSnapshotDir(snapshotDir)
    this.gitdir = path.join(this.root, this.id, 'repo.git')
    this.chain = Promise.resolve()
    this.ready = null
  }

  async run(args) {
    const verb = args[0] ?? ''
    if (!ALLOWED_VERBS.has(verb)) {
      throw new Error(`rewind-file refuses to run forbidden git verb ${JSON.stringify(verb)}`)
    }
    return await runGit(this.gitBin, ['--git-dir=' + this.gitdir, '--work-tree=' + this.cwd, ...args])
  }

  async init() {
    if (this.ready !== null) return this.ready
    // Run init on its own promise (NOT chained on this.chain) — chaining here
    // would deadlock, because track()'s locked fn awaits init() while this.chain
    // already contains track()'s own completion.
    this.ready = (async () => {
      fs.mkdirSync(this.root, { recursive: true })
      const gitdir = this.gitdir
      if (!fs.existsSync(path.join(gitdir, 'HEAD'))) {
        fs.mkdirSync(gitdir, { recursive: true })
        await runGit(this.gitBin, ['init', '--bare', gitdir])
      }
      for (const [k, v] of [
        ['core.autocrlf', 'false'],
        ['core.longpaths', 'true'],
        ['core.symlinks', 'true'],
        ['core.fsmonitor', 'false'],
        ['core.quotepath', 'false'],
      ]) {
        await runGit(this.gitBin, ['--git-dir=' + gitdir, 'config', k, v])
      }
      const info = path.join(gitdir, 'info')
      fs.mkdirSync(info, { recursive: true })
      fs.writeFileSync(
        path.join(info, 'exclude'),
        '# dsh-rewind-file excludes\n' + DEFAULTS.excludeGlobs.map((g) => String(g).replace(/\\/g, '/')).join('\n') + '\n',
      )
    })()
    return this.ready
  }

  locked(fn) {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** opencode `track()`: stage everything, return a content-addressed tree hash. */
  track() {
    return this.locked(async () => {
      await this.init()
      await this.run(['add', '--all'])
      const out = await this.run(['write-tree'])
      const tree = out.stdout.trim()
      if (tree === '') throw new Error('git write-tree produced an empty tree')
      return tree
    })
  }

  /** opencode `patch()`: files changed relative to a tree (after re-staging). */
  async changedFiles(tree) {
    await this.run(['add', '--all'])
    const out = await this.run(['diff', '--cached', '--name-only', tree, '--'])
    return out.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
  }

  /** opencode `revert()`: per-file checkout; delete files created after the tree. */
  async revertFiles(tree, files) {
    const restored = []
    const deleted = []
    for (const file of files) {
      const rel = file.replace(/\\/g, '/')
      const has = await this.run(['ls-tree', tree, '--', rel])
      if (has.stdout.trim() !== '') {
        const ck = await this.run(['checkout', tree, '--', rel])
        if (ck.code !== 0) {
          throw new Error(`git checkout ${rel} failed: ${(ck.stderr || ck.stdout).trim()}`)
        }
        restored.push(rel)
      } else {
        // Not present at the snapshot → created after it; delete.
        try {
          fs.rmSync(path.join(this.cwd, rel), { force: true, recursive: false })
          deleted.push(rel)
        } catch (error) {
          throw new Error(`failed to delete ${rel}: ${error.message}`)
        }
      }
    }
    return { restored, deleted }
  }

  /** Restore the whole worktree to `tree` (per-file revert incl. deletion). */
  async restore(tree) {
    const files = await this.changedFiles(tree)
    return await this.revertFiles(tree, files)
  }
}

// ---------------------------------------------------------------------------
// Persistent seq→tree index (small JSON file; git objects hold the content)
// ---------------------------------------------------------------------------

function loadIndex(repo) {
  try {
    const raw = fs.readFileSync(path.join(repo.root, repo.id, 'index.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
      return parsed
    }
  } catch { /* missing/corrupt → fresh */ }
  return { version: 1, sessions: {} }
}

function saveIndex(repo, index) {
  try {
    fs.mkdirSync(path.join(repo.root, repo.id), { recursive: true })
    const file = path.join(repo.root, repo.id, 'index.json')
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2))
    fs.renameSync(tmp, file)
    return undefined
  } catch (error) {
    return error
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export async function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  if (resolved.enabled === false) return

  const logger = ctx.logger(PLUGIN_NAME)
  const repos = new Map() // workspaceKey -> WorkspaceRepo
  const indexes = new Map() // workspaceKey -> index
  const states = new Map() // sessionId -> { snapshots, lastTree }

  const repoFor = (cwd) => {
    const key = workspaceKeyOf(cwd)
    let repo = repos.get(key)
    if (repo === undefined) {
      repo = new WorkspaceRepo(cwd, resolved.gitBin, resolved.snapshotDir)
      repos.set(key, repo)
    }
    return repo
  }

  const indexFor = (repo) => {
    let index = indexes.get(repo.key)
    if (index === undefined) {
      index = loadIndex(repo)
      indexes.set(repo.key, index)
    }
    return index
  }

  function ensureState(session) {
    const id = session?.id
    if (typeof id !== 'string' || id === '') return undefined
    let state = states.get(id)
    if (state === undefined) {
      state = { snapshots: [], lastTree: undefined }
      states.set(id, state)
    }
    return state
  }

  function persist(repo, sessionId, state) {
    const index = indexFor(repo)
    index.sessions[sessionId] = { snapshots: state.snapshots.map((s) => ({ ...s })) }
    const err = saveIndex(repo, index)
    if (err) logger.debug(`index save failed: ${err.message}`)
  }

  /** Capture a post-step snapshot (the durable file state after a step). */
  async function capturePostStep(session, event) {
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return
    const state = ensureState(session)
    if (state === undefined) return
    try {
      const repo = repoFor(cwd)
      const tree = await repo.track()
      if (tree === state.lastTree) return // unchanged → dedup
      state.lastTree = tree
      state.snapshots.push({
        seq: event.seq,
        turn: event.data?.turn,
        step: event.data?.step,
        tree,
        time: Date.now(),
      })
      if (state.snapshots.length > resolved.maxSnapshots) {
        state.snapshots.splice(0, state.snapshots.length - resolved.maxSnapshots)
      }
      persist(repo, session.id, state)
      logger.debug(`snapshot ${tree.slice(0, 12)} (step/end seq ${event.seq})`)
    } catch (error) {
      logger.warn(`post-step snapshot failed (seq ${event?.seq}): ${error.message}`)
    }
  }

  /**
   * Restore files when a fork/rewind child session is created. The harness
   * publishes the child via `session/created` with `header.parentSession`
   * (the source session id) and `header.seedLength` (the fork boundary) — the
   * rewind point. Restore the worktree to the newest snapshot at/before it.
   */
  async function restoreOnRewind(child) {
    const parentId = child?.header?.parentSession
    const seedLength = child?.header?.seedLength
    if (typeof parentId !== 'string' || typeof seedLength !== 'number') return // not a fork/rewind
    const cwd = child?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return

    // Source snapshots: in-memory first, persisted index as fallback.
    let snapshots = states.get(parentId)?.snapshots
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      snapshots = indexFor(repoFor(cwd)).sessions?.[parentId]?.snapshots
    }
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
      logger.debug(`rewind: no snapshots for source session ${parentId} — nothing to restore`)
      return
    }

    const target = [...snapshots].reverse().find((s) => s.seq <= seedLength)
    if (target === undefined) {
      logger.debug(`rewind: no snapshot at or before boundary seq ${seedLength} — nothing to restore`)
      return
    }

    const repo = repoFor(cwd)
    try {
      const r = await repo.restore(target.tree)
      logger.info(`rewind: restored files to snapshot ${target.tree.slice(0, 12)} (step/end seq ${target.seq} ≤ boundary ${seedLength}); ${r.restored.length} restored, ${r.deleted.length} created-after deleted`)
    } catch (error) {
      logger.warn(`rewind: file restore failed (boundary seq ${seedLength}): ${error.message}`)
    }
  }

  // Capture the durable file state at the end of every assistant step.
  ctx.on('session/event', (session, event) => {
    if (event?.type === 'step/end') {
      void capturePostStep(session, event)
    }
  })

  // A fork/rewind publishes a child session; restore the files to its boundary.
  ctx.on('session/created', (session) => {
    void restoreOnRewind(session)
  })
}
