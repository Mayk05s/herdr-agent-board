// Find a Codex rollout by the session id herdr reports. Discovery is shared across cards;
// transcript reads are bounded and cached by size and mtime, as for pi.
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { isCodexSession, parseCodexConversation, parseCodexTail } from '../core/codex.ts'
import { modelProblem } from '../core/launch/model.ts'
import type { TranscriptInfo } from '../core/types.ts'
import { cwdOf as readCwd, readTail, type SessionThread } from './claude-home.ts'
import { canProbeCodex, codexProcessRollouts, codexRolloutName, type LauncherCodexRollout } from './codex-process.ts'
import { readConfigFile } from './config-file.ts'
import type { HerdrPane } from './herdr.ts'
import { isRecord } from './json-store.ts'

type VerifiedRollout = { path: string; revision: string | null }
type ActiveThread =
  | { session: string; cwd: string; continues: boolean; rollout?: VerifiedRollout }
  | { reportedRollout: VerifiedRollout }
  | 'ambiguous'
  | 'launcher-unconfirmed'
  | null
type PaneProbe = { identity: string; pending: Promise<ActiveThread>; result?: ActiveThread; finishedAt?: number }

export interface CodexHome {
  /** The folder in the rollout header, rather than the enclosing shell's folder. */
  cwdOf(session: string): Promise<string | null>
  /** The foreground TUI's verified rollout if it differs from Herdr's, or ambiguity on this PTY. */
  currentThread(
    pane: HerdrPane,
    fresh?: boolean,
    launcher?: Promise<LauncherCodexRollout | null>,
  ): Promise<ActiveThread>
  transcriptInfo(session: string | null, rollout?: string | null): TranscriptInfo | null
  sessionThread(session: string, limit?: number, rollout?: string | null): SessionThread
}

const DISCOVERY_MS = 1000
const PANE_PROBE_MS = 4_000
const LIST_PROBE_WAIT_MS = 180
const CARD_WINDOWS = [256 << 10, 2 << 20]
const THREAD_WINDOWS = [2 << 20, 8 << 20]

const codexRoot = (): string => process.env.CODEX_HOME || join(homedir(), '.codex')

/**
 * Where rollouts are looked for: the folder Codex uses here, then the dedicated one for sessions
 * herdr runs (config.json `codexHome`, written by install.ts --codex-home). Without that key the
 * list is the one folder it always was.
 */
function codexRoots(first: string): string[] {
  const dedicated = dedicatedCodexHome()
  return dedicated && dedicated !== first ? [first, dedicated] : [first]
}

/** The dedicated CODEX_HOME for sessions herdr runs (config.json `codexHome`); null when none is set. */
export function dedicatedCodexHome(): string | null {
  const dedicated = readConfigFile()?.codexHome
  return typeof dedicated === 'string' && dedicated ? dedicated : null
}

export async function cachedCodexModels(root = codexRoot()): Promise<Record<string, string[]>> {
  try {
    const cache: unknown = await Bun.file(join(root, 'models_cache.json')).json()
    if (!isRecord(cache) || !Array.isArray(cache.models)) return {}
    return Object.fromEntries(
      cache.models.flatMap(model => {
        if (
          !isRecord(model) ||
          model.visibility !== 'list' ||
          typeof model.slug !== 'string' ||
          modelProblem(model.slug)
        )
          return []
        const levels: unknown[] = Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels
          : []
        return [
          [
            model.slug,
            [
              ...new Set(
                levels.flatMap(level =>
                  isRecord(level) && typeof level.effort === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(level.effort)
                    ? [level.effort]
                    : [],
                ),
              ),
            ],
          ],
        ]
      }),
    )
  } catch {
    return {}
  }
}

