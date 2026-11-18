// The profile sync's program on the server (the board-on-own-server spec's "Next step: syncing
// the Claude profiles"), run as the board's user by core/profile-sync/remote.ts over the local
// board's admin login: one op, its request the first frame on stdin, its answer in frames on
// stdout, both gzipped (adapters/profile-sync.ts). Nothing else is written to stdout.
//
//   profile-sync.ts scan     → {t:'manifest'}, the Manifest as its body
//   profile-sync.ts pack     → {t:'file', profile, from, to, merge, hash, found, cut, exec} and the file, …, {t:'end'}
//   profile-sync.ts apply    ← {t:'file', profile, to, merge, expect, cut, exec} and the file, …, {t:'end'}
//                            → {t:'progress', files, bytes}, …, {t:'done', created, install, skipped}
//   profile-sync.ts record   → {t:'done'}
//   profile-sync.ts dirs     → {t:'dirs', path, parent, home, entries, error}: the folders in a folder ('' its home)
//   profile-sync.ts mkdir    → {t:'dirs', …} of the folder it made (`name` in `path`)
//   profile-sync.ts exists   → {t:'exists', there}: whether each of `paths` is a folder here
//
// pack and apply take the groups the owner ticked (`allow`); each holds to them whatever the other
// side sends. A failure: {t:'error', message}, exit 1; what apply wrote before it is recorded all
// the same. A profile made by apply gets the board's hooks: the board's install action runs once,
// as on the server's install. The other side gone (its stdin cut short, its reader of stdout gone,
// or nothing from it for SYNC_IDLE_MS) is a failure too: the op ends and the process with it.
import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { createGunzip, type Gunzip } from 'node:zlib'
import { isRecord } from '../adapters/json-store.ts'
import { ROOT } from '../adapters/paths.ts'
import {
  type Frame,
  type FrameSink,
  frameSink,
  framesOf,
  openTarget,
  prepare,
  recordSynced,
  scanSide,
  sideProfiles,
} from '../adapters/profile-sync.ts'
import type { Move } from '../core/profile-sync/paths.ts'
import { type ProfilePlan, profileDir, type Same, ticksOf } from '../core/profile-sync/plan.ts'
import { type Allow, type CarryTo, fileGroup, historyFile } from '../core/profile-sync/secrets.ts'

/** What this program speaks: a request of another version is refused. */
export const SYNC_VERSION = 2

/**
 * How long an op waits for the other side to send anything (each piece of a file counts) before
 * it fails: a connection that dropped without closing ends the op instead of holding it. Generous,
 * as the computer sends while it reads its files.
 */
export const SYNC_IDLE_MS = 10 * 60_000

/** BOARD_SYNC_IDLE_MS (tests only, unset in production: the server's command runs this under env -i) when a whole number of ms, else SYNC_IDLE_MS. */
function idleMs(): number {
  const ms = Number(process.env.BOARD_SYNC_IDLE_MS)
  return Number.isInteger(ms) && ms > 0 ? ms : SYNC_IDLE_MS
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : [])
/** The groups ticked in a request: none but those said. */
const allowOf = (v: unknown): Allow => (isRecord(v) ? (v as Allow) : {})

/** This side: its home and system, and the board's install action (run once a profile was made). */
export interface Here {
  home: string
  platform: string
  install(dirs: readonly string[]): boolean
}

/** How this side sends to the other (its system and home in the request), from here. */
const carryTo = (here: Here, v: unknown): CarryTo | null =>
  isRecord(v) && typeof v.platform === 'string' && typeof v.home === 'string'
    ? { platform: v.platform, from: here.platform, fromHome: here.home, toHome: v.home }
    : null

async function scan(here: Here, out: FrameSink, req: Record<string, unknown>): Promise<void> {
  const m = await scanSide({
    home: here.home,
    platform: here.platform,
    peer: text(req.peer),
    to: carryTo(here, req.to),
    clones: true,
  })
  await out.send({ t: 'manifest' }, Buffer.from(JSON.stringify(m), 'utf8'))
}

