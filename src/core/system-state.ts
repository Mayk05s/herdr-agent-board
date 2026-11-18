// The board's own server's state at a glance (the head's chip and Settings → Server…, GET
// /api/system, services/system-state.ts): what Linux's /proc says now, read into numbers. Current
// values only, no history: CPU over the time since the reading before, memory and swap, each real
// disk, an NVIDIA GPU where nvidia-smi is, the uptime, and the processes that take the most CPU and
// memory, named by what the board knows of them (a session, an agent's desktop, the board, herdr).
// Pure, with no node: import: each parser takes a file's text, so they test on fixture text, and
// the page takes the view's types from here.
import { DISPLAY_BASE } from './desktop.ts'

/** /proc/stat's first line, summed: every CPU's time, its idle part, and how many CPUs there are. */
export interface CpuTimes {
  total: number
  idle: number
  cores: number
}

export interface SystemCpu {
  /** Percent of all CPUs busy since the reading before; null with none to compare. */
  usage: number | null
  cores: number
  /** The load average over 1, 5 and 15 minutes. */
  load: [number, number, number] | null
}

/** In bytes. `used` is what is not available (MemTotal − MemAvailable), as `free` counts it. */
export interface SystemMemory {
  total: number
  used: number
  available: number
  free: number
  /** Buffers, the page cache and reclaimable slab: given back when a program asks. */
  buffersCache: number
  swapTotal: number
  swapUsed: number
}

/** A mounted filesystem, in bytes: `used` and `available` as df counts them. */
export interface SystemDisk {
  mount: string
  device: string
  fs: string
  total: number
  used: number
  available: number
}

/** An NVIDIA GPU as nvidia-smi reads it; memory in bytes; null where it says N/A. */
export interface SystemGpu {
  name: string
  utilization: number | null
  memoryUsed: number | null
  memoryTotal: number | null
  temperature: number | null
}

/** What the board knows of a process: a session's, an agent desktop's (its display), the board, herdr. */
export type ProcessLabel =
  | { kind: 'session'; name: string }
  | { kind: 'browser' | 'vnc' | 'video'; display: number; name?: string }
  | { kind: 'board' }
  | { kind: 'herdr' }

export interface SystemProcess {
  pid: number
  /** The program's name (/proc/<pid>/stat's). */
  name: string
  /** Its command line, short. */
  command: string
  /** Its user's name, or the uid where none is known. */
  user: string
  /** Percent of one CPU since the reading before, as top counts it; null with none to compare. */
  cpu: number | null
  /** Resident memory, bytes. */
  rss: number
  label?: ProcessLabel
}

/** GET /api/system's answer. */
export interface SystemView {
  /** When it was read (ms). */
  at: number
  host: string
  /** Seconds since the server started; null where it cannot be read. */
  uptime: number | null
  cpu: SystemCpu | null
  memory: SystemMemory | null
  disks: SystemDisk[]
  /** Only where nvidia-smi is: no key at all otherwise (a virtio GPU says nothing). */
  gpu?: SystemGpu[]
  top: { cpu: SystemProcess[]; memory: SystemProcess[] }
}

/** How many processes each list shows. */
export const TOP_N = 8

const finite = (n: number): boolean => Number.isFinite(n)
const round1 = (n: number): number => Math.round(n * 10) / 10
const clampPct = (n: number): number => round1(Math.min(100, Math.max(0, n)))

/** /proc/stat: the summed `cpu` line (guest time is in user's already) and the count of `cpuN` lines. */
export function parseCpuTimes(text: string | null): CpuTimes | null {
  if (!text) return null
  const lines = text.split('\n')
  const all = lines.find(l => /^cpu\s/.test(l))
  if (!all) return null
  const n = all.trim().split(/\s+/).slice(1, 9).map(Number)
  if (n.length < 4 || !n.every(finite)) return null
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = n
  return {
    total: user + nice + system + idle + iowait + irq + softirq + steal,
    idle: idle + iowait,
    cores: Math.max(1, lines.filter(l => /^cpu\d+\s/.test(l)).length),
  }
}

/** Percent busy between two readings of /proc/stat; null when no time passed between them. */
export function cpuUsage(before: CpuTimes, after: CpuTimes): number | null {
  const total = after.total - before.total
  const idle = after.idle - before.idle
  if (!(total > 0)) return null
  return clampPct(((total - idle) / total) * 100)
}

/** /proc/loadavg's three averages. */
export function parseLoadavg(text: string | null): [number, number, number] | null {
  const n = (text ?? '').trim().split(/\s+/).slice(0, 3).map(Number)
  return n.length === 3 && n.every(finite) ? [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0] : null
}

