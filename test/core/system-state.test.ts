// The board's own server's state, its pure parts (core/system-state.ts), on fixture text as Linux
// writes it: CPU busy between two readings of /proc/stat, /proc/meminfo, /proc/loadavg and
// /proc/uptime, the real disks of /proc/mounts, a process's stat and status, the top lists over a
// span, the names the board knows a process by, and nvidia-smi's lines.
import { describe, expect, test } from 'bun:test'
import {
  argvOf,
  cpuUsage,
  diskPercent,
  diskSizes,
  displayOf,
  envValue,
  type LabelContext,
  type ProcSample,
  parseCpuTimes,
  parseLoadavg,
  parseMeminfo,
  parseMounts,
  parseNvidiaSmi,
  parsePasswd,
  parseProcStat,
  parseProcStatus,
  parseUptime,
  processLabel,
  shortCommand,
  tickMap,
  topProcesses,
  xvncDesktop,
} from '../../src/core/system-state.ts'

const STAT_BEFORE = `cpu  1000 0 500 8000 500 0 0 0 0 0
cpu0 500 0 250 4000 250 0 0 0 0 0
cpu1 500 0 250 4000 250 0 0 0 0 0
intr 12345
ctxt 6789
`
// 1000 ticks later: 250 of them busy (user 150, system 50, steal 50), 750 idle (idle 700, iowait 50)
const STAT_AFTER = `cpu  1150 0 550 8700 550 0 0 50 20 0
cpu0 575 0 275 4350 275 0 0 25 10 0
cpu1 575 0 275 4350 275 0 0 25 10 0
intr 12400
`

describe('CPU', () => {
  test('/proc/stat: summed without guest time (in user already), the cores counted, busy between two readings', () => {
    const before = parseCpuTimes(STAT_BEFORE)
    const after = parseCpuTimes(STAT_AFTER)
    expect(before).toEqual({ total: 10000, idle: 8500, cores: 2 })
    expect(after).toEqual({ total: 11000, idle: 9250, cores: 2 })
    if (!before || !after) throw new Error('unread')
    expect(cpuUsage(before, after)).toBe(25)
    // no time between them: nothing to say
    expect(cpuUsage(after, after)).toBeNull()
  })

  test('not /proc/stat: nothing', () => {
    expect(parseCpuTimes(null)).toBeNull()
    expect(parseCpuTimes('')).toBeNull()
    expect(parseCpuTimes('intr 1 2 3\n')).toBeNull()
    expect(parseCpuTimes('cpu  a b c d\n')).toBeNull()
  })

  test('/proc/loadavg and /proc/uptime', () => {
    expect(parseLoadavg('1.26 1.89 1.96 3/1364 2104403\n')).toEqual([1.26, 1.89, 1.96])
    expect(parseLoadavg('')).toBeNull()
    expect(parseLoadavg(null)).toBeNull()
    expect(parseUptime('350735.47 4143260.43\n')).toBe(350735)
    expect(parseUptime(null)).toBeNull()
    expect(parseUptime('x')).toBeNull()
  })
})

describe('memory', () => {
  const MEMINFO = `MemTotal:       24560304 kB
MemFree:        10900608 kB
MemAvailable:   17572988 kB
Buffers:         1091160 kB
Cached:          5134328 kB
SwapCached:        93088 kB
SReclaimable:     821508 kB
SwapTotal:      16777212 kB
SwapFree:       16513764 kB
`
  test('/proc/meminfo in bytes: used is what is not available, buffers and cache with reclaimable slab, swap', () => {
    const k = 1024
    expect(parseMeminfo(MEMINFO)).toEqual({
      total: 24560304 * k,
      used: (24560304 - 17572988) * k,
      available: 17572988 * k,
      free: 10900608 * k,
      buffersCache: (1091160 + 5134328 + 821508) * k,
      swapTotal: 16777212 * k,
      swapUsed: (16777212 - 16513764) * k,
    })
  })

  test('no MemAvailable (an old kernel): free + buffers + cache; no swap: zero; no MemTotal: nothing', () => {
    const old = parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 250 kB\n')
    expect(old).toMatchObject({
      total: 1000 * 1024,
      available: 400 * 1024,
      used: 600 * 1024,
      swapTotal: 0,
      swapUsed: 0,
    })
    expect(parseMeminfo('MemFree: 100 kB\n')).toBeNull()
    expect(parseMeminfo(null)).toBeNull()
  })
})