async function pack(here: Here, out: FrameSink, req: Record<string, unknown>): Promise<void> {
  const profiles = new Map(sideProfiles(here.home).map(p => [p.name, p]))
  const to = carryTo(here, req.to)
  if (!to) throw new Error('pack: no target named')
  const allow = ticksOf(allowOf(req.allow))
  const ctx = { to, moves: list(req.moves) as unknown as Move[], allow }
  for (const item of list(req.items)) {
    // session history, a hook's or the status line's script not ticked never leaves, whoever asks
    const group = fileGroup(text(item.from))
    if ((historyFile(text(item.from)) && !allow.history) || (group !== null && !allow[group])) continue
    const p = profiles.get(text(item.profile))
    const ready = p ? prepare(p, text(item.from), ctx) : null
    await out.send(
      {
        t: 'file',
        profile: item.profile,
        from: item.from,
        to: item.to,
        merge: item.merge === true,
        gone: ready === null,
        hash: ready?.hash ?? null,
        found: ready?.found ?? {},
        cut: ready?.cut === true,
        exec: ready?.exec === true,
      },
      ready?.body ?? null,
    )
  }
  await out.send({ t: 'end' })
}

async function apply(
  here: Here,
  out: FrameSink,
  req: Record<string, unknown>,
  rest: AsyncGenerator<Frame>,
): Promise<void> {
  const target = openTarget({
    peer: text(req.peer),
    home: here.home,
    platform: here.platform,
    profiles: list(req.profiles) as unknown as ProfilePlan[],
    allow: ticksOf(allowOf(req.allow)),
  })
  let files = 0
  let bytes = 0
  let said = Date.now()
  let done: ReturnType<typeof target.finish>
  let install: boolean | null = null
  try {
    for (const s of list(req.same) as unknown as Same[]) target.same(s.profile, s.to, s.there)
    for (const f of list(req.forget)) target.forget(text(f.profile), text(f.to))
    let ended = false
    for await (const f of rest) {
      if (f.head.t === 'end') {
        ended = true
        break
      }
      if (f.head.t !== 'file') continue
      const why = target.write(text(f.head.profile), text(f.head.to), f.body, {
        merge: f.head.merge === true,
        expect: typeof f.head.expect === 'string' ? f.head.expect : null,
        cut: f.head.cut === true,
        exec: f.head.exec === true,
      })
      if (why === null) {
        files++
        bytes += f.body.length
      }
      if (Date.now() - said > 1000) {
        said = Date.now()
        await out.send({ t: 'progress', files, bytes })
      }
    }
    if (!ended) throw new Error('the files stopped before their end')
    // the deletions ticked, once every file has come
    for (const d of list(req.deletions))
      target.remove(text(d.profile), text(d.to), typeof d.expect === 'string' ? d.expect : null)
  } finally {
    // what was written is recorded, however the run ended: met again as the same, not as conflicts;
    // a profile made gets the board's hooks all the same
    done = target.finish()
    if (done.created.length) install = here.install(done.created.map(n => profileDir(here.home, n, here.platform)))
  }
  const { created, skipped } = done
  await out.send({ t: 'done', files, bytes, created, install, skipped })
}

/** The most folders a listing names. */
const MOST_FOLDERS = 2000
/** The most paths one `exists` asks about. */
const MOST_PATHS = 5000

/** The folders in a folder, for the owner's picker: what it holds that is a folder (a link to one too), the hidden ones last. */
export interface Folders {
  path: string
  /** '' at the top. */
  parent: string
  home: string
  entries: string[]
  /** denied: it cannot be read; missing: it is not there; notDir: it is no folder. */
  error: 'denied' | 'missing' | 'notDir' | null
}

const errorOf = (err: unknown): Folders['error'] => {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'EACCES' || code === 'EPERM' ? 'denied' : code === 'ENOTDIR' ? 'notDir' : 'missing'
}

/** A path a request names: absolute, '..' resolved; '' is the home. Null when it is not one. */
function pathOf(v: unknown, home: string): string | null {
  if (v === undefined || v === null || v === '') return home
  return typeof v === 'string' && !v.includes('\0') && isAbsolute(v) ? resolve(v) : null
}

export function foldersIn(path: string, home: string): Folders {
  const up = dirname(path)
  const at = { path, parent: up === path ? '' : up, home }
  try {
    const entries = readdirSync(path, { withFileTypes: true })
      .filter(e => {
        if (e.isDirectory()) return true
        if (!e.isSymbolicLink()) return false
        try {
          return statSync(join(path, e.name)).isDirectory()
        } catch {
          return false
        }
      })
      .map(e => e.name)
      .sort(
        (a, b) =>
          Number(a.startsWith('.')) - Number(b.startsWith('.')) ||
          a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
      )
    return { ...at, entries: entries.slice(0, MOST_FOLDERS), error: null }
  } catch (err) {
    return { ...at, entries: [], error: errorOf(err) }
  }
}

/** A new folder's name: one folder, no separator, not . or .. */
const nameOk = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.trim() === v &&
  v !== '' &&
  v !== '.' &&
  v !== '..' &&
  Buffer.byteLength(v) <= 255 &&
  !/[/\\\0]/.test(v)

