/**
 * Deterministic coordination analysis. No model calls, no network.
 *
 * Every finding is backed by an event pattern. If a rule cannot see the
 * pattern in the log, it stays quiet instead of guessing intent.
 */
import { TASK_TYPES } from "./parse.mjs"

export const RULE_META = Object.freeze({
  duplicate_claim: { severity: "high", penalty: 15, cap: 30 },
  handoff_pingpong: { severity: "high", penalty: 12, cap: 24 },
  orphan_task: { severity: "medium", penalty: 8, cap: 16 },
  unverified_done: { severity: "medium", penalty: 5, cap: 15 },
  stalled_task: { severity: "medium", penalty: 6, cap: 12 },
  blocked_no_followup: { severity: "medium", penalty: 6, cap: 12 },
  broadcast_storm: { severity: "medium", penalty: 8, cap: 8 },
  silent_agent: { severity: "low", penalty: 4, cap: 8 },
})

const SEVERITY_RANK = Object.freeze({ high: 3, medium: 2, low: 1 })

const RULE_ORDER = Object.keys(RULE_META)

const round1 = (value) => Math.round(value * 10) / 10

/**
 * @param {Array<object>} events sorted events from parseEvents()
 * @param {{ stallMinutes?: number, maxBroadcastsPerTask?: number }} [options]
 */
