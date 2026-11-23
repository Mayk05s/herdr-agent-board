// The rules both halves of a move to another device agree on (#616, core/move-device.ts): the
// arguments, what makes a folder travel, the pack as it crosses a link, the entries that go with it
// and the profile it runs in there.
import { expect, test } from 'bun:test'
import {
  entriesToCarry,
  type FolderFacts,
  type MovePack,
  movePackOf,
  moveWhyText,
  packFolder,
  parseMoveAny,
  profileOn,
} from '../../src/core/move-device.ts'

const S = '0f8fad5b-d9cb-469f-a165-70867728950e'
const SHA = 'a'.repeat(64)

test('board move takes --device or --profile, never both, and checks the device id', () => {
  expect(parseMoveAny(['atlas', '--device', 'server-1'])).toEqual({ targets: ['atlas'], device: 'server-1' })
  expect(parseMoveAny(['atlas', 'ben', '--device', 'local'])).toEqual({ targets: ['atlas', 'ben'], device: 'local' })
  expect(parseMoveAny(['atlas', '--profile', 'work'])).toEqual({ targets: ['atlas'], profile: 'work' })
  expect(() => parseMoveAny(['atlas', '--device', 'server-1', '--profile', 'work'])).toThrow('not both')
  expect(() => parseMoveAny(['atlas', '--device', 'Server 1'])).toThrow('not a device id')
  expect(() => parseMoveAny(['atlas', '--device'])).toThrow('needs a device id')
  expect(() => parseMoveAny(['--device', 'server-1'])).toThrow('which sessions')
  expect(() => parseMoveAny(['atlas'])).toThrow('to which profile or device')
})

const clean: FolderFacts = {
  checkout: { root: '/w/atlas', url: 'git@github.com:anna/atlas.git', clean: true, branch: 'feature-x', pushed: true },
  subdir: 'web',
  identity: { name: 'Anna', email: 'anna@example.com' },
}

test('a clean pushed checkout on a branch travels, with its address, branch, folder below and author', () => {
  expect(packFolder(clean)).toEqual({
    ok: true,
    folder: {
      url: 'git@github.com:anna/atlas.git',
      address: 'github.com/anna/atlas',
      branch: 'feature-x',
      subdir: 'web',
      identity: { name: 'Anna', email: 'anna@example.com' },
    },
  })
})

test('a folder that cannot travel is refused with its reason, cheapest first', () => {
  const c = clean.checkout as NonNullable<FolderFacts['checkout']>
  const why = (f: FolderFacts) => {
    const r = packFolder(f)
    return r.ok ? null : r.why.kind
  }
  expect(why({ ...clean, checkout: null })).toBe('no-checkout')
  expect(why({ ...clean, checkout: { ...c, url: null } })).toBe('no-remote')
  // A remote on this computer has no address another device can clone.
  expect(why({ ...clean, checkout: { ...c, url: '/srv/git/atlas.git' } })).toBe('no-remote')
  expect(why({ ...clean, subdir: null })).toBe('no-remote')
  expect(why({ ...clean, checkout: { ...c, branch: '' } })).toBe('detached')
  expect(why({ ...clean, checkout: { ...c, branch: 'a..b' } })).toBe('name')
  expect(why({ ...clean, checkout: { ...c, clean: false } })).toBe('changes')
  expect(why({ ...clean, checkout: { ...c, pushed: false } })).toBe('unpushed')
  expect(moveWhyText({ kind: 'unpushed', branch: 'feature-x' })).toBe(
    'its branch feature-x is not pushed: push it first',
  )
  expect(moveWhyText({ kind: 'changes' })).toContain('untracked files count')
})