/** /proc/uptime's first number: seconds since boot. */
export function parseUptime(text: string | null): number | null {
  const n = Number((text ?? '').trim().split(/\s+/)[0])
  return text && finite(n) && n >= 0 ? Math.floor(n) : null
}

/** /proc/meminfo in bytes; null without MemTotal. MemAvailable missing (a kernel before 3.14): free + buffers + cache. */
export function parseMeminfo(text: string | null): SystemMemory | null {
  if (!text) return null
  const kb = (name: string): number | null => {
    const m = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)
    return m ? Number(m[1]) * 1024 : null
  }
  const total = kb('MemTotal')
  if (!total) return null
  const free = kb('MemFree') ?? 0
  const buffersCache = (kb('Buffers') ?? 0) + (kb('Cached') ?? 0) + (kb('SReclaimable') ?? 0)
  const available = Math.min(total, kb('MemAvailable') ?? free + buffersCache)
  const swapTotal = kb('SwapTotal') ?? 0
  const swapFree = kb('SwapFree') ?? swapTotal
  return {
    total,
    used: Math.max(0, total - available),
    available,
    free,
    buffersCache,
    swapTotal,
    swapUsed: Math.max(0, swapTotal - swapFree),
  }
}

/**
 * Filesystems that hold no files of a disk: the kernel's own, memory, containers' layers, snaps'
 * images, FUSE helpers of a desktop. Never shown.
 */
const PSEUDO_FS: ReadonlySet<string> = new Set([
  'autofs',
  'binfmt_misc',
  'bpf',
  'cgroup',
  'cgroup2',
  'configfs',
  'debugfs',
  'devpts',
  'devtmpfs',
  'efivarfs',
  'fuse.gvfsd-fuse',
  'fuse.lxcfs',
  'fuse.portal',
  'fuse.snapfuse',
  'fusectl',
  'hugetlbfs',
  'mqueue',
  'nfsd',
  'nsfs',
  'overlay',
  'proc',
  'pstore',
  'ramfs',
  'rpc_pipefs',
  'securityfs',
  'selinuxfs',
  'squashfs',
  'sysfs',
  'tmpfs',
  'tracefs',
])

/** Mount points of the system's own and of containers', under which no disk of the owner's is shown. */
const SYSTEM_MOUNTS = /^\/(proc|sys|dev|run(?!\/media\/)|snap|var\/lib\/(docker|containerd|kubelet|lxd))(\/|$)/

/** A path as /proc/mounts escapes it (\040 for a space, \011 a tab, \012 a newline, \134 a backslash). */
const unescapeMount = (s: string): string =>
  s.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)))

/** A mounted filesystem from /proc/mounts. */
export interface MountEntry {
  device: string
  mount: string
  fs: string
}

/**
 * The real filesystems /proc/mounts lists: no pseudo or memory filesystem, nothing under /proc,
 * /sys, /dev, /run (but removable media), /snap or a container runtime's folders, and a device
 * mounted twice (a bind mount) once, at its first mount point.
 */
export function parseMounts(text: string | null): MountEntry[] {
  const seen = new Set<string>()
  const out: MountEntry[] = []
  for (const line of (text ?? '').split('\n')) {
    const [rawDevice, rawMount, fs] = line.trim().split(/\s+/)
    if (!rawDevice || !rawMount || !fs) continue
    const device = unescapeMount(rawDevice)
    const mount = unescapeMount(rawMount)
    if (PSEUDO_FS.has(fs) || SYSTEM_MOUNTS.test(mount) || seen.has(device)) continue
    seen.add(device)
    out.push({ device, mount, fs })
  }
  return out
}

/** statfs's numbers as a disk's sizes: the block size df uses (frsize, else bsize); null for a filesystem of no size. */
export function diskSizes(s: {
  blocks: number | bigint
  bfree: number | bigint
  bavail: number | bigint
  bsize: number | bigint
  frsize?: number | bigint
}): { total: number; used: number; available: number } | null {
  const size = Number(s.frsize || s.bsize)
  const blocks = Number(s.blocks)
  if (!(size > 0) || !(blocks > 0)) return null
  return {
    total: blocks * size,
    used: Math.max(0, (blocks - Number(s.bfree)) * size),
    available: Math.max(0, Number(s.bavail) * size),
  }
}

/** Percent of a disk in use, as df's Use%: used over what its owner could use (used + available). */
export const diskPercent = (d: Pick<SystemDisk, 'used' | 'available'>): number =>
  d.used + d.available > 0 ? clampPct((d.used / (d.used + d.available)) * 100) : 0

