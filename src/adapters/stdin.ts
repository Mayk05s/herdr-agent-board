// Everything a process was handed on stdin, as UTF-8 (the Claude Code hook and status line read
// their input this way). Not Bun.stdin.text(): outside a top-level await it does not keep the
// process alive, which then exits before the input arrives.
export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8')
}

const ESC = '\u001b'

/**
 * One line typed at the terminal with nothing shown (a secret's value, `board secret set`): `prompt` on stderr, then
 * the keys read raw until Enter; Backspace takes one character back, Ctrl+C or Ctrl+D with nothing
 * typed ends it with null. Only for a terminal (process.stdin.isTTY).
 */
export function readHiddenLine(prompt: string): Promise<string | null> {
  const input = process.stdin
  process.stderr.write(prompt)
  return new Promise(resolve => {
    let typed = ''
    const done = (value: string | null): void => {
      input.off('data', onData)
      input.setRawMode?.(false)
      input.pause()
      process.stderr.write('\n')
      resolve(value)
    }
    const onData = (chunk: Buffer | string): void => {
      // A paste in a terminal that brackets it: the brackets are not typed.
      const text = String(chunk).split(`${ESC}[200~`).join('').split(`${ESC}[201~`).join('')
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          done(typed)
          return
        }
        if (ch === '\u0003' || (ch === '\u0004' && typed === '')) {
          done(null)
          return
        }
        if (ch === '\u007f' || ch === '\b') typed = [...typed].slice(0, -1).join('')
        else if (ch >= ' ' || ch === '\t') typed += ch
      }
    }
    input.setRawMode?.(true)
    input.resume()
    input.setEncoding('utf8')
    input.on('data', onData)
  })
}

/** A terminal's input as readHidden needs it: process.stdin, or a stand-in in a test. */
export interface HiddenInput {
  setRawMode(on: boolean): unknown
  resume(): unknown
  pause(): unknown
  on(event: 'data', fn: (chunk: Buffer | string) => void): unknown
  off(event: 'data', fn: (chunk: Buffer | string) => void): unknown
}

/**
 * One line each for `prompts`, typed on the terminal with nothing shown, for a secret (`board nodes
 * secret`): each prompt on stderr, the keys read raw, Backspace taking one back, Enter ending the
 * line. A key that is no character (an arrow, Home, Delete: an escape sequence; another control
 * key) is left out. Ctrl+C or Ctrl+D refuses it all, and so does a paste with a line break inside,
 * whose rest would else go unseen into the next value. The terminal is back as it was on every way out.
 */
export function readHidden(
  prompts: readonly string[],
  stdin: HiddenInput = process.stdin,
  say: (text: string) => void = text => void process.stderr.write(text),
): Promise<string[]> {
  const out: string[] = []
  if (!prompts.length) return Promise.resolve(out)
  return new Promise((resolve, reject) => {
    let value: string[] = []
    // In an escape sequence: after ESC, then after its `[` or `O`, until its final character.
    let inEscape: 'none' | 'esc' | 'csi' = 'none'
    let afterCr = false
    const done = (err: Error | null): void => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      say('\n')
      if (err) reject(err)
      else resolve(out)
    }
    const onData = (chunk: Buffer | string): void => {
      const chars = [...String(chunk)]
      for (let i = 0; i < chars.length; i++) {
        const ch = chars[i] as string
        const code = ch.codePointAt(0) ?? 0
        if (ch === '\n' && afterCr) {
          afterCr = false
          continue
        }
        afterCr = false
        if (inEscape === 'esc') {
          inEscape = ch === '[' || ch === 'O' ? 'csi' : 'none'
          continue
        }
        if (inEscape === 'csi') {
          if (code >= 0x40 && code <= 0x7e) inEscape = 'none'
          continue
        }
        if (ch === '\u001b') inEscape = 'esc'
        else if (ch === '\u0003' || ch === '\u0004') {
          done(new Error('cancelled: nothing sent'))
          return
        } else if (ch === '\r' || ch === '\n') {
          afterCr = ch === '\r'
          out.push(value.join(''))
          value = []
          const rest = chars.slice(i + 1).join('')
          if (rest && rest !== '\n') {
            done(new Error('a pasted value had a line break in it: nothing sent'))
            return
          }
          if (out.length === prompts.length) {
            done(null)
            return
          }
          say(`\n${prompts[out.length]}`)
        } else if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else if (code >= 0x20) value.push(ch)
      }
    }
    say(prompts[0] ?? '')
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on('data', onData)
  })
}