describe('disks', () => {
  const MOUNTS = `sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0
proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0
udev /dev devtmpfs rw,nosuid,relatime,size=12209704k 0 0
devpts /dev/pts devpts rw,nosuid,noexec,relatime 0 0
tmpfs /run tmpfs rw,nosuid,nodev,noexec,relatime,size=2456032k 0 0
efivarfs /sys/firmware/efi/efivars efivarfs rw,nosuid,nodev,noexec,relatime 0 0
/dev/vda3 / ext4 rw,relatime 0 0
tmpfs /dev/shm tmpfs rw,nosuid,nodev,inode64 0 0
cgroup2 /sys/fs/cgroup cgroup2 rw,nosuid,nodev,noexec,relatime 0 0
systemd-1 /proc/sys/fs/binfmt_misc autofs rw,relatime 0 0
hugetlbfs /dev/hugepages hugetlbfs rw,relatime,pagesize=2M 0 0
none /run/credentials/systemd-sysusers.service ramfs ro,nosuid,nodev,noexec,relatime 0 0
/dev/loop0 /snap/core20/2870 squashfs ro,nodev,relatime 0 0
/dev/vda2 /boot ext3 rw,relatime 0 0
/dev/vda1 /boot/efi vfat rw,relatime,fmask=0022 0 0
/dev/vdb1 /mnt/My\\040Data xfs rw,relatime 0 0
/dev/vda3 /var/lib/something ext4 rw,relatime 0 0
overlay /var/lib/docker/rootfs/overlayfs/8404 overlay rw,relatime,lowerdir=/x 0 0
nsfs /run/docker/netns/1c2e8364dd7d nsfs rw 0 0
/dev/sdc1 /run/media/me/USB vfat rw 0 0
/dev/vda3 /var/lib/docker ext4 rw,relatime 0 0
rpool/data /tank zfs rw 0 0
`
  test('/proc/mounts: the real filesystems once each, an escaped space read back, removable media kept', () => {
    expect(parseMounts(MOUNTS)).toEqual([
      { device: '/dev/vda3', mount: '/', fs: 'ext4' },
      { device: '/dev/vda2', mount: '/boot', fs: 'ext3' },
      { device: '/dev/vda1', mount: '/boot/efi', fs: 'vfat' },
      { device: '/dev/vdb1', mount: '/mnt/My Data', fs: 'xfs' },
      { device: '/dev/sdc1', mount: '/run/media/me/USB', fs: 'vfat' },
      { device: 'rpool/data', mount: '/tank', fs: 'zfs' },
    ])
    expect(parseMounts(null)).toEqual([])
  })

  test('statfs as sizes, df’s way (frsize, used over used + available); a filesystem of no size is none', () => {
    const d = diskSizes({ blocks: 1000, bfree: 300, bavail: 250, bsize: 4096, frsize: 4096 })
    expect(d).toEqual({ total: 1000 * 4096, used: 700 * 4096, available: 250 * 4096 })
    expect(diskSizes({ blocks: 10n, bfree: 5n, bavail: 5n, bsize: 1024n })).toEqual({
      total: 10240,
      used: 5120,
      available: 5120,
    })
    expect(diskSizes({ blocks: 0, bfree: 0, bavail: 0, bsize: 4096 })).toBeNull()
    if (!d) throw new Error('unread')
    expect(diskPercent(d)).toBe(73.7)
    expect(diskPercent({ used: 0, available: 0 })).toBe(0)
  })
})

