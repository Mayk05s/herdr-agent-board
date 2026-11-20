// The Workdesk feed (services/workdesk-feed.ts) beside a running board, for one task:
// `bun src/entrypoints/workdesk-feed.ts --only <task id> [--every <seconds>] [--once]`.
// A board with `workdesk.feed: true` in config.json runs it for every task itself.
import { loadConfig } from '../adapters/config-file.ts'
import { feedOnce, runWorkdeskFeed } from '../services/workdesk-feed.ts'

const args = process.argv.slice(2)
const value = (flag: string): string | undefined => {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}
const only = Number(value('--only'))
if (!Number.isSafeInteger(only) || only <= 0) {
  console.error('usage: bun src/entrypoints/workdesk-feed.ts --only <task id> [--every <seconds>] [--once]')
  process.exit(2)
}
const every = Number(value('--every') ?? 15)
const log = (message: string) => console.error(`${new Date().toISOString()} ${message}`)
const controller = new AbortController()
process.on('SIGINT', () => controller.abort())
process.on('SIGTERM', () => controller.abort())
const options = { cfg: loadConfig(), only, log }
if (args.includes('--once')) await feedOnce(options, controller.signal)
else await runWorkdeskFeed({ ...options, intervalSec: every > 0 ? every : 15 }, controller.signal)
