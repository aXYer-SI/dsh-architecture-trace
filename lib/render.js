/**
 * Markdown rendering for the DSH learning trace.
 *
 * Every line is labelled with the layer it came from:
 *   🗄 落盘 — durable `session/event` entries (DSH's authoritative log).
 *   ⚡ 内存 — in-process activity: model request streams, status, retries.
 *
 * Model changes are first-class: a 「模型轨道」 section summarizes which model
 * was active in which interval, the timeline carries the active model per row,
 * and every model-related section prints a 🔀 banner where the model changes.
 */

const TEXT_LIMIT = 20000
const CHUNK_SAMPLES = 300

export const DURABLE = '🗄 落盘'
export const REALTIME = '⚡ 内存'
export const SWITCH = '🔀'

/** Escape a value for a Markdown table cell. */
export function cell(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, '<br>')
    .replace(/\|/g, '\\|')
    .trim()
}

/** Collapse whitespace for one-line summaries. */
export function oneLine(value, limit = 120) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** Fence text without colliding with backticks already inside it. */
export function fence(text, language = '') {
  const body = String(text ?? '')
  let ticks = '```'
  while (body.includes(ticks)) ticks += '`'
  return `${ticks}${language}\n${body}\n${ticks}`
}

/** A collapsible block. */
export function details(summary, body, open = false) {
  return `<details${open ? ' open' : ''}><summary>${summary}</summary>\n\n${body}\n\n</details>`
}

/** Local wall-clock time with milliseconds. */
export function clock(epochMs) {
  const value = Number(epochMs)
  if (!Number.isFinite(value)) return '—'
  const date = new Date(value)
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/** Relative offset from a turn start, e.g. "+1.234s". */
export function offset(time, start) {
  const delta = Number(time) - Number(start)
  if (!Number.isFinite(delta)) return '—'
  return `+${(delta / 1000).toFixed(3)}s`
}

/** Human-readable duration. */
export function duration(from, to) {
  const delta = Number(to) - Number(from)
  if (!Number.isFinite(delta) || delta < 0) return '—'
  if (delta < 1000) return `${delta}ms`
  if (delta < 60000) return `${(delta / 1000).toFixed(1)}s`
  const minutes = Math.floor(delta / 60000)
  return `${minutes}m${Math.round((delta % 60000) / 1000)}s`
}

function truncate(text) {
  const body = String(text ?? '')
  if (body.length <= TEXT_LIMIT) return { body, truncated: false }
  return { body: `${body.slice(0, TEXT_LIMIT)}\n\n…（已截断，原长 ${body.length} 字符）`, truncated: true }
}

/** Render one content block list (text / reasoning / tool-call / file / image). */
export function renderBlocks(blocks, { skipToolCalls = false, labelText = false } = {}) {
  const parts = []
  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text': {
        const { body } = truncate(block.text)
        if (body.trim()) parts.push(`${labelText ? '**💬 正文**\n\n' : ''}${fence(body, 'text')}`)
        break
      }
      case 'reasoning': {
        const { body } = truncate(block.text)
        if (body.trim()) parts.push(`**🧠 推理过程**\n\n${fence(body, 'text')}`)
        break
      }
      case 'tool-call': {
        if (skipToolCalls) break
        parts.push(`**🔧 请求工具** \`${block.name}\`（callId: \`${block.id}\`）\n\n${fence(block.arguments, 'json')}`)
        break
      }
      case 'file': {
        const attachment = block.attachment ?? {}
        parts.push(`**📎 文件附件** \`${attachment.name ?? ''}\`（${attachment.bytes ?? '?'} bytes，id: \`${attachment.attachmentId ?? ''}\`）`)
        break
      }
      case 'image': {
        const attachment = block.attachment ?? {}
        parts.push(`**🖼 图片附件** ${attachment.width ?? '?'}×${attachment.height ?? '?'}（${attachment.mediaType ?? ''}）`)
        break
      }
      default:
        parts.push(`**未知内容块** \`${block.type}\`\n\n${fence(JSON.stringify(block, null, 2), 'json')}`)
    }
  }
  return parts.join('\n\n')
}

const modelLabel = (config) => {
  if (!config) return undefined
  const provider = config.provider ? String(config.provider) : ''
  const model = config.model ? String(config.model) : ''
  if (!provider && !model) return undefined
  return model ? `${provider}/${model}` : provider
}

/**
 * Derive the model track: which model was active in which interval, and where
 * it changed. A `request/header` marks a change; model calls before the first
 * header are inferred from the call itself.
 */
