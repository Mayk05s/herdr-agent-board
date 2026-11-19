import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { isRecord, readJson, updateJson } from '../../src/adapters/json-store.ts'
import type { WorkdeskTask } from '../../src/core/workdesk.ts'

type State = {
  tasks: WorkdeskTask[]
  missing?: boolean
  dropClaim?: number
  conflict?: number
}
const isState = (value: unknown): value is State => isRecord(value) && Array.isArray(value.tasks)
const [, , statePath = '', logPath = '', literal = ''] = process.argv
const send = (id: number, result: unknown) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }))
const tools = ['board_heartbeat', 'list_board_tasks', 'claim_task', 'report_task']
const response = (data: unknown, isError = false) => ({ structuredContent: data, isError })

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) continue
  const state = readJson(statePath, isState)
  if (!state) process.exit(1)
  appendFileSync(logPath, `${JSON.stringify({ method, params, literal })}\n`)
  if (method === 'initialize') send(id, { protocolVersion: '2024-11-05' })
  if (method === 'tools/list')
    send(id, { tools: (state.missing ? ['start_codex_review', 'get_codex_review'] : tools).map(name => ({ name })) })
  if (method !== 'tools/call') continue

  if (params.name === 'board_heartbeat') send(id, response({ ok: true, received_at: Date.now() }))
  if (params.name === 'list_board_tasks') send(id, response({ tasks: state.tasks }))
  if (params.name !== 'claim_task') continue

  const { task_id, executor } = params.arguments
  const updated = updateJson(
    statePath,
    live => {
      if (!live) throw new Error('fixture state was removed')
      return {
        ...live,
        tasks: live.tasks.map(task => {
          if (task.id !== task_id || task.executor !== null) return task
          return { ...task, status: 'doing' as const, executor: live.conflict === task_id ? 'Other master' : executor }
        }),
      }
    },
    isState,
  )
  const task = updated.tasks.find(task => task.id === task_id)
  if (task_id === updated.dropClaim && state.tasks.some(t => t.id === task_id && t.executor === null)) process.exit(1)
  if (task?.executor !== executor) send(id, response({ code: 'conflict', status: 409 }, true))
  else send(id, response({ ...task, replayed: state.tasks.some(t => t.id === task_id && t.executor === executor) }))
}
