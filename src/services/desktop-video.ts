// An agent's display as H.264 video for its viewers (core/desktop-video.ts), in the board's process:
// one encoder (ffmpeg) per desktop, only while at least one viewer watches it, shared by them all,
// ended when the last one goes. Its frames go to each viewer as they come; a viewer starts at a key
// frame. There is one key frame in a stream, its first: a viewer that comes while it runs, or whose
// decoder starts again, gets one by the encoder starting again (about 0.2 s; the others see their
// picture stand still meanwhile and go on from the new key frame), at most every MIN_RESTART_MS.
//
// Each viewer says which frames it got; one that has more than MAX_AHEAD of them (or their bytes)
// unanswered is behind (its link is slower than the picture changes): it gets no more until the
// ones in flight are down to LOW_AHEAD, then a key frame, so it never sees seconds-old frames. One
// that asks for a key frame starts over: what it was sent before is not waited for (its decoder
// went with them, and they would hold it behind for good).
//
// The rate follows the slowest viewer's link (core/desktop-video.ts VIDEO_RATES): a viewer behind
// has the encoder start again for its key frame at the next rate down (one step for each start,
// however many fall behind on it); no viewer behind for STEP_UP_MS, the encoder starts again one
// step up; behind again within that time, the step up did not hold and the next one waits twice as
// long (at most MAX_STEP_UP_MS), one that held makes it STEP_UP_MS again. A desktop's rate is kept
// for its next view within RATE_KEPT_MS (the page shown again, its socket opened again). While a
// desktop's video runs at a lower rate or something happened to it, the board's log has a line on
// it each minute (VIDEO_LOG_MS). The
// encoder is the board's child: the board gone, its stdout is closed and it ends. Where there is no
// ffmpeg, no viewer is taken (the route says so) and the page shows the VNC picture instead.
import { closeSync, openSync, readFileSync } from 'node:fs'
import {
  ffmpegArgs,
  flvUnits,
  readViewerText,
  VIDEO_RATES,
  type VideoRate,
  type VideoUnit,
  videoMessage,
} from '../core/desktop-video.ts'

export interface VideoProc {
  pid: number
  stdout: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void
}

/** What the video asks of the server: tests hand in their own. */
export interface VideoSystem {
  /** ffmpeg on PATH, or null (looked for at each start: one installed later counts). */
  which(name: string): string | null
  /** Whether this ffmpeg has zimg's scaler (`zscale`): asked once per program. */
  zscale(ffmpeg: string): Promise<boolean>
  /** ffmpeg with `argv`, its stdout a pipe, its errors into `log`. */
  spawn(argv: string[], env: Record<string, string>, log: string): VideoProc
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(t: unknown): void
}

/** The display a desktop's video grabs: its number, its X cookie, the log ffmpeg writes to. */
export interface VideoSource {
  pane: string
  display: number
  auth: string
  log: string
}

/** A viewer's socket: a frame's message sent, and closed with a code and a word. */
export interface VideoViewer {
  send(bytes: Uint8Array): void
  close(code: number, reason: string): void
}

export interface DesktopVideo {
  /** ffmpeg is on this server. */
  available(): boolean
  /** A viewer of the desktop: its encoder started for it, or started again for a key frame. */
  join(src: VideoSource, viewer: VideoViewer): void
  /** A viewer gone: the last one gone, its encoder ends. */
  leave(pane: string, viewer: VideoViewer): void
  /** What a viewer said (core/desktop-video.ts readViewerText). */
  message(pane: string, viewer: VideoViewer, text: string): void
  /** The desktop stopped: its encoder ended, its viewers closed. */
  stop(pane: string): void
  stopAll(): void
  /** How many encoders run (for tests and the log). */
  running(): number
}

