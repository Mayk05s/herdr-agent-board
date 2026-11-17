// Codex hooks use the same matcher groups as Claude, but live in their own hooks.json.
import { BOARD_EVENTS, normPath, quote, withOurHook } from './install-plan.ts'

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// An argv marker survives a moved checkout. It adds no hooks.json schema fields and the hook
// does not consume argv. Unmarked hooks from an unknown old folder stay: a filename alone is
// not proof that another command belongs to the board.
const MARKER = '--herdr-agent-board-hook'
const installedCommand = /^bun[ \t]+(?:"([^"\r\n]+)"|([^\s"'`$();&|<>]+))(?:[ \t]+(--herdr-agent-board-hook))?[ \t]*$/

function ourCommand(command: string, script: string): boolean {
  const match = installedCommand.exec(command)
  if (!match) return false // A quoted reference in echo or a shell wrapper is not our hook.
  const path = normPath(match[1] ?? match[2])
  if (!path.endsWith('/entrypoints/codex-hook.ts')) return false
  return !!match[3] || path === normPath(script) || /agent-board.*\/entrypoints\/codex-hook\.ts$/.test(path)
}

/**
 * `labels`: the name Codex shows for each event's hook in /hooks (its `statusMessage`; Codex has no
 * name field). Only the dedicated home passes them: a label changes the hook's trusted hash, so a
 * plain `--codex` install keeps its hooks, and their trust, as they were.
 */
export function planCodexHooks(
  settings: unknown,
  script: string,
  labels?: Partial<Record<string, string>>,
): Record<string, unknown> {
  if (settings !== undefined && !isRecord(settings)) throw new Error('hooks.json is not a JSON object; left as it was')
  const next: Record<string, unknown> = structuredClone(settings ?? {})
  if (next.hooks !== undefined && !isRecord(next.hooks))
    throw new Error('hooks.json hooks is not an object; left as it was')
  const hooks = isRecord(next.hooks) ? next.hooks : {}
  next.hooks = hooks
  const ours = (command: string): boolean => ourCommand(command, script)
  // Codex runs Windows commands through a shell; a quoted executable path can be misparsed.
  const command = `bun ${quote(script)} ${MARKER}`
  for (const event of BOARD_EVENTS) {
    const label = labels?.[event]
    const hook = { hooks: [{ type: 'command', command, timeout: 10, ...(label ? { statusMessage: label } : {}) }] }
    if (hooks[event] !== undefined && !Array.isArray(hooks[event]))
      throw new Error(`hooks.json ${event} is not a list; left as it was`)
    const entries = hooks[event]
    const owned = (Array.isArray(entries) ? entries : []).flatMap(e =>
      isRecord(e) && Array.isArray(e.hooks)
        ? e.hooks.flatMap(h =>
            isRecord(h) && h.type === 'command' && typeof h.command === 'string' && ours(h.command) ? [h] : [],
          )
        : [],
    )
    const [only] = owned
    if (owned.length === 1 && only?.command === command && only.statusMessage === label) continue
    hooks[event] = withOurHook(hooks[event], hook, ours, [])
  }
  return next
}

/**
 * herdr's own Codex hook (`herdr integration install codex`) with a name in /hooks, as the board's:
 * the entries whose command runs its `herdr-agent-state.sh` get `label` as their `statusMessage`.
 * Null when there is nothing to change.
 */
export function labelHerdrHook(settings: unknown, label: string): Record<string, unknown> | null {
  if (!isRecord(settings) || !isRecord(settings.hooks)) return null
  const next = structuredClone(settings) as Record<string, unknown> & { hooks: Record<string, unknown> }
  let changed = false
  for (const entries of Object.values(next.hooks)) {
    if (!Array.isArray(entries)) continue
    for (const e of entries) {
      if (!isRecord(e) || !Array.isArray(e.hooks)) continue
      for (const h of e.hooks) {
        if (!isRecord(h) || typeof h.command !== 'string' || !h.command.includes('herdr-agent-state.sh')) continue
        if (h.statusMessage === label) continue
        h.statusMessage = label
        changed = true
      }
    }
  }
  return changed ? next : null
}