describe('processes', () => {
  test('/proc/<pid>/stat: a name with spaces and parentheses, its ticks, its start, its resident pages', () => {
    const line =
      '2107851 (my (odd) proc) R 2107849 2107851 2107849 0 -1 4194304 75 0 0 0 120 30 0 0 20 0 1 0 259294257 5828608 196 18446744073709551615 0\n'
    expect(parseProcStat(line)).toEqual({
      pid: 2107851,
      comm: 'my (odd) proc',
      ticks: 150,
      start: 259294257,
      rssPages: 196,
    })
    expect(parseProcStat('garbage')).toBeNull()
    expect(parseProcStat(null)).toBeNull()
  })

  test('/proc/<pid>/status: the real uid and VmRSS; a kernel thread has none', () => {
    expect(parseProcStatus('Name:\tbun\nUid:\t1000\t1000\t1000\t1000\nVmRSS:\t    6584 kB\n')).toEqual({
      uid: 1000,
      rss: 6584 * 1024,
    })
    expect(parseProcStatus('Name:\tkworker/0:1\nUid:\t0\t0\t0\t0\n')).toEqual({ uid: 0, rss: null })
    expect(parsePasswd('root:x:0:0:root:/root:/bin/bash\nagent:x:1000:1000::/home/agent:/bin/bash\n')).toEqual(
      new Map([
        [0, 'root'],
        [1000, 'agent'],
      ]),
    )
  })

  const proc = (pid: number, ticks: number, rssPages: number, start = 1): ProcSample => ({
    pid,
    comm: `p${pid}`,
    ticks,
    start,
    rssPages,
  })

  test('the top by CPU over the span (a percent of one CPU, as top), those that took any; the top by memory', () => {
    const before = tickMap([proc(1, 100, 10), proc(2, 100, 500), proc(3, 100, 50), proc(4, 0, 5, 7)])
    // 2 cores, 200 ticks of all CPUs passed: 100 a core
    const now = [proc(1, 150, 10), proc(2, 100, 500), proc(3, 110, 50), proc(4, 30, 5, 9), proc(5, 20, 1)]
    const top = topProcesses(before, now, 200, 2, 3)
    expect(top.cpu.map(p => [p.proc.pid, p.cpu])).toEqual([
      [1, 50],
      // pid 4 started again (its start changed): all its ticks are in the span
      [4, 30],
      [5, 20],
    ])
    expect(top.memory.map(p => [p.proc.pid, p.cpu])).toEqual([
      [2, 0],
      [3, 10],
      [1, 50],
    ])
  })

  test('the first reading has nothing to compare: no CPU list, the memory list with no CPU', () => {
    const top = topProcesses(null, [proc(1, 150, 10), proc(2, 100, 500)], null, 2)
    expect(top.cpu).toEqual([])
    expect(top.memory.map(p => [p.proc.pid, p.cpu])).toEqual([
      [2, null],
      [1, null],
    ])
  })

  test('a command line, short: no folder, cut at its length; a kernel thread in brackets', () => {
    const argv = argvOf('/home/agent/.bun/bin/bun\0/home/agent/agent-board/src/entrypoints/cli.ts\0browser-mcp\0')
    expect(argv).toEqual(['/home/agent/.bun/bin/bun', '/home/agent/agent-board/src/entrypoints/cli.ts', 'browser-mcp'])
    expect(shortCommand(argv, 'bun')).toBe('bun /home/agent/agent-board/src/entrypoints/cli.ts browser-mcp')
    expect(shortCommand([], 'kworker/0:1')).toBe('[kworker/0:1]')
    const long = shortCommand(['/usr/bin/chrome', `--flags=${'x'.repeat(300)}`], 'chrome')
    expect([long.length, long.endsWith('…'), long.startsWith('chrome --flags=')]).toEqual([120, true, true])
  })

  test('the environment’s variables, and a display’s number', () => {
    const env = 'HOME=/home/agent\0HERDR_PANE_ID=w1H:p5\0DISPLAY=:100\0EMPTY=\0'
    expect([envValue(env, 'HERDR_PANE_ID'), envValue(env, 'DISPLAY'), envValue(env, 'EMPTY')]).toEqual([
      'w1H:p5',
      ':100',
      '',
    ])
    expect(envValue(env, 'NONE')).toBeNull()
    expect(envValue(null, 'DISPLAY')).toBeNull()
    expect([displayOf(':100'), displayOf(':101.0'), displayOf('host:0'), displayOf(null)]).toEqual([
      100,
      101,
      null,
      null,
    ])
  })
})

