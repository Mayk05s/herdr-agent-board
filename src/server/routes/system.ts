// GET /api/system: the board's own server's state now (services/system-state.ts), for the head's
// chip and Settings → Server…; read only, current values only. Added on the board's own server only
// (server/app.ts): on a PC there is no such route. Its domain's login reaches it, that page being the
// owner's own (core/remote.ts ownServerSettings); every other remote listener refuses it (localOnly).
import type { SystemState } from '../../services/system-state.ts'
import { json, type Route } from '../http.ts'

export function systemRoutes(state: SystemState): Route[] {
  return [{ method: 'GET', path: '/api/system', handle: async () => json(200, await state.read()) }]
}
