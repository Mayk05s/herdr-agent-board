// A local Codex TUI can switch rollouts without replacing its terminal or reporting a new SID to
// Herdr. On macOS the foreground process's writable rollout descriptors provide independent evidence.
import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import type { PaneProcesses } from '../core/board-pane.ts'
import { CODEX_AGENT, isCodexSession } from '../core/codex.ts'
import { asPaneProcesses, type HerdrPane, herdr } from './herdr.ts'
import { isRecord } from './json-store.ts'

const run = promisify(execFile)
const TIMEOUT = 1500

/** The thread ID precedes the optional rollout ID written by Codex thread/revert. */
export function codexRolloutName(name: string): { session: string; revision: string | null } | null {
  if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) return null
  const versioned = name.at(-43) === '_'
  const start = versioned ? -79 : -42
  const session = name.slice(start, start + 36).toLowerCase()
  if (name.at(start - 1) !== '-' || !isCodexSession(session)) return null
  const revision = versioned ? name.slice(-42, -6).toLowerCase() : null
  if (revision !== null && !isCodexSession(revision)) return null
  return { session, revision }
}

export async function codexOpenFiles(pid: number, shell = pid): Promise<string> {
  const pids = shell === pid ? String(pid) : `${pid},${shell}`
  const { stdout } = await run('/usr/sbin/lsof', ['-nP', '-a', '-p', pids, '-F0pfatn'], {
    timeout: TIMEOUT,
    env: { ...process.env, LC_ALL: 'en_US.UTF-8' },
  })
  return stdout
}

function singleCodexPid(processes: PaneProcesses): number | undefined {
  const codex = processes.foreground.filter(p => basename(p.args[0] ?? '') === CODEX_AGENT)
  return codex.length === 1 ? codex[0]?.pid : undefined
}

async function foreground(
  pane: string,
  selectPid = singleCodexPid,
): Promise<{ pid: number; shell: number; tty: string | null } | null> {
  const result = await herdr(['pane', 'process-info', '--pane', pane], TIMEOUT)
  const raw = isRecord(result) ? result.process_info : null
  if (!isRecord(raw) || raw.pane_id !== pane) return null
  const tty = raw.tty
  if (tty != null && (typeof tty !== 'string' || !tty.startsWith('/dev/'))) return null
  const processes = asPaneProcesses(result)
  if (!processes) return null
  const pid = selectPid(processes)
  return pid ? { pid, shell: processes.shell, tty: tty ?? null } : null
}

function processDescriptors(stdout: string): Map<number, string[][]> {
  const processes = new Map<number, string[][]>()
  let descriptors: string[][] | undefined
  // A NUL ends each field and a newline between fields marks a new record. Preserve names.
  for (const record of stdout.trimEnd().split('\0\n')) {
    const fields = record.split('\0')
    const field = fields[0] ?? ''
    if (/^p\d+$/.test(field)) {
      descriptors = []
      processes.set(Number(field.slice(1)), descriptors)
    } else if (/^f\d+$/.test(field)) descriptors?.push(fields)
  }
  return processes
}

function stdioTtys(descriptors: string[][]): string[] {
  return descriptors.flatMap(fields =>
    /^f[012]$/.test(fields[0] ?? '') && fields.includes('tCHR')
      ? fields.filter(field => field.startsWith('n/dev/')).map(field => field.slice(1))
      : [],
  )
}

function writableRollouts(descriptors: string[][]): string[] {
  const rollouts: string[] = []
  for (const fields of descriptors) {
    if (!fields.includes('tREG') || (!fields.includes('aw') && !fields.includes('au'))) continue
    const path = fields.find(field => field.startsWith('n'))?.slice(1) ?? ''
    if (path.startsWith('/') && codexRolloutName(basename(path))) rollouts.push(path)
  }
  return rollouts
}

function rolloutsOnTty(stdout: string, pid: number, shell: number, tty: string | null): string[] {
  const processes = processDescriptors(stdout)
  const descriptors = processes.get(pid)
  if (!descriptors) return []
  const codexTtys = new Set(stdioTtys(descriptors))
  if (tty) {
    if (!codexTtys.has(tty)) return []
  } else {
    // Herdr 0.9.5 omits tty. Both Herdr-reported PIDs must hold the same concrete macOS PTY on stdio.
    const shared = new Set(
      stdioTtys(processes.get(shell) ?? []).filter(name => /^\/dev\/ttys[0-9a-z]+$/i.test(name) && codexTtys.has(name)),
    )
    if (shared.size !== 1) return []
  }
  return [...new Set(writableRollouts(descriptors))]
}

