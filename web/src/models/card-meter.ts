// The line under a card's name that says what model it runs. With Settings' "Model and effort on
// cards" off it is what it was: only a Codex card's "model · effort". With it on, every agent's
// card has it, led by the agent's name, and the effort when known.
import type { Item } from '../../../src/core/types.ts'

const AGENT_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', pi: 'pi' }

export function cardMeter(item: Pick<Item, 'agent' | 'model' | 'effort'>, on: boolean): string | null {
  const { agent, model, effort } = item
  if (!on) return agent === 'codex' && model && effort ? `${model} · ${effort}` : null
  if (!model) return null
  const name = agent ? AGENT_NAMES[agent] : undefined
  return [name, model, effort].filter(Boolean).join(' · ')
}
