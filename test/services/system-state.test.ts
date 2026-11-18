// The board's own server's state as GET /api/system answers it (services/system-state.ts), read from
// fixture files: read only when asked and kept a moment, the reading before kept for CPU's deltas
// (two taken a moment apart when there is none or it is too old), the real disks with their sizes,
// no GPU without nvidia-smi and the GPU's numbers with it, the top processes with their users and
// what the board knows of them (a session by its pane, an agent desktop's Chrome, Xvnc and video,
// the board, herdr). nvidia-smi is looked for once, and never run where it is not.
import { describe, expect, test } from 'bun:test'
import {
  CACHE_MS,
  createSystemState,
  nvidiaSmi,
  PRIME_MS,
  STALE_MS,
  type SystemFiles,
} from '../../src/services/system-state.ts'

const KEY = 'c2a2fdd4-e555-459e-9014-3a817427c95a'

/** A process's /proc/<pid>/stat line: its ticks (user + system) and resident pages. */
const stat = (pid: number, comm: string, ticks: number, rssPages: number, start = 100): string =>
  `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 4194304 0 0 0 0 ${ticks} 0 0 0 20 0 1 0 ${start} 0 ${rssPages} 0\n`

const status = (uid: number, rssKb: number | null): string =>
  `Name:\tx\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n${rssKb === null ? '' : `VmRSS:\t ${rssKb} kB\n`}`

interface Proc {
  comm: string
  ticks: number
  rssPages: number
  uid: number
  argv: string[]
  env?: Record<string, string>
}

