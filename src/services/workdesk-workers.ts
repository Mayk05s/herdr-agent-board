import { readCard } from '../adapters/cards.ts'
import { openDb } from '../adapters/db.ts'
import { agentGet, snapshot } from '../adapters/herdr.ts'
import { getThread } from '../adapters/work-thread-store.ts'
import { workdeskHandoffTable } from '../adapters/workdesk-store.ts'
import { changeWorkerRoster, type WorkerChange } from '../adapters/workdesk-worker-store.ts'
import { isOpen } from '../core/work-threads.ts'
import { workdeskConfig } from '../core/workdesk.ts'
import { stableWorkdeskSid, workdeskAgent } from '../core/workdesk-topology.ts'

async function callerSid(): Promise<string> {
  const pane = process.env.HERDR_PANE_ID
  const live = pane ? await agentGet(pane) : null
  if (live && stableWorkdeskSid(live.session)) {
    const claude = process.env.CLAUDE_CODE_SESSION_ID
    if (live.kind === 'claude' && claude === live.session) return live.session
    if (
      live.kind === 'codex' &&
      process.env.CODEX_THREAD_ID === live.session &&
      (!claude || readCard(live.session)?.codexParentClaude === claude)
    )
      return live.session
  }
  throw new Error('Workdesk workers requires the master’s own Claude or Codex session with an exact Herdr SID')
}

function change(master: string, edit: WorkerChange): void {
  const db = openDb({ create: false })
  if (!db) throw new Error('No Workdesk handoff database')
  try {
    const rows = workdeskHandoffTable(db)
      ? db.db
          .query<{ thread_id: string }, [string]>(
            'SELECT thread_id FROM workdesk_handoffs WHERE session_key=? AND thread_id IS NOT NULL',
          )
          .all(master)
      : []
    if (
      !rows.some(row => {
        const thread = getThread(db, row.thread_id)
        return thread && isOpen(thread.status) && thread.assignee?.kind === 'session' && thread.assignee.key === master
      })
    )
      throw new Error('Workdesk workers requires a local Workdesk handoff assigned to this master')
    changeWorkerRoster(db, master, edit)
  } finally {
    db.close()
  }
}

function checkWorker(master: string, worker: unknown): string {
  if (!stableWorkdeskSid(worker) || worker === master) throw new Error('Give the worker’s exact Herdr SID')
  if (readCard(worker)?.forkOf) throw new Error('A fork cannot be registered as a Workdesk worker')
  return worker
}

export const WORKERS_USAGE = 'board workdesk workers link <SID> | unlink <SID> | complete | incomplete'

function requireTopology(raw: unknown): void {
  if (!workdeskConfig(raw)?.topologyDeviceId) throw new Error('Workdesk topology is not configured on this board')
}

export async function workdeskWorkerCommand(args: readonly string[], raw: unknown): Promise<void> {
  if (args.length === 1 && args[0] === '--help') return console.log(WORKERS_USAGE)
  const [workers, op, worker] = args
  if (
    workers !== 'workers' ||
    !(
      (args.length === 3 && (op === 'link' || op === 'unlink')) ||
      (args.length === 2 && (op === 'complete' || op === 'incomplete'))
    )
  )
    throw new Error(WORKERS_USAGE)
  requireTopology(raw)
  const master = await callerSid()
  if (op === 'complete' || op === 'incomplete') change(master, { op })
  else if (op === 'link' || op === 'unlink') {
    const sid = checkWorker(master, worker)
    if (op === 'link') {
      const matches = (await snapshot()).panes.filter(p => p.agent_session?.value === sid && workdeskAgent(p.agent))
      if (matches.length !== 1) throw new Error('The worker SID does not identify one local Claude or Codex session')
    }
    change(master, { op, worker: sid })
  }
  console.log(`ok · Workdesk workers · ${op}`)
}

export async function prepareWorkerLaunch(raw: unknown): Promise<(kind: string, sid: string | null) => void> {
  requireTopology(raw)
  const master = await callerSid()
  // Until the master confirms coverage again, an in-flight or failed launch can leave the roster incomplete.
  change(master, { op: 'incomplete' })
  return (kind, sid) => {
    if (!workdeskAgent(kind)) throw new Error('The launched worker does not have a supported Herdr identity')
    const worker = checkWorker(master, sid)
    change(master, { op: 'link', worker })
  }
}
