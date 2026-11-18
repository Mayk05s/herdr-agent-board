// The model rule (#429): config.json's `models` names the model family every session should run
// on, and a session on another one gets a red tag on its card and one herdr notification per start.
// Off without the key: the board then reads nothing of it and every card is as before.
//
//   "models": { "expect": "opus", "sessions": { "monitor": "sonnet" }, "lanes": { "ops": ["sonnet", "haiku"] } }
//
// A session is expected on the family its start asked for (card.modelWant, #380) when it asked for
// one, else on `expect`, which is always fine too; `sessions` (by name, key or session id) and `lanes` (by lane id) allow
// more families, "any" every model, and the card's "this model is fine here" (card.modelOk) the
// family it ran when the owner allowed it. Families, not names: a version bump or [1m] is the same
// model here. A model no family is known for (another provider's, through pi) is never judged.
//
// Pure, with no import but types: the web page bundles it.
import type { Card, Item } from './types.ts'

/** The families compared, as Claude Code's aliases name them. */
export const MODEL_FAMILIES: readonly string[] = ['opus', 'sonnet', 'haiku', 'fable']

/** "any" in an allow list: every model is fine there. */
const ANY = 'any'

const FAMILY = new RegExp(`(${MODEL_FAMILIES.join('|')})`, 'i')

/** A model's family: the first of MODEL_FAMILIES its name holds, any case; null for none. */
export function modelFamily(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const hit = FAMILY.exec(name)
  return hit?.[1] ? hit[1].toLowerCase() : null
}

/** A family as a tag or a notification names it: "Opus". */
export const familyTitle = (family: string): string => family.charAt(0).toUpperCase() + family.slice(1)

/** The rule as config.json's `models` gives it, read. */
export interface ModelsConfig {
  /** The family every session should run on. */
  expect: string
  /** More families allowed per session (its name lower-cased, its key or its session id): a family, or "any". */
  sessions: ReadonlyMap<string, readonly string[]>
  /** More families allowed per lane id. */
  lanes: ReadonlyMap<string, readonly string[]>
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** An allow list's entry: a family or a list of them, "any" kept; nothing else counts. */
function families(value: unknown): string[] {
  return (Array.isArray(value) ? value : [value]).flatMap(v => {
    if (typeof v !== 'string') return []
    if (v.trim().toLowerCase() === ANY) return [ANY]
    const family = modelFamily(v)
    return family ? [family] : []
  })
}

function allowMap(value: unknown, key: (k: string) => string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  if (!isRecord(value)) return map
  for (const [k, v] of Object.entries(value)) {
    const list = families(v)
    if (k.trim() && list.length) map.set(key(k.trim()), list)
  }
  return map
}

/** The rule from config.json's `models`; null (off) without it, or without an `expect` naming a family. */
export function modelsConfig(raw: unknown): ModelsConfig | null {
  if (!isRecord(raw)) return null
  const expect = modelFamily(raw.expect)
  if (!expect) return null
  return {
    expect,
    sessions: allowMap(raw.sessions, k => k.toLowerCase()),
    lanes: allowMap(raw.lanes, k => k),
  }
}

/** What a card's tag says: the model the session runs (as it reported it) and the family expected. */
export interface ModelWrong {
  runs: string
  want: string
}

/**
 * Whether a session runs on another model family than the rule expects of it: what its tag says,
 * null when it does not (or the rule is off, or its model or family is not known).
 */
export function modelCheck(
  item: Pick<Item, 'key' | 'session' | 'name' | 'category' | 'model'>,
  card: Pick<Card, 'modelWant' | 'modelOk'>,
  rule: ModelsConfig | null,
): ModelWrong | null {
  if (!rule || !item.model) return null
  const runs = modelFamily(item.model)
  if (!runs) return null
  const want = modelFamily(card.modelWant) ?? rule.expect
  // The rule's own family is always fine: a session started on haiku and moved to opus is no warning.
  const allowed = new Set<string>([want, rule.expect])
  const named = [item.key, item.session ?? '', (item.name ?? '').trim().toLowerCase()]
  for (const k of named) for (const f of (k && rule.sessions.get(k.toLowerCase())) || []) allowed.add(f)
  for (const f of rule.lanes.get(item.category) ?? []) allowed.add(f)
  const ok = modelFamily(card.modelOk)
  if (ok) allowed.add(ok)
  return allowed.has(ANY) || allowed.has(runs) ? null : { runs: item.model, want }
}
