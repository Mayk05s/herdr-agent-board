// The away journal's service (#489, core/journal.ts): after each refresh of the board it notes
// what changed (one transaction, only when something did), notices the owner's return, and keeps
// the "While you were away" strip the page and the phone read in the board's payload.
//
// The return: with presence on, its switch from away to anything else after at least
// returnMinutes away (the page going off show says nothing then: a full-screen terminal hides the
// browser all day). With presence off, the board's live streams going from none to one after at
// least returnMinutes with none: the page drops its stream while it is hidden (web/src/api/
// useBoard.ts), so that is the page shown again. A client that keeps a stream open all day means
// no return is ever seen. Both are marks in journal.db, so a restart in between loses neither.
//
// While config.json has no `journal`, observe returns at the config check: no file, no query.

import type { BoardDb } from '../adapters/db.ts'
import { type JournalStore, journalStore, openJournalDb, type StripMark } from '../adapters/journal-store.ts'
import {
  awaySince,
  diffStates,
  type JournalConfig,
  type JournalList,
  journalConfig,
  journalList,
  KEEP_MS,
  type StateRow,
} from '../core/journal.ts'
import type { JournalPayload } from '../core/payload.ts'
import type { Presence } from '../core/presence.ts'
import type { Config, Item } from '../core/types.ts'

export interface JournalService {
  /** One refresh's items: what moved is recorded, a return noticed. */
  observe(items: readonly Item[]): void
  /** The payload's part; null while the journal is off (or before its first refresh). */
  view(): JournalPayload | null
  /** The list since `since` (ms), up to `until`; null while off. */
  list(since: number, until?: number): JournalList | null
  /** Since when `--away` lists (core/journal.ts awaySince); null: no absence on record, or off. */
  awaySince(): number | null
  /** The strip dismissed (every page's and the phone's); false when none was on show. */
  dismiss(): boolean
  stop(): void
}

interface Options {
  cfg: Pick<Config, 'journal'>
  log: (line: string) => void
  /** Presence on record while it is on in config.json, else null (services/presence.ts view). */
  presence: () => Presence | null
  /** How many live streams the board has now (the page's, the phone's). */
  viewers: () => number
  /** The strip changed out of a refresh (a dismiss): publish the board. */
  onChange?: () => void
  now?: () => number
}

const HOUR = 60 * 60_000

export function createJournal({ cfg, log, presence, viewers, onChange, now = Date.now }: Options): JournalService {
  let db: BoardDb | null = null
  let store: JournalStore | null = null
  let states: Map<string, StateRow> = new Map()
  let strip: StripMark | null = null
  let stripList: JournalList | null = null
  let prunedAt = 0
  let logged = false

  function open(): JournalStore {
    if (store) return store
    db = openJournalDb(true)
    if (!db) throw new Error('journal.db could not be opened')
    store = journalStore(db)
    states = store.states()
    strip = store.strip()
    stripList = null
    prunedAt = 0
    return store
  }
  function close(): void {
    try {
      db?.close()
    } catch {}
    db = null
    store = null
    states = new Map()
    strip = null
    stripList = null
  }
  function safe<T>(fallback: T, run: () => T): T {
    try {
      const out = run()
      logged = false
      return out
    } catch (err) {
      if (!logged) log(`journal: ${err instanceof Error ? err.message : String(err)}`)
      logged = true
      return fallback
    }
  }

  /** Away or back, as presence or the live streams say; a return long enough sets the strip. */
  function notice(c: JournalConfig, s: JournalStore, at: number): void {
    const marks = s.away()
    const away = marks.left !== undefined && (marks.back === undefined || marks.left > marks.back)
    const p = presence()
    let left: number | undefined
    let back: number | undefined
    if (p) {
      if (p.state === 'away') {
        const since = p.since || at
        if (!away || (marks.left ?? 0) < since) left = since
      } else if (away) back = p.since > (marks.left ?? 0) ? p.since : at
    } else {
      const n = viewers()
      if (n === 0 && !away) left = at
      else if (n > 0 && away) back = at
    }
    if (left !== undefined) s.setMarks({ left })
    if (back === undefined || marks.left === undefined) return
    const from = marks.left
    const long = back - from >= c.returnMinutes * 60_000
    const next = long ? { from, to: back, dismissed: false } : undefined
    s.setMarks({ back, ...(next && { strip: next }) })
    if (next) {
      strip = next
      stripList = null
    }
  }

  return {
    observe(items) {
      const c = journalConfig(cfg.journal)
      if (!c) {
        if (store) close()
        return
      }
      safe(undefined, () => {
        const s = open()
        const at = now()
        const { moves, states: changed } = diffStates(states, items, at, states.size === 0)
        if (moves.length || changed.size) {
          s.record(moves, changed)
          for (const [key, state] of changed) states.set(key, state)
        }
        if (at - prunedAt >= HOUR) {
          prunedAt = at
          if (s.prune(at - KEEP_MS)) states = s.states()
        }
        notice(c, s, at)
      })
    },
    view() {
      if (!journalConfig(cfg.journal) || !store) return null
      if (!strip) return { strip: null, last: null }
      const { from, to, dismissed } = strip
      if (!dismissed && !stripList) {
        const s = store
        stripList = safe(null, () => journalList(s.movesSince(from), states, from, to))
      }
      return { strip: !dismissed && stripList ? { ...stripList, from, to } : null, last: { from, to } }
    },
    list(since, until) {
      if (!journalConfig(cfg.journal)) return null
      return safe(null, () => {
        const s = open()
        return journalList(s.movesSince(since), states, since, until)
      })
    },
    awaySince() {
      if (!journalConfig(cfg.journal)) return null
      return safe(null, () => awaySince(presence(), open().away()))
    },
    dismiss() {
      if (!journalConfig(cfg.journal) || !store || !strip || strip.dismissed) return false
      const next = { ...strip, dismissed: true }
      const s = store
      const ok = safe(false, () => {
        s.setMarks({ strip: next })
        return true
      })
      if (!ok) return false
      strip = next
      onChange?.()
      return true
    },
    stop: close,
  }
}
