// The board's own server's state now (GET /api/system, server/routes/system.ts; the head's chip and
// Settings → Server…): Linux's /proc read when someone asks, never on a timer. An answer is kept
// for CACHE_MS, so the chip and the panel asking together read once; the reading before is kept
// for CPU's deltas (the machine's and each process's), and with none, or one too old to say what
// is happening now, two are taken PRIME_MS apart. The disks are statfs'd with a time limit (a hung
// network mount answers nothing); the GPU only where nvidia-smi is (looked for once). Processes:
// every /proc/<pid>/stat for the top lists, then the status, command line and environment of the
// few shown, for their user and what the board knows of them (core/system-state.ts processLabel).
// Made only on the board's own server (server/app.ts): on a PC nothing of it runs. The parsing is
// core/system-state.ts.
import { readdirSync, readFileSync, statfs } from 'node:fs'
import { hostname } from 'node:os'
import { run } from '../adapters/process.ts'
import {
  argvOf,
  type CpuTimes,
  cpuUsage,
  diskSizes,
  envValue,
  type LabelContext,
  type ProcSample,
  parseCpuTimes,
  parseLoadavg,
  parseMeminfo,
  parseMounts,
  parseNvidiaSmi,
  parsePasswd,
  parseProcStat,
  parseProcStatus,
  parseUptime,
  processLabel,
  type SystemDisk,
  type SystemProcess,
  type SystemView,
  shortCommand,
  TOP_N,
  tickMap,
  topProcesses,
  xvncDesktop,
} from '../core/system-state.ts'

/** An answer is kept this long: the chip and the panel asking at once read /proc once. */
export const CACHE_MS = 1500
/** With no reading before (or one too old), the two readings CPU is measured between are this far apart. */
export const PRIME_MS = 250
/** A reading before older than this says nothing of now: two are taken again. */
export const STALE_MS = 15_000
/** A disk's statfs that takes longer is left out (a hung network mount). */
export const STATFS_MS = 1000
/** nvidia-smi's time limit. */
export const GPU_MS = 2000
/** The user names (/etc/passwd) are read again after this long. */
const USERS_MS = 60_000

/** The files the reader reads; real ones by default, fixtures in tests. */
export interface SystemFiles {
  /** A file's text; null when it cannot be read (gone, refused). */
  read(path: string): string | null
  /** A folder's names; [] when it cannot be read. */
  list(dir: string): string[]
  /** A filesystem's sizes; null when it cannot say. */
  statfs(path: string): Promise<{ total: number; used: number; available: number } | null>
}

/** A board session, as the labels need it. */
export interface SystemSession {
  key: string
  pane: string | null
  name: string
  sleeping?: boolean | undefined
}

export interface SystemStateOptions {
  /** The board's sessions now (board.items()). */
  sessions(): readonly SystemSession[]
  files?: SystemFiles
  /** nvidia-smi's query's output; null where there is no nvidia-smi (or it failed). */
  gpu?: () => Promise<string | null>
  /** The board's own process. */
  boardPid?: number
  host?: () => string
  now?: () => number
  wait?: (ms: number) => Promise<void>
}

export interface SystemState {
  read(): Promise<SystemView>
}

const textOf = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const statfsOf = (path: string): Promise<{ total: number; used: number; available: number } | null> =>
  new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), STATFS_MS)
    statfs(path, (err, s) => {
      clearTimeout(timer)
      resolve(err ? null : diskSizes(s))
    })
  })

export const realFiles: SystemFiles = {
  read: textOf,
  list: dir => {
    try {
      return readdirSync(dir)
    } catch {
      return []
    }
  },
  statfs: statfsOf,
}

/** nvidia-smi's query, where it is: looked for once; without it nothing is run again. */
export function nvidiaSmi(
  which: (name: string) => string | null = name => Bun.which(name),
): () => Promise<string | null> {
  let bin: string | null | undefined
  return async () => {
    if (bin === undefined) bin = which('nvidia-smi')
    if (!bin) return null
    const r = await run(
      bin,
      ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'],
      { timeout: GPU_MS },
    )
    return r.error || r.code !== 0 ? null : r.stdout
  }
}

/** One reading: when, the CPUs' times and every process's stat. */
interface Sample {
  at: number
  cpu: CpuTimes | null
  procs: ProcSample[]
}

const NUMERIC = /^\d+$/

