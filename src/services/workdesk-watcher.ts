import { openDb } from '../adapters/db.ts'
import { WorkdeskToolError, withWorkdeskMcp } from '../adapters/workdesk-mcp.ts'
import { type WorkdeskMaster, workdeskStore } from '../adapters/workdesk-store.ts'
import type { Config, Item } from '../core/types.ts'
import { threadsConfig } from '../core/work-threads.ts'
import {
  object,
  projectKey,
  type WorkdeskConfig,
  type WorkdeskPayload,
  type WorkdeskProblem,
  type WorkdeskTask,
  workdeskConfig,
  workdeskTask,
} from '../core/workdesk.ts'
import { sessionsFor } from './sleep.ts'

type Options = {
  cfg: Config
  items(): readonly Item[] | null
  onChange(): void
  log(message: string): void
}

const REQUIRED = ['board_heartbeat', 'list_board_tasks', 'claim_task', 'report_task']
const empty = (): WorkdeskPayload => ({ queue: null, polledAt: null, problem: null })

function masterFor(items: readonly Item[] | null, name: string): WorkdeskMaster | null {
  const matches = sessionsFor(items ?? [], name)
  const item = matches[0]
  if (matches.length !== 1 || !item || (item.agent !== 'claude' && item.agent !== 'codex')) return null
  return { key: item.key, name, lane: item.category }
}

export function createWorkdeskWatcher({ cfg, items, onChange, log }: Options) {
  let status: WorkdeskPayload | null = null
  let config: WorkdeskConfig | null = null
  let signature = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let current: AbortController | null = null
  let inFlight: Promise<void> | null = null
  let loggedProblem = false
  let stopped = false

  function publish(next: WorkdeskPayload | null): void {
    status = next
    if (next?.problem && !loggedProblem) log(`Workdesk watcher: ${next.problem}`)
    loggedProblem = !!next?.problem
    onChange()
  }

  async function poll(active: WorkdeskConfig, signal: AbortSignal): Promise<void> {
    let problem: WorkdeskProblem | null = null
    let queue = status?.queue ?? null
    const polledAt = Date.now()
    try {
      await withWorkdeskMcp(active, signal, async mcp => {
        const tools = await mcp.tools()
        if (tools.has('board_heartbeat')) {
          try {
            const result = object(await mcp.call('board_heartbeat', {}))
            if (result?.ok !== true || !Number.isSafeInteger(result.received_at)) problem = 'heartbeat'
          } catch {
            problem = 'heartbeat'
          }
        }
        if (!REQUIRED.every(name => tools.has(name))) {
          problem = 'tools'
          return
        }

        let listed: unknown
        try {
          listed = object(await mcp.call('list_board_tasks', {}))?.tasks
        } catch {
          problem ??= 'list'
          return
        }
        if (!Array.isArray(listed)) {
          problem ??= 'list'
          return
        }
        const scoped: WorkdeskTask[] = []
        for (const raw of listed) {
          if (active.onlyTaskId && object(raw)?.id !== active.onlyTaskId) continue
          const task = workdeskTask(raw)
          if (task) scoped.push(task)
          else problem ??= 'list'
        }
        const tasks = [...new Map(scoped.map(task => [task.id, task])).values()]
        const eligible = new Set(
          tasks.filter(task => task.status === 'queued' && task.executor === null).map(task => task.id),
        )
        queue = eligible.size
        const threadsOn = threadsConfig(cfg.threads)
        if (!threadsOn) {
          problem ??= 'threads'
          return
        }
        signal.throwIfAborted()

        try {
          const db = openDb()
          if (!db) throw new Error('Workdesk store unavailable')
          try {
            const store = workdeskStore(db)
            store.release(active.onlyTaskId, Date.now())
            for (const task of tasks) {
              signal.throwIfAborted()
              if (!threadsConfig(cfg.threads)) {
                problem ??= 'threads'
                return
              }
              const saved = store.find(task.id)
              const resumed = saved && task.executor === saved.executor
              if (saved?.thread_id || (!eligible.has(task.id) && !resumed)) continue

              const name = saved?.executor ?? active.masters.get(projectKey(task.project)) ?? active.fallback
              const master = masterFor(items(), name)
              if (!master || (saved && master.key !== saved.session_key)) {
                problem ??= 'master'
                continue
              }
              if (!store.reserve(task.id, master)) continue
              let claimed: ReturnType<typeof workdeskTask>
              try {
                claimed = workdeskTask(await mcp.call('claim_task', { task_id: task.id, executor: master.name }))
              } catch (err) {
                problem ??= err instanceof WorkdeskToolError && err.conflict ? 'conflict' : 'claim'
                if (err instanceof WorkdeskToolError && err.conflict) eligible.delete(task.id)
                continue
              }
              signal.throwIfAborted()
              if (!threadsConfig(cfg.threads)) {
                problem ??= 'threads'
                return
              }
              if (
                !claimed ||
                claimed.id !== task.id ||
                claimed.executor !== master.name ||
                claimed.status === 'queued'
              ) {
                problem ??= 'claim'
                continue
              }
              eligible.delete(task.id)
              store.handoff(claimed, master, Date.now())
            }
            store.release(active.onlyTaskId, Date.now())
          } finally {
            db.close()
          }
        } catch {
          problem ??= 'handoff'
        } finally {
          queue = eligible.size
        }
      })
    } catch {
      problem ??= 'connection'
    } finally {
      if (!signal.aborted) publish({ queue, polledAt, problem })
    }
  }

  function arm(delay: number): void {
    clearTimeout(timer)
    if (!config || stopped || inFlight) return
    timer = setTimeout(() => {
      if (!config || stopped) return
      const active = config
      const controller = new AbortController()
      current = controller
      const started = Date.now()
      inFlight = poll(active, controller.signal).finally(() => {
        inFlight = null
        current = null
        // Measure from the beginning of the last poll and never overlap a slow poll.
        arm(controller.signal.aborted ? 0 : Math.max(0, active.intervalSec * 1000 - (Date.now() - started)))
      })
    }, delay)
  }

  return {
    view: () => status,
    configChanged(): void {
      const next = JSON.stringify(cfg.workdesk ?? null)
      if (signature === next) return
      signature = next
      current?.abort()
      config = workdeskConfig(cfg.workdesk)
      if (config) publish(empty())
      else if (cfg.workdesk == null || cfg.workdesk === false) {
        if (status) publish(null)
      } else publish({ ...empty(), problem: 'config' })
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
