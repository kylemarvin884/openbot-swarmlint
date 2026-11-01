import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { analyze, findingsAtLeast, gradeFor } from "../src/analyze.mjs"
import { parseEvents } from "../src/parse.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const load = (name) => parseEvents(readFileSync(join(here, "..", "demo", name), "utf8")).events

const rules = (result) => result.findings.map((finding) => finding.rule).sort()

test("minecraft demo：账目数字", () => {
  const result = analyze(load("minecraft-swarm.jsonl"))
  assert.equal(result.agents, 6)
  assert.equal(result.metrics.createdTasks, 7)
  assert.equal(result.metrics.events, 40)
  assert.equal(result.metrics.messages, 10)
  assert.equal(result.metrics.broadcasts, 8)
  assert.equal(result.metrics.directMessages, 2)
  assert.equal(result.metrics.handoffs, 7)
  assert.equal(result.metrics.completedTasks, 3)
  assert.equal(result.metrics.coordinationEvents, 17)
  assert.equal(result.metrics.productiveEvents, 9)
  assert.equal(result.metrics.coordinationRatio, 1.9)
  assert.equal(result.metrics.messagesPerCompletedTask, 3.3)
  assert.equal(result.metrics.broadcastShare, 80)
})

test("minecraft demo：七类 finding 全部命中", () => {
  const result = analyze(load("minecraft-swarm.jsonl"))
  assert.deepEqual(rules(result), [
    "blocked_no_followup",
    "broadcast_storm",
    "duplicate_claim",
    "handoff_pingpong",
    "orphan_task",
    "silent_agent",
    "stalled_task",
    "unverified_done",
    "unverified_done",
  ].sort())
  assert.equal(result.score, 31)
  assert.equal(result.grade, "D")
})

test("duplicate_claim 记录认领人与推进人", () => {
  const result = analyze(load("minecraft-swarm.jsonl"))
  const finding = result.findings.find((item) => item.rule === "duplicate_claim")
  assert.equal(finding.task, "T1")
  assert.match(finding.detail, /claimed by architect, mason/)
  assert.match(finding.detail, /progressed by mason, architect/)
})

test("duplicate_claim 也覆盖「一人认领、另一人推进」", () => {
  const events = parseEvents(
    [
      '{"ts":"2026-11-01T10:00:00Z","agent":"planner","type":"task.create","task":"T1"}',
      '{"ts":"2026-11-01T10:01:00Z","agent":"coder","type":"task.claim","task":"T1"}',
      '{"ts":"2026-11-01T10:02:00Z","agent":"reviewer","type":"task.progress","task":"T1"}',
    ].join("\n"),
  ).events
  const result = analyze(events)
  const finding = result.findings.find((item) => item.rule === "duplicate_claim")
  assert.ok(finding)
  assert.equal(finding.detail, "claimed by coder; progressed by reviewer")
})

test("handoff_pingpong 数的是往返次数", () => {
  const result = analyze(load("handoff-loop.jsonl"))
  const finding = result.findings.find((item) => item.rule === "handoff_pingpong")
  assert.equal(finding.task, "T1")
  assert.match(finding.detail, /3 reverse handoffs, a <-> b x3/)
})

test("任务状态：orphan / blocked / done / open", () => {
  const result = analyze(load("minecraft-swarm.jsonl"))
  const status = Object.fromEntries(result.tasks.map((task) => [task.id, task.status]))
  assert.deepEqual(status, {
    T1: "done",
    T2: "done",
    T3: "orphan",
    T4: "open",
    T5: "open",
    T6: "done",
    T7: "blocked",
  })
})

test("healthy demo：没有 finding，满分", () => {
  const result = analyze(load("healthy-swarm.jsonl"))
  assert.deepEqual(result.findings, [])
  assert.equal(result.score, 100)
  assert.equal(result.grade, "A")
  assert.equal(result.metrics.coordinationRatio, 0.8)
})

test("stallMinutes 可调：放宽后 stalled 消失", () => {
  const result = analyze(load("minecraft-swarm.jsonl"), { stallMinutes: 120 })
  assert.equal(result.findings.filter((item) => item.rule === "stalled_task").length, 0)
})

test("maxBroadcastsPerTask 可调：放宽后广播风暴消失", () => {
  const result = analyze(load("minecraft-swarm.jsonl"), { maxBroadcastsPerTask: 10 })
  assert.equal(result.findings.filter((item) => item.rule === "broadcast_storm").length, 0)
})

test("空日志不崩", () => {
  const result = analyze([])
  assert.equal(result.metrics.events, 0)
  assert.equal(result.metrics.coordinationRatio, null)
  assert.equal(result.score, 100)
  assert.equal(result.window.start, null)
})

test("重复 done 只记第一个 evidence", () => {
  const events = parseEvents(
    [
      '{"ts":"2026-11-01T10:00:00Z","agent":"a","type":"task.create","task":"T1"}',
      '{"ts":"2026-11-01T10:01:00Z","agent":"a","type":"task.claim","task":"T1"}',
      '{"ts":"2026-11-01T10:02:00Z","agent":"a","type":"task.done","task":"T1","evidence":"ci-42"}',
      '{"ts":"2026-11-01T10:03:00Z","agent":"b","type":"task.done","task":"T1"}',
    ].join("\n"),
  ).events
  const result = analyze(events)
  assert.equal(result.findings.filter((item) => item.rule === "unverified_done").length, 0)
  assert.equal(result.tasks[0].evidence, true)
  assert.equal(result.tasks[0].doneBy, "a")
})

test("findingsAtLeast 按级别过滤", () => {
  const result = analyze(load("minecraft-swarm.jsonl"))
  assert.equal(findingsAtLeast(result.findings, "high").length, 2)
  assert.equal(findingsAtLeast(result.findings, "medium").length, 8)
  assert.equal(findingsAtLeast(result.findings, "low").length, 9)
})

test("grade 边界", () => {
  assert.equal(gradeFor(90), "A")
  assert.equal(gradeFor(89), "B")
  assert.equal(gradeFor(75), "B")
  assert.equal(gradeFor(74), "C")
  assert.equal(gradeFor(60), "C")
  assert.equal(gradeFor(59), "D")
})
