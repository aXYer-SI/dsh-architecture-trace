/**
 * The reader-facing format guide, written next to the traces so the Markdown
 * structure is self-explanatory without opening the source.
 */
export const FORMAT_GUIDE = `# DSH 学习记录 · 格式说明

本目录由插件 \`dsh-architecture-trace\` 自动生成，用来观察 DSH 处理一次任务时的完整链路。
**只读**：DSH 不会读取这些文件，删除它们不影响任何会话。

> 该插件**默认关闭**。需要学习时在「设置 → 插件」里启用 \`architecture-trace\`，
> 或执行 \`plugin_manager set_bundle\`（target: \`dsh-architecture-trace\`, enabled: true）。

## 先看「环节导航」

每个轮次文件开头都有一张导航表，告诉你这一轮的 9 个章节分别看什么：

| 章节<br>Section | 看什么<br>What |
|---|---|
| 0 · 概览 | 整轮规模与结果（含模型轨道、切换次数） |
| 1 · 模型轨道 | **哪些模型先后参与、何时切换、各段调用几次** |
| 2 · 全链路时间线 | 全部条目按时间排列，含当前模型列 |
| 3 · 提示词 | 模型看到的 system 内容 |
| 4 · 请求头 | 模型配置与工具清单，含相对上一版的字段变更 |
| 5 · 模型输出 | 每一步的推理 / 正文 / 工具请求 |
| 6 · 工具调用 | 参数、结果、耗时 |
| 7 · 模型对话明细 | 每次请求的 TTFT、耗时、Token、tok/s |
| 8 · 收尾 | 结束原因与其它事件 |

## 两种来源：落盘 vs 内存

全文用两个徽标区分，这是理解 DSH 的关键：

| 徽标<br>Badge | 含义<br>Meaning | 来源<br>Source | 能否回放<br>Replayable |
|---|---|---|---|
| **🗄 落盘** | 写入会话日志（session log）的权威事件 | \`session/event\` | 能，重开会话仍在 |
| **⚡ 内存** | 只存在于进程内存的实时活动 | \`llm/stream\` / \`agent/status\` / \`agent/request-error\` | 不能，进程结束即消失 |

DSH 的“事实”是那条 append-only 日志；⚡ 记录的是日志之外的运行现场
（模型逐字流、状态迁移、重试），用于观察性能与管线行为。

## 中途切换模型怎么看

一次任务里换了模型时，会在这四处同时留下标记：

1. **§0 概览**：\`模型轨道\` 一行显示 \`A → B\`，\`模型切换\` 显示 \`🔀 N 次\`。
2. **§1 模型轨道**：每段一行，列出起始偏移、持续时长、该段内的模型调用次数与触发原因
   （\`initial\` / \`change\`），切换点下方有 \`🔀 模型切换：A → B\` 横幅。
3. **§2 时间线**：新增「模型」列，每个相关条目都标明当时生效的模型；
   切换发生的 \`request/header\` 行前面带 \`🔀\`。
4. **§4 / §5 / §7**：请求头条目标题带 \`🔀 模型切换\`，并给出「相对上一个请求头的变化」
   字段级 diff；模型输出与模型对话在切换的那一条前插入 \`🔀\` 横幅。

DSH 记录模型变更的落盘依据是 \`request/header\`（原因 \`change\`），
因此「模型轨道」是权威视图；⚡ 的每次调用则用于核对实际用的是哪个模型。

## 目录结构

\`\`\`
dsh-traces/
├── 00-格式说明.md          ← 本文件
└── <会话 ID>/
    ├── index.md            ← 轮次索引（含每轮模型轨道与切换次数）
    ├── turn-00.md          ← 轮次外的辅助调用（如标题生成）
    ├── turn-01.md          ← 第 1 轮任务的完整过程
    └── ...
\`\`\`

一个「轮次（turn）」＝ 你发一次消息到 DSH 停止工作为止。轮次内部可能包含多个
「步（step）」，每步是一次模型调用加上它请求的工具执行。

## 时间线里的关键事件

| 事件<br>Event | 来源<br>Source | 含义<br>Meaning |
|---|---|---|
| \`turn/start\` / \`turn/end\` | 🗄 | 一轮任务的开始与结束 |
| \`step/start\` / \`step/end\` | 🗄 | 一次模型调用（含其工具执行）的边界 |
| \`system/message\` | 🗄 | 组装好的系统提示被写入日志（模型真正看到的内容） |
| \`request/header\` | 🗄 | 本次请求的模型配置与可用工具；模型变更以它为准 |
| \`request/context\` | 🗄 | 路由元数据：上下文窗口、系统提示更新方式 |
| \`user/message\` | 🗄 | 用户输入（也可能是 DSH 注入的上下文，如技能内容） |
| \`assistant/message\` | 🗄 | 模型最终输出、Token 用量 |
| \`assistant/attempt\` | 🗄 | 未提交的模型尝试（重试、失败、取消） |
| \`tool/call\` / \`tool/result\` | 🗄 | 工具调用与结果；用 \`callId\` 配对 |
| \`llm/call\` | ⚡ | 一次模型请求发出（含消息数、工具数） |
| \`llm/first-chunk\` | ⚡ | 收到第一个流片段（TTFT） |
| \`llm/finish\` | ⚡ | 该次调用结束（结束原因 / 错误 / usage） |
| \`agent/status\` | ⚡ | agent 在 running ⇄ idle 之间切换 |
| \`agent/request-error\` | ⚡ | 模型请求失败（重试前） |

## 符号约定

| 符号<br>Symbol | 含义<br>Meaning |
|---|---|
| 🔀 | 模型中途切换 |
| ✅ / ❌ | 工具成功 / 工具失败 |
| ⏳ | 工具尚未返回 |
| 🧠 | 模型的推理（reasoning）内容 |
| 🔧 | 模型请求的工具调用 |
| 📎 / 🖼 | 文件附件 / 图片附件 |
| \`+1.234s\` | 相对本轮开始的时间偏移 |
| \`seq N\` | 该事件在会话日志里的序号（从 0 递增）；⚡ 条目没有 seq，记为 -1 |

## 折叠块

长内容（系统提示全文、流式片段、原始 JSON）放在 \`<details>\` 里，点击即可展开，
方便先扫结构再看细节。

## 切换记录层级（/trace-realtime）

命令行里可以直接切换：\`/trace-realtime off\` 只记落盘事件，\`/trace-realtime on\` 恢复非落盘记录，不带参数查看当前状态。切换只对本次运行有效。

## 默认关闭与自动关闭

这个插件**默认是关闭的**，需要在「设置 → 插件」里手动打开。
提示词会随任务变长，记录文件（尤其 \`prompts.md\`）增长很快，长任务可能写满磁盘；**建议只在小型任务上开启**。
一轮结束、空闲 5 分钟后，插件会**自动把自己的开关关掉**（\`autoDisable: 'idle'\`，可用 \`idleMinutes\` 调整；\`turn\` 则每轮结束立刻关），避免下次静默记录。结果会写进会话目录的 \`auto-disable.log\`。

## 提示词记录（prompts.md）

同目录的 \`prompts.md\` 记 **harness 实际发给模型的原话** 和 **模型的原样回答**，专门用来学提示词：

- 第一次调用给完整提示词（系统提示 + 用户输入）；
- 之后每次只列**新增**的消息（工具结果、助手消息），并注明「前 N 条与上一次相同」；
- 上下文被压缩或重排时，回落为完整提示词并标注；
- 每次调用后紧跟模型回答：推理、正文、工具调用（由流式片段重建）。

和 \`turn-NN.md\` 互补：那边是落盘事实（§3 系统提示、§7 每次请求），这边是对话原貌。

## 可调参数

在 profile 的 \`cordis.patch.yml\` 里：

\`\`\`yaml
- id: architecture-trace
  config:
    outputDir: "C:/Users/you/dsh-traces"   # 留空则写到会话工作目录下的 dsh-traces/
    captureRealtime: true                   # ⚡ 总开关：记录 / 不记录非落盘事件
    captureLlmCalls: true                   # ⚡ 开启时，记录每次模型调用与流式响应
    summaryMaxChars: 0                      # 摘要字数上限；0 = 完整不截断
    capturePrompts: true                    # 另存 prompts.md：发给模型的提示词与模型回答
    includeStream: false                    # 🗄 附带落盘的逐片段记录
    includeRaw: false                       # 附带原始事件 JSON
\`\`\`

## 注意

- ⚡ 数据在进程内存中聚合；插件被禁用或进程退出后不再产生新记录。
- 系统提示通常很长（含技能与工具说明），文件会相应地大——这是为学习完整性有意为之。
- \`turn-00.md\` 收集轮次之外的辅助调用（例如会话标题生成），它们同样消耗 Token。
- 摘要默认完整不截断；某次工具结果特别大时，可设 \`summaryMaxChars: 400\` 之类收窄时间线。
- \`captureRealtime: false\` 时完全不记录 ⚡ 层，文件里只剩可回放的 🗄 事件。
- §7 的性能数字（TTFT、总耗时、输出字符、Token、tok/s）来自真实请求，可横向比较不同模型与配置。
`
