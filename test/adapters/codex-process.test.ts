import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { sandbox } from '../support/sandbox.ts'

const OLD = '01a15a8a-bd97-7701-a7f7-401e4bec3147'
const CURRENT = '01a15a8a-bd97-7701-a7f7-401e4bec3149'
const ROLLOUT = `/synthetic/Codex home/rollout-2026-10-20T08-00-00-${CURRENT}.jsonl`
const SHELL = 801
const CODEX = 802
const HELPER = 803
const TTY = '/dev/ttys004'

async function fixture() {
  const { codexProcessRollouts } = await import('../../src/adapters/codex-process.ts')
  const pane = { pane_id: 'p1', agent: 'codex', terminal_id: 'terminal-1', agent_session: { value: OLD } }
  const record = (...fields: string[]) => `${fields.join('\0')}\0\n`
  const cases = [
    { name: 'null tty shares stdio', tty: null, shellTty: TTY, codexFd: 'f1' },
    { name: 'omitted tty shares stdio', tty: undefined, shellTty: TTY, codexFd: 'f1' },
    { name: 'different PTYs', tty: null, shellTty: '/dev/ttys009', codexFd: 'f1' },
    { name: 'Codex PTY on fd10 only', tty: null, shellTty: TTY, codexFd: 'f10' },
  ]
  for (const { name, tty, shellTty, codexFd } of cases) {
    const herdr = {
      'pane process-info --pane p1': {
        result: {
          process_info: {
            pane_id: 'p1',
            tty,
            shell_pid: SHELL,
            foreground_process_group_id: CODEX,
            foreground_processes: [
              { pid: HELPER, argv: ['/synthetic/codex-code-mode-host'] },
              { pid: CODEX, argv: ['/synthetic/bin/codex', '--no-daemon'] },
            ],
          },
        },
      },
      'agent get p1': { result: { agent: pane } },
    }
    writeFileSync(process.env.FAKE_HERDR_STATE ?? '', JSON.stringify(herdr))
    const lsof = [
      record(`p${SHELL}`),
      record('f0', 'au', 'tCHR', `n${shellTty}`),
      record(`p${CODEX}`),
      record(codexFd, 'au', 'tCHR', `n${TTY}`),
      record('f38', 'aw', 'tREG', `n${ROLLOUT}`),
      record(`p${HELPER}`),
      record('f10', 'au', 'tCHR', `n${TTY}`),
    ].join('')
    const calls: number[][] = []
    const paths = await codexProcessRollouts(pane, async (pid, shell) => {
      calls.push(shell === undefined ? [pid] : [pid, shell])
      return lsof
    })
    console.log(JSON.stringify({ name, calls, paths }))
  }
}

if (import.meta.main && process.env.SYNTHETIC_CODEX_PROCESS_FIXTURE) await fixture()
else
  test.skipIf(process.platform !== 'darwin')(
    'Herdr 0.9.5 uses only stdio PTYs of the reported shell and foreground Codex',
    async () => {
      const box = await sandbox()
      const child = Bun.spawn([process.execPath, import.meta.path], {
        env: { ...box.env, SYNTHETIC_CODEX_PROCESS_FIXTURE: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(stderr).toBe('')
      expect(code).toBe(0)
      const results = stdout
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      expect(results).toEqual([
        { name: 'null tty shares stdio', calls: [[CODEX, SHELL]], paths: [ROLLOUT] },
        { name: 'omitted tty shares stdio', calls: [[CODEX, SHELL]], paths: [ROLLOUT] },
        { name: 'different PTYs', calls: [[CODEX, SHELL]], paths: [] },
        { name: 'Codex PTY on fd10 only', calls: [[CODEX, SHELL]], paths: [] },
      ])
    },
  )
