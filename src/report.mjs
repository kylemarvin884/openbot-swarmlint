/**
 * Plain-text report. Fixed columns, ASCII-only, safe on Windows consoles.
 */

const SEVERITY_LABEL = { high: "HIGH", medium: "MEDIUM", low: "LOW" }

/**
 * @param {ReturnType<import("./analyze.mjs").analyze>} result
 * @param {{ source?: string, ignored?: Array<{type: string, count: number}>, failOn?: string, failed?: boolean, version?: string }} [options]
 */
export function formatReport(
  result,
  { source = "<input>", ignored = [], failOn, failed = false, version = "0.1.0" } = {},
) {
  const lines = []
  const metrics = result.metrics

  lines.push(`swarmlint ${version}   ${source}`)

  if (metrics.events === 0) {
    lines.push("")
    lines.push("empty log: no events parsed")
    lines.push(exitLine(failOn, failed))
    return lines.join("\n")
  }

  const agentsLabel = result.agents === 1 ? "agent" : "agents"
  const tasksLabel = metrics.createdTasks === 1 ? "task" : "tasks"
  lines.push(
    `${result.agents} ${agentsLabel} · ${metrics.createdTasks} ${tasksLabel} · ${metrics.events} events · ` +
      `${result.window.durationMinutes} min`,
  )
  lines.push("")

  lines.push("Coordination bill")
  lines.push(
    `  coordination        ${pad(metrics.coordinationEvents)}   ` +
      `messages ${metrics.messages} (broadcast ${metrics.broadcasts}, direct ${metrics.directMessages}), ` +
      `handoffs ${metrics.handoffs}, assigns ${metrics.assigns}`,
  )
  lines.push(
    `  production          ${pad(metrics.productiveEvents)}   ` +
      `progress ${metrics.progressEvents}, done ${metrics.doneEvents}`,
  )
  lines.push(
    `  coordination/production  ${metrics.coordinationRatio === null ? "n/a" : `${metrics.coordinationRatio.toFixed(1)}x`}`,
  )
  lines.push(
    `  messages per completed   ${metrics.messagesPerCompletedTask === null ? "n/a" : metrics.messagesPerCompletedTask.toFixed(1)}`,
  )
  lines.push(`  broadcast share          ${metrics.broadcastShare}%`)
  lines.push("")

  lines.push(`Swarm health  ${result.score}/100 (${result.grade})`)
  lines.push("")

  if (result.findings.length === 0) {
    lines.push("no coordination pathologies found in this log")
  } else {
    lines.push(`Findings (${result.findings.length})`)
    const taskWidth = Math.max(4, ...result.findings.map((finding) => String(finding.task ?? "-").length))
    for (const finding of result.findings) {
      lines.push(
        `  ${SEVERITY_LABEL[finding.severity].padEnd(6)}  ` +
          `${finding.rule.padEnd(20)}  ` +
          `${String(finding.task ?? "-").padEnd(taskWidth)}   ${finding.detail}`,
      )
    }
  }

  if (ignored.length > 0) {
    const total = ignored.reduce((sum, entry) => sum + entry.count, 0)
    lines.push("")
    lines.push(`ignored ${total} event(s): ${ignored.map((entry) => `${entry.type} ${entry.count}`).join(", ")}`)
  }

  lines.push("")
  lines.push(exitLine(failOn, failed))
  return lines.join("\n")
}

const pad = (value) => String(value).padStart(3)

function exitLine(failOn, failed) {
  if (!failOn) return "exit 0 (no --fail-on)"
  return failed ? `exit 1 (--fail-on=${failOn})` : `exit 0 (--fail-on=${failOn})`
}
