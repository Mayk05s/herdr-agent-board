// The model rule (#429, core/model-check.ts): config.json's `models` read, and a session's model
// against it by family, with the start's model, the per-session and per-lane allows and the card's.
import { expect, test } from 'bun:test'
import { familyTitle, modelCheck, modelFamily, modelsConfig } from '../../src/core/model-check.ts'

const item = (
  model: string | null,
  more: Partial<{ key: string; session: string; name: string; category: string }> = {},
) => ({
  key: 's1',
  session: 's1',
  name: 'Atlas',
  category: 'other',
  model,
  ...more,
})

test('a model is known by its family, whatever its version, window or spelling', () => {
  expect(modelFamily('claude-opus-5-5')).toBe('opus')
  expect(modelFamily('claude-opus-5-5[1m]')).toBe('opus')
  expect(modelFamily('Opus 5.5 (1M context)')).toBe('opus')
  expect(modelFamily('sonnet')).toBe('sonnet')
  expect(modelFamily('claude-3-5-haiku-20241022')).toBe('haiku')
  expect(modelFamily('claude-fable-5-2')).toBe('fable')
  expect(modelFamily('gpt-5')).toBeNull()
  expect(modelFamily('')).toBeNull()
  expect(modelFamily(undefined)).toBeNull()
  expect(familyTitle('opus')).toBe('Opus')
})

test('no models key, or none naming a family: the rule is off', () => {
  for (const raw of [undefined, null, true, 'opus', [], {}, { expect: '' }, { expect: 'gpt-5' }, { expect: 3 }])
    expect(modelsConfig(raw)).toBeNull()
  expect(modelCheck(item('claude-sonnet-5-5'), {}, null)).toBeNull()
})

test('the rule read: expect as a family, allows by session (any case) and lane, junk left out', () => {
  const rule = modelsConfig({
    expect: 'claude-opus-5-5',
    sessions: { Monitor: 'sonnet', ben: ['haiku', 'nope', 7], cleo: 'any', empty: [] },
    lanes: { ops: ['Sonnet 5.5'] },
  })
  expect(rule?.expect).toBe('opus')
  expect([...(rule?.sessions ?? [])]).toEqual([
    ['monitor', ['sonnet']],
    ['ben', ['haiku']],
    ['cleo', ['any']],
  ])
  expect([...(rule?.lanes ?? [])]).toEqual([['ops', ['sonnet']]])
})

test('on the expected family: no tag; on another: the model it runs and the family expected', () => {
  const rule = modelsConfig({ expect: 'opus' })
  expect(modelCheck(item('claude-opus-5-5[1m]'), {}, rule)).toBeNull()
  expect(modelCheck(item('claude-sonnet-5-5'), {}, rule)).toEqual({ runs: 'claude-sonnet-5-5', want: 'opus' })
  // Not known yet, or no family known (another provider's): never judged.
  expect(modelCheck(item(null), {}, rule)).toBeNull()
  expect(modelCheck(item('gpt-5'), {}, rule)).toBeNull()
})

test('a start that asked for a model is expected on it; the rule’s family is fine too, another one warns', () => {
  const rule = modelsConfig({ expect: 'opus' })
  expect(modelCheck(item('claude-sonnet-5-5'), { modelWant: 'sonnet' }, rule)).toBeNull()
  // Started on haiku and moved to opus with /model: the rule's own family, no warning.
  expect(modelCheck(item('claude-opus-5-5'), { modelWant: 'haiku' }, rule)).toBeNull()
  expect(modelCheck(item('claude-sonnet-5-5'), { modelWant: 'haiku' }, rule)).toEqual({
    runs: 'claude-sonnet-5-5',
    want: 'haiku',
  })
  // A model name with no family known keeps the rule's.
  expect(modelCheck(item('claude-sonnet-5-5'), { modelWant: 'gpt-5' }, rule)?.want).toBe('opus')
})

test('allowed per session (name, key or session id), per lane, from the card, or any', () => {
  const rule = modelsConfig({
    expect: 'opus',
    sessions: { monitor: 'sonnet', 'pane-wp:p2': 'sonnet', 'abc-123': 'sonnet', cleo: 'any' },
    lanes: { ops: 'sonnet' },
  })
  const sonnet = 'claude-sonnet-5-5'
  expect(modelCheck(item(sonnet, { name: ' Monitor ' }), {}, rule)).toBeNull()
  expect(modelCheck(item(sonnet, { key: 'pane-wP:p2', session: '' }), {}, rule)).toBeNull()
  expect(modelCheck(item(sonnet, { key: 'ABC-123', session: 'ABC-123' }), {}, rule)).toBeNull()
  expect(modelCheck(item('claude-haiku-4-5', { name: 'cleo' }), {}, rule)).toBeNull()
  expect(modelCheck(item(sonnet, { category: 'ops' }), {}, rule)).toBeNull()
  expect(modelCheck(item(sonnet), { modelOk: 'sonnet' }, rule)).toBeNull()
  // An allow is for its family: another one warns again.
  expect(modelCheck(item('claude-haiku-4-5', { category: 'ops' }), {}, rule)?.want).toBe('opus')
  expect(modelCheck(item('claude-haiku-4-5'), { modelOk: 'sonnet' }, rule)?.runs).toBe('claude-haiku-4-5')
  // Names with spaces, other alphabets and % match as written.
  const named = modelsConfig({ expect: 'opus', sessions: { 'анна 100%': 'sonnet' } })
  expect(modelCheck(item(sonnet, { name: 'Анна 100%' }), {}, named)).toBeNull()
})
