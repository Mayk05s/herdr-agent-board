import { eventCursor, type WorkdeskEvent, type WorkdeskEventsConfig, workdeskEvent } from '../core/workdesk-events.ts'

const MAX_FRAME = 64 * 1024
const READ_TIMEOUT = 45_000

export async function* workdeskFrames(
  body: ReadableStream<Uint8Array>,
  onRead: () => void,
): AsyncGenerator<WorkdeskEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  let id: string | undefined
  let event: string | undefined
  let data: string | undefined
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return
      onRead()
      pending += decoder.decode(chunk.value, { stream: true })
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end).replace(/\r$/, '')
        pending = pending.slice(end + 1)
        size += end + 1
        if (size > MAX_FRAME) throw new Error('Workdesk SSE frame too large')
        if (!line) {
          const fields = [id, event, data] as const
          id = event = data = undefined
          size = 0
          if (fields.every(part => part === undefined)) continue
          if (fields[0] === undefined || fields[1] === undefined || fields[2] === undefined)
            throw new Error('Incomplete Workdesk SSE frame')
          const parsed = workdeskEvent(fields[0], fields[1], fields[2])
          if (!parsed) throw new Error('Invalid Workdesk SSE event')
          yield parsed
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        if (colon === -1) throw new Error('Invalid Workdesk SSE field')
        const key = line.slice(0, colon)
        const value = line.slice(colon + 1).replace(/^ /, '')
        if (key === 'id' && id === undefined) id = value
        else if (key === 'event' && event === undefined) event = value
        else if (key === 'data' && data === undefined) data = value
        else throw new Error('Unexpected Workdesk SSE field')
      }
      if (size + pending.length > MAX_FRAME) throw new Error('Workdesk SSE frame too large')
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export class WorkdeskCursorReset extends Error {
  constructor(readonly highWater: number) {
    super('Workdesk SSE cursor reset')
  }
}

export type WorkdeskConnection = {
  events: AsyncGenerator<WorkdeskEvent>
  close(): void
}

export async function connectWorkdeskEvents(
  config: WorkdeskEventsConfig,
  since: number,
  signal: AbortSignal,
  fetcher: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> = fetch,
): Promise<WorkdeskConnection> {
  const idle = new AbortController()
  let timer: ReturnType<typeof setTimeout>
  const clear = () => clearTimeout(timer)
  const arm = () => {
    clear()
    timer = setTimeout(() => idle.abort(), READ_TIMEOUT)
    timer.unref()
  }
  const url = new URL(config.url)
  url.searchParams.set('since', String(since))
  const token = (await Bun.file(config.tokenFile).text()).trim()
  if (!/^[!-~]+$/.test(token)) throw new Error('Invalid Workdesk SSE credential')
  const ca = config.caFile ? await Bun.file(config.caFile).text() : undefined
  const combined = AbortSignal.any([signal, idle.signal])
  const close = () => {
    clear()
    idle.abort()
  }
  arm()
  try {
    const response = await fetcher(url, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` },
      signal: combined,
      redirect: 'error',
      ...(ca && { tls: { ca } }),
    })
    if (response.status === 409 && response.body) {
      const reader = response.body.getReader()
      try {
        let received = 0
        let data = ''
        const decoder = new TextDecoder()
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          received += chunk.value.byteLength
          if (received > 1024) throw new Error('Invalid Workdesk SSE reset')
          data += decoder.decode(chunk.value, { stream: true })
        }
        const body = JSON.parse(data + decoder.decode())
        const highWater = typeof body?.high_water === 'number' ? eventCursor(String(body.high_water)) : null
        if (body?.error === 'cursor_reset' && body.reset_cursor === 0 && highWater !== null && since > highWater)
          throw new WorkdeskCursorReset(highWater)
      } finally {
        await reader.cancel().catch(() => {})
      }
      throw new Error('Invalid Workdesk SSE reset')
    }
    if (
      !response.ok ||
      !response.body ||
      response.headers.get('content-type')?.split(';')[0]?.trim() !== 'text/event-stream'
    ) {
      await response.body?.cancel()
      throw new Error(`Workdesk SSE unavailable (HTTP ${response.status})`)
    }
    // Time out while waiting for bytes. Do not time out a paused iterator while the consumer
    // applies a snapshot or commits an event.
    const frames = workdeskFrames(response.body, arm)
    return {
      events: (async function* () {
        try {
          for (;;) {
            arm()
            const out = await frames.next()
            clear()
            if (out.done) return
            yield out.value
          }
        } finally {
          close()
          await frames.return(undefined)
        }
      })(),
      close,
    }
  } catch (error) {
    close()
    throw error
  } finally {
    // The first read arms its own timeout.
    clear()
  }
}
