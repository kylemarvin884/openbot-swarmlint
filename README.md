# swarmlint

**多 agent 跑完一轮，先看账单：多少事件是在协调，多少是在干活，哪个任务被两个人同时认领、被来回踢了几次。**

`swarmlint` 读一份多 agent 事件日志（JSONL），输出协调/生产比、任务归属和结构化的协调病。
零依赖，不调模型，不联网，能直接进 CI。

```bash
$ git clone https://github.com/kylemarvin884/openbot-swarmlint
$ cd openbot-swarmlint
$ node src/cli.mjs report demo/minecraft-swarm.jsonl

swarmlint 0.1.0   demo/minecraft-swarm.jsonl
6 agents · 7 tasks · 40 events · 65 min

Coordination bill
  coordination         17   messages 10 (broadcast 8, direct 2), handoffs 7, assigns 0
  production            9   progress 6, done 3
  coordination/production  1.9x
  messages per completed   3.3
  broadcast share          80%

Swarm health  31/100 (D)

Findings (9)
  HIGH    duplicate_claim       T1     claimed by architect, mason; progressed by mason, architect
  HIGH    handoff_pingpong      T5     3 reverse handoffs, planner <-> architect x3
  MEDIUM  orphan_task           T3     created by planner, no claim/progress/done
  MEDIUM  unverified_done       T2     done by mason, no evidence field
  MEDIUM  unverified_done       T6     done by mason, no evidence field
  MEDIUM  stalled_task          T4     claimed/progressed, then silent for 50 min
  MEDIUM  blocked_no_followup   T7     blocked by scout, no later event on this task
  MEDIUM  broadcast_storm       -      8 broadcasts for 3 completed tasks
  LOW     silent_agent          -      quartermaster received 2 routed messages, emitted 0 events

exit 0 (no --fail-on)
```

上面是 `demo/minecraft-swarm.jsonl`，**合成日志**，clone 下来就能复现。
它不是 benchmark，也不代表任何真实团队的数据。

## 为什么

