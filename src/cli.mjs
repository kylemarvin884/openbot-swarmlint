#!/usr/bin/env node
/**
 * swarmlint CLI
 *
 *   swarmlint report <events.jsonl> [--json out.json] [--md out.txt]
 *                    [--fail-on=high|medium|low] [--stall-minutes=30]
 *                    [--max-broadcasts-per-task=2]
 *
 * Exit codes:
 *   0 ok   1 threshold hit   2 usage   3 input/read error
 */
import { readFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { analyze, findingsAtLeast } from "./analyze.mjs"
import { InputError, parseEvents } from "./parse.mjs"
import { formatReport } from "./report.mjs"

export const VERSION = "0.1.0"

export const EXIT_CODES = Object.freeze({
  OK: 0,
  FAIL: 1,
  USAGE: 2,
  INPUT: 3,
})

const VALUE_OPTIONS = new Set(["json", "md", "fail-on", "stall-minutes", "max-broadcasts-per-task"])
const FAIL_ON = new Set(["high", "medium", "low", "none"])

const HELP = `swarmlint ${VERSION} — coordination accounting for multi-agent runs

用法:
  swarmlint report <events.jsonl> [options]

选项:
  --json <path>                    把机器可读结果写到文件
  --md <path>                      把报告另外写一份到文件
  --fail-on=high|medium|low|none   命中该级别及以上 finding 时 exit 1（默认 none）
  --stall-minutes=<n>              任务静默多久算 stalled（默认 30）
  --max-broadcasts-per-task=<n>    每个已完成任务允许的广播数（默认 2）
  -h, --help                       显示帮助

事件格式（每行一个 JSON 对象）:
  {"ts":"2026-11-01T10:00:00Z","agent":"planner","type":"task.create","task":"T1"}
  {"ts":"2026-11-01T10:01:00Z","agent":"planner","type":"handoff","task":"T1","to":"builder"}
  {"ts":"2026-11-01T10:02:00Z","agent":"builder","type":"task.claim","task":"T1"}
  {"ts":"2026-11-01T10:05:00Z","agent":"builder","type":"task.done","task":"T1","evidence":"commit abc123"}

事件类型:
  task.create task.assign task.claim task.progress task.done task.block
  message handoff

例子:
  swarmlint report demo/minecraft-swarm.jsonl
  swarmlint report demo/minecraft-swarm.jsonl --fail-on=high --json out.json
`

export class CliError extends Error {
  constructor(message, { code = "E_USAGE", exitCode = EXIT_CODES.USAGE } = {}) {
    super(message)
    this.name = "CliError"
    this.code = code
    this.exitCode = exitCode
  }
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv = []) {
  const [first, ...rest] = argv
  if (!first || first === "-h" || first === "--help") {
    return { command: "help", options: {}, target: undefined }
  }
  if (first.startsWith("-")) throw new CliError(`未知选项：${first}`)
  if (first !== "report") throw new CliError(`未知命令：${first}（只支持 report）`)

  const options = {}
  const positionals = []

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (token === "-h" || token === "--help") {
      options.help = true
      continue
    }
    if (!token.startsWith("--")) {
      positionals.push(token)
      continue
    }

    const body = token.slice(2)
    const equals = body.indexOf("=")
    const key = equals === -1 ? body : body.slice(0, equals)
    if (!VALUE_OPTIONS.has(key)) throw new CliError(`report 不支持选项：--${key}`)

    if (equals !== -1) {
      options[key] = body.slice(equals + 1)
      continue
    }
    const next = rest[index + 1]
    if (next === undefined || next.startsWith("--")) throw new CliError(`--${key} 需要一个值`)
    options[key] = next
    index += 1
  }

  if (positionals.length === 0) throw new CliError("缺少事件日志路径")
  if (positionals.length > 1) throw new CliError(`多余的参数：${positionals.slice(1).join(" ")}`)

  return { command: first, options, target: positionals[0] }
}

function positiveInteger(raw, fallback, name) {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new CliError(`${name} 必须是正整数：${raw}`)
  return value
}

function nonNegativeInteger(raw, fallback, name) {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new CliError(`${name} 必须是非负整数：${raw}`)
  return value
}

/**
 * @param {string[]} argv
 * @param {{ log?: Function, error?: Function }} [io]
 * @param {{ readFile?: Function, writeFile?: Function }} [deps]
 */
export function main(
  argv = [],
  { log = console.log, error = console.error } = {},
  { readFile = readFileSync, writeFile = writeFileSync } = {},
) {
  try {
    const args = parseArgs(argv)
    if (args.command === "help" || args.options.help) {
      log(HELP)
      return EXIT_CODES.OK
    }

    const failOn = args.options["fail-on"] ?? "none"
    if (!FAIL_ON.has(failOn)) {
      throw new CliError(`--fail-on 只接受 high / medium / low / none：${failOn}`)
    }

    const stallMinutes = positiveInteger(args.options["stall-minutes"], 30, "--stall-minutes")
    const maxBroadcastsPerTask = nonNegativeInteger(
      args.options["max-broadcasts-per-task"],
      2,
      "--max-broadcasts-per-task",
    )

    let text
    try {
      text = readFile(args.target, "utf8")
    } catch (cause) {
      throw new InputError(`读不了 ${args.target}：${cause.message}`)
    }

    const { events, ignored } = parseEvents(text, { source: args.target })
    const result = analyze(events, { stallMinutes, maxBroadcastsPerTask })
    const failed = failOn !== "none" && findingsAtLeast(result.findings, failOn).length > 0
    const report = formatReport(result, {
      source: args.target,
      ignored,
      failOn: failOn === "none" ? undefined : failOn,
      failed,
      version: VERSION,
    })

    log(report)

    if (args.options.json) {
      const payload = { version: VERSION, source: args.target, ignored, ...result }
      writeFile(args.options.json, `${JSON.stringify(payload, null, 2)}\n`, "utf8")
    }
    if (args.options.md) {
      writeFile(args.options.md, `${report}\n`, "utf8")
    }

    return failed ? EXIT_CODES.FAIL : EXIT_CODES.OK
  } catch (cause) {
    if (cause instanceof CliError || cause instanceof InputError) {
      error(`swarmlint: ${cause.message}`)
      return cause.exitCode
    }
    error(`swarmlint: ${cause.message}`)
    return EXIT_CODES.INPUT
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2))
}
