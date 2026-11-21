// Decisions on the page (#487, src/server/routes/decisions.ts): an option or the owner's own words
// typed into the session, Hold, and the panel seen. Every change is POST /api/decisions; the board
// that comes back after it shows it. A refusal (a question no longer open, a session that would not
// take it) is a toast. An answer goes through ownerPost, as the Threads panel's does: on a shared
// thread with the passkey on, the board answers 428 once the answer is in, and its going out to the
// peers waits for the confirmation window.
import type { Item, Translator } from '../../../src/core/types.ts'
import { ApiError, api, errorText } from '../api/client.ts'
import { useT } from '../i18n/I18nProvider.tsx'
import { confirmError, ownerPost } from '../models/team-confirm.ts'
import { useBoardContext } from '../state/BoardProvider.tsx'
import { useLatest } from './useLatest.ts'

export interface DecisionsUi {
  /** The option `n` (1-based) of the question `id`, or the owner's words; whether it went. */
  answer(key: string, id: string, choice: { option: number } | { text: string }): Promise<boolean>
  /** A question with no options of the board's (an ask from before): the words as a message. */
  message(item: Item, text: string): Promise<boolean>
  hold(key: string, id: string): Promise<boolean>
  /** The panel showed what went by default up to `upTo` (the newest one's time): seen. */
  seen(upTo: number): void
}

export interface DecisionsDeps {
  post(path: string, body: unknown): Promise<unknown>
  ownerPost(path: string, body: unknown): Promise<unknown>
  toast(text: string, error: boolean): void
  t: Translator
}

/** What the page's buttons do, on the calls and the toast it is given. */
export function decisionsActions(d: DecisionsDeps): DecisionsUi {
  async function post(path: string, body: Record<string, unknown>): Promise<boolean> {
    try {
      await d.post(path, body)
      return true
    } catch (err) {
      d.toast(errorText(err, d.t), true)
      return false
    }
  }
  return {
    async answer(key, id, choice) {
      try {
        await d.ownerPost('/api/decisions', { op: 'answer', key, id, ...choice })
        return true
      } catch (err) {
        const code = err instanceof ApiError ? err.reply.error : null
        // The answer is in; only its going out to a shared thread's peers waits: on the computer
        // (from the owner's phone, #377), or in the thread once the owner closed the window.
        if (code === 'confirm') {
          d.toast(d.t('team.err.confirmAway'), false)
          return true
        }
        if (code === 'cancelled') return true
        d.toast(confirmError(err, d.t) ?? errorText(err, d.t), true)
        return false
      }
    },
    message: (item, text) =>
      post(`/api/session/${encodeURIComponent(item.key)}/message`, { text, session: item.session ?? null }),
    hold: (key, id) => post('/api/decisions', { op: 'hold', key, id }),
    seen: upTo => void d.post('/api/decisions', { op: 'seen', upTo }).catch(() => {}),
  }
}

export function useDecisions(): DecisionsUi {
  const t = useT()
  const board = useBoardContext()
  const latest = useLatest({ t, board })
  return decisionsActions({
    post: (path, body) => api.post(path, body),
    ownerPost: (path, body) => ownerPost(path, body),
    toast: (text, error) => latest.current.board.toast(text, error),
    get t() {
      return latest.current.t
    },
  })
}
