import type { WorkdeskConnection } from '../adapters/workdesk-events.ts'
import { WorkdeskCursorReset } from '../adapters/workdesk-events.ts'
import type { WorkdeskEvent } from '../core/workdesk-events.ts'

type Cursor = {
  read(): number
  commit(event: WorkdeskEvent): void
  reset(): void
}
type Options = {
  signal: AbortSignal
  cursor: Cursor
  connect(since: number, signal: AbortSignal): Promise<WorkdeskConnection>
  reconcile(signal: AbortSignal): Promise<void>
  apply(event: WorkdeskEvent, signal: AbortSignal): Promise<void>
  connectionHealthy(healthy: boolean): void
  intervalMs?: number
  minRetryMs?: number
  maxRetryMs?: number
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

/** One consumer and one reconciler. Pull one frame ahead while applying the snapshot and use
 * stream backpressure for the remainder. Leave a failed/unprocessed frame above the cursor. */
export async function runWorkdeskEvents({
  signal,
  cursor,
  connect,
  reconcile,
  apply,
  connectionHealthy,
  intervalMs = 600_000,
  minRetryMs = 2_000,
  maxRetryMs = 60_000,
}: Options): Promise<void> {
  let lastPoll: number | null = null
  let needsSnapshot = true
  let retry = minRetryMs
  let outage = false
  async function poll() {
    lastPoll = Date.now()
    await reconcile(signal)
  }
  while (!signal.aborted) {
    let connection: WorkdeskConnection | undefined
    let reset = false
    const attempt = new AbortController()
    const scope = AbortSignal.any([signal, attempt.signal])
    try {
      let since = cursor.read()
      connection = await connect(since, scope)
      const events = connection.events
      // The first frame can arrive or fail while the initial snapshot is being applied.
      const next = () =>
        events.next().then(
          value => ({ value }),
          () => ({ value: null }),
        )
      let frame = next()
      if (!outage) connectionHealthy(true)
      if (needsSnapshot) {
        await poll()
        needsSnapshot = false
      }
      for (;;) {
        signal.throwIfAborted()
        const tick = new AbortController()
        const due = Math.max(0, (lastPoll ?? 0) + intervalMs - Date.now())
        let result: Awaited<typeof frame> | null
        try {
          result = await Promise.race([frame, delay(due, AbortSignal.any([scope, tick.signal])).then(() => null)])
        } finally {
          tick.abort()
        }
        if (result === null) {
          signal.throwIfAborted()
          await poll()
          retry = minRetryMs
          outage = false
          connectionHealthy(true)
          continue
        }
        if (!result.value || result.value.done) throw new Error('Workdesk SSE disconnected')
        const event = result.value.value
        if (event.id > since) {
          await apply(event, signal)
          signal.throwIfAborted()
          cursor.commit(event)
          since = event.id
        }
        retry = minRetryMs
        outage = false
        connectionHealthy(true)
        frame = next()
      }
    } catch (err) {
      if (signal.aborted) return
      if (err instanceof WorkdeskCursorReset) {
        try {
          cursor.reset()
          needsSnapshot = true
          reset = true
        } catch {
          // The previous cursor is still on disk. Retry the reset after fallback/backoff.
        }
      }
      connectionHealthy(false)
    } finally {
      attempt.abort()
      connection?.close()
      await connection?.events.return(undefined).catch(() => {})
    }
    if (signal.aborted) return
    if (reset) continue
    // Poll at the first outage and at the normal fallback cadence during a long outage.
    if (!outage || lastPoll === null || Date.now() - lastPoll >= intervalMs) {
      outage = true
      try {
        await poll()
      } catch {
        // Leave the cursor untouched. A later reconciliation or replay will retry the work.
      }
    }
    await delay(retry, signal)
    retry = Math.min(maxRetryMs, retry * 2)
  }
}

type Watcher = { reconcile(signal: AbortSignal, targetId?: number): Promise<void> }
type Dialog = { reconcile(signal: AbortSignal, required?: boolean): Promise<void> }

export function workdeskEventHandlers(watcher: Watcher, dialog: Dialog, onlyTaskId?: number) {
  return {
    async reconcile(signal: AbortSignal) {
      try {
        await watcher.reconcile(signal)
      } finally {
        await dialog.reconcile(signal)
      }
    },
    async apply(event: WorkdeskEvent, signal: AbortSignal) {
      if (onlyTaskId !== undefined && event.board_task_id !== onlyTaskId) return
      if (event.type === 'task.created') return // The committed assignment event follows this in the same transaction.
      if (event.type !== 'owner.message') await watcher.reconcile(signal, event.board_task_id)
      if (event.type === 'owner.message' || event.type === 'owner.rework') await dialog.reconcile(signal, true)
    },
  }
}