/** A /proc of fixtures: the CPU's times and the processes as they are now (changed between readings). */
function world() {
  const cpu = { busy: 1000, idle: 9000 }
  const procs = new Map<number, Proc>([
    [1, { comm: 'systemd', ticks: 10, rssPages: 300, uid: 0, argv: ['/sbin/init'] }],
    [
      42,
      {
        comm: 'bun',
        ticks: 100,
        rssPages: 20000,
        uid: 1000,
        argv: ['/home/agent/.bun/bin/bun', 'src/entrypoints/tui.ts'],
      },
    ],
    [50, { comm: 'herdr', ticks: 50, rssPages: 4000, uid: 1000, argv: ['/home/agent/.local/bin/herdr', 'server'] }],
    [
      60,
      {
        comm: 'claude',
        ticks: 200,
        rssPages: 90000,
        uid: 1000,
        argv: ['claude', '--resume', KEY],
        env: { HERDR_PANE_ID: 'w1H:p5' },
      },
    ],
    [
      70,
      {
        comm: 'Xvnc',
        ticks: 5,
        rssPages: 1000,
        uid: 1000,
        argv: ['/usr/bin/Xvnc', ':100', '-geometry', '1440x900', '-desktop', `agent-board ${KEY}`],
      },
    ],
    [
      71,
      {
        comm: 'chrome',
        ticks: 300,
        rssPages: 50000,
        uid: 1000,
        argv: ['/x/chromium/chrome', '--user-data-dir=/x/sessions/100/profile'],
        env: { DISPLAY: ':100' },
      },
    ],
    [
      72,
      {
        comm: 'ffmpeg',
        ticks: 0,
        rssPages: 2000,
        uid: 1000,
        argv: ['/usr/bin/ffmpeg', '-f', 'x11grab', '-i', ':100', '-an'],
        env: { DISPLAY: ':100' },
      },
    ],
    [80, { comm: 'nginx', ticks: 0, rssPages: 500, uid: 33, argv: ['nginx: worker process'] }],
    [2, { comm: 'kthreadd', ticks: 0, rssPages: 0, uid: 0, argv: [] }],
  ])
  const reads: string[] = []
  const files: SystemFiles = {
    read(path) {
      reads.push(path)
      if (path === '/proc/stat')
        return `cpu  ${cpu.busy} 0 0 ${cpu.idle} 0 0 0 0 0 0\ncpu0 0 0 0 0 0 0 0 0 0 0\ncpu1 0 0 0 0 0 0 0 0 0 0\n`
      if (path === '/proc/loadavg') return '0.50 0.40 0.30 2/300 999\n'
      if (path === '/proc/uptime') return '93784.12 100.00\n'
      if (path === '/proc/meminfo')
        return 'MemTotal: 1000000 kB\nMemFree: 200000 kB\nMemAvailable: 600000 kB\nBuffers: 50000 kB\nCached: 300000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n'
      if (path === '/proc/mounts')
        return '/dev/vda3 / ext4 rw 0 0\ntmpfs /run tmpfs rw 0 0\n/dev/vda2 /boot ext3 rw 0 0\n/dev/nfs1 /mnt/hung nfs rw 0 0\n'
      if (path === '/etc/passwd') return 'root:x:0:0::/root:/bin/sh\nagent:x:1000:1000::/home/agent:/bin/bash\n'
      const m = /^\/proc\/(\d+)\/(stat|status|cmdline|environ)$/.exec(path)
      const p = m ? procs.get(Number(m[1])) : undefined
      if (!m || !p) return null
      if (m[2] === 'stat') return stat(Number(m[1]), p.comm, p.ticks, p.rssPages)
      if (m[2] === 'status') return status(p.uid, p.argv.length ? p.rssPages * 4 : null)
      if (m[2] === 'cmdline') return p.argv.map(a => `${a}\0`).join('')
      // another user's environment is refused
      if (p.uid !== 1000) return null
      return Object.entries(p.env ?? {})
        .map(([k, v]) => `${k}=${v}\0`)
        .join('')
    },
    list: dir => (dir === '/proc' ? ['self', 'cpuinfo', ...[...procs.keys()].map(String)] : []),
    async statfs(path) {
      if (path === '/') return { total: 100e9, used: 85e9, available: 10e9 }
      if (path === '/boot') return { total: 1e9, used: 0.2e9, available: 0.7e9 }
      return null
    },
  }
  let clock = 1_000_000
  const waits: number[] = []
  let gpuCalls = 0
  let gpuText: string | null = null
  const state = createSystemState({
    sessions: () => [
      { key: KEY, pane: 'w1H:p5', name: 'Fix the login' },
      { key: 'asleep', pane: null, name: 'Asleep', sleeping: true },
    ],
    files,
    gpu: async () => {
      gpuCalls++
      return gpuText
    },
    boardPid: 42,
    host: () => 'workbench',
    now: () => clock,
    // the moment between two readings: the machine works on meanwhile
    wait: async ms => {
      waits.push(ms)
      clock += ms
      cpu.busy += 50
      cpu.idle += 150
      bump(60, 10)
      bump(71, 30)
    },
  })
  const bump = (pid: number, ticks: number) => {
    const p = procs.get(pid)
    if (p) p.ticks += ticks
  }
  return {
    state,
    procs,
    cpu,
    reads,
    waits,
    bump,
    tick: (ms: number) => {
      clock += ms
    },
    gpu: (text: string | null) => {
      gpuText = text
    },
    gpuCalls: () => gpuCalls,
  }
}

