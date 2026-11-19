import { damageOf, openDb } from '../adapters/db.ts'
import { getThread } from '../adapters/work-thread-store.ts'
import { workdeskHandoffReader } from '../adapters/workdesk-store.ts'
import { workerRoster } from '../adapters/workdesk-worker-store.ts'
import type { Item } from '../core/types.ts'
import { isOpen } from '../core/work-threads.ts'
import type { WorkdeskTask } from '../core/workdesk.ts'
import {
  type BoardObservation,
  type MasterObservation,
  stableWorkdeskSid,
  topologyV1,
  WORKER_LIMIT,
  type WorkdeskTopology,
  workdeskAgent,
} from '../core/workdesk-topology.ts'

/** A complete roster can still have an unknown status in this Herdr snapshot. */
export function activeWorkers(roster: readonly string[] | null, items: readonly Item[]): number | null {
  if (!roster) return null
  let active = 0
  for (const sid of new Set(roster)) {
    const matches = items.filter(item => item.session === sid)
    const item = matches[0]
    if (matches.length > 1) return null
    if (!item) {
      // An unidentified foreground pane could be the registered worker. Do not infer its identity.
      if (items.some(i => i.pane && workdeskAgent(i.agent) && !stableWorkdeskSid(i.session))) return null
      continue
    }
    if (item.sleeping || item.fork || item.call || item.day || !item.pane || !workdeskAgent(item.agent)) continue
    if (item.status === 'unknown') return null
    if (item.status === 'working' || item.status === 'blocked') active++
  }
  return active <= WORKER_LIMIT ? active : null
}

export function observeWorkdesk(
  device: string,
  observation: BoardObservation | null,
  tasks: readonly WorkdeskTask[],
): WorkdeskTopology | null {
  if (!observation) return null
  const held = tasks.filter(task => (task.status === 'doing' || task.status === 'waiting') && task.executor)
  if (!held.length) return topologyV1(device, observation.observedAt, [])
  if (damageOf() !== null) return null
  const db = openDb({ create: false })
  if (!db) return null
  try {
    const find = workdeskHandoffReader(db)
    const masters = new Map<string, MasterObservation>()
    for (const task of held) {
      const saved = find(task.id)
      // Claims with no corresponding local reservation belong to another observer or workflow.
      if (!saved || saved.executor !== task.executor) continue
      const thread = saved.thread_id ? getThread(db, saved.thread_id) : null
      if (
        !thread ||
        !isOpen(thread.status) ||
        thread.assignee?.kind !== 'session' ||
        thread.assignee.key !== saved.session_key ||
        thread.assignee.name !== saved.executor
      )
        return null
      const sessions = observation.items.filter(item => item.key === saved.session_key)
      const session = sessions[0]
      if (sessions.length !== 1 || !session || !workdeskAgent(session.agent) || !stableWorkdeskSid(session.session))
        return null
      let master = masters.get(session.session)
      if (!master) {
        master = {
          session_id: session.session,
          name: saved.executor,
          task_ids: [],
          workers_active: activeWorkers(workerRoster(db, session.session), observation.items),
        }
        masters.set(session.session, master)
      } else if (master.name !== saved.executor) return null
      master.task_ids.push(task.id)
    }
    return topologyV1(device, observation.observedAt, [...masters.values()])
  } finally {
    db.close()
  }
}
