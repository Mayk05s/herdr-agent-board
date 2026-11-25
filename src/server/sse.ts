// Live updates as Server-Sent Events: each client gets the current board when it connects, every
// new one after, and a comment now and then that keeps an idle connection from being dropped.
type Client = ReadableStreamDefaultController<Uint8Array>

export interface Broadcaster {
  response(req: Request): Response
  /** A string is JSON already and goes as it is; anything else is serialised. */
  send(payload: unknown): void
  /** A named event (`event: <name>`) with its data serialised, to every client. */
  event(name: string, data: unknown): void
  size(): number
}

const HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' }

/** One named event as the stream carries it. */
export const namedEvent = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

export interface BroadcasterOptions {
  pingMs?: number
  /** What a new client is told right after the payload it starts with ('' for nothing). */
  greet?: () => string
}

/** `current`: the payload a new client starts with. Call close() to stop the pings and end every stream. */
export function createBroadcaster(
  current: () => string,
  { pingMs = 20_000, greet }: BroadcasterOptions = {},
): Broadcaster & { close(): void } {
  const clients = new Set<Client>()
  const encoder = new TextEncoder()

  function write(client: Client, text: string): void {
    try {
      client.enqueue(encoder.encode(text))
    } catch {
      // Closed under us: the client left between its last event and this one.
      clients.delete(client)
    }
  }
  const all = (text: string): void => {
    for (const client of clients) write(client, text)
  }
  const ping = setInterval(() => all(': ping\n\n'), pingMs)

  return {
    response(req) {
      let client: Client | undefined
      const leave = (): void => {
        if (client) clients.delete(client)
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          client = controller
          clients.add(controller)
          write(controller, `retry: 2000\ndata: ${current()}\n\n`)
          const more = greet?.()
          if (more) write(controller, more)
        },
        cancel: leave,
      })
      req.signal.addEventListener('abort', leave, { once: true })
      return new Response(stream, { headers: HEADERS })
    },
    send(payload) {
      all(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
    },
    event(name, data) {
      all(namedEvent(name, data))
    },
    size: () => clients.size,
    close() {
      clearInterval(ping)
      for (const client of clients) {
        try {
          client.close()
        } catch {}
      }
      clients.clear()
    },
  }
}

/** A replay stream only reads a page when the client is ready for it. */
export function replayResponse<T extends { id: number; type: string }>(
  req: Request,
  since: number,
  read: (cursor: number) => readonly T[],
  listen: (changed: () => void) => () => void,
): Response {
  const encoder = new TextEncoder()
  let cursor = since
  let wake: (() => void) | undefined
  let ended = false
  const unlisten = listen(() => wake?.())
  const close = () => {
    ended = true
    req.signal.removeEventListener('abort', close)
    unlisten()
    wake?.()
  }
  req.signal.addEventListener('abort', close, { once: true })
  if (req.signal.aborted) close()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'))
    },
    async pull(controller) {
      try {
        while (!ended) {
          const rows = read(cursor)
          const last = rows.at(-1)
          if (last) {
            cursor = last.id
            controller.enqueue(encoder.encode(rows.map(row => `id: ${row.id}\n${namedEvent(row.type, row)}`).join('')))
            return
          }
          const pinged = await new Promise<boolean>(resolve => {
            const timer = setTimeout(() => resolve(true), 15_000)
            timer.unref()
            wake = () => {
              clearTimeout(timer)
              resolve(false)
            }
          })
          wake = undefined
          if (pinged && !ended) {
            controller.enqueue(encoder.encode(': ping\n\n'))
            return
          }
        }
        controller.close()
      } catch (error) {
        close()
        if (!req.signal.aborted) controller.error(error)
      }
    },
    cancel: close,
  })
  return new Response(stream, { headers: { ...HEADERS, 'x-accel-buffering': 'no' } })
}
