// The board's own server's state for a part of the page (the head's chip, the Server panel): it says
// how often it wants it (null: not now), and draws again with each answer. One poll for the page
// (models/server-state.ts createServerPoll), made at the first want: a page that never shows the
// server's state (a PC's) makes none.
import { useEffect } from 'react'
import { api } from '../api/client.ts'
import { createServerPoll, isSystemView, type ServerPoll, type ServerSnapshot } from '../models/server-state.ts'
import { useStore } from '../state/store.ts'

let pagePoll: ServerPoll | null = null

/** No document (drawn to markup, not in a browser): never visible, so nothing is asked. */
const NO_DOCUMENT = { visibilityState: 'hidden', addEventListener() {}, removeEventListener() {} } as const

/** The page's poll of GET /api/system. */
export function serverPoll(): ServerPoll {
  pagePoll ??= createServerPoll({
    get: () => api.get('/api/system', isSystemView, { cache: 'no-store' }),
    doc: typeof document === 'undefined' ? NO_DOCUMENT : document,
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    now: Date.now,
  })
  return pagePoll
}

/** The state as `poll` has it; `who` wants it every `ms` (null: not now) while it is drawn. */
export function useServerState(who: string, ms: number | null, poll: ServerPoll = serverPoll()): ServerSnapshot {
  useEffect(() => {
    poll.want(who, ms)
    return () => poll.want(who, null)
  }, [poll, who, ms])
  return useStore(poll.store)
}