describe('what the board knows of a process', () => {
  const KEY = 'c2a2fdd4-e555-459e-9014-3a817427c95a'
  const XVNC = [
    '/usr/bin/Xvnc',
    ':100',
    '-geometry',
    '1440x900',
    '-rfbunixpath',
    '/x/vnc.sock',
    '-auth',
    '/x/Xauthority',
    '-desktop',
    `agent-board ${KEY}`,
  ]
  const ctx: LabelContext = {
    boardPid: 42,
    panes: new Map([['w1H:p5', 'Fix the login']]),
    displays: new Map([[100, 'Fix the login']]),
  }
  const facts = (f: Partial<Parameters<typeof processLabel>[0]>) => ({
    pid: 7,
    comm: 'x',
    argv: [],
    pane: null,
    display: null,
    ...f,
  })

  test('an agent desktop’s Xvnc: its display and its session’s key', () => {
    expect(xvncDesktop(XVNC)).toEqual({ display: 100, key: KEY })
    expect(xvncDesktop(['/usr/bin/Xvnc', ':100'])).toEqual({ display: 100, key: null })
    // a person's own X server, and another program
    expect(xvncDesktop(['/usr/bin/Xvnc', ':1'])).toBeNull()
    expect(xvncDesktop(['/usr/bin/Xorg', ':100'])).toBeNull()
  })

  test('the board, herdr, a desktop’s Xvnc, its video and its Chrome (renderers too), each with its session', () => {
    expect(processLabel(facts({ pid: 42, comm: 'bun' }), ctx)).toEqual({ kind: 'board' })
    expect(processLabel(facts({ comm: 'herdr', argv: ['/home/agent/.local/bin/herdr', 'server'] }), ctx)).toEqual({
      kind: 'herdr',
    })
    expect(processLabel(facts({ comm: 'Xvnc', argv: XVNC }), ctx)).toEqual({
      kind: 'vnc',
      display: 100,
      name: 'Fix the login',
    })
    const ffmpeg = ['/usr/bin/ffmpeg', '-f', 'x11grab', '-framerate', '30', '-i', ':100', '-an']
    expect(processLabel(facts({ comm: 'ffmpeg', argv: ffmpeg, display: ':100' }), ctx)).toEqual({
      kind: 'video',
      display: 100,
      name: 'Fix the login',
    })
    const chrome = ['/home/agent/desktop/chromium/chrome-linux-arm64/chrome', '--type=renderer']
    expect(processLabel(facts({ comm: 'chrome', argv: chrome, display: ':100' }), ctx)).toEqual({
      kind: 'browser',
      display: 100,
      name: 'Fix the login',
    })
    // a desktop the board has no session for: its display only
    expect(processLabel(facts({ comm: 'chrome', argv: chrome, display: ':103' }), ctx)).toEqual({
      kind: 'browser',
      display: 103,
    })
  })

  test('a session’s processes by their pane (its Claude and what it started); the rest have none', () => {
    expect(processLabel(facts({ comm: 'claude', argv: ['claude', '--resume', KEY], pane: 'w1H:p5' }), ctx)).toEqual({
      kind: 'session',
      name: 'Fix the login',
    })
    // the session's MCP server, a Chrome DevTools one with no display of its own
    expect(
      processLabel(facts({ comm: 'chrome-devtools', argv: ['chrome-devtools-mcp'], pane: 'w1H:p5' }), ctx),
    ).toEqual({
      kind: 'session',
      name: 'Fix the login',
    })
    // a pane the board has no session in, a person's own X display, nothing known
    expect(processLabel(facts({ comm: 'bash', argv: ['bash'], pane: 'w9:p9' }), ctx)).toBeUndefined()
    expect(processLabel(facts({ comm: 'chrome', argv: ['/usr/bin/chrome'], display: ':0' }), ctx)).toBeUndefined()
    expect(processLabel(facts({ comm: 'nginx', argv: ['nginx: worker process'] }), ctx)).toBeUndefined()
    // ffmpeg on something else than a desktop's display
    expect(processLabel(facts({ comm: 'ffmpeg', argv: ['ffmpeg', '-i', 'in.mp4', 'out.webm'] }), ctx)).toBeUndefined()
  })
})

describe('nvidia-smi', () => {
  test('one GPU a line, memory in MiB to bytes, a name with a comma, N/A as null', () => {
    const out = 'NVIDIA GeForce RTX 3090, 37, 1024, 24576, 61\nNVIDIA A100, 80GB PCIe, [N/A], 0, 81920, [N/A]\n'
    expect(parseNvidiaSmi(out)).toEqual([
      {
        name: 'NVIDIA GeForce RTX 3090',
        utilization: 37,
        memoryUsed: 1024 * 1024 * 1024,
        memoryTotal: 24576 * 1024 * 1024,
        temperature: 61,
      },
      {
        name: 'NVIDIA A100, 80GB PCIe',
        utilization: null,
        memoryUsed: 0,
        memoryTotal: 81920 * 1024 * 1024,
        temperature: null,
      },
    ])
  })

  test('no output (no nvidia-smi, or it said nothing): no GPU', () => {
    expect(parseNvidiaSmi(null)).toEqual([])
    expect(parseNvidiaSmi('')).toEqual([])
    expect(parseNvidiaSmi('NVIDIA-SMI has failed because it couldn’t communicate with the NVIDIA driver.\n')).toEqual(
      [],
    )
  })
})
