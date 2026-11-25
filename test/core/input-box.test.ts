import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { inputDraft, PICTURE_PATH, stillPasting } from '../../src/core/dialogs/input-box.ts'
import { trustScreen } from '../support/trust-screen.ts'

const rule = '─'.repeat(40)
const ESC = '\x1b'
const grey = (s: string): string => `${ESC}[0m${ESC}[38;2;136;136;136m${s}${ESC}[0m`
const box = (text: string, footer = '  ⏵⏵ bypass permissions on'): string =>
  [rule, `❯ ${text}`, rule, footer].join('\n')

test('a complete current input box preserves multiline text and ignores a dim suggestion', () => {
  expect(inputDraft(box(''))).toBe('')
  expect(inputDraft(box('\x1b[2mTry fixing the tests\x1b[0m'))).toBe('')
  expect(inputDraft(box('first\n  second line'))).toBe('first\n  second line')
  expect(inputDraft(box('Explain\n  Esc to cancel'))).toBe('Explain\n  Esc to cancel')
  expect(inputDraft(box('Explain this terminal snippet:\n  ❯ bun test'))).toBe(
    'Explain this terminal snippet:\n  ❯ bun test',
  )
  expect(inputDraft(box('typed', '  esc to interrupt · tab to accept'))).toBe('typed')
  expect(inputDraft(`Earlier question: Esc to cancel\n${box('current')}`)).toBe('current')
})

test('an old input box is not evidence that a later dialog takes messages', () => {
  expect(inputDraft(`${box('')}\nTeach auto mode?\n   ❯ Continue\n   Esc to cancel`)).toBeNull()
  expect(inputDraft(`${box('')}\nUnknown dialog\nEnter to continue`)).toBeNull()
  expect(inputDraft(`${rule}\n❯ Continue\n  Cancel`)).toBeNull()
  expect(inputDraft(`${rule}\n❯ `)).toBeNull()
  expect(inputDraft('')).toBeNull()
})

// Claude Code 2.1.308 in herdr, captured with `agent read --source visible --ansi`: a screenshot's
// path pasted, then the box once it was read.
const screen = (name: string): string =>
  readFileSync(new URL(`../support/screens/${name}.txt`, import.meta.url), 'utf8')

test('a paste still being read: "Pasting…" under the box, the box empty', () => {
  expect(stillPasting(screen('claude-pasting'))).toBe(true)
  expect(stillPasting(screen('claude-pasting').replaceAll('\n', '\r\n'))).toBe(true)
  expect(inputDraft(screen('claude-pasting'))).toBe('')
  expect(stillPasting(box('', '  Pasting...'))).toBe(true)
})

test('the picture in the box, an empty box, and "Pasting…" anywhere else are not a paste being read', () => {
  expect(stillPasting(screen('claude-picture-in-box'))).toBe(false)
  expect(inputDraft(screen('claude-picture-in-box'))).toBe(
    '[Image #3]the browser icon looks broken on the tablet\n  Файл:',
  )
  expect(stillPasting(box(''))).toBe(false)
  expect(stillPasting(box('Pasting…'))).toBe(false)
  expect(stillPasting(`  Pasting…\n${box('')}`)).toBe(false)
  expect(stillPasting(box('', '  Pasting… more'))).toBe(false)
  expect(stillPasting('')).toBe(false)
  expect(stillPasting(null)).toBe(false)
})

test('the paths Claude Code takes in as pictures: its own extensions, any case, on any system', () => {
  for (const path of [
    '/home/agent/.local/state/herdr/plugins/agent-board/uploads/2026-10-31/054431-screenshot-074431.png',
    'C:\\Users\\Team Work\\AppData\\Local\\herdr\\plugins\\agent-board\\uploads\\2026-10-31\\074431-снимок-100%.PNG',
    '/uploads/2026-10-31/IMG-0001.jpeg',
    '/uploads/2026-10-31/photo.JPG',
    '/uploads/2026-10-31/a.gif',
    '/uploads/2026-10-31/a.webp',
  ])
    expect(PICTURE_PATH.test(path)).toBe(true)
  for (const path of [
    '/uploads/2026-10-31/notes.pdf',
    '/uploads/2026-10-31/a.heic',
    '/uploads/a.png.txt',
    '/uploads/png',
  ])
    expect(PICTURE_PATH.test(path)).toBe(false)
})

// Captured from Claude Code (stub API) after /rename, in a pane 120 columns wide: the rule over
// the box carries the name at its right end, as wide as the rule under the box, and a name longer
// than the rule takes its whole start, cut with "…" (#484). Before, such a box read as a dialog:
// no message from the card, no archive, no sleep.
test('the rule over the box may carry the session name, however long', () => {
  const wide = '─'.repeat(119)
  const named = (top: string, text = `${ESC}[7m ${ESC}[0m`, bottom = wide): string =>
    [
      grey(top),
      `❯ ${ESC}[0m${text}`,
      grey(bottom),
      `  ${ESC}[0m${ESC}[38;2;255;193;7m⏵⏵ auto mode on${ESC}[0m${ESC}[38;2;153;153;153m (shift+tab to cycle)${ESC}[0m`,
    ].join('\n')
  expect(inputDraft(named(`${'─'.repeat(105)} anna#1 ─`))).toBe('')
  const long =
    ' anna-1# Brief: board issue(s) #1, #2 Board agent. Work in thread atlas-1: post your status there. The owner asks to… ─'
  expect(inputDraft(named(long))).toBe('')
  expect(inputDraft(named(long, 'hello'))).toBe('hello')
  // A name a little shorter than the rule leaves a few dashes before it.
  expect(inputDraft(named(`─── ${'b'.repeat(113)} ─`, 'typed'))).toBe('typed')
  // Not that rule: a heading that ends in a dash over a picker, one wider or narrower than the rule
  // under it, a line of text over a picker's cursor, a box with no rule under it.
  expect(inputDraft(named('  Pick one ─', '1. Yes\n  2. No'))).toBeNull()
  expect(inputDraft(named(long, '', '─'.repeat(80)))).toBeNull()
  expect(inputDraft('Pick one:\n❯ 1. Yes\n  2. No')).toBeNull()
  expect(inputDraft(`${grey(long)}\n❯ Continue\n  Cancel`)).toBeNull()
})

// Claude Code 2.1.330's prompt once a start is over, read through herdr (test/core/prompt-screen.test.ts
// says how), and the screens every launch meets at its message step: the verdicts every setup had
// before #602, which runs on main as on the change.
test('the screens a launch meets read as before: the prompt empty, with its suggestion, with text typed, the trust dialog', () => {
  const prompt = readFileSync(new URL('../support/screens/startup-prompt.txt', import.meta.url), 'utf8')
  const typedInto = (text: string): string => prompt.replace(/^❯.*$/m, `❯\u00a0${text}${ESC}[7m ${ESC}[0m`)
  expect(inputDraft(prompt)).toBe('')
  expect(inputDraft(typedInto(`${ESC}[0m${ESC}[2mTry "fix the failing test"${ESC}[0m`))).toBe('')
  expect(inputDraft(typedInto('half a thought the owner typed'))).toBe('half a thought the owner typed')
  expect(inputDraft(trustScreen('C:\\work\\probe'))).toBeNull()
})
