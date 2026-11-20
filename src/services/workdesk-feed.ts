// BOARD-9: the thread of a Workdesk task and the task's chat in Workdesk are one feed (#452).
// For each task the watcher handed to a master (workdesk_handoffs), on the watcher's own MCP
// connection and credential (config.json's `workdesk`):
// - a public entry of a session in the thread (a note, a report's text) goes to the task's chat
//   (post_board_thread_message); a question (`board thread ask`) puts the card under "Ждёт меня"
//   (report_task waiting) instead;
// - the owner's message in the chat comes into the thread as the owner's answer, so the assignee
//   hears it, and is acknowledged (read_owner_messages, ack_owner_messages);
// - a card Workdesk shows as waiting on the owner puts the thread with the owner;
// - the task accepted in Workdesk closes the thread, cancelled drops it.
// On only where `workdesk.feed` is true (or for one task, `bun src/entrypoints/workdesk-feed.ts
// --only <id>`); every other board goes on as before. What was sent and read is kept in
// workdesk-feed.json in the state folder, so a restart neither repeats nor skips an entry.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BoardDb, openDb } from '../adapters/db.ts'
import { stateDir } from '../adapters/paths.ts'
import { entriesOf, getThread } from '../adapters/work-thread-store.ts'
import { WorkdeskToolError, withWorkdeskMcp } from '../adapters/workdesk-mcp.ts'
import { workdeskHandoffTable } from '../adapters/workdesk-store.ts'
import type { Config } from '../core/types.ts'
import { isOpen, type ThreadEntry, type ThreadHead, threadsConfig } from '../core/work-threads.ts'
import { object, type WorkdeskMcpConfig, type WorkdeskTask, workdeskMcpConfig, workdeskTask } from '../core/workdesk.ts'
import { answerAsk, openAsk, postEntry, type ThreadsCtx } from './work-threads.ts'

const CHAT_MAX = 12_000
const SUMMARY_MAX = 4_000
const OWNER = { kind: 'owner' } as const

/** What the feed keeps of one task: its thread, the last entry sent, the last owner message read. */
export type FeedTask = {
  thread: string
  assignment: string
  url: string
  sent: number
  read: number
  closed?: boolean
}
export type FeedState = { tasks: Record<string, FeedTask> }

export const feedFile = (): string => join(stateDir(), 'workdesk-feed.json')

export function readFeed(path = feedFile()): FeedState {
  try {
    if (!existsSync(path)) return { tasks: {} }
    const raw = object(JSON.parse(readFileSync(path, 'utf8')))
    return { tasks: (object(raw?.tasks) as Record<string, FeedTask> | null) ?? {} }
  } catch {
    return { tasks: {} }
  }
}

export function writeFeed(state: FeedState, path = feedFile()): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`)
  renameSync(tmp, path)
}

/** The feed's settings: the watcher's MCP command, on when `workdesk.feed` is true or one task is named. */
export function feedConfig(cfg: Pick<Config, 'workdesk'>, only?: number): WorkdeskMcpConfig | null {
  const raw = object(cfg.workdesk)
  if (!raw || (raw.feed !== true && only === undefined)) return null
  return workdeskMcpConfig(raw)
}

/** The words of an entry that go to the chat: a public note or report of a session, never the owner's own. */
export function chatText(e: ThreadEntry): string | null {
  if (e.author.kind !== 'session' || e.private || e.out) return null
  if (e.type !== 'note') return null
  const words = e.text.trim() || e.set?.summary?.trim() || ''
  if (!words) return null
  const files = e.files?.map(f => f.name) ?? []
  const links = e.links?.map(l => l.url) ?? []
  const tail = [...files.map(f => `📎 ${f}`), ...links].join('\n')
  return (tail ? `${words}\n${tail}` : words).slice(0, CHAT_MAX)
}

/** The Workdesk card the URL names: a Mini App task (`#tasks/-257`) or a Workdesk task (`#tasks/26`). */
export function cardOf(url: string): { task_id: number; source: 'miniapp' | 'workdesk' } | null {
  const m = /#tasks\/(-?)(\d{1,15})$/.exec(url)
  if (!m) return null
  return { task_id: Number(m[2]), source: m[1] ? 'miniapp' : 'workdesk' }
}

