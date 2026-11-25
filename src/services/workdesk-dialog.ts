import { openDb } from '../adapters/db.ts'
import { workdeskDialogStore } from '../adapters/workdesk-dialog-store.ts'
import { WorkdeskToolError, withWorkdeskMcp } from '../adapters/workdesk-mcp.ts'
import type { Config, Item } from '../core/types.ts'
import { threadsConfig } from '../core/work-threads.ts'
import { object, type WorkdeskTask, workdeskTask } from '../core/workdesk.ts'
import {
  DIALOG_TOOLS,
  type DialogProblem,
  type DialogStatus,
  OWNER_EVENT_LIMIT,
  ownerEvents,
  type WorkdeskDialogConfig,
  workdeskDialogConfig,
} from '../core/workdesk-dialog.ts'

type Options = {
  cfg: Config
  items(): readonly Item[] | null
  onChange(): void
  streamDriven?(): boolean
}

const idle = (): DialogStatus => ({
  delivery: 'awaiting_recipient',
  pending: null,
  more: null,
  polledAt: null,
  problem: null,
  blocked: {},
})
const MAX_DISCOVERY_PAGES = 10

function toolProblem(error: unknown, fallback: DialogProblem): DialogProblem {
  if (!(error instanceof WorkdeskToolError)) return fallback
  if (error.code === 'conflict') return 'executor_changed'
  if (error.code === 'assignment_mismatch' || error.code === 'role_denied' || error.code === 'invalid_cursor')
    return error.code
  return fallback
}

export function createWorkdeskDialog({ cfg, items, onChange, streamDriven }: Options) {
  let status: DialogStatus | null = null
  let config: WorkdeskDialogConfig | null = null
  let signature = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let current: AbortController | null = null
  let inFlight: Promise<DialogStatus> | null = null
  let stopped = false

  function publish(next: DialogStatus | null): void {
    status = next
    onChange()
  }

  async function poll(active: WorkdeskDialogConfig, signal: AbortSignal): Promise<DialogStatus> {
    const next: DialogStatus = { ...idle(), pending: status?.pending ?? null, polledAt: Date.now() }
    try {
      await withWorkdeskMcp(active, signal, async mcp => {
        const tools = await mcp.tools()
        if (!DIALOG_TOOLS.every(tool => tools.has(tool))) {
          next.problem = 'tools'
          return
        }
        signal.throwIfAborted()
        try {
          const db = openDb()
          if (!db) throw new Error('Workdesk dialog store unavailable')
          try {
            const store = workdeskDialogStore(db, items)
            for (let n = 0; n < MAX_DISCOVERY_PAGES; n++) {
              const after = store.cursor()
              let data: unknown
              try {
                data = await mcp.call('list_owner_events', { after, limit: OWNER_EVENT_LIMIT })
              } catch (error) {
                next.problem = toolProblem(error, 'list')
                break
              }
              signal.throwIfAborted()
              const page = ownerEvents(data, after)
              if (!page) {
                next.problem = 'invalid_page'
                break
              }
              if (store.retain(after, page.entries, page.cursor)) {
                next.more = page.more
                if (!page.more) break
              }
            }

            let legacyTasks: Map<number, WorkdeskTask | null> | undefined
            async function readLegacyTasks(): Promise<Map<number, WorkdeskTask | null>> {
              const tasks = new Map<number, WorkdeskTask | null>()
              if (!tools.has('list_board_tasks')) return tasks
              const response = object(await mcp.call('list_board_tasks', {}))
              signal.throwIfAborted()
              if (!Array.isArray(response?.tasks)) return tasks
              for (const raw of response.tasks) {
                const id = object(raw)?.id
                if (typeof id !== 'number' || !active.legacyBindings.has(id)) continue
                tasks.set(id, tasks.has(id) ? null : workdeskTask(raw))
              }
              return tasks
            }

            async function deliver(group: ReturnType<typeof store.pending>[number]): Promise<DialogProblem | null> {
              if (!threadsConfig(cfg.threads)) return 'threads_disabled'
              let resolved = store.resolve(group)
              const pin = active.legacyBindings.get(group.board_task_id)
              if (pin && 'problem' in resolved && resolved.problem === 'assignment_unverified') {
                if (pin.assignmentId !== group.assignment_id) return 'assignment_mismatch'
                try {
                  legacyTasks ??= await readLegacyTasks()
                } catch (error) {
                  signal.throwIfAborted()
                  return toolProblem(error, 'legacy_source_unavailable')
                }
                if (!threadsConfig(cfg.threads)) return 'threads_disabled'
                const remote = legacyTasks.get(pin.taskId)
                if (!remote) return 'legacy_source_unavailable'
                resolved = store.adoptLegacy(group, pin, remote)
              }
              if ('problem' in resolved) return resolved.problem
              const { binding } = resolved
              return store.notice(group, binding, Date.now()) ?? 'protected_delivery_unavailable'
            }

            const pending = store.pending(active.onlyTaskId)
            if (next.problem === 'role_denied') {
              next.pending = pending.reduce((count, group) => count + group.count, 0)
              return
            }
            for (const group of pending) {
              signal.throwIfAborted()
              const problem = await deliver(group)
              if (problem) next.blocked[problem] = (next.blocked[problem] ?? 0) + group.count
            }
            next.pending = store.pending(active.onlyTaskId).reduce((count, group) => count + group.count, 0)
          } finally {
            db.close()
          }
        } catch {
          next.problem ??= 'store'
        }
      })
    } catch {
      next.problem ??= 'connection'
    } finally {
      if (!signal.aborted) publish(next)
    }
    return next
  }

  function start(active: WorkdeskDialogConfig, parent?: AbortSignal) {
    const controller = new AbortController()
    current = controller
    const signal = parent ? AbortSignal.any([controller.signal, parent]) : controller.signal
    inFlight = poll(active, signal).finally(() => {
      inFlight = null
      current = null
    })
    return inFlight
  }

  function arm(delay: number): void {
    clearTimeout(timer)
    if (!config || stopped || inFlight || streamDriven?.()) return
    timer = setTimeout(() => {
      if (!config || stopped) return
      const active = config
      const started = Date.now()
      void start(active).finally(() =>
        arm(config !== active ? 0 : Math.max(0, active.intervalSec * 1000 - (Date.now() - started))),
      )
    }, delay)
  }

  return {
    view: () => status,
    async reconcile(signal: AbortSignal, required = false): Promise<void> {
      while (inFlight) await inFlight
      signal.throwIfAborted()
      if (!config || stopped) {
        if (required) throw new Error('Workdesk dialog unavailable')
        return
      }
      const status = await start(config, signal)
      signal.throwIfAborted()
      if (status.problem || status.more) throw new Error('Workdesk dialog reconciliation incomplete')
    },
    configChanged(): void {
      const next = JSON.stringify(cfg.workdeskDialog ? [cfg.workdeskDialog, cfg.workdesk] : null)
      if (signature === next) return
      signature = next
      current?.abort()
      config = workdeskDialogConfig(cfg.workdeskDialog, cfg.workdesk)
      if (config) publish(idle())
      else if (cfg.workdeskDialog == null || cfg.workdeskDialog === false) {
        if (status) publish(null)
      } else publish({ ...idle(), problem: 'config' })
      arm(0)
    },
    async stop(): Promise<void> {
      stopped = true
      clearTimeout(timer)
      current?.abort()
      await inFlight
    },
  }
}
