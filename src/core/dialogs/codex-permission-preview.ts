// Card text only. The full screen, action options and fingerprints stay with the permission parser.
import { CODEX_AGENT } from '../codex.ts'
import { stripAnsi } from './input-box.ts'
import { cleanOther, parseDialog } from './questions.ts'

interface PermissionPreview {
  reason: string
  command: string
}

const COMMAND = /^(?:\$\s+|Command:\s*)(.*)$/
const FIELD = /^(?:Environment|Thread|Reason|Permission rule|Command|Input):|^\$ /
const WRAPPER = /^(?:\/\/\s*)?@exec\b|^exec\s*·/
const INLINE_SCRIPT =
  /^((?:\S+[/\\])?(?:(?:ba|z|da|k|fi)?sh(?:\.exe)?\s+-[a-z]*c|(?:node|bun|deno|ruby|perl)(?:\.exe)?\s+(?:-[ep]|--eval|eval)|python(?:[23](?:\.\d+)?)?(?:\.exe)?\s+-c|(?:pwsh|powershell)(?:\.exe)?\s+-(?:command|encodedcommand)))(?=\s|=|$)/i

const short = (s: string, limit: number): string => (s.length > limit ? `${s.slice(0, limit - 1).trimEnd()}…` : s)

export const isCodexExecWrapper = (text: string): boolean => WRAPPER.test(text.trimStart())

/** Some displays omit Environment or spell out Command. Recognize these for presentation only. */
function visibleBody(screen: string): string[] | null {
  const dialog = parseDialog(screen, CODEX_AGENT)
  if (dialog?.kind === 'permission') return dialog.body.map(line => line.trim())
  const lines = stripAnsi(screen)
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.trim())
  const title = lines.lastIndexOf('Would you like to run the following command?')
  const footer = lines.findLastIndex(line => /^Press enter to confirm or esc to cancel$/i.test(line))
  if (title < 0 || footer <= title) return null
  const rows = lines.slice(title + 1, footer).filter(Boolean)
  const first = rows.findIndex(line => /^(?:›\s+)?1\. Yes, proceed \(y\)$/.test(line))
  if (first < 1) return null
  const choices = rows.slice(first)
  const deny = /^(?:›\s+)?([23])\. No, and tell Codex what to do differently \(esc\)$/.exec(choices.at(-1) ?? '')
  if (
    !deny ||
    Number(deny[1]) !== choices.length ||
    (choices.length === 3 && !/^(?:›\s+)?2\. Yes, and don't ask again.+\(p\)$/.test(choices[1] ?? ''))
  )
    return null
  return rows.slice(0, first)
}

export function codexPermissionPreview(screen: string): PermissionPreview | null {
  const body = visibleBody(screen)
  if (!body) return null
  const reasonAt = body.findIndex(line => line.startsWith('Reason:'))
  const commandAt = body.findIndex(line => COMMAND.test(line))
  let reason = ''
  if (reasonAt >= 0 && (commandAt < 0 || reasonAt < commandAt)) {
    const following = body.slice(reasonAt + 1)
    const stop = following.findIndex(line => FIELD.test(line))
    reason = short(
      cleanOther(
        [body[reasonAt]?.slice('Reason:'.length), ...following.slice(0, stop < 0 ? undefined : stop)].join(' '),
      ),
      180,
    )
  }
  if (commandAt < 0) return { reason, command: '' }
  const first = COMMAND.exec(body[commandAt] ?? '')?.[1]?.trim() ?? ''
  const next = body[commandAt + 1] ?? ''
  const separate = !first && !!next && !FIELD.test(next)
  const raw = (first || (separate ? next : '')).replace(/^\$\s+/, '')
  if (!raw || isCodexExecWrapper(raw)) return { reason, command: '' }
  const script = INLINE_SCRIPT.exec(raw)?.[1]
  const rest = body[commandAt + (separate ? 2 : 1)]
  const command =
    script && raw.length > script.length ? `${script} …` : short(`${raw}${rest && !FIELD.test(rest) ? ' …' : ''}`, 96)
  return { reason, command: `$ ${command}` }
}
