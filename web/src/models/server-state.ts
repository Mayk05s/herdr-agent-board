// The board's own server's state on its page (GET /api/system, src/core/system-state.ts): the head's
// chip (components/server/ServerChip.tsx) and Settings → Server…'s panel (ServerPanel.tsx), offered on
// the board's own server's page only (offersServer): through its domain's login, or its own page
// there, never a phone's pairing (the board refuses /api/system there) and never on a PC. Current
// values only. Here: the answer's check, the levels (warn from WARN %, critical from CRIT %), the
// chip's parts, human units, and the poll: one for the page, at the shortest interval anyone wants
// (the chip CHIP_MS, the open panel PANEL_MS), only while the page is visible and someone wants it;
// a board that refuses or has no such route (401, 403, 404) is not asked again.
import {
  diskPercent,
  type ProcessLabel,
  type SystemDisk,
  type SystemMemory,
  type SystemView,
} from '../../../src/core/system-state.ts'
import type { Translator } from '../../../src/core/types.ts'
import { ApiError, isReply } from '../api/client.ts'
import { Store } from '../state/store.ts'
import { boardOnServer } from './settings-menu.ts'

/** The chip asks this often while the page is visible. */
export const CHIP_MS = 5000
/** The open panel asks this often. */
export const PANEL_MS = 2500
/** From this percent a value is drawn as a warning (orange). */
export const WARN = 80
/** From this percent, critical (red). */
export const CRIT = 90

export type Level = '' | 'warn' | 'crit'

export const levelOf = (pct: number | null | undefined): Level =>
  pct === null || pct === undefined ? '' : pct >= CRIT ? 'crit' : pct >= WARN ? 'warn' : ''

/** The worst of some levels. */
export const worst = (levels: readonly Level[]): Level =>
  levels.includes('crit') ? 'crit' : levels.includes('warn') ? 'warn' : ''

/**
 * Whether the page offers the server's state: on the board's own server's page (the payload's
 * `server`), its domain's login or its own page there; not a phone paired through Tailscale, which
 * the board refuses /api/system (`auth`: how the last hello said this browser gets in, asked only
 * there: a PC's page reads nothing for it).
 */
export const offersServer = (
  remote: boolean,
  payload: { server?: boolean | undefined } | null | undefined,
  auth: () => 'pair' | 'login' | null,
): boolean => boardOnServer(payload) && (!remote || auth() === 'login')

/** GET /api/system's answer, as far as the page relies on it. */
export const isSystemView = (value: unknown): value is SystemView =>
  isReply(value) &&
  typeof value.at === 'number' &&
  typeof value.host === 'string' &&
  Array.isArray(value.disks) &&
  isReply(value.top) &&
  Array.isArray(value.top.cpu) &&
  Array.isArray(value.top.memory) &&
  (value.cpu === null || isReply(value.cpu)) &&
  (value.memory === null || isReply(value.memory)) &&
  (value.gpu === undefined || Array.isArray(value.gpu))

const round1 = (n: number): number => Math.round(n * 10) / 10

export const memoryPercent = (m: Pick<SystemMemory, 'total' | 'used'>): number =>
  m.total > 0 ? round1((m.used / m.total) * 100) : 0

export const swapPercent = (m: Pick<SystemMemory, 'swapTotal' | 'swapUsed'>): number =>
  m.swapTotal > 0 ? round1((m.swapUsed / m.swapTotal) * 100) : 0

/** A part of a whole as a percent; 0 of nothing. */
export const share = (part: number | null, whole: number | null): number | null =>
  part === null || whole === null ? null : whole > 0 ? round1((part / whole) * 100) : 0

/** The fullest disk and how full, as df's Use%; null with none. */
export function fullestDisk(disks: readonly SystemDisk[]): { disk: SystemDisk; pct: number } | null {
  let best: { disk: SystemDisk; pct: number } | null = null
  for (const disk of disks) {
    const pct = diskPercent(disk)
    if (!best || pct > best.pct) best = { disk, pct }
  }
  return best
}

/** One of the chip's readings. */
export interface ChipPart {
  id: 'cpu' | 'ram' | 'disk'
  label: string
  pct: number | null
  level: Level
}

/** A mount point as short as the chip shows it. */
const shortMount = (mount: string): string => (mount.length > 14 ? `…${mount.slice(-13)}` : mount)

/** The chip's readings: CPU and RAM, and the fullest disk while it is at WARN % or over. */
export function chipParts(view: SystemView, t: Translator): ChipPart[] {
  const cpu = view.cpu?.usage ?? null
  const ram = view.memory ? memoryPercent(view.memory) : null
  const parts: ChipPart[] = [
    { id: 'cpu', label: t('sys.chip.cpu'), pct: cpu, level: levelOf(cpu) },
    { id: 'ram', label: t('sys.chip.ram'), pct: ram, level: levelOf(ram) },
  ]
  const disk = fullestDisk(view.disks)
  if (disk && disk.pct >= WARN)
    parts.push({
      id: 'disk',
      label: t('sys.chip.disk', { mount: shortMount(disk.disk.mount) }),
      pct: disk.pct,
      level: levelOf(disk.pct),
    })
  return parts
}

