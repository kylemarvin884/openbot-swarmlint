import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { InputError, parseEvents } from "../src/parse.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFileSync(join(here, "..", "demo", name), "utf8")

test("解析 demo 日志：40 条事件，按时间排序", () => {
  const { events, ignored } = parseEvents(fixture("minecraft-swarm.jsonl"), { source: "demo" })
  assert.equal(events.length, 40)
  assert.deepEqual(ignored, [])
  assert.equal(events[0].agent, "mayor")
  assert.equal(events.at(-1).agent, "mayor")
  assert.ok(events.every((event, index) => index === 0 || events[index - 1].at <= event.at))
})

test("未知事件类型被忽略并计数，不报错", () => {
  const text = [
    '{"ts":"2026-11-01T10:00:00Z","agent":"a","type":"note","task":"T1"}',
    '{"ts":"2026-11-01T10:01:00Z","agent":"a","type":"note"}',
    '{"ts":"2026-11-01T10:02:00Z","agent":"a","type":"task.create","task":"T1"}',
  ].join("\n")
  const { events, ignored } = parseEvents(text)
  assert.equal(events.length, 1)
  assert.deepEqual(ignored, [{ type: "note", count: 2 }])
})

test("无效 JSON 报出行号", () => {
  assert.throws(
    () => parseEvents('{"ts":"2026-11-01T10:00:00Z","agent":"a","type":"task.create","task":"T1"}\nnot json', { source: "run.jsonl" }),
    (error) => error instanceof InputError && /run\.jsonl:2: invalid JSON/.test(error.message),
  )
})

test("缺少 ts 直接报错，不猜时间", () => {
  assert.throws(
    () => parseEvents('{"agent":"a","type":"message","to":"*"}', { source: "x" }),
    /missing or invalid "ts"/,
  )
})

test("message / handoff 必须有 to", () => {
  assert.throws(
    () => parseEvents('{"ts":"2026-11-01T10:00:00Z","agent":"a","type":"message","text":"hi"}'),
    /"message" requires "to"/,
  )
  assert.throws(
    () => parseEvents('{"ts":"2026-11-01T10:00:00Z","agent":"a","type":"handoff","task":"T1"}'),
    /"handoff" requires "to"/,
  )
})

test("task 事件必须有 task", () => {
  assert.throws(
    () => parseEvents('{"ts":"2026-11-01T10:00:00Z","agent":"a","type":"task.claim"}'),
    /"task.claim" requires "task"/,
  )
})

test("接受 from 作为 agent 别名，并去掉 BOM", () => {
  const { events } = parseEvents('\uFEFF{"ts":"2026-11-01T10:00:00Z","from":"a","type":"task.create","task":"T1"}')
  assert.equal(events[0].agent, "a")
})

test("空行被跳过", () => {
  const { events } = parseEvents('\n\n{"ts":"2026-11-01T10:00:00Z","agent":"a","type":"task.create","task":"T1"}\n\n')
  assert.equal(events.length, 1)
})
