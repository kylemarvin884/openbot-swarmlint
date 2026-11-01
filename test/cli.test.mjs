import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { EXIT_CODES, main, parseArgs, VERSION } from "../src/cli.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name) => readFileSync(join(here, "..", "demo", name), "utf8")

const minecraft = fixture("minecraft-swarm.jsonl")
const healthy = fixture("healthy-swarm.jsonl")

function run(argv, { text = minecraft, writes = [] } = {}) {
  const out = []
  const err = []
  const code = main(
    argv,
    { log: (line) => out.push(line), error: (line) => err.push(line) },
    {
      readFile: () => text,
      writeFile: (path, data) => writes.push({ path, data }),
    },
  )
  return { code, out: out.join("\n"), err: err.join("\n"), writes }
}

test("help 输出用法，退出码 0", () => {
  const { code, out } = run([])
  assert.equal(code, EXIT_CODES.OK)
  assert.match(out, /swarmlint 0\.1\.0/)
  assert.match(out, /事件类型/)
})

test("report 正常输出，退出码 0", () => {
  const { code, out } = run(["report", "run.jsonl"])
  assert.equal(code, EXIT_CODES.OK)
  assert.match(out, /6 agents · 7 tasks · 40 events · 65 min/)
  assert.match(out, /Swarm health  31\/100 \(D\)/)
  assert.match(out, /exit 0 \(no --fail-on\)/)
})

test("--fail-on=high 命中时 exit 1", () => {
  const { code, out } = run(["report", "run.jsonl", "--fail-on=high"])
  assert.equal(code, EXIT_CODES.FAIL)
  assert.match(out, /exit 1 \(--fail-on=high\)/)
})

test("--fail-on=low 在干净日志上 exit 0", () => {
  const { code } = run(["report", "clean.jsonl", "--fail-on=low"], { text: healthy })
  assert.equal(code, EXIT_CODES.OK)
})

test("--fail-on 支持空格写法", () => {
  const { code } = run(["report", "run.jsonl", "--fail-on", "medium"])
  assert.equal(code, EXIT_CODES.FAIL)
})

test("--json 写出可解析结果", () => {
  const writes = []
  const { code } = run(["report", "run.jsonl", "--json", "out.json"], { writes })
  assert.equal(code, EXIT_CODES.OK)
  assert.equal(writes.length, 1)
  assert.equal(writes[0].path, "out.json")
  const payload = JSON.parse(writes[0].data)
  assert.equal(payload.version, VERSION)
  assert.equal(payload.source, "run.jsonl")
  assert.equal(payload.agents, 6)
  assert.equal(payload.metrics.coordinationRatio, 1.9)
  assert.equal(payload.findings.length, 9)
})

test("--md 写出一份报告副本", () => {
  const writes = []
  const { code, out } = run(["report", "run.jsonl", "--md=out.txt"], { writes })
  assert.equal(code, EXIT_CODES.OK)
  assert.equal(writes[0].path, "out.txt")
  assert.equal(writes[0].data, `${out}\n`)
})

test("缺少路径是用法错误", () => {
  assert.throws(() => parseArgs(["report"]), /缺少事件日志路径/)
  const { code, err } = run(["report"])
  assert.equal(code, EXIT_CODES.USAGE)
  assert.match(err, /缺少事件日志路径/)
})

test("未知命令 / 选项 / 取值都是用法错误", () => {
  assert.equal(run(["scan", "run.jsonl"]).code, EXIT_CODES.USAGE)
  assert.equal(run(["report", "run.jsonl", "--nope"]).code, EXIT_CODES.USAGE)
  assert.equal(run(["report", "run.jsonl", "--fail-on=always"]).code, EXIT_CODES.USAGE)
  assert.equal(run(["report", "run.jsonl", "--stall-minutes=0"]).code, EXIT_CODES.USAGE)
  assert.equal(run(["report", "run.jsonl", "--max-broadcasts-per-task=-1"]).code, EXIT_CODES.USAGE)
})

test("输入不是 JSON 时 exit 3", () => {
  const { code, err } = run(["report", "bad.jsonl"], { text: "not json" })
  assert.equal(code, EXIT_CODES.INPUT)
  assert.match(err, /invalid JSON/)
})

test("文件读不了时 exit 3", () => {
  const err = []
  const code = main(["report", "missing.jsonl"], { log: () => {}, error: (line) => err.push(line) })
  assert.equal(code, EXIT_CODES.INPUT)
  assert.match(err.join("\n"), /读不了 missing\.jsonl/)
})