/** One process from /proc/<pid>/stat: its CPU time in ticks (user + system), its start (to tell a pid reused), its RSS in pages. */
export interface ProcSample {
  pid: number
  comm: string
  ticks: number
  start: number
  /** Resident pages: proportional to its bytes, for ranking. */
  rssPages: number
}

/** /proc/<pid>/stat; its name is in parentheses and may hold spaces and parentheses itself. */
export function parseProcStat(text: string | null): ProcSample | null {
  if (!text) return null
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const pid = Number(text.slice(0, open).trim())
  // after the name: the state is field 3, so field N is at N - 3
  const f = text
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const utime = Number(f[11])
  const stime = Number(f[12])
  const start = Number(f[19])
  const rssPages = Number(f[21])
  if (!Number.isInteger(pid) || pid <= 0 || ![utime, stime, start, rssPages].every(finite)) return null
  return { pid, comm: text.slice(open + 1, close), ticks: utime + stime, start, rssPages: Math.max(0, rssPages) }
}

/** /proc/<pid>/status: the real uid and VmRSS in bytes (none for a kernel thread). */
export function parseProcStatus(text: string | null): { uid: number | null; rss: number | null } {
  const uid = /^Uid:\s+(\d+)/m.exec(text ?? '')
  const rss = /^VmRSS:\s+(\d+)\s*kB/m.exec(text ?? '')
  return { uid: uid ? Number(uid[1]) : null, rss: rss ? Number(rss[1]) * 1024 : null }
}

/** /etc/passwd: uid → user name. */
export function parsePasswd(text: string | null): Map<number, string> {
  const users = new Map<number, string>()
  for (const line of (text ?? '').split('\n')) {
    const [name, , uid] = line.split(':')
    const id = Number(uid)
    if (name && uid !== undefined && uid !== '' && Number.isInteger(id) && !users.has(id)) users.set(id, name)
  }
  return users
}

/** A key that tells a process from a later one with its pid. */
export const procKey = (p: Pick<ProcSample, 'pid' | 'start'>): string => `${p.pid}:${p.start}`

/** The processes' CPU ticks by procKey, kept for the next reading. */
export const tickMap = (procs: readonly ProcSample[]): Map<string, number> =>
  new Map(procs.map(p => [procKey(p), p.ticks]))

/**
 * The processes that took the most CPU since the reading before (`before`: their ticks by procKey;
 * `span`: every CPU's ticks that passed; null: none to compare, no CPU list) and those with the most
 * resident memory, `n` each. A process not in `before` started since: all its ticks are in the span.
 * CPU is a percent of one CPU, as top counts it (`cores` times the share of the span); only those
 * that took any.
 */
export function topProcesses(
  before: ReadonlyMap<string, number> | null,
  now: readonly ProcSample[],
  span: number | null,
  cores: number,
  n = TOP_N,
): { cpu: { proc: ProcSample; cpu: number }[]; memory: { proc: ProcSample; cpu: number | null }[] } {
  const cpuOf = (p: ProcSample): number | null => {
    if (!before || !span || span <= 0) return null
    const delta = p.ticks - (before.get(procKey(p)) ?? 0)
    return round1(Math.max(0, (delta / span) * cores * 100))
  }
  const withCpu = now.map(proc => ({ proc, cpu: cpuOf(proc) }))
  const byPid = (a: { proc: ProcSample }, b: { proc: ProcSample }) => a.proc.pid - b.proc.pid
  const cpu = withCpu
    .filter((p): p is { proc: ProcSample; cpu: number } => p.cpu !== null && p.cpu > 0)
    .sort((a, b) => b.cpu - a.cpu || byPid(a, b))
    .slice(0, n)
  const memory = [...withCpu].sort((a, b) => b.proc.rssPages - a.proc.rssPages || byPid(a, b)).slice(0, n)
  return { cpu, memory }
}

/** /proc/<pid>/cmdline's arguments (NUL-separated). */
export const argvOf = (cmdline: string | null): string[] => (cmdline ?? '').split('\0').filter(Boolean)

const baseName = (path: string): string => path.split('/').pop() ?? path

/** The longest command shown. */
export const COMMAND_MAX = 120

/** A command line, short: its program without the folder, its arguments, cut at COMMAND_MAX; a kernel thread's name in brackets. */
export function shortCommand(argv: readonly string[], comm: string): string {
  if (!argv.length) return `[${comm}]`
  const line = [baseName(argv[0] ?? ''), ...argv.slice(1)].join(' ')
  return line.length > COMMAND_MAX ? `${line.slice(0, COMMAND_MAX - 1)}…` : line
}