export function buildModelTrack(turn) {
  const headers = [...(turn.headers ?? [])].sort((a, b) => a.time - b.time)
  const calls = turn.llmCalls ?? []
  const segments = []
  const end = turn.endedAt ?? turn.lastTime

  const push = (label, from, to, reason, kind) => {
    segments.push({ label, from, to, reason, kind, calls: 0 })
  }

  const early = headers.length > 0 ? calls.filter((call) => call.startedAt < headers[0].time) : calls
  if (early.length > 0) {
    push(`${early[0].provider}/${early[0].model}`, early[0].startedAt, headers[0]?.time, '推断（未见请求头）', 'inferred')
  }

  headers.forEach((header, index) => {
    const label = modelLabel(header.header?.config) ?? '(未知模型)'
    const from = header.time
    const to = headers[index + 1]?.time ?? end
    push(label, from, to, header.reason, index === 0 ? 'initial' : 'header')
  })

  // Consecutive segments with the same model are one track piece.
  const merged = []
  for (const segment of segments) {
    const previous = merged[merged.length - 1]
    if (previous && previous.label === segment.label) {
      previous.to = segment.to
      previous.calls += segment.calls
      if (segment.reason === 'change') previous.reason = 'change'
      continue
    }
    merged.push({ ...segment })
  }
  for (const segment of merged) {
    if (segment.from === undefined) segment.from = turn.startedAt ?? turn.firstTime
    if (segment.to === undefined) segment.to = end
  }

  // Attribute each call to the last segment that had already started: without
  // this, a call landing exactly on a boundary would fall into neither interval.
  for (const call of calls) {
    let index = -1
    for (let cursor = 0; cursor < merged.length; cursor += 1) {
      if (call.startedAt >= merged[cursor].from) index = cursor
      else break
    }
    if (index >= 0) merged[index].calls += 1
  }
  return merged
}

/** The model active at one instant, from the model track. */
function modelAt(track, time) {
  for (let index = track.length - 1; index >= 0; index -= 1) {
    const segment = track[index]
    if (time >= segment.from) return segment.label
  }
  return track[0]?.label
}

function renderModelConfig(config, adapterDefaults) {
  const rows = []
  if (!config || typeof config !== 'object') return '_（无配置信息）_'
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null || value === '') continue
    rows.push(`| ${cell(key)} | ${cell(typeof value === 'object' ? JSON.stringify(value) : value)} |`)
  }
  if (rows.length === 0) return '_（无配置信息）_'
  const defaults = adapterDefaults && Object.keys(adapterDefaults).length > 0
    ? `\n\n适配器补齐的默认值：\n\n${fence(JSON.stringify(adapterDefaults, null, 2), 'json')}`
    : ''
  return `| 字段 | 值 |\n|---|---|\n${rows.join('\n')}${defaults}`
}

/** A compact "what changed in the request header" diff. */
function renderHeaderDiff(previous, current) {
  if (!previous) return '_首个请求头（初始配置）_'
  const before = previous.config ?? {}
  const after = current.config ?? {}
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const changes = []
  for (const key of keys) {
    const from = JSON.stringify(before[key] ?? null)
    const to = JSON.stringify(after[key] ?? null)
    if (from !== to) changes.push(`| ${cell(key)} | ${cell(from)} | ${cell(to)} |`)
  }
  const toolDelta = (previous.tools?.length ?? 0) !== (current.tools?.length ?? 0)
    ? `\n\n工具数量：${previous.tools?.length ?? 0} → ${current.tools?.length ?? 0}`
    : ''
  if (changes.length === 0) return `_请求头无字段变化_${toolDelta}`
  return `| 字段 | 变更前 | 变更后 |\n|---|---|---|\n${changes.join('\n')}${toolDelta}`
}

function renderToolSchemas(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '_本轮请求未携带工具（tools 为空）_'
  const rows = tools.map((tool) => `| \`${cell(tool?.name)}\` | ${cell(oneLine(tool?.description, 90))} |`)
  return `共 ${tools.length} 个工具：\n\n| 工具 | 描述 |\n|---|---|\n${rows.join('\n')}`
}

