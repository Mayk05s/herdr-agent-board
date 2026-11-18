// `board thread watch --owner` (#434, core/owner-watch.ts): after each refresh the web board compares
// what waits on the owner now (cards with an ask, threads in status owner) with what each watching
// session was told, and leaves one line for it in the schedule, as a thread event does
// (services/work-threads.ts): one pending entry `by: 'asks'` at a time, typed in as "[board
// reminder from asks] ...", going to a MokuPilot day session's inbox. A change before it goes out
// replaces it (taken back, never changed in place), told from what the session heard before it,
// so a question asked and settled meanwhile says nothing; the next one after it waits out
// threads.events.gapSec. What a session was told is kept in owner-watch.json in the state folder,
// which only the web board writes. A watch seen for the first time starts from what waits then.
// No `owner` watch: one query, nothing read or written.
import { randomUUID } from 'node:crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { allCards } from '../adapters/cards.ts'
import type { BoardDb } from '../adapters/db.ts'
import { isRecord, readJson } from '../adapters/json-store.ts'
import { stateDir } from '../adapters/paths.ts'
import { entriesOf, listThreads, watchesOf } from '../adapters/work-thread-store.ts'
import {
  ASKS_FROM,
  cardsWaiting,
  OWNER,
  ownerLine,
  sameTold,
  type Told,
  threadsWaiting,
  toldOf,
  waitingFor,
} from '../core/owner-watch.ts'
import type { Card, Item } from '../core/types.ts'
import type { ThreadsConfig } from '../core/work-threads.ts'
import { type EventSchedule, fileSchedule, openAsk } from './work-threads.ts'

/** One watching session's record: what it was told, when its last line was due, and what it heard before a pending one. */
interface Record_ {
  told: Told
  at: number
  base?: Told
}
type State = Record<string, Record_>

export const ownerWatchFile = (): string => join(stateDir(), 'owner-watch.json')

const isTold = (v: unknown): v is Told =>
  isRecord(v) && Object.values(v).every(w => isRecord(w) && typeof w.who === 'string' && typeof w.text === 'string')
const isState = (v: unknown): v is State =>
  isRecord(v) &&
  Object.values(v).every(
    r => isRecord(r) && isTold(r.told) && typeof r.at === 'number' && (r.base === undefined || isTold(r.base)),
  )

function save(path: string, state: State): void {
  if (!Object.keys(state).length) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

export interface OwnerWatchCtx {
  db: BoardDb
  cfg: Pick<ThreadsConfig, 'gapSec'>
  /** The board's items as the last refresh collected them. */
  items: readonly Item[]
  now: number
  /** The cards by key: read from their folder when not given. */
  cards?: () => ReadonlyMap<string, Card>
  /** The tests' schedule and file. */
  schedule?: EventSchedule
  file?: string
}

// What the sessions were told, as last written: the web board is the file's one writer, so it is
// read once, and a board with no `owner` watch reads it no more after that.
let memory: { file: string; state: State } | null = null
function load(file: string): State {
  if (memory?.file !== file) memory = { file, state: readJson(file, isState) ?? {} }
  return memory.state
}
function store(file: string, state: State): void {
  save(file, state)
  memory = { file, state }
}

/** The pending line of a session: one not claimed yet. */
const pendingOf = (schedule: EventSchedule, session: string) =>
  schedule.list().find(e => e.key === session && e.by === 'asks' && !e.claim)

/** Tells every `owner` watcher what changed since it was last told; the sessions given a line. */
export function tellOwnerWatchers(ctx: OwnerWatchCtx): string[] {
  const file = ctx.file ?? ownerWatchFile()
  const all = watchesOf(ctx.db)
  const owners = all.filter(w => w.target === OWNER)
  const before = load(file)
  if (!owners.length) {
    // The last `owner` watch went: what it was told goes too, the file with it.
    if (Object.keys(before).length) store(file, {})
    return []
  }
  const schedule = ctx.schedule ?? fileSchedule
  const heads = listThreads(ctx.db, { status: 'owner' })
  const waiting = [
    ...cardsWaiting(ctx.items, (ctx.cards ?? allCards)()),
    ...threadsWaiting(heads.map(head => ({ head, ask: openAsk(head, entriesOf(ctx.db, head.id))?.text ?? '' }))),
  ]
  const state: State = {}
  const told: string[] = []
  for (const w of owners) {
    const now = toldOf(waitingFor(waiting, w.session, all))
    const had = before[w.session]
    if (!had) {
      state[w.session] = { told: now, at: 0 }
      continue
    }
    if (sameTold(had.told, now)) {
      state[w.session] = had
      continue
    }
    const pending = pendingOf(schedule, w.session)
    // Replaced, not changed in place; one claimed meanwhile goes as it is, and this one follows it.
    const replaced = pending ? schedule.takeBack(pending.id) : false
    const base = replaced && had.base ? had.base : had.told
    const text = ownerLine(base, now)
    if (!text) {
      // Asked and settled before the line went out: nothing to say, and nothing pending.
      state[w.session] = { told: now, at: had.at }
      continue
    }
    const next = replaced && pending ? pending.next : Math.max(ctx.now, had.at + ctx.cfg.gapSec * 1000)
    schedule.add({
      key: w.session,
      ...(w.name && { name: w.name }),
      text,
      at: next,
      next,
      by: 'asks',
      from: { ...ASKS_FROM },
      ...(w.wake ? {} : { noWake: true }),
      ...(w.idle && { idle: true }),
    })
    state[w.session] = { told: now, at: next, base }
    told.push(w.session)
  }
  if (JSON.stringify(state) !== JSON.stringify(before)) store(file, state)
  return told
}
