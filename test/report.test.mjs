import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { analyze } from "../src/analyze.mjs"
import { parseEvents } from "../src/parse.mjs"
import { formatReport } from "../src/report.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const load = (name) => parseEvents(readFileSync(join(here, "..", "demo", name), "utf8"))

test("报告包含账目、评分与 finding 行", () => {
  const { events, ignored } = load("minecraft-swarm.jsonl")
  const text = formatReport(analyze(events), { source: "demo/run.jsonl", ignored })
  assert.match(text, /^swarmlint 0\.1\.0 {3}demo\/run\.jsonl/)
  assert.match(text, /coordination\s+17/)
  assert.match(text, /coordination\/production\s+1\.9x/)
  assert.match(text, /HIGH\s+duplicate_claim/)
  assert.match(text, /MEDIUM\s+broadcast_storm/)
  assert.match(text, /LOW\s+silent_agent/)
})

test("没有 finding 时写明", () => {
  const { events } = load("healthy-swarm.jsonl")
  const text = formatReport(analyze(events), { source: "demo/healthy.jsonl" })
  assert.match(text, /no coordination pathologies found/)
  assert.match(text, /Swarm health {2}100\/100 \(A\)/)
})

test("空日志不崩", () => {
  const text = formatReport(analyze([]), { source: "empty.jsonl" })
  assert.match(text, /empty log: no events parsed/)
  assert.match(text, /exit 0 \(no --fail-on\)/)
})

test("ignored 事件写入脚注", () => {
  const { events, ignored } = load("minecraft-swarm.jsonl")
  const text = formatReport(analyze(events), {
    source: "run.jsonl",
    ignored: [...ignored, { type: "note", count: 2 }],
  })
  assert.match(text, /ignored 2 event\(s\): note 2/)
})

test("失败时退出行是 exit 1", () => {
  const { events } = load("minecraft-swarm.jsonl")
  const text = formatReport(analyze(events), { source: "run.jsonl", failOn: "high", failed: true })
  assert.match(text, /exit 1 \(--fail-on=high\)/)
})