/** A viewer with this many frames (or bytes) unanswered is behind: it gets none until it is down to LOW_AHEAD. */
export const MAX_AHEAD = 20
export const MAX_AHEAD_BYTES = 3 << 20
export const LOW_AHEAD = 2
/** The encoder starts again (for a key frame) at most this often. */
export const MIN_RESTART_MS = 1500
/** No viewer behind this long: one step up the rates; twice as long after each step up that did not hold, at most MAX_STEP_UP_MS. */
export const STEP_UP_MS = 25_000
export const MAX_STEP_UP_MS = 240_000
/** A desktop's rate is where its next view starts, within this long after its video ended. */
export const RATE_KEPT_MS = 5 * 60_000
/** A line in the board's log on a desktop's video this often, while it has something to say. */
export const VIDEO_LOG_MS = 60_000
/** A viewer's socket closed as the video ended (the encoder failed, its display gone): the page shows VNC. */
export const VIDEO_ENDED = 4011
/** Closed: the video cannot be made here (no ffmpeg). */
export const VIDEO_NONE = 4010

const PATH = '/usr/local/bin:/usr/bin:/bin'

/** The server's own. */
export const realVideoSystem: VideoSystem = {
  which: name => Bun.which(name, { PATH: `${process.env.PATH ?? ''}:${PATH}` }),
  zscale: async ffmpeg => {
    try {
      const p = Bun.spawn([ffmpeg, '-hide_banner', '-filters'], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
      const out = await new Response(p.stdout).text()
      await p.exited
      return /^\s*\S+\s+zscale\s/m.test(out)
    } catch {
      return false
    }
  },
  spawn(argv, env, log) {
    const fd = openSync(log, 'a', 0o600)
    try {
      const p = Bun.spawn(argv, { env, stdin: 'ignore', stdout: 'pipe', stderr: fd })
      return {
        pid: p.pid,
        stdout: p.stdout as ReadableStream<Uint8Array>,
        exited: p.exited,
        kill: signal => p.kill(signal),
      }
    } finally {
      closeSync(fd)
    }
  },
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: t => clearTimeout(t as ReturnType<typeof setTimeout>),
}

/** A viewer's place in a stream: waiting for a key frame, what it was sent and has not said it got. */
interface Seat {
  waitKey: boolean
  /** Behind: nothing until what is in flight is down to LOW_AHEAD. */
  behind: boolean
  flight: { seq: number; bytes: number }[]
}

interface Stream {
  src: VideoSource
  viewers: Map<VideoViewer, Seat>
  proc: VideoProc | null
  /** Which start of the encoder is the current one: an earlier one's frames and end are not its. */
  gen: number
  /** The current start has made its key frame. */
  keyed: boolean
  seq: number
  startedAt: number
  /** A start again waits for its turn (MIN_RESTART_MS). */
  again: unknown
  ending: boolean
  rate: Rate
  /** The step (of VIDEO_RATES) the current encoder was started at. */
  started: number
  /** This minute's: viewers fallen behind, encoder starts, steps down and up; the timer of its line. */
  minute: { behind: number; starts: number; down: number; up: number }
  logTimer: unknown
}

/** Where a desktop's video is on VIDEO_RATES, and how its steps up have gone. */
interface Rate {
  /** The step the next start of the encoder runs at (0 the best). */
  step: number
  /** No viewer behind since then (or the step changed then). */
  calmSince: number
  /** How long calm before a step up. */
  upWait: number
  /** The last step up, until a viewer fell behind (it did not hold) or the next step up (it did). */
  upAt: number | null
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A log's last lines, on one line. */
function tailOf(path: string): string {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').slice(-3).join(' | ').slice(-400)
  } catch {
    return ''
  }
}

export function createDesktopVideo(o: { log(line: string): void; system?: VideoSystem }): DesktopVideo {
  const sys = o.system ?? realVideoSystem
  const streams = new Map<string, Stream>()
  const zscales = new Map<string, Promise<boolean>>()
  /** The rates of desktops whose video ended, by pane: where a view that comes back soon starts. */
  const kept = new Map<string, { rate: Rate; at: number }>()

  const last = VIDEO_RATES.length - 1
  const rateOf = (step: number) => VIDEO_RATES[step] as VideoRate

  /** A viewer fell behind: the next start of the encoder (its key frame) a step down, once for this start. */
  function fellBehind(st: Stream): void {
    const now = sys.now()
    const r = st.rate
    st.minute.behind++
    // a step up that did not hold: the next one waits longer
    if (r.upAt !== null && now - r.upAt < r.upWait) r.upWait = Math.min(r.upWait * 2, MAX_STEP_UP_MS)
    r.upAt = null
    r.calmSince = now
    if (r.step === st.started && r.step < last) {
      r.step++
      st.minute.down++
    }
  }

  /** No viewer behind for its wait, each one steady: a step up, the encoder started again for it. */
  function maybeUp(st: Stream): void {
    const r = st.rate
    if (r.step === 0 || r.step !== st.started || !st.keyed || st.again !== undefined) return
    const now = sys.now()
    if (now - r.calmSince < r.upWait) return
    for (const seat of st.viewers.values()) if (seat.behind || seat.waitKey) return
    // the last step up held as long: the next as soon as the first
    if (r.upAt !== null) r.upWait = STEP_UP_MS
    r.step--
    r.upAt = now
    r.calmSince = now
    st.minute.up++
    keyFrame(st)
  }

  /** The minute's line, while there is something to say; the next minute's timer. */
  function minuteLine(st: Stream): void {
    st.logTimer = undefined
    if (st.ending || streams.get(st.src.pane) !== st) return
    const m = st.minute
    if (m.behind || m.down || m.up || st.started > 0)
      o.log(
        `desktop :${st.src.display}: video, last minute: behind ${m.behind}, starts ${m.starts}, down ${m.down}, up ${m.up}; now ${rateOf(st.started).maxrate} (step ${st.started + 1} of ${last + 1})`,
      )
    st.minute = { behind: 0, starts: 0, down: 0, up: 0 }
    st.logTimer = sys.setTimeout(() => minuteLine(st), VIDEO_LOG_MS)
  }

  const inFlight = (s: Seat) => s.flight.reduce((n, f) => n + f.bytes, 0)

  function deliver(st: Stream, unit: VideoUnit): void {
    st.seq = (st.seq + 1) >>> 0
    if (unit.key) st.keyed = true
    maybeUp(st)
    const msg = videoMessage(st.seq, unit)
    for (const [viewer, seat] of st.viewers) {
      if (seat.behind && seat.flight.length > LOW_AHEAD) continue
      if (seat.waitKey && !unit.key) continue
      if (!unit.key && (seat.flight.length >= MAX_AHEAD || inFlight(seat) >= MAX_AHEAD_BYTES)) {
        // its link backs up: nothing more until it catches up, then a key frame, at a lower rate
        fellBehind(st)
        seat.behind = true
        seat.waitKey = true
        continue
      }
      seat.waitKey = false
      seat.behind = false
      seat.flight.push({ seq: st.seq, bytes: msg.length })
      try {
        viewer.send(msg)
      } catch {}
    }
  }

  async function start(st: Stream): Promise<void> {
    const gen = ++st.gen
    st.keyed = false
    st.startedAt = sys.now()
    st.started = st.rate.step
    st.minute.starts++
    const ffmpeg = sys.which('ffmpeg')
    if (!ffmpeg) return end(st, gen, 'no ffmpeg')
    let zscale = zscales.get(ffmpeg)
    if (!zscale) {
      zscale = sys.zscale(ffmpeg)
      zscales.set(ffmpeg, zscale)
    }
    const z = await zscale
    if (st.gen !== gen || st.ending) return
    let proc: VideoProc
    try {
      proc = sys.spawn(
        [ffmpeg, ...ffmpegArgs({ display: st.src.display, zscale: z, rate: rateOf(st.started) })],
        {
          DISPLAY: `:${st.src.display}`,
          XAUTHORITY: st.src.auth,
          HOME: process.env.HOME ?? '',
          PATH: `${process.env.PATH ?? ''}:${PATH}`,
        },
        st.src.log,
      )
    } catch (err) {
      return end(st, gen, messageOf(err))
    }
    st.proc = proc
    void proc.exited.then(code => {
      if (st.gen === gen && !st.ending) end(st, gen, `ffmpeg ended (${code}): ${tailOf(st.src.log) || 'no word'}`)
    })
    const read = flvUnits()
    try {
      for await (const chunk of proc.stdout) {
        if (st.gen !== gen) break
        const units = read(chunk)
        if (!units) return end(st, gen, 'ffmpeg wrote what is not H.264 in FLV')
        for (const unit of units) deliver(st, unit)
      }
    } catch {}
  }

  /** The stream over (it failed, or ended by itself): its viewers told, so their pages show VNC. */
  function end(st: Stream, gen: number, why: string): void {
    if (st.gen !== gen || streams.get(st.src.pane) !== st) return
    o.log(`desktop :${st.src.display}: video ended: ${why}`)
    halt(st)
    for (const viewer of st.viewers.keys()) viewer.close(VIDEO_ENDED, 'video ended')
    st.viewers.clear()
  }

  function halt(st: Stream): void {
    st.ending = true
    st.gen++
    sys.clearTimeout(st.again)
    st.again = undefined
    sys.clearTimeout(st.logTimer)
    st.logTimer = undefined
    const now = sys.now()
    for (const [pane, k] of kept) if (now - k.at >= RATE_KEPT_MS) kept.delete(pane)
    kept.set(st.src.pane, { rate: st.rate, at: now })
    st.proc?.kill('SIGKILL')
    st.proc = null
    if (streams.get(st.src.pane) === st) streams.delete(st.src.pane)
  }

  /** A key frame for whoever waits for one: the encoder started again, now or when its turn comes. */
  function keyFrame(st: Stream): void {
    if (st.again !== undefined || st.ending) return
    // a start whose key frame has not come yet brings one anyway
    if (!st.keyed) return
    const wait = Math.max(0, st.startedAt + MIN_RESTART_MS - sys.now())
    st.again = sys.setTimeout(() => {
      st.again = undefined
      if (st.ending || streams.get(st.src.pane) !== st) return
      st.proc?.kill('SIGKILL')
      st.proc = null
      void start(st)
    }, wait)
  }

  return {
    available: () => sys.which('ffmpeg') !== null,

    join(src, viewer) {
      let st = streams.get(src.pane)
      if (!st) {
        const now = sys.now()
        const was = kept.get(src.pane)
        kept.delete(src.pane)
        const rate: Rate =
          was && now - was.at < RATE_KEPT_MS
            ? { ...was.rate, calmSince: now, upAt: null }
            : { step: 0, calmSince: now, upWait: STEP_UP_MS, upAt: null }
        st = {
          src,
          viewers: new Map(),
          proc: null,
          gen: 0,
          keyed: false,
          seq: 0,
          startedAt: 0,
          again: undefined,
          ending: false,
          rate,
          started: rate.step,
          minute: { behind: 0, starts: 0, down: 0, up: 0 },
          logTimer: undefined,
        }
        const s = st
        st.logTimer = sys.setTimeout(() => minuteLine(s), VIDEO_LOG_MS)
        streams.set(src.pane, st)
        st.viewers.set(viewer, { waitKey: true, behind: false, flight: [] })
        o.log(`desktop :${src.display}: video for its viewers`)
        void start(st)
        return
      }
      st.viewers.set(viewer, { waitKey: true, behind: false, flight: [] })
      keyFrame(st)
    },

    leave(pane, viewer) {
      const st = streams.get(pane)
      if (!st?.viewers.delete(viewer) || st.viewers.size) return
      halt(st)
      o.log(`desktop :${st.src.display}: video stopped (no viewer)`)
    },

    message(pane, viewer, text) {
      const st = streams.get(pane)
      const seat = st?.viewers.get(viewer)
      const says = readViewerText(text)
      if (!st || !seat || !says) return
      if ('key' in says) {
        // its decoder starts over: what it was sent before will never be answered (a decoder that
        // failed, or stopped giving frames out, with them in it), so nothing is waited for; held
        // behind on them it would never get the key frame it asks for
        seat.flight = []
        seat.behind = false
        seat.waitKey = true
        keyFrame(st)
        return
      }
      seat.flight = seat.flight.filter(f => f.seq > says.ack)
      // caught up after it was behind: a key frame to go on from
      if (seat.behind && seat.flight.length <= LOW_AHEAD) keyFrame(st)
    },

    stop(pane) {
      const st = streams.get(pane)
      if (!st) return
      halt(st)
      for (const viewer of st.viewers.keys()) viewer.close(1001, 'stopped')
      st.viewers.clear()
    },

    stopAll() {
      for (const pane of [...streams.keys()]) this.stop(pane)
    },

    running: () => [...streams.values()].filter(s => s.proc !== null).length,
  }
}