/**
 * `input` read on into `into` while bytes keep coming: none for `ms` while it is open, and `into`
 * fails with it (the frame waited on fails); a read that fails fails it too. The timer keeps no
 * process alive.
 */
function failWhenQuiet(input: Readable, into: Gunzip, ms: number): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = (): void => clearTimeout(timer)
  const fail = (err: Error): void => {
    stop()
    input.unpipe(into)
    into.destroy(err)
  }
  const arm = (): void => {
    stop()
    timer = setTimeout(() => fail(new Error(`nothing came from the other side for ${ms} ms`)), ms)
    timer.unref()
  }
  arm()
  input.on('data', arm)
  input.on('error', fail)
  input.once('end', stop)
  input.once('close', stop)
  into.once('close', stop)
}

/** One op: its request and frames read from `input`, its answer written to `output`; the exit code. */
export async function serve(
  op: string,
  input: Readable,
  output: Writable,
  here: Here,
  idle: number = SYNC_IDLE_MS,
): Promise<number> {
  // the other side's reader of `output` gone (EPIPE): every send fails at once and nothing waits on
  // it (unheard, the error ended nothing: the op waited on gzip's end for ever)
  let lost = false
  const gone = new Promise<void>(resolve =>
    output.on('error', () => {
      lost = true
      resolve()
    }),
  )
  const out = frameSink(output, gone)
  const gunzip = createGunzip()
  const frames = framesOf(input.pipe(gunzip))
  failWhenQuiet(input, gunzip, idle)
  try {
    const first = await frames.next()
    const req = first.done ? null : first.value.head
    if (!req || req.op !== op || req.v !== SYNC_VERSION)
      throw new Error(`the board on this server speaks sync ${SYNC_VERSION}; it was asked ${String(req?.v)}`)
    if (op === 'scan') await scan(here, out, req)
    else if (op === 'pack') await pack(here, out, req)
    else if (op === 'apply') await apply(here, out, req, frames)
    else if (op === 'record') {
      recordSynced(
        text(req.peer),
        list(req.changes).map(c => ({
          profile: text(c.profile),
          rel: text(c.rel),
          hash: typeof c.hash === 'string' ? c.hash : null,
        })),
      )
      await out.send({ t: 'done' })
    } else if (op === 'dirs') {
      const path = pathOf(req.path, here.home)
      if (path === null) throw new Error('dirs: no absolute path')
      await out.send({ t: 'dirs', ...foldersIn(path, here.home) })
    } else if (op === 'mkdir') {
      const parent = pathOf(req.path, here.home)
      if (parent === null || !nameOk(req.name)) throw new Error('mkdir: no folder named')
      const made = join(parent, req.name)
      mkdirSync(made)
      await out.send({ t: 'dirs', ...foldersIn(made, here.home) })
    } else if (op === 'exists') {
      const paths = Array.isArray(req.paths) ? req.paths.slice(0, MOST_PATHS) : []
      const there = paths.map(p => {
        const path = typeof p === 'string' && p !== '' ? pathOf(p, here.home) : null
        try {
          return path !== null && statSync(path).isDirectory()
        } catch {
          return false
        }
      })
      await out.send({ t: 'exists', there })
    } else throw new Error(`no op ${op}`)
    await out.end()
    return lost ? 1 : 0
  } catch (err) {
    // said to the other side, unless it is gone
    try {
      await out.send({ t: 'error', message: err instanceof Error ? err.message : String(err) })
      await out.end()
    } catch {}
    return 1
  }
}

/**
 * The board's install action, as the board's user, once per profile the sync made, with
 * CLAUDE_CONFIG_DIR pointing at it: the install shows the profile its env points to, so its hooks
 * go in, whatever the board's config shows (a profile found anew is added hidden there).
 */
function installAction(dirs: readonly string[]): boolean {
  let ok = true
  for (const dir of dirs) {
    const r = Bun.spawnSync([process.execPath, join(ROOT, 'src', 'entrypoints', 'install.ts')], {
      cwd: ROOT,
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
      timeout: 5 * 60_000,
    })
    ok &&= r.exitCode === 0
  }
  return ok
}

// Not awaited at the top: Bun spins a core on a top-level await that never settles (one ran 18
// days so). 1 until the op ends well; a failed one ends the process at once, its stdin maybe open.
if (import.meta.main) {
  process.exitCode = 1
  void serve(
    process.argv[2] ?? '',
    process.stdin,
    process.stdout,
    { home: homedir(), platform: process.platform, install: installAction },
    idleMs(),
  ).then(code => {
    if (code === 0) process.exitCode = 0
    else process.exit(code)
  })
}