/** A variable of /proc/<pid>/environ (NUL-separated); null when it has none. */
export function envValue(environ: string | null, name: string): string | null {
  const line = (environ ?? '').split('\0').find(l => l.startsWith(`${name}=`))
  return line === undefined ? null : line.slice(name.length + 1)
}

/** An X display's number (`:100`, `:100.0`); null for anything else. */
export function displayOf(value: string | null | undefined): number | null {
  const m = /^:(\d+)(?:\.\d+)?$/.exec(value ?? '')
  return m ? Number(m[1]) : null
}

/** A desktop's display (from DISPLAY_BASE up): a person's own (:0, :1) is not one. */
const deskDisplay = (value: string | null | undefined): number | null => {
  const n = displayOf(value)
  return n !== null && n >= DISPLAY_BASE ? n : null
}

/**
 * An agent desktop's Xvnc (services/desktop.ts, core/desktop.ts xvncArgs): its display, and the
 * session's key in its name (`-desktop "agent-board <key>"`); null for any other process.
 */
export function xvncDesktop(argv: readonly string[]): { display: number; key: string | null } | null {
  if (baseName(argv[0] ?? '') !== 'Xvnc') return null
  const display = deskDisplay(argv[1])
  if (display === null) return null
  const name = argv[argv.indexOf('-desktop') + 1] ?? ''
  const key = argv.includes('-desktop') && name.startsWith('agent-board ') ? name.slice('agent-board '.length) : null
  return { display, key: key || null }
}

/** What the board knows around a process's label: who it is, and the sessions' and desktops' names. */
export interface LabelFacts {
  pid: number
  comm: string
  argv: readonly string[]
  /** Its environment's HERDR_PANE_ID and DISPLAY (null where unreadable or unset). */
  pane: string | null
  display: string | null
}

export interface LabelContext {
  boardPid: number
  /** A session's name by its herdr pane. */
  panes: ReadonlyMap<string, string>
  /** A desktop's session's name by its display. */
  displays: ReadonlyMap<number, string>
}

const CHROME =
  /^(chrome|chromium|chromium-browser|google-chrome|google-chrome-stable|chrome_crashpad_handler|chrome-sandbox)$/

/**
 * What the board knows of a process: the board itself, herdr, an agent desktop's Xvnc, its video's
 * ffmpeg (x11grab of its display) or its Chrome (DISPLAY on a desktop's display), else a session's
 * (HERDR_PANE_ID, which a session's Claude and all it starts carry); none for the rest.
 */
export function processLabel(f: LabelFacts, ctx: LabelContext): ProcessLabel | undefined {
  if (f.pid === ctx.boardPid) return { kind: 'board' }
  const program = baseName(f.argv[0] ?? '')
  if (f.comm === 'herdr' || program === 'herdr') return { kind: 'herdr' }
  const desk = (kind: 'browser' | 'vnc' | 'video', display: number): ProcessLabel => {
    const name = ctx.displays.get(display)
    return name ? { kind, display, name } : { kind, display }
  }
  const vnc = xvncDesktop(f.argv)
  if (vnc) return desk('vnc', vnc.display)
  if (program === 'ffmpeg' && f.argv.includes('x11grab')) {
    const display = deskDisplay(f.argv[f.argv.indexOf('-i') + 1])
    if (f.argv.includes('-i') && display !== null) return desk('video', display)
  }
  const display = deskDisplay(f.display)
  if (display !== null && (CHROME.test(program) || /^chrom/.test(f.comm))) return desk('browser', display)
  const session = f.pane ? ctx.panes.get(f.pane) : undefined
  return session ? { kind: 'session', name: session } : undefined
}

/**
 * nvidia-smi's `--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu
 * --format=csv,noheader,nounits`: one GPU a line, memory in MiB; "[N/A]" and the like are null.
 * The name may hold commas: the four numbers are the line's last fields.
 */
export function parseNvidiaSmi(text: string | null): SystemGpu[] {
  const num = (s: string | undefined): number | null => {
    const n = Number((s ?? '').trim())
    return (s ?? '').trim() !== '' && finite(n) ? n : null
  }
  const mib = (s: string | undefined): number | null => {
    const n = num(s)
    return n === null ? null : n * 1024 * 1024
  }
  const gpus: SystemGpu[] = []
  for (const line of (text ?? '').split('\n')) {
    const fields = line.split(',')
    if (fields.length < 5) continue
    const [utilization, used, total, temperature] = fields.slice(-4)
    const name = fields.slice(0, -4).join(',').trim()
    if (!name) continue
    gpus.push({
      name,
      utilization: num(utilization),
      memoryUsed: mib(used),
      memoryTotal: mib(total),
      temperature: num(temperature),
    })
  }
  return gpus
}