type Handoff = { task_id: number; executor: string; thread_id: string }

function handoffs(db: BoardDb): Handoff[] {
  if (!workdeskHandoffTable(db)) return []
  return db.db
    .query<Handoff, []>('SELECT task_id, executor, thread_id FROM workdesk_handoffs WHERE thread_id IS NOT NULL')
    .all()
}

type Mcp = { call(name: string, args: Record<string, unknown>): Promise<unknown> }

export type FeedOptions = {
  cfg: Config
  only?: number
  log(message: string): void
  now?(): number
  path?: string
}

/** One pass over every task the watcher handed out: out, in, the waiting state and the close. */
export async function feedOnce(o: FeedOptions, signal: AbortSignal): Promise<void> {
  const settings = feedConfig(o.cfg, o.only)
  if (!settings) return
  const threads = threadsConfig(o.cfg.threads)
  if (!threads) return
  const db = openDb({ create: false })
  if (!db) return
  const state = readFeed(o.path)
  const save = () => writeFeed(state, o.path)
  const now = o.now ?? Date.now
  const ctx = (): ThreadsCtx => ({ db, cfg: threads, actor: OWNER, now: now() })
  try {
    const rows = handoffs(db).filter(h => o.only === undefined || h.task_id === o.only)
    const watched = rows.filter(h => !state.tasks[h.task_id]?.closed)
    if (!watched.length) return
    await withWorkdeskMcp(settings, signal, async mcp => {
      // Without include_key: the URL keeps the card's number (#tasks/-257), which get_codex_review takes.
      const listed = object(await mcp.call('list_board_tasks', {}))?.tasks
      if (!Array.isArray(listed)) throw new Error('Workdesk list unavailable')
      const active = new Map<number, { task: WorkdeskTask; summary: string }>()
      for (const raw of listed) {
        const task = workdeskTask(raw)
        const summary = object(raw)?.summary
        if (task) active.set(task.id, { task, summary: typeof summary === 'string' ? summary : '' })
      }
      for (const h of watched) {
        signal.throwIfAborted()
        const head = getThread(db, h.thread_id)
        if (!head) continue
        const live = active.get(h.task_id)
        try {
          const assignment = live?.task.assignment
          if (live && assignment && live.task.executor === h.executor) {
            const { task } = live
            const round = { task_id: task.id, assignment_id: assignment.id, revision: assignment.revision }
            let fed = state.tasks[h.task_id]
            if (!fed || fed.thread !== head.id || fed.assignment !== round.assignment_id) {
              // A task met for the first time: from now on, the thread's past stays where it is.
              fed = {
                thread: head.id,
                assignment: round.assignment_id,
                url: task.url,
                sent: head.rev,
                read: fed?.read ?? 0,
              }
              state.tasks[h.task_id] = fed
              save()
            }
            await outbound(db, mcp, h, head, round, fed, save, o.log)
            await inbound(ctx, mcp, h, round, fed, save, o.log)
            ownerWait(ctx, h.thread_id, live.task.status, live.summary)
          } else if (!live) await closeIfDone(ctx, mcp, h, state, save, o.log)
        } catch (err) {
          if (signal.aborted) throw err
          o.log(`Workdesk feed: task ${h.task_id}: ${err instanceof Error ? err.message : err}`)
        }
      }
    })
  } finally {
    db.close()
  }
}

type Round = { task_id: number; assignment_id: string; revision: number }

async function outbound(
  db: BoardDb,
  mcp: Mcp,
  h: Handoff,
  head: ThreadHead,
  round: Round,
  fed: FeedTask,
  save: () => void,
  log: (m: string) => void,
): Promise<void> {
  for (const e of entriesOf(db, head.id, { since: fed.sent })) {
    try {
      if (e.type === 'ask' && e.author.kind === 'session' && e.text.trim()) {
        await mcp.call('report_task', {
          ...round,
          status: 'waiting',
          summary: `Нужно от вас: ${e.text.trim()}`.slice(0, SUMMARY_MAX),
        })
      } else {
        const text = chatText(e)
        if (text && e.author.kind === 'session')
          await mcp.call('post_board_thread_message', {
            ...round,
            executor: h.executor,
            thread_uuid: head.id,
            entry_uuid: e.id,
            author: e.author.name.slice(0, 100),
            text,
          })
      }
    } catch (err) {
      // A refusal stays one: the entry is passed by and said in the log; a lost connection is tried again.
      if (!(err instanceof WorkdeskToolError)) throw err
      log(`Workdesk feed: ${h.task_id} #${e.n} not sent (${err.code ?? 'refused'})`)
    }
    fed.sent = e.n
    save()
  }
}

