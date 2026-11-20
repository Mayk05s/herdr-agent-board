// Launch only as the dedicated sender user under the system service manager.
import { loadConfig } from '../adapters/config-file.ts'
import { startWorkdeskUnified } from '../services/workdesk-unified.ts'

try {
  process.umask(0o007)
  const stop = startWorkdeskUnified(loadConfig())
  if (!stop) {
    console.error('Workdesk sender refused: check the pinned assignment, service UID and isolated state permissions.')
    process.exitCode = 1
  } else {
    const shutdown = () => {
      void stop().catch(() => {
        process.exitCode = 1
      })
    }
    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)
  }
} catch {
  console.error('Workdesk sender could not load its configuration.')
  process.exitCode = 1
}
