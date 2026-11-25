// The model warning on a card (#429): a red tag after the name while the server says the session
// runs on another model family than config.json's `models` expects (item.modelWrong), and the
// card's menu offers "This model is fine here". Without it the card and its menu are as before.
import { expect, test } from 'bun:test'
import { translator } from '../../src/core/i18n/translator.ts'
import type { Item } from '../../src/core/types.ts'
import { tagOf as lineTag } from '../../src/tui/render.ts'
import type { TuiState } from '../../src/tui/state.ts'
import { Board } from '../../web/src/components/Board.tsx'
import { ALL_LANES } from '../../web/src/models/lane-picks.ts'
import { cardMenu, isSeparator, type MenuEntry } from '../../web/src/models/menu-model.ts'
import { board, item, payload, renderInBoard } from './support/board.tsx'
import { type Element, find, findAll, hasClass, type Node } from './support/markup.ts'

const OTHER = {
  id: 'other',
  title: 'Other',
  color: '#8E8E93',
  colorName: '',
  paths: [],
  configured: true,
  fallback: true,
}
const WRONG = { runs: 'claude-sonnet-5-5[1m]', want: 'opus' }
const anna = item({ key: 'a', name: 'anna', column: 'work', status: 'working', modelWrong: WRONG })
const ben = item({ key: 'b', name: 'ben', column: 'work', status: 'working' })

const boardOf = (items: Item[], lang = 'en'): Node[] =>
  renderInBoard(
    <Board />,
    board({ data: payload({ items, categories: [OTHER] }), ui: { filter: ALL_LANES, query: '', sleepers: true } }),
    lang,
  )
const textOf = (n: Node): string => (n.kind === 'text' ? n.text : n.children.map(textOf).join(''))
const cardOf = (nodes: Node[], key: string): Element =>
  find(nodes, el => el.tag === 'article' && el.attrs.get('data-key') === key)
const modelTags = (nodes: Node[], key: string) =>
  findAll(cardOf(nodes, key).children, el => hasClass(el, 'model-tag')).map(el => [
    textOf(el),
    el.attrs.get('title') ?? '',
  ])

test('a card on another model: a red tag naming both families, the model in its tooltip; the others none', () => {
  const nodes = boardOf([anna, ben])
  expect(modelTags(nodes, 'a')).toEqual([['Sonnet, expected Opus', 'Runs on claude-sonnet-5-5[1m], expected Opus']])
  expect(modelTags(nodes, 'b')).toEqual([])
  expect(modelTags(boardOf([anna], 'ru'), 'a')).toEqual([
    ['Sonnet, ожидается Opus', 'Работает на claude-sonnet-5-5[1m], ожидается Opus'],
  ])
})

test('its menu offers "This model is fine here", and only while the tag shows', () => {
  const t = translator('en')
  const ctx = { t, canMutate: true, canEdit: true, categories: [], column: 'work', category: 'other' }
  const ids = (m: MenuEntry[]) => m.filter(e => !isSeparator(e)).map(e => ('id' in e ? e.id : ''))
  const withTag = cardMenu(anna, ctx)
  const entry = withTag.find(e => !isSeparator(e) && 'id' in e && e.id === 'modelOk')
  expect(entry && 'label' in entry ? entry.label : null).toBe('This model is fine here')
  expect(ids(withTag).indexOf('modelOk')).toBe(ids(withTag).indexOf('favorite') + 1)
  // Without it the menu is the same as a card's with no field at all.
  const { modelWrong: _, ...plain } = anna
  expect(ids(cardMenu(ben, ctx))).not.toContain('modelOk')
  expect(ids(cardMenu(plain, ctx))).toEqual(ids(withTag).filter(id => id !== 'modelOk'))
  expect(ids(cardMenu(anna, { ...ctx, canEdit: false }))).toContain('modelOk')
})

test('the terminal board: "wrong model" in red, a wrong profile first, none without the field', () => {
  const state = { profiles: [] } as unknown as TuiState
  expect(lineTag(state, anna, 20)).toEqual({ text: 'wrong model', color: 'red' })
  expect(lineTag(state, ben, 20)).toBeNull()
  const both = { ...anna, profile: 'default', profileWanted: 'work' }
  expect(lineTag(state, both, 20)?.color).toBe('red')
  expect(lineTag(state, both, 20)?.text).not.toBe('wrong model')
  expect(lineTag(state, anna, 0)).toBeNull()
})