export type LauncherCodexRollout = { path: string; openPaths: readonly string[] }

/** Called by the launcher for the TUI and the authenticated App Server it started itself. */
export async function launcherCodexRollout(
  pane: string,
  terminal: string,
  sid: string,
  tuiPid: number,
  appPid: number,
  readNative: () => Promise<unknown>,
  tuiCommand: readonly string[],
): Promise<LauncherCodexRollout | null> {
  if (process.platform !== 'darwin') return null
  const selectTui = ({ foreground }: PaneProcesses): number | undefined => {
    const candidates = foreground.filter(
      ({ pid, args }) => pid === tuiPid || pid === appPid || basename(args[0] ?? '') === CODEX_AGENT,
    )
    const tui = candidates.filter(({ pid }) => pid === tuiPid)
    const app = candidates.filter(({ pid }) => pid === appPid)
    if (tui.length !== 1 || app.length > 1 || candidates.length !== tui.length + app.length) return undefined
    const args = tui[0]?.args ?? []
    if (
      basename(args[0] ?? '') !== CODEX_AGENT ||
      args.length !== tuiCommand.length ||
      !args.slice(1).every((arg, index) => arg === tuiCommand[index + 1])
    )
      return undefined
    if (app.length && (basename(app[0]?.args[0] ?? '') !== CODEX_AGENT || app[0]?.args[1] !== 'app-server'))
      return undefined
    return tuiPid
  }
  try {
    const before = await foreground(pane, selectTui)
    if (before?.pid !== tuiPid) return null
    const native = await readNative()
    if (!isRecord(native) || native.id !== sid || typeof native.path !== 'string') return null
    const status = isRecord(native.status) ? native.status.type : null
    if (status !== 'idle' && status !== 'active') return null
    const openPaths = writableRollouts(processDescriptors(await codexOpenFiles(appPid)).get(appPid) ?? [])
    if (
      codexRolloutName(basename(native.path))?.session !== sid ||
      openPaths.filter(path => path === native.path).length !== 1
    )
      return null
    const after = await foreground(pane, selectTui)
    if (after?.pid !== tuiPid || after.shell !== before.shell || after.tty !== before.tty) return null
    const result = await herdr(['agent', 'get', pane], TIMEOUT)
    const live = isRecord(result) ? result.agent : null
    if (
      !isRecord(live) ||
      live.agent !== CODEX_AGENT ||
      live.terminal_id !== terminal ||
      !isRecord(live.agent_session) ||
      live.agent_session.value !== sid
    )
      return null
    return { path: native.path, openPaths }
  } catch {
    return null
  }
}

export const canProbeCodex = (pane: HerdrPane): boolean =>
  process.platform === 'darwin' &&
  pane.agent === CODEX_AGENT &&
  !!pane.terminal_id &&
  isCodexSession(pane.agent_session?.value ?? '')

/** Candidates only for the terminal in the snapshot and its still-foreground Codex process. */
export async function codexProcessRollouts(pane: HerdrPane, openFiles = codexOpenFiles): Promise<string[]> {
  if (!canProbeCodex(pane)) return []
  const session = pane.agent_session?.value
  try {
    const before = await foreground(pane.pane_id)
    if (!before) return []
    const { pid, shell, tty } = before
    const paths = rolloutsOnTty(await openFiles(pid, tty === null ? shell : undefined), pid, shell, tty)
    const only = paths.length === 1 && paths[0] ? codexRolloutName(basename(paths[0])) : null
    if (!paths.length || (only && !only.revision && only.session === session?.toLowerCase())) return []
    const after = await foreground(pane.pane_id)
    if (pid !== after?.pid || shell !== after.shell || tty !== after.tty) return []
    const result = await herdr(['agent', 'get', pane.pane_id], TIMEOUT)
    const live = isRecord(result) ? result.agent : null
    if (
      !isRecord(live) ||
      live.agent !== CODEX_AGENT ||
      live.terminal_id !== pane.terminal_id ||
      !isRecord(live.agent_session) ||
      live.agent_session.value !== session
    )
      return []
    return paths
  } catch {
    return []
  }
}