多 agent 失败，很多时候不是模型不够强，而是协调把预算吃光了：
重复认领、来回转手、广播刷屏、任务创建后没人做。
HN 上那篇 Minecraft agent swarm 的实验（[50325662](https://news.ycombinator.com/item?id=50325662)，99 分 / 39 评论）
讨论的就是这个：50 个 agent 的团队最后陷在官僚流程里。

现有 trace 工具回答「发生了什么」：调用链、延迟、token 成本。
`swarmlint` 只回答四个更窄的问题：

1. 协调事件和生产事件的比例是多少？
2. 同一个任务有几个 owner？
3. 哪些任务创建后没人接、接了之后没声音、或者被来回踢？
4. 哪些「完成」没有任何 evidence？

## 安装

需要 Node >= 22，没有其他依赖。

```bash
git clone https://github.com/kylemarvin884/openbot-swarmlint
cd openbot-swarmlint
node src/cli.mjs report demo/minecraft-swarm.jsonl
```

本地 link 成命令：

```bash
npm install -g .
swarmlint report run.jsonl --fail-on=high
```

## 输入格式

每行一个 JSON 对象。`ts`、`agent`、`type` 必填。

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `ts` | 是 | ISO 8601，例如 `2026-11-01T10:00:00Z` |
| `agent` | 是 | 发出事件的 agent 名（也接受 `from`） |
| `type` | 是 | 见下表 |
| `task` | task 事件必填 | 任务 ID，同一任务用同一个字符串 |
| `to` | message / handoff 必填 | 目标 agent；广播写 `*` |
| `text` | 否 | 人类可读备注，不参与规则判断 |
| `evidence` | 否 | `task.done` 的证据引用（commit、测试输出、文件路径） |

事件类型：

| type | 含义 |
| --- | --- |
| `task.create` | 创建任务 |
| `task.assign` | 把任务指派给 `to` |
| `task.claim` | agent 认领任务 |
| `task.progress` | 有实际推进 |
| `task.done` | 标记完成 |
| `task.block` | 卡住，`text` 写原因 |
| `message` | 发消息，`to: "*"` 是广播 |
| `handoff` | 把任务转交给 `to` |

示例：

```json
{"ts":"2026-11-01T10:00:00Z","agent":"planner","type":"task.create","task":"T1","text":"build walls"}
{"ts":"2026-11-01T10:01:00Z","agent":"planner","type":"handoff","task":"T1","to":"builder"}
{"ts":"2026-11-01T10:02:00Z","agent":"builder","type":"task.claim","task":"T1"}
{"ts":"2026-11-01T10:05:00Z","agent":"builder","type":"task.progress","task":"T1","text":"wall 30%"}
{"ts":"2026-11-01T10:09:00Z","agent":"builder","type":"task.done","task":"T1","evidence":"commit abc123"}
```

未知的 `type` 会被忽略并在报告脚注计数；缺字段、坏 JSON、坏时间戳直接报错，不猜。

如果你用的是 CrewAI / LangGraph / 自研 orchestrator，需要自己把日志映射成上面的 schema：
消息类事件通常好映射，**任务事件需要 orchestrator 在 claim / done 时打点**。
这是本工具的前提，不假装能自动理解任意框架的日志。

## 规则

| 规则 | 触发条件 | 级别 |
| --- | --- | --- |
| `duplicate_claim` | 同一任务被 ≥2 个不同 agent claim 或 progress | HIGH |
| `handoff_pingpong` | 同一任务上连续反向 handoff ≥2 次（A→B→A→B） | HIGH |
| `orphan_task` | 任务创建后没有 claim / progress / done，也没有 handoff | MEDIUM |
| `unverified_done` | `task.done` 的 `evidence` 为空 | MEDIUM |
| `stalled_task` | 已 claim/progress、未完成，距日志结束超过 30 分钟无事件 | MEDIUM |
| `blocked_no_followup` | `task.block` 是该任务最后一个事件，且任务未完成 | MEDIUM |
| `broadcast_storm` | 广播 ≥5 条，且超过已完成任务数的 2 倍 | MEDIUM |
| `silent_agent` | 收到 ≥2 条定向消息，但自己发出 0 条事件 | LOW |

阈值可调：

```bash
swarmlint report run.jsonl --stall-minutes=60 --max-broadcasts-per-task=4
```

## 指标

| 指标 | 定义 |
| --- | --- |
| `coordination/production` | (message + handoff + assign) / (progress + done) |
| `messages per completed` | 消息总数 / 已完成任务数 |
| `broadcast share` | 广播消息 / 消息总数 |
| `Swarm health` | 100 减去各规则扣分，最低 0 |

扣分：duplicate 每条 -15（最多 -30）、pingpong 每条 -12（最多 -24）、orphan -8、unverified -5、
stalled -6、blocked -6、broadcast storm -8、silent agent -4。
A ≥ 90，B ≥ 75，C ≥ 60，其余 D。

这些权重是拍出来的，不是标定过的。它们只用来排序问题，不构成对系统质量的证明。

## CI

```bash
swarmlint report run.jsonl --fail-on=high
# 命中 HIGH 时 exit 1

swarmlint report run.jsonl --fail-on=low --json swarm.json --md swarm.txt
# 任意 finding 都失败，同时留下机器可读结果
```

退出码：`0` 通过，`1` 命中阈值，`2` 参数错误，`3` 输入/读取错误。

## 三个可以这样用的场景

1. **多 agent 编码**：planner / coder / reviewer 修一组测试。看 reviewer 是否被反复踢回、coder 是否重复认领。
2. **多 agent 调研**：researcher ×3 + writer。看是否有大量任务创建后没人接、广播是否压过产出。
3. **多 agent 游戏 / 仿真**：对比 3 个 agent 和 10 个 agent 的协调/生产比，验证「同步开销随规模上升」是否成立。

## 局限

- **只支持本文档的 JSONL schema。** 没有自动适配器，也不猜字段。
- **`evidence` 只检查非空。** 不验证 commit 是否存在、测试是否真的跑过。要验证内容，用别的工具。
- **广播多不等于错。** 有些系统就是靠广播同步；报告给比例和阈值，不替你下结论。
- **合成日志不是证据。** `demo/` 里的三份日志是为了演示规则，不能引用为真实实验结果。
- **单条 trace 的循环检测不在范围内。** 那是 [loopbuster](https://github.com/liuchunwei732-cmyk/loopbuster) 这类工具的事。

## 开发

```bash
npm test        # node:test，37 个测试
npm run demo    # 跑三份 demo 日志
```

## License

MIT
