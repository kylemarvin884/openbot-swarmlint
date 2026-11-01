#!/usr/bin/env node
/**
 * Run all three demo logs through the analyzer.
 * The logs are synthetic fixtures, not production telemetry.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { analyze } from "../src/analyze.mjs"
import { parseEvents } from "../src/parse.mjs"
import { formatReport } from "../src/report.mjs"

const here = dirname(fileURLToPath(import.meta.url))

const cases = [
  ["minecraft-swarm.jsonl", "6 agents, 7 tasks, bureaucracy-heavy"],
  ["handoff-loop.jsonl", "2 agents bouncing one task"],
  ["healthy-swarm.jsonl", "control run: claimed, progressed, evidenced"],
]

for (const [file, note] of cases) {
  const source = `demo/${file}`
  const { events, ignored } = parseEvents(readFileSync(join(here, file), "utf8"), { source })
  const result = analyze(events)
  console.log(`# ${note}`)
  console.log(formatReport(result, { source, ignored }))
  console.log("")
}

console.log("All three logs are synthetic. See README.md for the event schema.")