describe('GET /api/system’s view', () => {
  test('the first read takes two readings a moment apart: CPU, memory, disks, uptime, host, no GPU', async () => {
    const w = world()
    const view = await w.state.read()
    expect(w.waits).toEqual([PRIME_MS])
    expect(view.host).toBe('workbench')
    expect(view.uptime).toBe(93784)
    // 200 ticks of both CPUs passed, 50 busy
    expect(view.cpu).toEqual({ usage: 25, cores: 2, load: [0.5, 0.4, 0.3] })
    expect(view.memory).toMatchObject({ total: 1000000 * 1024, used: 400000 * 1024, swapTotal: 0, swapUsed: 0 })
    // tmpfs is no disk; a mount that does not answer is left out
    expect(view.disks).toEqual([
      { device: '/dev/vda3', mount: '/', fs: 'ext4', total: 100e9, used: 85e9, available: 10e9 },
      { device: '/dev/vda2', mount: '/boot', fs: 'ext3', total: 1e9, used: 0.2e9, available: 0.7e9 },
    ])
    expect('gpu' in view).toBe(false)
  })

  test('the top by CPU and by memory, each with its user and what the board knows of it', async () => {
    const w = world()
    const view = await w.state.read()
    // 100 ticks a core passed: chrome took 30, claude 10 (a percent of one CPU)
    expect(view.top.cpu.map(p => [p.pid, p.cpu, p.user, p.label])).toEqual([
      [71, 30, 'agent', { kind: 'browser', display: 100, name: 'Fix the login' }],
      [60, 10, 'agent', { kind: 'session', name: 'Fix the login' }],
    ])
    const memory = view.top.memory.map(p => [p.pid, p.name, p.user, p.label ?? null])
    expect(memory).toEqual([
      [60, 'claude', 'agent', { kind: 'session', name: 'Fix the login' }],
      [71, 'chrome', 'agent', { kind: 'browser', display: 100, name: 'Fix the login' }],
      [42, 'bun', 'agent', { kind: 'board' }],
      [50, 'herdr', 'agent', { kind: 'herdr' }],
      [72, 'ffmpeg', 'agent', { kind: 'video', display: 100, name: 'Fix the login' }],
      [70, 'Xvnc', 'agent', { kind: 'vnc', display: 100, name: 'Fix the login' }],
      [80, 'nginx', '33', null],
      [1, 'systemd', 'root', null],
    ])
    const claude = view.top.memory[0]
    expect([claude?.rss, claude?.command]).toEqual([90000 * 4 * 1024, `claude --resume ${KEY}`])
  })

  test('kept a moment: a read within CACHE_MS reads nothing again; two at once read once', async () => {
    const w = world()
    const [a, b] = await Promise.all([w.state.read(), w.state.read()])
    expect(a).toBe(b)
    const reads = w.reads.length
    w.tick(CACHE_MS - 1)
    expect(await w.state.read()).toBe(a)
    expect(w.reads.length).toBe(reads)
  })

  test('the next read compares with the reading before: no wait, CPU over the time between', async () => {
    const w = world()
    await w.state.read()
    w.tick(5000)
    w.cpu.busy += 180
    w.cpu.idle += 20
    w.bump(60, 100)
    const view = await w.state.read()
    expect(w.waits).toEqual([PRIME_MS])
    expect(view.cpu?.usage).toBe(90)
    expect(view.top.cpu.map(p => [p.pid, p.cpu])).toEqual([[60, 100]])
  })

  test('a reading before that is too old says nothing of now: two are taken again', async () => {
    const w = world()
    await w.state.read()
    w.tick(STALE_MS + 1)
    await w.state.read()
    expect(w.waits).toEqual([PRIME_MS, PRIME_MS])
  })

  test('the GPU only where nvidia-smi answers, its numbers as it says them', async () => {
    const w = world()
    w.gpu('NVIDIA L4, 12, 2048, 23034, 45\n')
    const view = await w.state.read()
    expect(view.gpu).toEqual([
      { name: 'NVIDIA L4', utilization: 12, memoryUsed: 2048 * 2 ** 20, memoryTotal: 23034 * 2 ** 20, temperature: 45 },
    ])
  })

  test('nvidia-smi is looked for once, and nothing runs where it is not', async () => {
    let looked = 0
    const query = nvidiaSmi(() => {
      looked++
      return null
    })
    expect([await query(), await query(), looked]).toEqual([null, null, 1])
  })

  test('a machine with no /proc (not Linux): every part empty, nothing thrown', async () => {
    const state = createSystemState({
      sessions: () => [],
      files: { read: () => null, list: () => [], statfs: async () => null },
      gpu: async () => null,
      host: () => 'mac',
      wait: async () => {},
    })
    expect(await state.read()).toMatchObject({
      host: 'mac',
      uptime: null,
      cpu: null,
      memory: null,
      disks: [],
      top: { cpu: [], memory: [] },
    })
  })
})
