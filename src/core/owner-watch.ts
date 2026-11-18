// Everything that waits on the owner, for a session that watches it (#434): `board thread watch
// --owner`. A MokuPilot day session (the owner talks to it by voice all day) sets it so that an
// agent waiting on the owner reaches him at once, whatever its lane or profile. Not a thread
// digest (core/work-threads.ts covers no `owner` target): the server compares what waits now with
// what the session was told and leaves one line in the schedule (services/owner-watch.ts).
// Pure: the set, what a session is told of it, and the line.
import { cleanName } from './schedule-rules.ts'
import type { Card, Item } from './types.ts'
import {
  clip,
  EVENT_MAX,
  EVENT_SPELLED,
  isSession,
  MINE,
  oneLine,
  type Party,
  SUMMARY_MAX,
  sharedOf,
  type ThreadHead,
  type Watch,
} from './work-threads.ts'

/** The watch's target in thread_watch: no thread, lane or `mine` is called that. */
export const OWNER = 'owner'

/** The tag its line is typed with, from the scheduler's `from`: `[board reminder from asks]`. */
export const ASKS_FROM = { key: 'asks', name: 'asks' } as const

/** One thing that waits on the owner: a card (`card:<key>`) or a thread (`thread:<id>`). */
export interface Waiting {
  id: string
  /** The session's name, or the thread's key. */
  who: string
  /** Its question in one line; '' when it may not be typed in (a shared thread's). */
  text: string
  /** A card's session: its key and Claude session id. */
  card?: { key: string; session: string | null }
  thread?: ThreadHead
  /** Who put the thread on the owner: the author of its open question, else of the entry that set the status. */
  by?: Party | null
}

/** What a session was told: by id, who and the question it heard. */
export type Told = Record<string, { who: string; text: string }>

/**
 * The cards that wait on the owner: their `board ask`, or the board's "needs the user" ask (a secret
 * request only the owner can fill, #273). The card's ask counts while its session works on too: the
 * column hides it then, but a session that asked and took a reminder in would otherwise be told as
 * settled and asked again each time it worked.
 */
export function cardsWaiting(items: readonly Item[], cards: ReadonlyMap<string, Card>): Waiting[] {
  const out: Waiting[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (!item?.key || seen.has(item.key)) continue
    seen.add(item.key)
    const ask = cards.get(item.key)?.ask
    const own = typeof ask === 'string' ? ask.trim() : ''
    if (!own && item.attention !== 'ask') continue
    out.push({
      id: `card:${item.key}`,
      who: cleanName(item.name || item.autoName) || item.key.slice(0, 8),
      text: oneLine(own || item.question || '', SUMMARY_MAX),
      card: { key: item.key, session: item.session ?? null },
    })
  }
  return out
}

/**
 * The open threads in status owner, each with its open question ('' for none) and who put it on
 * the owner. A peer's words never go in.
 */
export function threadsWaiting(threads: readonly { head: ThreadHead; ask: string; by?: Party | null }[]): Waiting[] {
  return threads
    .filter(t => t.head.status === 'owner')
    .map(({ head, ask, by }) => ({
      id: `thread:${head.id}`,
      who: head.key,
      text: sharedOf(head) ? '' : oneLine(ask || head.waitingOn || head.summary || head.title, SUMMARY_MAX),
      thread: head,
      by: by ?? null,
    }))
}

/**
 * Whether the session hears of the thread waiting on the owner already: it put it there, it created
 * it (a creator hears of its status changes), or another of its watches covers it and hears status
 * changes. An assignee's own watch hears answers only, so a thread someone else set to the owner
 * is still told to it.
 */
function heardElsewhere(w: Waiting & { thread: ThreadHead }, session: string, watches: readonly Watch[]): boolean {
  const h = w.thread
  if (isSession(w.by, session) || isSession(h.createdBy, session)) return true
  return watches.some(
    x =>
      x.session === session &&
      x.target !== OWNER &&
      x.what !== 'answers' &&
      (x.target === h.id ||
        x.target === `lane:${h.lane}` ||
        (x.target === MINE && (isSession(h.createdBy, session) || isSession(h.assignee, session)))),
  )
}

/** What waits on the owner as `session` hears it: never its own card, nor a thread it hears of already. */
export function waitingFor(all: readonly Waiting[], session: string, watches: readonly Watch[]): Waiting[] {
  return all.filter(w =>
    w.card
      ? w.card.key !== session && w.card.session !== session
      : !(w.thread && heardElsewhere(w as Waiting & { thread: ThreadHead }, session, watches)),
  )
}

/** The set as it is told: by id. */
export const toldOf = (now: readonly Waiting[]): Told =>
  Object.fromEntries(now.map(w => [w.id, { who: w.who, text: w.text }]))

/** The same ids with the same questions: nothing to tell. */
export function sameTold(a: Told, b: Told): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  return ka.every(k => b[k] !== undefined && b[k].text === a[k]?.text)
}

/**
 * The line for what changed from `before` to `now`, '' for nothing: a new or changed question
 * first ("anna asks the owner: <question>"), then what is settled ("ben: settled"). At most
 * EVENT_SPELLED clauses of each spelled out, then "and N more"; EVENT_MAX characters at most.
 */
export function ownerLine(before: Told, now: Told): string {
  const asks = Object.entries(now).filter(([id, w]) => before[id]?.text !== w.text)
  const settled = Object.entries(before).filter(([id]) => !now[id])
  if (!asks.length && !settled.length) return ''
  const shownAsks = asks.slice(0, EVENT_SPELLED)
  const shownSettled = settled.slice(0, EVENT_SPELLED)
  const more = asks.length - shownAsks.length + settled.length - shownSettled.length
  const build = (max: number): string =>
    [
      ...shownAsks.map(([, w]) => `${w.who} asks the owner${w.text ? `: ${clip(w.text, Math.max(8, max))}` : ''}`),
      ...shownSettled.map(([, w]) => `${w.who}: settled`),
    ].join(' · ') + (more > 0 ? ` · and ${more} more` : '')
  let line = build(SUMMARY_MAX)
  for (let max = SUMMARY_MAX; line.length > EVENT_MAX && max > 8; max -= 4) line = build(max)
  return clip(line, EVENT_MAX)
}