/** A percent as the chip and the bars say it: a whole number; a dash for none. */
export const pctText = (pct: number | null): string => (pct === null ? '—' : `${Math.round(pct)}%`)

/** The chip's words: "CPU 25% · RAM 34%". */
export const chipText = (parts: readonly ChipPart[]): string =>
  parts.map(p => `${p.label} ${pctText(p.pct)}`).join(' · ')

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const

/** Bytes in the unit that fits (1024s): "23.4 GiB", "512 MiB", "0 B". */
export function bytesText(bytes: number | null, t: Translator): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—'
  let n = Math.max(0, bytes)
  let unit = 0
  while (n >= 1024 && unit < UNITS.length - 1) {
    n /= 1024
    unit++
  }
  const digits = unit === 0 || n >= 100 ? 0 : 1
  const number = new Intl.NumberFormat(t.lang, { maximumFractionDigits: digits }).format(n)
  return t(`sys.unit.${UNITS[unit]}`, { n: number })
}

/** How long the server has been up: days and hours, else hours and minutes, else minutes. */
export function uptimeText(seconds: number, t: Translator): string {
  const days = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (days > 0) return t('sys.uptime.days', { n: days, h })
  if (h > 0) return t('sys.uptime.hours', { h, m })
  return t('sys.uptime.minutes', { m })
}

/** A load average's three figures, as the page writes numbers. */
export const loadText = (load: readonly [number, number, number], t: Translator): string => {
  const f = new Intl.NumberFormat(t.lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return t('sys.cpu.load', { one: f.format(load[0]), five: f.format(load[1]), fifteen: f.format(load[2]) })
}

/** A process's CPU, one decimal; a dash for none. */
export const cpuText = (cpu: number | null, t: Translator): string =>
  cpu === null ? '—' : `${new Intl.NumberFormat(t.lang, { maximumFractionDigits: 1 }).format(cpu)}%`

/** What the board knows of a process, in words: the session's name; a desktop's part with its session's. */
export function labelText(label: ProcessLabel, t: Translator): string {
  if (label.kind === 'session') return label.name
  if (label.kind === 'board' || label.kind === 'herdr') return t(`sys.label.${label.kind}`)
  const part = t(`sys.label.${label.kind}`, { display: label.display })
  return label.name ? `${part} · ${label.name}` : part
}

/** What the page has of the server's state: the last answer, the last failure (null since an answer), and whether to ask no more. */
export interface ServerSnapshot {
  view: SystemView | null
  error: unknown
  gone: boolean
}

export interface PollDeps {
  get(): Promise<SystemView>
  doc: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(timer: unknown): void
  now(): number
}

export interface ServerPoll {
  store: Store<ServerSnapshot>
  /** `who` wants the state every `ms` (null: no longer). The poll asks at the shortest; with nobody, never. */
  want(who: string, ms: number | null): void
}

/** The board refuses the route here, or has none: asked no more. */
const refused = (err: unknown): boolean => err instanceof ApiError && [401, 403, 404].includes(err.status)

/**
 * The page's poll of GET /api/system: while someone wants it and the page is visible, at once when
 * it is due (on a want or on coming back into view) and then every interval after an answer; a
 * hidden page asks nothing, and with nobody wanting it no timer runs and the page's visibility is
 * not listened to.
 */
export function createServerPoll(d: PollDeps): ServerPoll {
  const store = new Store<ServerSnapshot>({ view: null, error: null, gone: false })
  const wants = new Map<string, number>()
  let timer: unknown = null
  let busy = false
  let askedAt: number | null = null
  let listening = false
  const every = (): number | null => (wants.size ? Math.min(...wants.values()) : null)
  const clear = (): void => {
    if (timer !== null) d.clearTimeout(timer)
    timer = null
  }
  const schedule = (): void => {
    clear()
    const ms = every()
    if (ms === null || busy || store.get().gone || d.doc.visibilityState !== 'visible') return
    const due = askedAt === null ? 0 : Math.max(0, askedAt + ms - d.now())
    timer = d.setTimeout(() => void ask(), due)
  }
  async function ask(): Promise<void> {
    timer = null
    busy = true
    askedAt = d.now()
    try {
      const view = await d.get()
      store.set({ view, error: null, gone: false })
    } catch (err) {
      store.set({ ...store.get(), error: err, gone: refused(err) })
    } finally {
      busy = false
      schedule()
    }
  }
  const visibility = (): void => schedule()
  return {
    store,
    want(who, ms) {
      const before = every()
      if (ms === null) wants.delete(who)
      else wants.set(who, ms)
      if (wants.size && !listening) d.doc.addEventListener('visibilitychange', visibility)
      if (!wants.size && listening) d.doc.removeEventListener('visibilitychange', visibility)
      listening = wants.size > 0
      // a shorter interval than before (the panel opened) asks now; else on time
      const now = every()
      if (now !== null && before !== null && now < before) askedAt = null
      schedule()
    },
  }
}