/** Render one model call (⚡ 非落盘) as a metrics block. */
function renderLlmCall(call, index, start) {
  const lines = []
  const label = `${call.provider}/${call.model}`
  const ttft = call.firstChunkAt ? duration(call.startedAt, call.firstChunkAt) : '—'
  const total = call.endedAt ? duration(call.startedAt, call.endedAt) : '进行中'
  const usage = call.usage ?? {}
  const outputTokens = Number(usage.outputTokens) || 0
  const elapsedMs = call.firstChunkAt && call.endedAt ? Math.max(1, call.endedAt - call.firstChunkAt) : 0
  const speed = outputTokens > 0 && elapsedMs > 0 ? `${(outputTokens / (elapsedMs / 1000)).toFixed(1)} tok/s` : '—'

  lines.push(`### 7.${index + 1} · \`${cell(label)}\` · ${clock(call.startedAt)}（${offset(call.startedAt, start)}）`)
  lines.push('')
  lines.push('| 指标 | 值 |')
  lines.push('|---|---|')
  lines.push(`| 模型 | \`${cell(label)}\` |`)
  lines.push(`| 请求消息 | ${call.messageCount} 条 / ${call.messageChars} 字符 |`)
  lines.push(`| 工具 | ${call.toolCount} 个 |`)
  lines.push(`| 首字延迟 (TTFT) | ${cell(ttft)} |`)
  lines.push(`| 总耗时 | ${cell(total)} |`)
  lines.push(`| 输出字符 | ${call.textChars}（推理 ${call.reasoningChars}） |`)
  lines.push(`| 流片段 | ${call.chunkCount}（文本 ${call.textDeltas} / 推理 ${call.reasoningDeltas} / 工具参数 ${call.toolDeltas}） |`)
  lines.push(`| Token | 输入 ${usage.inputTokens ?? '—'} / 输出 ${usage.outputTokens ?? '—'}`
    + `${usage.cacheReadTokens ? ` / 缓存读 ${usage.cacheReadTokens}` : ''}`
    + `${usage.reasoningTokens ? ` / 推理 ${usage.reasoningTokens}` : ''} |`)
  lines.push(`| 生成速度 | ${cell(speed)} |`)
  lines.push(`| 结束 | \`${cell(finishText(call.finishReason) || (call.error ? 'error' : '进行中'))}\` |`)
  if (call.reasoningEffort) lines.push(`| 推理力度 | \`${cell(call.reasoningEffort)}\` |`)
  if (call.maxTokens) lines.push(`| maxTokens | ${call.maxTokens} |`)
  if (call.sessionBound === false) lines.push('| 会话归属 | 未绑定会话（辅助调用） |')
  lines.push('')

  if (call.error) {
    lines.push(`> ❌ 调用失败：${cell(call.error)}`)
    lines.push('')
  }
  if (call.samples?.length > 0) {
    const rows = call.samples.map((sample) => `| ${offset(sample.t, start)} | \`${sample.type}\` | ${sample.chars} |`)
    lines.push(details(
      `流式片段采样（前 ${call.samples.length} 个${call.samplesTruncated ? '，已截断' : ''}）`,
      `| 偏移 | 类型 | 字符 |\n|--:|---|--:|\n${rows.join('\n')}`,
    ))
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Render one turn as a complete Markdown document.
 * @param {object} turn
 * @param {{ sessionId: string, sessionCreatedAt?: number, cwd?: string, includeStream?: boolean, includeRaw?: boolean }} meta
 * @returns {string}
 */
export function renderTurn(turn, meta) {
  const start = turn.startedAt ?? turn.firstTime ?? Date.now()
  const end = turn.endedAt ?? turn.lastTime ?? start
  const lines = []

  const userText = (turn.userMessages ?? [])
    .map((message) => (message.blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' '))
    .join(' ')
  const title = oneLine(userText, 60) || '（无用户文本）'
  const track = buildModelTrack(turn)
  const switches = []
  for (let index = 1; index < track.length; index += 1) {
    if (track[index].label !== track[index - 1].label) {
      switches.push({ from: track[index - 1].label, to: track[index].label, at: track[index].from })
    }
  }
  const finalModel = track.length > 0 ? track[track.length - 1].label : '—'

  lines.push(`# 第 ${turn.turn} 轮 · ${title}`)
  lines.push('')
  lines.push('> 本文件由 `dsh-learning-trace` 自动生成，记录这一轮任务里 DSH 的完整运作过程。')
  lines.push('>')
  lines.push('> **两种来源，全文以此区分：**')
  lines.push(`> - ${DURABLE}：写入会话日志的权威事件（\`session/event\`），可回放、可持久化`)
  lines.push(`> - ${REALTIME}：只存在于进程内存的实时活动（模型流、状态迁移、重试），不落盘`)
  lines.push('>')
  lines.push(`> **模型中途切换以 ${SWITCH} 标记**：见 §1 模型轨道、§2 时间线模型列、§5/§7 的切换横幅。`)
  lines.push('')

  // ---------------------------------------------------------------- 环节导航
  lines.push('## 环节导航')
  lines.push('')
  lines.push('| 章节 | 看什么 | 来源 |')
  lines.push('|---|---|---|')
  lines.push(`| 0 · 概览 | 整轮规模与结果 | 混合 |`)
  lines.push(`| 1 · 模型轨道 | **哪些模型先后参与、何时切换** | 🗄 + ⚡ |`)
  lines.push(`| 2 · 全链路时间线 | 全部条目按时间排列，含当前模型 | 🗄 + ⚡ |`)
  lines.push(`| 3 · 提示词 | 模型看到的 system 内容 | 🗄 |`)
  lines.push(`| 4 · 请求头 | 模型配置与工具清单，含字段变更 | 🗄 |`)
  lines.push(`| 5 · 模型输出 | 每一步的推理/正文/工具请求 | 🗄 |`)
  lines.push(`| 6 · 工具调用 | 参数、结果、耗时 | 🗄 |`)
  lines.push(`| 7 · 模型对话明细 | 每次请求的 TTFT/耗时/Token | ⚡ |`)
  lines.push(`| 8 · 收尾 | 结束原因与其它事件 | 🗄 |`)
  lines.push('')

  // ---------------------------------------------------------------- 概览
  const toolNames = (turn.toolCalls ?? []).map((call) => call.name)
  const toolCount = toolNames.length
  const toolSummary = toolCount === 0
    ? '—'
    : [...new Set(toolNames)].map((name) => `${name}×${toolNames.filter((n) => n === name).length}`).join('、')
  const usage = (turn.assistantMessages ?? []).reduce((acc, message) => {
    const u = message.usage
    if (!u) return acc
    acc.input += Number(u.inputTokens) || 0
    acc.output += Number(u.outputTokens) || 0
    acc.cacheRead += Number(u.cacheReadTokens) || 0
    acc.cacheWrite += Number(u.cacheWriteTokens) || 0
    acc.reasoning += Number(u.reasoningTokens) || 0
    return acc
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
  const reason = turn.reason?.kind ?? '（未结束/未知）'
  const llmCalls = turn.llmCalls ?? []

  lines.push('## 0 · 概览')
  lines.push('')
  lines.push('| 项目 | 内容 |')
  lines.push('|---|---|')
  lines.push(`| 会话 ID | \`${cell(meta.sessionId)}\` |`)
  lines.push(`| 工作目录 | ${cell(meta.cwd ?? '（默认）')} |`)
  lines.push(`| 开始 | ${cell(clock(start))} |`)
  lines.push(`| 结束 | ${cell(clock(end))} |`)
  lines.push(`| 总耗时 | ${cell(duration(start, end))} |`)
  lines.push(`| 步数（step） | ${(turn.steps ?? []).length || (turn.stepCount ?? 0)} |`)
  lines.push(`| 模型轨道 | ${track.length === 0 ? '—' : track.map((segment) => `\`${cell(segment.label)}\``).join(' → ')} |`)
  lines.push(`| 模型切换 | ${switches.length === 0 ? '无' : `${SWITCH} ${switches.length} 次`} |`)
  lines.push(`| 模型调用 | ${llmCalls.length} 次（${REALTIME}） |`)
  lines.push(`| 工具调用 | ${cell(toolCount === 0 ? '—' : `${toolCount} 次：${toolSummary}`)} |`)
  lines.push(`| 结束原因 | \`${cell(reason)}\` |`)
  lines.push(`| Token | 输入 ${usage.input} / 输出 ${usage.output} / 缓存读 ${usage.cacheRead} / 缓存写 ${usage.cacheWrite} / 推理 ${usage.reasoning} |`)
  lines.push('')

  // ---------------------------------------------------------------- 模型轨道
  lines.push('## 1 · 模型轨道')
  lines.push('')
  if (track.length === 0) {
    lines.push('_本轮没有捕获到模型信息。_')
  } else if (track.length === 1 && switches.length === 0) {
    lines.push(`全程使用 \`${cell(track[0].label)}\`。`)
  } else {
    lines.push(`本轮共 ${track.length} 段模型轨道，发生 **${switches.length} 次 ${SWITCH} 切换**。`)
  }
  lines.push('')
  if (track.length > 0) {
    lines.push('| 段 | 模型 | 起始 | 持续 | 该段调用 | 触发 |')
    lines.push('|--:|---|---|--:|--:|---|')
    track.forEach((segment, index) => {
      const marker = index > 0 && track[index - 1].label !== segment.label ? `${SWITCH} ` : ''
      lines.push(`| ${index + 1} | ${marker}\`${cell(segment.label)}\` | ${cell(offset(segment.from, start))} | ${cell(duration(segment.from, segment.to ?? end))} | ${segment.calls} | \`${cell(segment.reason)}\` |`)
    })
    lines.push('')
    if (switches.length > 0) {
      for (const change of switches) {
        lines.push(`> ${SWITCH} **模型切换**：\`${cell(change.from)}\` → \`${cell(change.to)}\`（${cell(offset(change.at, start))}）`)
      }
      lines.push('')
    }
  }

  // ---------------------------------------------------------------- 时间线
  lines.push('## 2 · 全链路时间线')
  lines.push('')
  lines.push('按发生顺序排列；`来源` 列标明是否落盘，`模型` 列标明该条目生效时的模型。')
  lines.push('')
  lines.push('| # | 偏移 | 来源 | 事件 | 模型 | 摘要 |')
  lines.push('|--:|--:|---|---|---|---|')
  const timeline = [...(turn.events ?? [])].sort((a, b) => (a.time - b.time) || (a.seq - b.seq))
  let activeModel
  let lastModel
  timeline.forEach((event, index) => {
    const source = event.realtime ? REALTIME : DURABLE
    let marker = ''
    if (event.type === 'request/header') {
      const label = modelLabel(event.data?.header?.config)
      if (label) {
        if (lastModel !== undefined && label !== lastModel) marker = `${SWITCH} `
        activeModel = label
        lastModel = label
      }
    } else if (event.type === 'llm/call') {
      const label = `${event.data?.provider}/${event.data?.model}`
      if (lastModel !== undefined && label !== lastModel) marker = `${SWITCH} `
      activeModel = label
      lastModel = label
    }
    const showModel = event.type === 'request/header' || event.type === 'llm/call'
      || event.type === 'assistant/message' || event.type === 'step/start'
    lines.push(`| ${index + 1} | ${cell(offset(event.time, start))} | ${source} | ${marker}\`${cell(event.type)}\` | ${showModel ? cell(activeModel ?? '—') : '·'} | ${cell(eventSummary(event))} |`)
  })
  if (timeline.length === 0) lines.push('| — | — | — | — | — | （无事件） |')
  lines.push('')

  // ---------------------------------------------------------------- 提示词
  lines.push(`## 3 · 提示词（${DURABLE} · system/message）`)
  lines.push('')
  const systems = turn.systemMessages ?? []
  if (systems.length === 0) {
    lines.push('_本轮没有新的 system/message 事件（沿用上一次请求的系统提示，或该路由不支持刷新）。_')
  } else {
    systems.forEach((entry, index) => {
      lines.push(`### 3.${index + 1} · seq ${entry.seq} · ${clock(entry.time)}`)
      lines.push('')
      lines.push(`长度：**${String(entry.text ?? '').length}** 字符`)
      lines.push('')
      lines.push(details(
        `展开系统提示全文（${String(entry.text ?? '').length} 字符）`,
        fence(entry.text ?? '', 'markdown'),
        false,
      ))
      lines.push('')
    })
  }
  lines.push('')

  // ---------------------------------------------------------------- 请求头
  lines.push(`## 4 · 请求头（${DURABLE} · request/header）`)
  lines.push('')
  const headers = [...(turn.headers ?? [])].sort((a, b) => a.time - b.time)
  if (headers.length === 0) {
    lines.push('_本轮没有新的 request/header 事件（请求头与上次相同）。_')
  } else {
    headers.forEach((entry, index) => {
      const label = modelLabel(entry.header?.config) ?? '(未知)'
      const previous = headers[index - 1]
      const changed = previous && modelLabel(previous.header?.config) !== label
      lines.push(`### 4.${index + 1} · seq ${entry.seq} · 原因 \`${cell(entry.reason)}\`${changed ? ` · ${SWITCH} 模型切换` : ''}`)
      lines.push('')
      if (changed) {
        lines.push(`> ${SWITCH} 模型由 \`${cell(modelLabel(previous.header?.config) ?? '?')}\` 切换为 \`${cell(label)}\``)
        lines.push('')
      }
      lines.push('**模型调用配置**')
      lines.push('')
      lines.push(renderModelConfig(entry.header?.config, entry.header?.adapterDefaults))
      lines.push('')
      lines.push('**相对上一个请求头的变化**')
      lines.push('')
      lines.push(renderHeaderDiff(previous?.header, entry.header))
      lines.push('')
      lines.push('**工具清单**')
      lines.push('')
      lines.push(renderToolSchemas(entry.header?.tools))
      lines.push('')
    })
  }
  const contexts = turn.contexts ?? []
  if (contexts.length > 0) {
    lines.push('### 4.x · 路由元数据（request/context）')
    lines.push('')
    lines.push('| seq | provider | model | 上下文窗口 | 系统提示更新方式 |')
    lines.push('|--:|---|---|--:|---|')
    for (const entry of contexts) {
      const context = entry.context ?? {}
      lines.push(`| ${entry.seq} | ${cell(context.provider)} | ${cell(context.model)} | ${cell(context.contextWindow ?? '—')} | ${cell(context.systemPromptUpdate ?? '—')} |`)
    }
    lines.push('')
  }

  // ---------------------------------------------------------------- 模型输出
  lines.push(`## 5 · 模型输出（${DURABLE} · assistant/message）`)
  lines.push('')
  const assistant = turn.assistantMessages ?? []
  if (assistant.length === 0) {
    lines.push('_本轮没有模型输出事件。_')
  } else {
    let previousModel
    assistant.forEach((message, index) => {
      const model = modelAt(track, message.time)
      const changed = previousModel !== undefined && model !== previousModel
      lines.push(`### 5.${index + 1} · step ${message.step ?? '?'} · ${clock(message.time)} · \`${cell(model ?? '—')}\``)
      lines.push('')
      if (changed) {
        lines.push(`> ${SWITCH} 此处模型已切换：\`${cell(previousModel)}\` → \`${cell(model)}\``)
        lines.push('')
      }
      previousModel = model
      if (message.interrupted) {
        lines.push('> ⚠️ 该消息是被中断后保留下来的前缀。')
        lines.push('')
      }
      if (message.usage) {
        lines.push(`Token：输入 ${message.usage.inputTokens ?? 0} / 输出 ${message.usage.outputTokens ?? 0}`
          + (message.usage.cacheReadTokens ? ` / 缓存读 ${message.usage.cacheReadTokens}` : '')
          + (message.usage.reasoningTokens ? ` / 推理 ${message.usage.reasoningTokens}` : ''))
        lines.push('')
      }
      const toolCallBlocks = (message.blocks ?? []).filter((block) => block.type === 'tool-call')
      const rendered = renderBlocks(message.blocks, { skipToolCalls: true, labelText: true })
      lines.push(rendered || '_（该步没有可见正文）_')
      if (toolCallBlocks.length > 0) {
        lines.push('')
        lines.push(`**本步请求了 ${toolCallBlocks.length} 个工具调用**：${toolCallBlocks.map((block) => `\`${block.name}\``).join('、')}（参数与结果见 §6）`)
      }
      if (message.stream && meta.includeStream) {
        lines.push('')
        lines.push(details(
          `落盘的流式记录（${message.stream.length} 个片段）`,
          fence(JSON.stringify(message.stream, null, 2), 'json'),
        ))
      }
      lines.push('')
    })
  }
  const attempts = turn.attempts ?? []
  if (attempts.length > 0) {
    lines.push('### 5.x · 未提交的模型尝试（重试 / 失败 / 取消）')
    lines.push('')
    for (const attempt of attempts) {
      lines.push(`- seq ${attempt.seq} · step ${attempt.step} · ${clock(attempt.time)} · ${attempt.stream?.length ?? 0} 个流片段`)
    }
    lines.push('')
  }

  // ---------------------------------------------------------------- 工具调用
  lines.push(`## 6 · 工具调用明细（${DURABLE}）`)
  lines.push('')
  const calls = turn.toolCalls ?? []
  if (calls.length === 0) {
    lines.push('_本轮没有工具调用。_')
    lines.push('')
  } else {
    calls.forEach((call, index) => {
      const result = turn.toolResults?.[call.callId]
      lines.push(`### 6.${index + 1} · \`${call.name}\``)
      lines.push('')
      lines.push('| 项目 | 内容 |')
      lines.push('|---|---|')
      lines.push(`| callId | \`${cell(call.callId)}\` |`)
      lines.push(`| 发起时间 | ${cell(clock(call.time))} |`)
      lines.push(`| 结果时间 | ${cell(result ? clock(result.time) : '（无结果）')} |`)
      lines.push(`| 耗时 | ${cell(result ? duration(call.time, result.time) : '—')} |`)
      lines.push(`| 状态 | ${result ? (result.isError ? '❌ 失败' : '✅ 成功') : '⏳ 未返回'} |`)
      lines.push('')
      lines.push('**调用参数**')
      lines.push('')
      lines.push(fence(prettyJson(call.arguments), 'json'))
      lines.push('')
      lines.push('**工具结果**')
      lines.push('')
      if (!result) {
        lines.push('_（尚未返回）_')
      } else {
        const body = renderBlocks(result.content)
        lines.push(body || '_（空结果）_')
        if (result.error) {
          lines.push('')
          lines.push(`> 错误：\`${cell(result.error.code)}\` ${cell(result.error.reason ?? '')}`)
        }
        if (result.meta && meta.includeRaw) {
          lines.push('')
          lines.push(details('工具私有 meta', fence(JSON.stringify(result.meta, null, 2), 'json')))
        }
      }
      lines.push('')
    })
  }

  // ---------------------------------------------------------------- 模型对话
  lines.push(`## 7 · 模型对话明细（${REALTIME}，不落盘）`)
  lines.push('')
  lines.push('这里记录**每一次真正发给大模型的请求**及其流式响应，用于观察请求规模与模型性能。')
  lines.push('这些数据只存在于进程内存，会话日志里没有；可回放的事实见 §3–§6。')
  lines.push('')
  if (llmCalls.length === 0) {
    lines.push('_本轮没有捕获到模型调用（可能未开启 captureLlmCalls，或本轮没有调用模型）。_')
    lines.push('')
  } else {
    lines.push('| # | 开始 | 模型 | 消息 | 工具 | TTFT | 总耗时 | 输出字符 | Token 出 | 结束 |')
    lines.push('|--:|---|--:|--:|--:|--:|--:|--:|--:|---|')
    llmCalls.forEach((call, index) => {
      const ttft = call.firstChunkAt ? duration(call.startedAt, call.firstChunkAt) : '—'
      const total = call.endedAt ? duration(call.startedAt, call.endedAt) : '进行中'
      lines.push(`| ${index + 1} | ${cell(clock(call.startedAt))} | \`${cell(`${call.provider}/${call.model}`)}\` | ${call.messageCount} | ${call.toolCount} `
        + `| ${cell(ttft)} | ${cell(total)} | ${call.textChars} | ${call.usage?.outputTokens ?? '—'} | \`${cell(finishText(call.finishReason) || (call.error ? 'error' : '进行中'))}\` |`)
    })
    lines.push('')
    let previousModel
    llmCalls.forEach((call, index) => {
      const label = `${call.provider}/${call.model}`
      if (previousModel !== undefined && label !== previousModel) {
        lines.push(`> ${SWITCH} **模型切换**：\`${cell(previousModel)}\` → \`${cell(label)}\``)
        lines.push('')
      }
      previousModel = label
      lines.push(renderLlmCall(call, index, start))
      lines.push('')
    })
  }

  // ---------------------------------------------------------------- 收尾
  lines.push(`## 8 · 收尾与其它环节（${DURABLE}）`)
  lines.push('')
  lines.push(`**结束原因**：\`${cell(reason)}\``)
  lines.push(`**最终模型**：\`${cell(finalModel)}\``)
  if (turn.reason?.kind === 'error' && turn.reason.error) {
    lines.push('')
    lines.push(fence(JSON.stringify(turn.reason.error, null, 2), 'json'))
  }
  if (turn.reason?.kind === 'aborted' && turn.reason.reason) {
    lines.push('')
    lines.push(`取消原因：\`${cell(JSON.stringify(turn.reason.reason))}\``)
  }
  lines.push('')
  const others = (turn.others ?? []).filter((entry) => !entry.realtime)
  if (others.length > 0) {
    lines.push('**其它落盘事件**')
    lines.push('')
    lines.push('| 偏移 | 类型 | 内容 |')
    lines.push('|--:|---|---|')
    for (const entry of others) {
      lines.push(`| ${cell(offset(entry.time, start))} | \`${cell(entry.type)}\` | ${cell(oneLine(JSON.stringify(entry.data), 140))} |`)
    }
    lines.push('')
  }
  if (meta.includeRaw) {
    lines.push(details('原始事件（JSON）', fence(JSON.stringify(timeline, null, 2), 'json')))
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(`_由 dsh-learning-trace 生成 · 会话 \`${meta.sessionId}\` · 第 ${turn.turn} 轮_`)
  lines.push('')
  return lines.join('\n')
}

/** Pretty-print a JSON string when possible. */
export function prettyJson(value) {
  if (typeof value !== 'string') return JSON.stringify(value, null, 2)
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

/**
 * Describe a finish reason, which DSH may hand over as a plain string or as a
 * structured event object (for example `{ kind: 'tool-calls' }`). Printing the
 * object directly would render `[object Object]` in the timeline.
 */
function finishText(reason) {
  if (reason === undefined || reason === null) return ''
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object') {
    const named = reason.kind ?? reason.reason ?? reason.type ?? reason.code
    if (typeof named === 'string' && named !== '') return named
    return oneLine(JSON.stringify(reason), 60)
  }
  return String(reason)
}

/** One-line summary per event type, used by the timeline table. */
export function eventSummary(event) {
  const data = event?.data ?? {}
  switch (event?.type) {
    case 'turn/start': return `开始第 ${data.turn} 轮`
    case 'turn/end': return `结束：${data.reason?.kind ?? '?'}`
    case 'step/start': return `进入 step ${data.step}`
    case 'step/end': return `离开 step ${data.step}`
    case 'system/message': {
      const text = (data.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
      return `系统提示 ${text.length} 字符`
    }
    case 'user/message': {
      const blocks = data.content ?? []
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
      const files = blocks.filter((b) => b.type === 'file').length
      return oneLine(`${text}${files ? `（含 ${files} 个文件）` : ''}`, 100)
    }
    case 'assistant/message': {
      const blocks = data.message?.content ?? []
      const tools = blocks.filter((b) => b.type === 'tool-call').length
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ')
      return `step ${data.step} · ${tools ? `${tools} 个工具调用 · ` : ''}${oneLine(text, 80) || '（无正文）'}`
    }
    case 'assistant/attempt': return `未提交尝试 · step ${data.step} · ${data.stream?.length ?? 0} 片段`
    case 'tool/call': return `调用 \`${data.name}\` · ${oneLine(data.arguments, 80)}`
    case 'tool/result': {
      const isError = data.message?.isError
      return `${isError ? '失败' : '成功'} · ${oneLine((data.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' '), 80)}`
    }
    case 'request/header': return `原因 ${data.reason} · ${data.header?.config?.model ?? '?'}`
    case 'request/context': return `路由 ${data.provider}/${data.model}`
    case 'developer/message': return '开发者消息（工具增删等）'
    case 'session/end-seed': return '会话种子分界'
    case 'llm/call': return `发起模型调用 ${data.provider}/${data.model} · ${data.messageCount} 条消息 · ${data.toolCount} 个工具`
    case 'llm/first-chunk': return `收到首个流片段（TTFT ${data.ttft ?? '?'}）`
    case 'llm/finish': {
      const parts = [
        finishText(data.finishReason),
        data.error ? oneLine(String(data.error), 60) : '',
        data.chunks ? `${data.chunks} 片段` : '',
      ].filter(Boolean)
      return `调用结束：${parts.join(' · ') || '?'}`
    }
    case 'agent/status': return `agent 状态 → ${data.status}`
    case 'agent/request-error': return `模型请求失败：${oneLine(data.message, 80)}`
    default: return oneLine(JSON.stringify(data), 100)
  }
}

/** Render the per-session index document. */
export function renderIndex(state) {
  const turns = [...(state.turns?.values?.() ?? [])].sort((a, b) => a.turn - b.turn)
  const lines = []
  lines.push(`# 会话学习记录 · \`${state.sessionId}\``)
  lines.push('')
  lines.push('| 项目 | 内容 |')
  lines.push('|---|---|')
  lines.push(`| 会话 ID | \`${state.sessionId}\` |`)
  lines.push(`| 创建时间 | ${clock(state.createdAt)} |`)
  lines.push(`| 工作目录 | ${state.cwd ?? '（默认）'} |`)
  lines.push(`| 已记录轮次 | ${turns.length} |`)
  lines.push('')
  lines.push('## 轮次索引')
  lines.push('')
  lines.push('| 轮次 | 开始 | 耗时 | 模型 | 模型切换 | 模型调用 | 工具 | 结束原因 | 标题 |')
  lines.push('|--:|---|--:|---|--:|--:|--:|---|---|')
  for (const turn of turns) {
    const userText = (turn.userMessages ?? [])
      .map((m) => (m.blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' '))
      .join(' ')
    const track = buildModelTrack(turn)
    let switches = 0
    for (let index = 1; index < track.length; index += 1) {
      if (track[index].label !== track[index - 1].label) switches += 1
    }
    lines.push(`| ${turn.turn} | ${cell(clock(turn.startedAt))} | ${cell(duration(turn.startedAt, turn.endedAt ?? turn.lastTime))} `
      + `| ${cell(track.map((segment) => segment.label).join(' → ') || '—')} | ${switches === 0 ? '无' : `${SWITCH} ${switches}`} `
      + `| ${(turn.llmCalls ?? []).length} | ${(turn.toolCalls ?? []).length} `
      + `| \`${cell(turn.reason?.kind ?? '进行中')}\` | ${cell(oneLine(userText, 40))} |`)
  }
  if (turns.length === 0) lines.push('| — | — | — | — | — | — | — | — | （暂无） |')
  lines.push('')
  lines.push('每个轮次的详细过程见同目录下的 `turn-XX.md`。格式说明见上级目录的 `00-格式说明.md`。')
  lines.push('')
  return lines.join('\n')
}
