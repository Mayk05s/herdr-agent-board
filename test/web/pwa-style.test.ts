// Typing on a phone (web/styles/pwa.css, the sheet the board serves a phone's browser only): every
// field at 16px, so iOS does not zoom the page into it as it takes the focus (and leave it zoomed and
// slid sideways); the message box's text across its width; the sheet within what shows above the
// keyboard. All of it under one query, a phone in the hand, the one the page's hook goes by: the
// computer and a tablet, through the same page, read none of it.
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PHONE_TOUCH_QUERY } from '../../web/src/hooks/usePhoneKeyboard.ts'
import { type Complex, rulesOf } from './support/stylesheets.ts'

const STYLES = join(import.meta.dir, '..', '..', 'web', 'styles')
const bare = (name: string) => readFileSync(join(STYLES, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const pwa = bare('pwa.css')

/** The body of each `@media <query> { … }` block of `css`, braces matched. */
function mediaBlocks(css: string, query: string): string[] {
  const blocks: string[] = []
  const head = `@media ${query}`
  for (let at = css.indexOf(head); at >= 0; at = css.indexOf(head, at + 1)) {
    const open = css.indexOf('{', at)
    let depth = 1
    let i = open + 1
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') depth--
    }
    blocks.push(css.slice(open + 1, i - 1))
  }
  return blocks
}

/** `css` without those blocks. */
const without = (css: string, blocks: string[]) => blocks.reduce((rest, block) => rest.replace(block, ''), css)

/** A selector list's selectors: split at the commas outside brackets. */
function selectors(list: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < list.length; i++) {
    const c = list[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      parts.push(list.slice(start, i))
      start = i + 1
    }
  }
  parts.push(list.slice(start))
  return parts.map(s => s.replace(/\s+/g, ' ').trim())
}

/** The declarations of the rules whose selector list holds `selector`, in `css`. */
function declared(css: string, selector: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => selectors(m[1] ?? '').includes(selector))
    .flatMap(m => (m[2] ?? '').split(';').map(d => d.trim()))
    .filter(Boolean)
}

/** A selector's specificity as one number (ids, then classes, attributes and pseudo-classes, then types). */
function weight(complex: Complex): number {
  let sum = 0
  for (const c of complex.compounds) {
    sum += (c.id ? 10_000 : 0) + 100 * (c.classes.length + c.attrs.length) + (c.tag && c.tag !== '*' ? 1 : 0)
    for (const p of c.pseudos) {
      if (p.name === 'where') continue
      // :not(), :is() and :has() weigh as their heaviest argument.
      sum += p.args ? Math.max(...p.args.map(weight)) : 100
    }
  }
  return sum
}

const SIXTEEN = 'font-size: 16px !important'
const fold = (selector: string) => selector.replace(/\s+/g, ' ').trim()

describe('typing on a phone', () => {
  const phone = mediaBlocks(pwa, PHONE_TOUCH_QUERY)
  const inPhone = phone.join('\n')

  test("the phone's rules are under the query the page's hook goes by, and only there", () => {
    expect(phone.length).toBe(1)
    const rest = without(pwa, phone)
    for (const marker of ['data-keyboard', '--vv-', '.composer', SIXTEEN])
      expect({ marker, outside: rest.includes(marker) }).toEqual({ marker, outside: false })
  })

  test('every field is 16px there, outranking any size another sheet gives one; checkboxes and the login keep theirs', () => {
    const fields = rulesOf('pwa.css', inPhone).filter(r => declared(inPhone, fold(r.selector)).includes(SIXTEEN))
    const subjects = fields.map(r => r.complex.compounds.at(-1)?.tag)
    expect(subjects.sort()).toEqual(['input', 'select', 'textarea'])
    const input = fields.find(r => r.complex.compounds.at(-1)?.tag === 'input')
    const kept = input?.complex.compounds.at(-1)?.pseudos[0]?.args?.map(a => a.compounds[0]) ?? []
    const types = kept.flatMap(c => c?.attrs.map(a => a.value) ?? [])
    expect(types).toEqual(expect.arrayContaining(['checkbox', 'radio', 'range', 'file', 'color']))
    expect(types).not.toContain('text')
    expect(kept.some(c => c?.classes.includes('login-input'))).toBe(true)
    // A size another sheet makes important on a field (the folder's, in the launch window) loses to ours.
    const others = readdirSync(STYLES)
      .filter(f => f.endsWith('.css') && f !== 'pwa.css')
      .flatMap(f =>
        [...bare(f).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
          .filter(m => /font-size:[^;]*!important/.test(m[2] ?? ''))
          .flatMap(m => rulesOf(f, `${m[1]} {}`)),
      )
    expect(others.map(r => r.selector)).toContain('.folder-field input')
    for (const r of others) {
      const tag = r.complex.compounds.at(-1)?.tag
      const ours = fields.find(f => f.complex.compounds.at(-1)?.tag === tag)
      const outranked = !ours || weight(r.complex) < weight(ours.complex)
      expect({ selector: r.selector, outranked }).toEqual({ selector: r.selector, outranked: true })
    }
  })

  test("the message box's text across its width, its buttons under it", () => {
    expect(declared(inPhone, '#sheet .composer-box')).toContain('flex-wrap: wrap')
    expect(declared(inPhone, '#sheet .composer textarea')).toEqual(
      expect.arrayContaining(['order: -1', 'flex: 1 0 100%']),
    )
  })

  test('with the keyboard up, the sheet takes what shows above it', () => {
    const sheet = declared(inPhone, ':root[data-keyboard] .sheet')
    expect(sheet).toContain('bottom: auto')
    expect(sheet.some(d => d.startsWith('top:') && d.includes('var(--vv-top'))).toBe(true)
    expect(sheet.some(d => d.startsWith('height:') && d.includes('var(--vv-height'))).toBe(true)
  })
})
