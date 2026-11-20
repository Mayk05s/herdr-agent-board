import { eventCursor } from '../../core/workdesk-events.ts'
import type { BoardEvents } from '../../services/board-events.ts'
import { json, type Route } from '../http.ts'
import { replayResponse } from '../sse.ts'

/** Only mounted on the local Board listener. Require a non-browser request. */
export function boardEventRoutes(events: BoardEvents): Route[] {
  const path = '/api/board-events'
  function refused(req: Request): Response | null {
    if (!events.enabled()) return json(404, { error: 'disabled' })
    return req.headers.get('x-board') !== '1' || req.headers.has('origin')
      ? json(403, { error: 'local_coordinator' })
      : null
  }
  return [
    {
      method: 'GET',
      path,
      handle(req, { url }) {
        const denied = refused(req)
        if (denied) return denied
        const cursors = url.searchParams.getAll('since')
        const requested = cursors[0] ?? req.headers.get('last-event-id')
        const cursorOverride = requested === null ? undefined : eventCursor(requested)
        if (cursors.length > 1 || cursorOverride === null) return json(400, { error: 'invalid_cursor' })
        const store = events.store()
        const cursor = cursorOverride ?? store.readerCursor()
        const floor = store.replayFloor()
        const high = store.highWater()
        if (cursor < floor || cursor > high)
          return json(409, { error: 'cursor_reset', reset_cursor: floor, high_water: high })
        return replayResponse(
          req,
          cursor,
          position => {
            if (!events.enabled() || position < store.replayFloor() || position > store.highWater())
              throw new Error('Board event stream must reconnect')
            return store.read(position)
          },
          events.listen,
        )
      },
    },
    {
      method: 'POST',
      path: `${path}/ack`,
      async handle(req, { body }) {
        const denied = refused(req)
        if (denied) return denied
        const { through } = await body()
        const cursor = typeof through === 'number' ? eventCursor(String(through)) : null
        if (cursor === null || !events.ack(cursor)) return json(400, { error: 'invalid_cursor' })
        return json(200, { ok: true })
      },
    },
  ]
}
