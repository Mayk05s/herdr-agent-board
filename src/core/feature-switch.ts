// A feature's switch in config.json (#596): Settings turns watches, decisions, the away journal and
// threads' verified done on and off without losing what the section holds. A section is `true` or
// an object; off with fields of its own keeps them under `"on": false`, off with none takes the key
// out; on drops `on` again, and a section left with nothing else in it is `true`. A config with no
// `"on": false` in it reads as it did before Settings had these switches.

type Raw = Record<string, unknown>

const sectionOf = (raw: unknown): Raw | null =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Raw) : null

/** The section turned off by Settings (`"on": false`): its reader takes it as absent. */
export const switchedOff = (raw: unknown): boolean => sectionOf(raw)?.on === false

/** config.json's value for a section once Settings turned it `on` or off; undefined: the key goes. */
export function switched(raw: unknown, on: boolean): unknown {
  const { on: _was, ...own } = sectionOf(raw) ?? {}
  if (on) return Object.keys(own).length ? own : true
  return Object.keys(own).length ? { ...own, on: false } : undefined
}

/** The section with `field` set to `value` (undefined: taken out), `true` when nothing else is left. */
export function withField(raw: unknown, field: string, value: unknown): unknown {
  const section: Raw = { ...(sectionOf(raw) ?? {}) }
  if (value === undefined) delete section[field]
  else section[field] = value
  return Object.keys(section).length ? section : true
}