export function analyze(events, { stallMinutes = 30, maxBroadcastsPerTask = 2 } = {}) {
  if (!Array.isArray(events)) throw new TypeError("analyze(events): events must be an array")

  const tasks = new Map()
  const agents = new Set()
  const emitted = new Map()
  const received = new Map()

  let messages = 0
  let broadcasts = 0
  let directMessages = 0
  let handoffs = 0
  let assigns = 0
  let progressEvents = 0
  let doneEvents = 0

  const startAt = events.length > 0 ? events[0].at : null
  const endAt = events.length > 0 ? events[events.length - 1].at : null

  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1)
  const addUnique = (list, value) => {
    if (!list.includes(value)) list.push(value)
  }

  const taskOf = (id) => {
    let task = tasks.get(id)
    if (!task) {
      task = {
        id,
        createdAt: null,
        createdBy: null,
        claimants: [],
        workers: [],
        assignees: [],
        progress: 0,
        done: null,
        evidence: false,
        blocked: null,
        lastAt: null,
        lastType: null,
        handoffs: [],
      }
      tasks.set(id, task)
    }
    return task
  }

  for (const event of events) {
    agents.add(event.agent)
    bump(emitted, event.agent)

    if (TASK_TYPES.has(event.type)) {
      const task = taskOf(event.task)
      task.lastAt = event.at
      task.lastType = event.type

      switch (event.type) {
        case "task.create":
          if (task.createdAt === null) {
            task.createdAt = event.at
            task.createdBy = event.agent
          }
          break
        case "task.assign": {
          const assignee = event.to ?? event.agent
          addUnique(task.assignees, assignee)
          assigns += 1
          break
        }
        case "task.claim":
          addUnique(task.claimants, event.agent)
          break
        case "task.progress":
          addUnique(task.workers, event.agent)
          task.progress += 1
          progressEvents += 1
          break
        case "task.done":
          if (task.done === null) {
            task.done = { by: event.agent, at: event.at }
            task.evidence = event.evidence !== ""
          }
          doneEvents += 1
          break
        case "task.block":
          task.blocked = { by: event.agent, at: event.at, text: event.text }
          break
        default:
          break
      }
      continue
    }

    if (event.type === "message") {
      messages += 1
      if (event.to === "*") {
        broadcasts += 1
      } else {
        directMessages += 1
        agents.add(event.to)
        bump(received, event.to)
      }
      continue
    }

    if (event.type === "handoff") {
      handoffs += 1
      if (event.to !== "*") {
        agents.add(event.to)
        bump(received, event.to)
      }
      if (event.task) {
        const task = taskOf(event.task)
        task.handoffs.push({ from: event.agent, to: event.to, at: event.at })
        task.lastAt = event.at
        task.lastType = event.type
      }
    }
  }

  const completed = [...tasks.values()].filter((task) => task.done !== null).length
  const coordination = messages + handoffs + assigns
  const productive = progressEvents + doneEvents

  /** @type {Array<object>} */
  const findings = []

  for (const task of tasks.values()) {
    const workedOn = [...new Set([...task.claimants, ...task.workers])]
    if (workedOn.length > 1) {
      const parts = []
      if (task.claimants.length > 0) parts.push(`claimed by ${task.claimants.join(", ")}`)
      if (task.workers.length > 0) parts.push(`progressed by ${task.workers.join(", ")}`)
      findings.push({
        rule: "duplicate_claim",
        task: task.id,
        detail: parts.join("; "),
        data: { claimants: task.claimants, workers: task.workers },
      })
    }

    let reversals = 0
    const pairs = new Map()
    for (let index = 1; index < task.handoffs.length; index += 1) {
      const previous = task.handoffs[index - 1]
      const current = task.handoffs[index]
      if (previous.from === current.to && previous.to === current.from && previous.from !== previous.to) {
        reversals += 1
        const key = [previous.from, previous.to].sort().join("\u0000")
        const entry = pairs.get(key) ?? { a: previous.from, b: previous.to, count: 0 }
        entry.count += 1
        pairs.set(key, entry)
      }
    }
    if (reversals >= 2) {
      const dominant = [...pairs.values()].sort((left, right) => right.count - left.count)[0]
      findings.push({
        rule: "handoff_pingpong",
        task: task.id,
        detail: `${reversals} reverse handoffs, ${dominant.a} <-> ${dominant.b} x${dominant.count}`,
        data: { reversals, pairs: [...pairs.values()] },
      })
    }

    if (
      task.createdBy &&
      task.claimants.length === 0 &&
      task.workers.length === 0 &&
      task.done === null &&
      task.handoffs.length === 0
    ) {
      findings.push({
        rule: "orphan_task",
        task: task.id,
        detail: `created by ${task.createdBy}, no claim/progress/done`,
        data: { createdBy: task.createdBy },
      })
    }

    if (task.done !== null && !task.evidence) {
      findings.push({
        rule: "unverified_done",
        task: task.id,
        detail: `done by ${task.done.by}, no evidence field`,
        data: { doneBy: task.done.by },
      })
    }

    if (task.done === null && task.lastType === "task.block") {
      findings.push({
        rule: "blocked_no_followup",
        task: task.id,
        detail: `blocked by ${task.blocked.by}, no later event on this task`,
        data: { blockedBy: task.blocked.by },
      })
    } else if (
      task.done === null &&
      (task.claimants.length > 0 || task.progress > 0) &&
      task.lastAt !== null
    ) {
      const silentMinutes = Math.round((endAt - task.lastAt) / 60000)
      if (silentMinutes > stallMinutes) {
        findings.push({
          rule: "stalled_task",
          task: task.id,
          detail: `claimed/progressed, then silent for ${silentMinutes} min`,
          data: { silentMinutes },
        })
      }
    }
  }

  if (broadcasts >= 5 && broadcasts > maxBroadcastsPerTask * Math.max(1, completed)) {
    findings.push({
      rule: "broadcast_storm",
      task: undefined,
      detail: `${broadcasts} broadcasts for ${completed} completed task${completed === 1 ? "" : "s"}`,
      data: { broadcasts, completed },
    })
  }

  for (const [agent, inbound] of received.entries()) {
    if (inbound >= 2 && (emitted.get(agent) ?? 0) === 0) {
      findings.push({
        rule: "silent_agent",
        task: undefined,
        detail: `${agent} received ${inbound} routed messages, emitted 0 events`,
        data: { agent, inbound },
      })
    }
  }

  for (const finding of findings) {
    finding.severity = RULE_META[finding.rule].severity
  }

  findings.sort((left, right) => {
    const bySeverity = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity]
    if (bySeverity !== 0) return bySeverity
    const byRule = RULE_ORDER.indexOf(left.rule) - RULE_ORDER.indexOf(right.rule)
    if (byRule !== 0) return byRule
    return String(left.task ?? "").localeCompare(String(right.task ?? ""), undefined, { numeric: true })
  })

  let score = 100
  for (const [rule, meta] of Object.entries(RULE_META)) {
    const count = findings.filter((finding) => finding.rule === rule).length
    score -= Math.min(count * meta.penalty, meta.cap)
  }
  score = Math.max(0, Math.min(100, score))

  const taskList = [...tasks.values()]
    .sort((left, right) => left.id.localeCompare(right.id, undefined, { numeric: true }))
    .map((task) => {
      const status = task.done
        ? "done"
        : task.lastType === "task.block"
          ? "blocked"
          : task.claimants.length > 0 || task.progress > 0 || task.handoffs.length > 0
            ? "open"
            : "orphan"
      return {
        id: task.id,
        status,
        createdBy: task.createdBy,
        claimants: task.claimants,
        workers: task.workers,
        assignees: task.assignees,
        progressEvents: task.progress,
        doneBy: task.done?.by ?? null,
        evidence: task.done === null ? null : task.evidence,
        handoffs: task.handoffs.length,
      }
    })

  return {
    agents: agents.size,
    tasks: taskList,
    metrics: {
      events: events.length,
      messages,
      broadcasts,
      directMessages,
      handoffs,
      assigns,
      progressEvents,
      doneEvents,
      completedTasks: completed,
      createdTasks: tasks.size,
      coordinationEvents: coordination,
      productiveEvents: productive,
      coordinationRatio: productive === 0 ? null : round1(coordination / productive),
      messagesPerCompletedTask: completed === 0 ? null : round1(messages / completed),
      broadcastShare: messages === 0 ? 0 : Math.round((broadcasts / messages) * 100),
    },
    findings,
    score,
    grade: gradeFor(score),
    window: {
      start: startAt === null ? null : new Date(startAt).toISOString(),
      end: endAt === null ? null : new Date(endAt).toISOString(),
      durationMinutes: startAt === null ? 0 : Math.round((endAt - startAt) / 60000),
    },
    thresholds: { stallMinutes, maxBroadcastsPerTask },
  }
}

/**
 * @param {number} score
 */
export function gradeFor(score) {
  if (score >= 90) return "A"
  if (score >= 75) return "B"
  if (score >= 60) return "C"
  return "D"
}

/**
 * @param {Array<object>} findings
 * @param {string} minimum high | medium | low
 */
export function findingsAtLeast(findings, minimum) {
  const threshold = SEVERITY_RANK[minimum] ?? 0
  return findings.filter((finding) => SEVERITY_RANK[finding.severity] >= threshold)
}
