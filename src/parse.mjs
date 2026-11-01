/**
 * Parse a swarm event log: one JSON object per line.
 *
 * The schema is intentionally small. Every event needs `ts`, `agent` and
 * `type`; task-scoped events need `task`; routed events need `to`.
 */

export const EVENT_TYPES = Object.freeze([
  "task.create",
  "task.assign",
  "task.claim",
  "task.progress",
  "task.done",
  "task.block",
  "message",
  "handoff",
])

export const TASK_TYPES = new Set([
  "task.create",
  "task.assign",
  "task.claim",
  "task.progress",
  "task.done",
  "task.block",
])

const TYPE_SET = new Set(EVENT_TYPES)

export class InputError extends Error {
  constructor(message) {
    super(message)
    this.name = "InputError"
    this.code = "E_INPUT"
    this.exitCode = 3
  }
}

/**
 * @param {string} text
 * @param {{ source?: string }} [options]
 * @returns {{ events: Array<object>, ignored: Array<{ type: string, count: number }> }}
 */
export function parseEvents(text, { source = "<input>" } = {}) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/)
  const events = []
  const ignored = new Map()

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim()
    if (raw === "") continue

    const where = `${source}:${index + 1}`
    let value
    try {
      value = JSON.parse(raw)
    } catch {
      throw new InputError(`${where}: invalid JSON`)
    }

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new InputError(`${where}: expected a JSON object`)
    }

    const type = typeof value.type === "string" ? value.type.trim() : ""
    if (type === "") throw new InputError(`${where}: missing "type"`)

    if (!TYPE_SET.has(type)) {
      ignored.set(type, (ignored.get(type) ?? 0) + 1)
      continue
    }

    const agent =
      typeof value.agent === "string"
        ? value.agent.trim()
        : typeof value.from === "string"
          ? value.from.trim()
          : ""
    if (agent === "") throw new InputError(`${where}: missing "agent"`)

    const ts = typeof value.ts === "string" ? value.ts : ""
    const at = ts === "" ? Number.NaN : Date.parse(ts)
    if (!Number.isFinite(at)) {
      throw new InputError(`${where}: missing or invalid "ts" (ISO 8601 required)`)
    }

    const task = typeof value.task === "string" ? value.task.trim() : ""
    if (TASK_TYPES.has(type) && task === "") {
      throw new InputError(`${where}: "${type}" requires "task"`)
    }

    const to = typeof value.to === "string" ? value.to.trim() : ""
    if ((type === "message" || type === "handoff") && to === "") {
      throw new InputError(`${where}: "${type}" requires "to" (use "*" for broadcast)`)
    }

    events.push({
      seq: events.length,
      type,
      agent,
      ts,
      at,
      task: task === "" ? undefined : task,
      to: to === "" ? undefined : to,
      text: typeof value.text === "string" ? value.text : "",
      evidence: typeof value.evidence === "string" ? value.evidence.trim() : "",
    })
  }

  events.sort((left, right) => left.at - right.at || left.seq - right.seq)

  return {
    events,
    ignored: [...ignored.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((left, right) => left.type.localeCompare(right.type)),
  }
}