const pack = (over: Partial<MovePack> = {}): Record<string, unknown> => ({
  v: 1,
  session: S,
  name: 'Atlas',
  category: 'atlas',
  profile: 'default',
  workspace: 'Atlas',
  cwd: '/w/atlas/web',
  folder: {
    url: 'git@github.com:anna/atlas.git',
    address: 'github.com/anna/atlas',
    branch: 'feature-x',
    subdir: 'web',
  },
  files: [
    { kind: 'transcript', path: '', size: 10, sha256: SHA, mode: 0o644 },
    { kind: 'side', path: 'subagents/agent-1.jsonl', size: 3, sha256: 'b'.repeat(64), mode: 0o644 },
    { kind: 'history', path: 'f1@v1', size: 3, sha256: 'c'.repeat(64), mode: 0o755 },
  ],
  entries: [{ id: 'abc123', text: 'check the build', next: 1_800_000_000_000 }],
  trusted: true,
  from: 'laptop',
  ...over,
})

test('a pack that came over a link is checked field by field, never trusted as a path', () => {
  const ok = movePackOf(pack())
  expect('field' in ok).toBe(false)
  expect((ok as MovePack).files.map(f => f.mode)).toEqual([0o644, 0o644, 0o755])
  const fieldOf = (over: Record<string, unknown>) => {
    const r = movePackOf({ ...pack(), ...over })
    return 'field' in r ? r.field : null
  }
  expect(fieldOf({ session: '../x' })).toBe('session')
  expect(fieldOf({ profile: '' })).toBe('profile')
  // The address must be the URL's own: a node names its checkout by it.
  expect(fieldOf({ folder: { ...(pack().folder as object), address: 'github.com/other/x' } })).toBe('folder.url')
  expect(fieldOf({ folder: { ...(pack().folder as object), subdir: '../etc' } })).toBe('folder.subdir')
  const files = pack().files as Record<string, unknown>[]
  const withFile = (f: Record<string, unknown>) => fieldOf({ files: [files[0], f] })
  expect(withFile({ kind: 'side', path: '../../.ssh/id_ed25519', size: 1, sha256: SHA })).toBe('files')
  expect(withFile({ kind: 'side', path: '/etc/passwd', size: 1, sha256: SHA })).toBe('files')
  expect(withFile({ kind: 'history', path: 'a\\b', size: 1, sha256: SHA })).toBe('files')
  expect(withFile({ kind: 'transcript', path: '', size: 1, sha256: SHA })).toBe('files') // two transcripts
  expect(withFile({ kind: 'side', path: 'x', size: -1, sha256: SHA })).toBe('files')
  expect(withFile({ kind: 'side', path: 'x', size: 1, sha256: 'nothex' })).toBe('files')
  expect(fieldOf({ files: [files[1]] })).toBe('files') // no transcript
  expect(fieldOf({ entries: [{ id: 'x', text: 'y' }] })).toBe('entries')
})

test("only a session's reminders travel: a restart, a sleep or a call report is this board's own", () => {
  const entries = [
    { id: 'r1', key: S, text: 'look again', next: 5, name: 'Atlas', by: 'agent', cron: '0 9 * * *', pane: 'w1:p1' },
    { id: 'r2', key: S, text: '', next: 6, kind: 'restart' },
    { id: 'r3', key: S, text: '', next: 7, kind: 'sleep' },
    { id: 'r4', key: S, text: 'report', next: 8, kind: 'call', receipt: {} },
    { id: 'r5', key: 'other', text: 'not mine', next: 9 },
    { id: 'r6', key: S, text: 'wait for it', next: 10, noWake: true, idle: true },
  ]
  expect(entriesToCarry(entries, S)).toEqual([
    { id: 'r1', text: 'look again', next: 5, cron: '0 9 * * *', name: 'Atlas', by: 'agent' },
    { id: 'r6', text: 'wait for it', next: 10, noWake: true, idle: true },
  ])
})

test("the profile there goes by each device's map of the master's ids", () => {
  const devices = { 'server-1': { profiles: { work: 'w1' } }, 'server-2': { profiles: {} } }
  expect(profileOn(devices, 'local', 'server-1', 'work')).toBe('w1')
  expect(profileOn(devices, 'local', 'server-1', 'default')).toBe('default')
  expect(profileOn(devices, 'server-1', 'local', 'w1')).toBe('work')
  expect(profileOn(devices, 'server-1', 'server-2', 'w1')).toBe('work')
  expect(profileOn(devices, 'server-2', 'server-1', 'work')).toBe('w1')
})