export function createSystemState(o: SystemStateOptions): SystemState {
  const files = o.files ?? realFiles
  const now = o.now ?? Date.now
  const wait = o.wait ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const boardPid = o.boardPid ?? process.pid
  const gpu = o.gpu ?? nvidiaSmi()
  let last: SystemView | null = null
  let pending: Promise<SystemView> | null = null
  let before: { at: number; cpu: CpuTimes | null; ticks: Map<string, number> } | null = null
  let users: { at: number; names: Map<number, string> } | null = null

  const take = (): Sample => ({
    at: now(),
    cpu: parseCpuTimes(files.read('/proc/stat')),
    procs: files
      .list('/proc')
      .filter(name => NUMERIC.test(name))
      .flatMap(pid => parseProcStat(files.read(`/proc/${pid}/stat`)) ?? []),
  })

  const userOf = (uid: number | null): string => {
    if (uid === null) return ''
    if (!users || now() - users.at > USERS_MS) users = { at: now(), names: parsePasswd(files.read('/etc/passwd')) }
    return users.names.get(uid) ?? String(uid)
  }

  /** The sessions' names by pane, and the desktops' by display (each Xvnc's session key), for the labels. */
  const context = (procs: readonly ProcSample[]): LabelContext => {
    const sessions = o.sessions()
    const nameOf = new Map(sessions.map(s => [s.key, s.name]))
    const panes = new Map(sessions.flatMap(s => (s.pane && !s.sleeping ? [[s.pane, s.name] as const] : [])))
    const displays = new Map<number, string>()
    for (const p of procs) {
      if (p.comm !== 'Xvnc') continue
      const desk = xvncDesktop(argvOf(files.read(`/proc/${p.pid}/cmdline`)))
      const name = desk?.key ? nameOf.get(desk.key) : undefined
      if (desk && name) displays.set(desk.display, name)
    }
    return { boardPid, panes, displays }
  }

  /** A process shown: its user, its command line, what the board knows of it. */
  const shown = (p: ProcSample, cpu: number | null, ctx: () => LabelContext): SystemProcess => {
    const status = parseProcStatus(files.read(`/proc/${p.pid}/status`))
    const argv = argvOf(files.read(`/proc/${p.pid}/cmdline`))
    const environ = files.read(`/proc/${p.pid}/environ`)
    const label = processLabel(
      {
        pid: p.pid,
        comm: p.comm,
        argv,
        pane: envValue(environ, 'HERDR_PANE_ID'),
        display: envValue(environ, 'DISPLAY'),
      },
      ctx(),
    )
    return {
      pid: p.pid,
      name: p.comm,
      command: shortCommand(argv, p.comm),
      user: userOf(status.uid),
      cpu,
      rss: status.rss ?? 0,
      ...(label && { label }),
    }
  }

  async function disks(): Promise<SystemDisk[]> {
    const mounts = parseMounts(files.read('/proc/mounts'))
    const sizes = await Promise.all(mounts.map(m => files.statfs(m.mount).catch(() => null)))
    return mounts.flatMap((m, i) => {
      const s = sizes[i]
      return s ? [{ ...m, ...s }] : []
    })
  }

  async function fresh(): Promise<SystemView> {
    const gpuOut = gpu().catch(() => null)
    const disked = disks()
    let prior = before
    if (!prior || now() - prior.at > STALE_MS) {
      const first = take()
      prior = { at: first.at, cpu: first.cpu, ticks: tickMap(first.procs) }
      await wait(PRIME_MS)
    }
    const next = take()
    before = { at: next.at, cpu: next.cpu, ticks: tickMap(next.procs) }
    const cores = next.cpu?.cores ?? 1
    const span = prior.cpu && next.cpu ? next.cpu.total - prior.cpu.total : null
    const top = topProcesses(prior.cpu ? prior.ticks : null, next.procs, span, cores, TOP_N)
    let ctx: LabelContext | null = null
    const lazy = () => (ctx ??= context(next.procs))
    const seen = new Map<number, SystemProcess>()
    const once = (p: ProcSample, cpu: number | null): SystemProcess => {
      const had = seen.get(p.pid)
      if (had) return had
      const made = shown(p, cpu, lazy)
      seen.set(p.pid, made)
      return made
    }
    const cpuTop = top.cpu.map(t => once(t.proc, t.cpu))
    const memTop = top.memory.map(t => once(t.proc, t.cpu))
    const gpus = parseNvidiaSmi(await gpuOut)
    return {
      at: next.at,
      host: (o.host ?? hostname)(),
      uptime: parseUptime(files.read('/proc/uptime')),
      cpu: next.cpu
        ? {
            usage: prior.cpu ? cpuUsage(prior.cpu, next.cpu) : null,
            cores,
            load: parseLoadavg(files.read('/proc/loadavg')),
          }
        : null,
      memory: parseMeminfo(files.read('/proc/meminfo')),
      disks: await disked,
      ...(gpus.length > 0 && { gpu: gpus }),
      top: { cpu: cpuTop, memory: memTop },
    }
  }

  return {
    read() {
      if (last && now() - last.at < CACHE_MS) return Promise.resolve(last)
      pending ??= fresh()
        .then(view => {
          last = view
          return view
        })
        .finally(() => {
          pending = null
        })
      return pending
    },
  }
}
