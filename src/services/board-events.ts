import {
  boardEventStore,
  openBoardEventDb,
  type SessionObservation,
  type StageObservation,
} from '../adapters/board-event-store.ts'
import type { BoardDb } from '../adapters/db.ts'
import type { HerdrSnapshot } from '../adapters/herdr.ts'
import type { Item } from '../core/types.ts'
import { object } from '../core/workdesk.ts'
import type { WorkdeskEvent } from '../core/workdesk-events.ts'
import { stableWorkdeskSid, workdeskAgent } from '../core/workdesk-topology.ts'
import type { Deps } from './deps.ts'

export function sessionObservations(snapshot: HerdrSnapshot, items: readonly Item[]): SessionObservation[] {
  const native = snapshot.panes.flatMap(pane => {
    const sid = pane.agent_session
    if (
      !workdeskAgent(pane.agent) ||
      !stableWorkdeskSid(sid?.value) ||
      (sid.kind !== undefined && sid.kind !== 'id') ||
      (sid.agent !== undefined && sid.agent !== pane.agent) ||
      (sid.source !== undefined && sid.source !== `herdr:${pane.agent}`)
    )
      return []
    return [{ pane, sid: sid.value }]
  })
  const ids = new Map<string, number>()
  for (const { sid } of native) ids.set(sid, (ids.get(sid) ?? 0) + 1)
  return native.flatMap(({ pane, sid }) => {
    if (!pane.terminal_id || ids.get(sid) !== 1) return []
    const item = items.find(i => i.session === sid && i.pane === pane.pane_id && !i.sleeping)
    if (!item) return []
    const phase =
      pane.agent_status === 'blocked'
        ? 'dialog'
        : item.attention === 'ask' || item.attention === 'question'
          ? 'owner'
          : pane.agent_status === 'working'
            ? 'running'
            : pane.agent_status === 'idle' || pane.agent_status === 'done'
              ? 'free'
              : 'unknown'
    return [{ sid, pane: pane.pane_id, terminal: pane.terminal_id, phase }]
  })
}

export function createBoardEvents(deps: Deps) {
  let db: BoardDb | null = null
  let stageTimer: ReturnType<typeof setTimeout> | undefined
  let stopping = false
  let logged = false
  const listeners = new Set<() => void>()
  function enabled() {
    return !stopping && (deps.cfg.boardEvents === true || object(deps.cfg.boardEvents) !== null)
  }
  function store() {
    if (stopping) throw new Error('Board events stopped')
    db ??= openBoardEventDb()
    if (!db) throw new Error('Board event store unavailable')
    return boardEventStore(db)
  }
  const notify = () => {
    for (const listener of listeners) listener()
  }
  function safe(run: () => void) {
    try {
      run()
      logged = false
    } catch {
      if (!logged) deps.log('Board events store unavailable')
      logged = true
    }
  }
  function armStages() {
    clearTimeout(stageTimer)
    if (!enabled()) return
    const next = store().nextStageAt()
    if (next === null) return
    stageTimer = setTimeout(
      () =>
        safe(() => {
          if (!enabled()) return
          store().expireStages(Date.now())
          notify()
          armStages()
        }),
      Math.min(2_147_483_647, Math.max(0, next - Date.now())),
    )
    stageTimer.unref()
  }
  return {
    enabled,
    store,
    ack: (id: number) => store().ack(id),
    listen(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    observe(snapshot: HerdrSnapshot, items: readonly Item[], at: number) {
      if (!enabled()) return
      safe(() => {
        const journal = store()
        journal.health('herdr', true, at)
        const current = sessionObservations(snapshot, items)
        const departed = new Set<string>()
        for (const old of journal.trackedSessions()) {
          // A closed/moved pane or a deliberately sleeping session does not prove a crash.
          if (items.some(i => i.session === old.sid)) continue
          const same = snapshot.panes.find(p => p.terminal_id === old.terminal)
          if (
            same &&
            (!same.agent || (stableWorkdeskSid(same.agent_session?.value) && same.agent_session?.value !== old.sid))
          )
            departed.add(old.sid)
        }
        journal.sessions(current, departed, at)
        notify()
      })
    },
    health(service: string, healthy: boolean) {
      if (enabled())
        safe(() => {
          store().health(service, healthy, Date.now())
          notify()
        })
    },
    stages(observations: readonly StageObservation[]) {
      if (enabled())
        safe(() => {
          store().stages(observations)
          armStages()
        })
    },
    source(source: string, onlyTaskId?: number) {
      return {
        read: () => store().cursor(source).read(),
        reset: () => store().cursor(source).reset(),
        commit: (event: WorkdeskEvent) => {
          store()
            .cursor(source)
            .commit(event, enabled() && (onlyTaskId === undefined || onlyTaskId === event.board_task_id))
          notify()
        },
      }
    },
    async stop() {
      stopping = true
      clearTimeout(stageTimer)
      notify()
      listeners.clear()
      db?.close()
      db = null
    },
  }
}

export type BoardEvents = ReturnType<typeof createBoardEvents>
