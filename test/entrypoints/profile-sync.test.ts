// The profile sync's program on the server (entrypoints/profile-sync.ts) as its own process, as
// runuser starts it over the admin's login: when the computer's side goes away mid-op (stdout's
// reader gone, stdin cut short, or nothing more coming), the op ends, with a non-zero exit code,
// and a file it had not finished is left as it was. One once ran for 18 days at 100% CPU: its
// stdout's reader was gone, and Bun spins a core on a top-level await that never settles.
import { afterAll, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { constants, createGzip, type Gzip, gunzipSync } from 'node:zlib'
import { ROOT } from '../../src/adapters/paths.ts'
import { type Frame, FrameReader, frame } from '../../src/adapters/profile-sync.ts'
import { SYNC_VERSION } from '../../src/entrypoints/profile-sync.ts'

const PROGRAM = join(ROOT, 'src', 'entrypoints', 'profile-sync.ts')
/** How long a test waits for the program to end before it calls it hung (and kills it). */
const HUNG_MS = 8000
const roots: string[] = []
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** A home of its own with the default profile in it (a settings.json makes the folder one). */
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'profile-sync-ends-'))
  roots.push(dir)
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), '{}\n')
  return dir
}

interface Started {
  child: ChildProcess
  /** What goes to its stdin, gzipped. */
  gz: Gzip
  /** How it ended: 'exit <code>', or 'hung' when it had not ended after HUNG_MS (then killed). */
  ended: Promise<string>
  /** Its frames on stdout, once it ended (stdout read whole). */
  frames(): Frame[]
  /** What was written so far handed over, the gzip not ended: what a connection carries before it drops. */
  flush(): Promise<void>
  /** Its stdin closed with the gzip cut short. */
  cut(): void
}

/** The program run as the server's command runs it: a bare env, the board's user's home. */
function start(op: string, at: string, env: Record<string, string> = {}): Started {
  const child = spawn(process.execPath, [PROGRAM, op], {
    cwd: ROOT,
    env: { HOME: at, PATH: dirname(process.execPath), BUN_FEATURE_FLAG_NO_ORPHANS: '1', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const out: Buffer[] = []
  child.stdout?.on('data', (d: Buffer) => out.push(d))
  child.stderr?.resume()
  // its stdin closed once it ended: what still goes there goes nowhere
  child.stdin?.on('error', () => {})
  const gz = createGzip()
  gz.pipe(child.stdin as NodeJS.WritableStream)
  const ended = new Promise<string>(resolve => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve('hung')
    }, HUNG_MS)
    child.once('exit', code => {
      clearTimeout(timer)
      resolve(`exit ${code}`)
    })
  })
  return {
    child,
    gz,
    ended,
    frames: () => new FrameReader().push(gunzipSync(Buffer.concat(out))),
    flush: () => new Promise<void>(resolve => gz.flush(constants.Z_SYNC_FLUSH, () => resolve())),
    cut: () => {
      gz.unpipe(child.stdin as NodeJS.WritableStream)
      child.stdin?.end()
    },
  }
}

const request = (op: string, more: Record<string, unknown> = {}): Buffer =>
  frame({ op, v: SYNC_VERSION, peer: 'the-pc', profiles: [], same: [], forget: [], deletions: [], allow: {}, ...more })
const file = (to: string, body: string, expect: string | null = null): Buffer =>
  frame({ t: 'file', profile: 'default', to, merge: false, expect }, Buffer.from(body))
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The files left beside their place by a write not finished. */
function parts(dir: string): string[] {
  const all = readdirSync(dir, { recursive: true, encoding: 'utf8' })
  return all.filter(p => p.endsWith('.agent-board-sync'))
}

/** What the program recorded of a sync with the PC (under the board's state dir in its home). */
function recorded(dir: string): Record<string, Record<string, string>> {
  const at = readdirSync(dir, { recursive: true, encoding: 'utf8' }).find(p => p.endsWith('profile-sync/the-pc.json'))
  return at ? JSON.parse(readFileSync(join(dir, at), 'utf8')).profiles : {}
}