async function inbound(
  ctx: () => ThreadsCtx,
  mcp: Mcp,
  h: Handoff,
  round: Round,
  fed: FeedTask,
  save: () => void,
  log: (m: string) => void,
): Promise<void> {
  const key = { task_id: round.task_id, assignment_id: round.assignment_id, executor: h.executor }
  const page = object(await mcp.call('read_owner_messages', key))
  const messages = Array.isArray(page?.messages) ? page.messages : []
  let through = 0
  for (const raw of messages) {
    const m = object(raw)
    const id = m?.id
    const text = typeof m?.text === 'string' ? m.text.trim() : ''
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) break
    if (id > fed.read && text) {
      const c = ctx()
      const head = getThread(c.db, h.thread_id)
      if (!head) break
      const words = m?.kind === 'rework' ? `Доработка: ${text}` : text
      try {
        answerAsk(c, head, words)
      } catch {
        // No open question (or a close proposed meanwhile): the owner's words come as an answer all the same.
        postEntry(c, head, { type: 'answer', text: words })
      }
      fed.read = id
      save()
    }
    through = id
  }
  if (through > (typeof page?.delivered_through === 'number' ? page.delivered_through : 0))
    try {
      await mcp.call('ack_owner_messages', { ...key, through })
    } catch (err) {
      log(`Workdesk feed: ${h.task_id} ack: ${err instanceof Error ? err.message : err}`)
    }
}

/** Workdesk waits on the owner and the thread does not: the thread goes to the owner with the card's words. */
function ownerWait(ctx: () => ThreadsCtx, thread: string, status: WorkdeskTask['status'], summary: string): void {
  if (status !== 'waiting') return
  const c = ctx()
  const head = getThread(c.db, thread)
  if (!head || head.status === 'owner' || !isOpen(head.status)) return
  if (openAsk(head, entriesOf(c.db, head.id))) return
  const words = summary.replace(/\s+/g, ' ').trim()
  postEntry(c, head, { status: 'owner', ...(words && { waitingOn: words.slice(0, 200) }) })
}

/** The task left the board's list: accepted closes the thread, cancelled drops it; awaiting acceptance leaves it. */
async function closeIfDone(
  ctx: () => ThreadsCtx,
  mcp: Mcp,
  h: Handoff,
  state: FeedState,
  save: () => void,
  log: (m: string) => void,
): Promise<void> {
  const fed = state.tasks[h.task_id]
  if (!fed) return
  const c = ctx()
  const head = getThread(c.db, h.thread_id)
  if (!head) return
  const card = cardOf(fed.url)
  if (!card) return
  const run = object(object(await mcp.call('get_codex_review', card))?.task)
  const status = run?.status
  if (status !== 'done' && status !== 'cancelled') return
  if (isOpen(head.status))
    postEntry(c, head, {
      status: status === 'done' ? 'done' : 'dropped',
      summary: status === 'done' ? 'Принято в Workdesk' : 'Отменено в Workdesk',
    })
  fed.closed = true
  save()
  log(`Workdesk feed: ${h.task_id} ${status === 'done' ? 'accepted' : 'cancelled'}, thread closed`)
}

/** Runs the feed every `intervalSec` until `signal` aborts. */
export async function runWorkdeskFeed(o: FeedOptions & { intervalSec?: number }, signal: AbortSignal): Promise<void> {
  const every = (o.intervalSec ?? 15) * 1000
  while (!signal.aborted) {
    try {
      await feedOnce(o, signal)
    } catch (err) {
      if (!signal.aborted) o.log(`Workdesk feed: ${err instanceof Error ? err.message : err}`)
    }
    await new Promise<void>(resolve => {
      const t = setTimeout(resolve, every)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          resolve()
        },
        { once: true },
      )
    })
  }
}