export function createCodexHome(
  root = codexRoot(),
  probe: (pane: HerdrPane) => Promise<readonly string[]> = codexProcessRollouts,
  now = Date.now,
): CodexHome {
  const files = new Map<string, string>()
  const cache = new Map<string, { mtimeMs: number; size: number; info: TranscriptInfo }>()
  let scannedAt = -Infinity
  const probes = new Map<string, PaneProbe>()

  function discover(dir: string, depth = 0): void {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && depth < 3 && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) {
        try {
          discover(join(dir, entry.name), depth + 1)
        } catch {} // An unreadable date folder does not hide the others.
      } else if (depth === 3 && entry.isFile()) {
        const name = codexRolloutName(entry.name)
        if (name && !name.revision) files.set(name.session, join(dir, entry.name))
      }
    }
  }

  function locate(session: string | null, rollout?: string | null) {
    if (rollout === null || !session || !isCodexSession(session)) return null
    const id = session.toLowerCase()
    try {
      // A roll forward or revert keeps the SID. Only the foreground probe supplies a revision.
      if (rollout) {
        const st = statSync(rollout, { throwIfNoEntry: false })
        return st?.isFile() ? { file: rollout, st } : null
      }
      let file = files.get(id)
      let st = file ? statSync(file, { throwIfNoEntry: false }) : null
      if (!st?.isFile() && Date.now() - scannedAt >= DISCOVERY_MS) {
        scannedAt = Date.now()
        files.clear()
        for (const base of codexRoots(root))
          try {
            discover(join(base, 'sessions'))
          } catch {} // A folder that is not there hides no other.
        file = files.get(id)
        st = file ? statSync(file, { throwIfNoEntry: false }) : null
      }
      return file && st?.isFile() ? { file, st } : null
    } catch {
      return null // A removed or unreadable rollout leaves a bare card.
    }
  }

  function transcriptInfo(session: string | null, rollout?: string | null): TranscriptInfo | null {
    const found = locate(session, rollout)
    if (!found) return null
    const { file, st } = found
    const hit = cache.get(file)
    if (hit?.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.info
    try {
      let info: TranscriptInfo = {}
      for (const bytes of CARD_WINDOWS) {
        info = parseCodexTail(readTail(file, st.size, bytes).split('\n'))
        if ((info.prompt && info.lastText) || bytes >= st.size) break
      }
      // A long tool result can move the last user turn outside the bounded tail.
      if (!info.prompt && hit?.info.prompt && st.size >= hit.size) info.prompt = hit.info.prompt
      info.activity = st.mtimeMs
      cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, info })
      return info
    } catch {
      return null
    }
  }

  function sessionThread(session: string, limit = 40, rollout?: string | null): SessionThread {
    const found = locate(session, rollout)
    if (!found) return { conversation: [], queued: [] }
    const { file, st } = found
    try {
      let conversation = parseCodexConversation([], limit)
      for (const bytes of THREAD_WINDOWS) {
        conversation = parseCodexConversation(readTail(file, st.size, bytes).split('\n'), limit)
        if (conversation.filter(t => t.role !== 'tool').length >= limit / 3 || bytes >= st.size) break
      }
      return { conversation, queued: [] }
    } catch {
      return { conversation: [], queued: [] }
    }
  }

  async function rolloutMeta(file: string) {
    const fd = await open(file, 'r')
    try {
      const buf = Buffer.alloc(32 << 10)
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0)
      const header: unknown = JSON.parse(buf.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0] ?? '')
      const meta = isRecord(header) && header.type === 'session_meta' ? header.payload : null
      return isRecord(meta) && meta.originator === 'codex-tui' ? meta : null
    } finally {
      await fd.close()
    }
  }

  function inSessionStore(path: string): boolean {
    // Resolve dates and roots as well as the file so a symlink cannot turn a different store
    // into evidence about this pane.
    const real = realpathSync(path)
    const day = dirname(real)
    const month = dirname(day)
    const year = dirname(month)
    return (
      /^\d{2}$/.test(basename(day)) &&
      /^\d{2}$/.test(basename(month)) &&
      /^\d{4}$/.test(basename(year)) &&
      codexRoots(root).some(base => {
        try {
          return realpathSync(join(base, 'sessions')) === dirname(year) && basename(real) === basename(path)
        } catch {
          return false
        }
      })
    )
  }

  async function interactiveRollouts(paths: readonly string[]) {
    const candidates = await Promise.all(
      paths.map(async path => {
        const name = codexRolloutName(basename(path))
        if (!name || !inSessionStore(path)) return null
        const meta = await rolloutMeta(path)
        if (!meta || meta.id !== name.session) return null
        const { source } = meta
        const subagent = isRecord(source) ? source.subagent : null
        // Guardian reviewers are background threads of the same process, never its TUI composer.
        if (!name.revision && isRecord(subagent) && subagent.other === 'guardian') return 'guardian' as const
        return source === 'cli' ? { path, name, meta } : null
      }),
    ).catch(() => null)
    return candidates?.filter(candidate => candidate !== 'guardian')
  }

  async function probeThread(pane: HerdrPane): Promise<ActiveThread> {
    const paths = await probe(pane)
    if (!paths.length) return null
    const interactive = await interactiveRollouts(paths)
    const previous = pane.agent_session?.value
    if (interactive?.length !== 1 || !interactive[0]) {
      // While selection is ambiguous, Herdr's reported SID still has a read-only history.
      const reported = interactive?.filter(candidate => candidate?.name.session === previous)
      const known = reported?.length === 1 ? reported[0] : null
      if (known?.name.revision) return { reportedRollout: { path: known.path, revision: known.name.revision } }
      return 'ambiguous'
    }
    const {
      path,
      name: { session, revision },
      meta,
    } = interactive[0]
    if (!revision) {
      const found = locate(session)
      if (!found || realpathSync(found.file) !== realpathSync(path)) return 'ambiguous'
      if (session === previous?.toLowerCase()) return null
    }
    const cwd = typeof meta.cwd === 'string' ? meta.cwd : ''
    const target = { session, cwd, ...(revision && { rollout: { path, revision } }) }
    // The writable descriptor identifies the current SID. Ancestry only decides whether to keep
    // the reported card as the stable identity and make its original conversation selectable.
    let parent = meta.forked_from_id
    for (let depth = 0; depth < 32 && typeof parent === 'string' && isCodexSession(parent); depth++) {
      if (parent === previous) return { ...target, continues: true }
      const earlier = locate(parent)
      const ancestor = earlier ? await rolloutMeta(earlier.file) : null
      if (ancestor?.source !== 'cli' || ancestor.id !== parent) break
      parent = ancestor.forked_from_id
    }
    return { ...target, continues: false }
  }

  async function currentThread(
    pane: HerdrPane,
    fresh = false,
    launcher?: Promise<LauncherCodexRollout | null>,
  ): Promise<ActiveThread> {
    if (launcher) {
      const proof = await launcher.catch(() => null)
      const candidates = proof && (await interactiveRollouts(proof.openPaths))
      const candidate = candidates?.length === 1 ? candidates[0] : null
      if (!candidate || candidate.path !== proof?.path || candidate.name.session !== pane.agent_session?.value)
        return 'launcher-unconfirmed'
      return {
        session: candidate.name.session,
        cwd: typeof candidate.meta.cwd === 'string' ? candidate.meta.cwd : '',
        continues: false,
        rollout: { path: candidate.path, revision: candidate.name.revision },
      }
    }
    if (!canProbeCodex(pane)) return null
    // A reused pane cannot borrow another terminal's history. Keep both successes and misses for
    // this incarnation. A send starts its own verification even while a list probe is in flight.
    const identity = JSON.stringify([
      pane.terminal_id,
      pane.agent_session?.value,
      pane.agent_status,
      pane.state_change_seq,
    ])
    const cached = probes.get(pane.pane_id)
    const same = cached?.identity === identity ? cached : undefined
    let entry = same
    if (!entry || fresh || (entry.finishedAt !== undefined && now() - entry.finishedAt >= PANE_PROBE_MS)) {
      const pending = probeThread(pane).catch(() => 'ambiguous' as const)
      const next: PaneProbe = { identity, pending, ...(same?.result !== undefined && { result: same.result }) }
      void pending.then(result => {
        next.result = result
        next.finishedAt = now()
      })
      probes.delete(pane.pane_id)
      probes.set(pane.pane_id, next)
      const oldest = probes.keys().next().value
      if (probes.size > 256 && oldest) probes.delete(oldest)
      entry = next
    }
    if (fresh) return entry.pending
    if (entry.result !== undefined) return entry.result
    // All list probes run in parallel. Give a cold check a short chance to resolve, then let it
    // finish in the background. A slow Herdr or lsof call must not hold the rest of the board.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<null>(resolve => {
        timer = setTimeout(resolve, LIST_PROBE_WAIT_MS, null)
      })
      return await Promise.race([entry.pending, deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    currentThread,
    transcriptInfo,
    sessionThread,
    async cwdOf(session) {
      const found = locate(session)
      return found ? readCwd(found.file) : null
    },
  }
}