describe('the sync program on the server ends when the computer goes away', () => {
  test("apply: stdout's reader gone (EPIPE) mid-apply: it ends, non-zero; what it wrote is whole and recorded", async () => {
    const at = home()
    const p = start('apply', at)
    p.child.stdout?.destroy()
    p.gz.write(request('apply'))
    p.gz.write(file('agents/a.md', 'a\n'))
    p.gz.write(frame({ t: 'end' }))
    p.gz.end()
    expect(await p.ended).toBe('exit 1')
    expect(readFileSync(join(at, '.claude', 'agents', 'a.md'), 'utf8')).toBe('a\n')
    expect(parts(at)).toEqual([])
    expect(Object.keys(recorded(at).default ?? {})).toEqual(['agents/a.md'])
  }, 15_000)

  test("apply: the connection dropped mid-file (stdin cut short, stdout's reader gone): it ends, non-zero; the file there is left as it was", async () => {
    const at = home()
    const keep = join(at, '.claude', 'agents', 'keep.md')
    writeFileSync(keep, 'original\n')
    const p = start('apply', at)
    p.gz.write(request('apply'))
    p.gz.write(file('agents/keep.md', `new ${'x'.repeat(4000)}\n`, sha('original\n')).subarray(0, 1500))
    await p.flush()
    p.child.stdout?.destroy()
    p.cut()
    expect(await p.ended).toBe('exit 1')
    expect(readFileSync(keep, 'utf8')).toBe('original\n')
    expect(parts(at)).toEqual([])
  }, 15_000)

  test('apply: stdin at its end before the request is whole, or before {t:end}: it ends with 1 and says why', async () => {
    for (const sent of [
      request('apply').subarray(0, 10),
      Buffer.concat([request('apply'), file('agents/b.md', 'b\n')]),
    ]) {
      const at = home()
      const p = start('apply', at)
      p.gz.write(sent)
      p.gz.end()
      expect(await p.ended).toBe('exit 1')
      expect(p.frames().map(f => f.head.t)).toEqual(['error'])
    }
  }, 15_000)

  test('apply: nothing more comes for BOARD_SYNC_IDLE_MS, stdin still open: it ends with 1 and says why', async () => {
    for (const sent of [
      Buffer.alloc(0),
      request('apply'),
      Buffer.concat([request('apply'), file('agents/c.md', 'c\n')]),
    ]) {
      const at = home()
      const p = start('apply', at, { BOARD_SYNC_IDLE_MS: '300' })
      p.gz.write(sent)
      await p.flush()
      const ended = await p.ended
      p.cut()
      expect(ended).toBe('exit 1')
      const frames = p.frames()
      expect(frames.map(f => f.head.t)).toEqual(['error'])
      expect(String(frames[0]?.head.message)).toContain('nothing came')
    }
  }, 30_000)

  test("scan, pack, record, dirs, mkdir, exists: stdout's reader gone: each ends, non-zero", async () => {
    const at = home()
    const to = { platform: process.platform, home: at }
    const ops: [string, Record<string, unknown>][] = [
      ['scan', { to }],
      ['pack', { to, items: [] }],
      ['record', { changes: [] }],
      ['dirs', { path: at }],
      ['mkdir', { path: at, name: 'made' }],
      ['exists', { paths: [at] }],
    ]
    const ended = await Promise.all(
      ops.map(async ([op, more]) => {
        const p = start(op, at)
        p.child.stdout?.destroy()
        p.gz.write(request(op, more))
        p.gz.end()
        return `${op}: ${await p.ended}`
      }),
    )
    expect(ended).toEqual(ops.map(([op]) => `${op}: exit 1`))
  }, 15_000)
})

describe('the sync program as before when the computer stays', () => {
  test('apply to its end: exit 0, the file written, {t:done}', async () => {
    const at = home()
    const p = start('apply', at, { BOARD_SYNC_IDLE_MS: '300' })
    p.gz.write(request('apply'))
    p.gz.write(file('agents/d.md', 'd\n'))
    p.gz.write(frame({ t: 'end' }))
    p.gz.end()
    expect(await p.ended).toBe('exit 0')
    expect(readFileSync(join(at, '.claude', 'agents', 'd.md'), 'utf8')).toBe('d\n')
    const frames = p.frames()
    expect(frames.map(f => f.head.t)).toEqual(['done'])
    expect(frames[0]?.head).toMatchObject({ files: 1, created: [], install: null, skipped: [] })
  }, 15_000)

  test('exists, its stdin ended after the request: exit 0 and its answer', async () => {
    const at = home()
    const p = start('exists', at)
    p.gz.write(request('exists', { paths: [at, join(at, 'nowhere')] }))
    p.gz.end()
    expect(await p.ended).toBe('exit 0')
    expect(p.frames().map(f => f.head)).toEqual([{ t: 'exists', there: [true, false], size: 0 }])
  }, 15_000)

  test('a request of another version: exit 1 and the error frame, as before', async () => {
    const at = home()
    const p = start('scan', at)
    p.gz.write(frame({ op: 'scan', v: SYNC_VERSION + 1 }))
    p.gz.end()
    expect(await p.ended).toBe('exit 1')
    expect(p.frames().map(f => f.head.t)).toEqual(['error'])
  }, 15_000)
})
