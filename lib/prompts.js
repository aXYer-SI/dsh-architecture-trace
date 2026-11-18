/**
 * Prompt journal: what the harness actually sent to the model, and what came
 * back, in one readable document.
 *
 * Every model call repeats the whole conversation, so dumping each request
 * verbatim would repeat the system prompt dozens of times. Instead each call
 * shows only the messages that are new since the previous call — the harness's
 * own construction order becomes the reading order. When the context is
 * rewritten (compaction), the full prompt is shown with a note.
 *
 * @module dsh-architecture-trace/prompts
 */
import { clock, offset, renderBlocks } from './render.js'

/** Deep equality that survives JSON-shaped message arrays. */
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

/**
 * What to show for one call: the messages it added, or the whole prompt when
 * the previous request is no longer a prefix of this one.
 * @param {unknown[]} previous
 * @param {unknown[]} current
 * @returns {{ added: unknown[], mode: 'full'|'delta'|'rewritten', skipped: number }}
 */
export function promptDelta(previous, current) {
  if (!Array.isArray(previous) || previous.length === 0) {
    return { added: current, mode: 'full', skipped: 0 }
  }
  let prefix = 0
  while (prefix < previous.length && prefix < current.length && same(previous[prefix], current[prefix])) prefix += 1
  if (prefix === previous.length) {
    return { added: current.slice(prefix), mode: 'delta', skipped: prefix }
  }
  return { added: current, mode: 'rewritten', skipped: 0 }
}

/** One message as a titled block list. */
function renderMessage(message, index) {
  const role = String(message?.role ?? '?')
  const raw = message?.content
  const content = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' && raw !== '' ? [{ type: 'text', text: raw }] : [])
  const tag = message?.toolCallId ? ` · \`${message.toolCallId}\`` : ''
  const body = renderBlocks(content) || '_（空消息）_'
  return `**${index} · ${role}**${tag}\n\n${body}`
}

/**
 * Prepend the turn's system prompt when the request does not carry one.
 * DSH records it as a `system/message` event; the newest one before the call is
 * what the model saw.
 */
function withSystem(turn, call, messages) {
  const list = Array.isArray(messages) ? messages : []
  if (list[0]?.role === 'system') return list
  const before = (turn?.systemMessages ?? []).filter((entry) => Number(entry.time) <= Number(call?.startedAt ?? Infinity))
  const entry = before[before.length - 1] ?? (turn?.systemMessages ?? [])[0]
  const text = String(entry?.text ?? '')
  if (!text) return list
  return [{ role: 'system', content: [{ type: 'text', text }] }, ...list]
}

/** The model's side of one call. */
function renderResponse(call) {
  const response = call?.response ?? {}
  const blocks = []
  if (response.reasoning) blocks.push({ type: 'reasoning', text: response.reasoning })
  if (response.text) blocks.push({ type: 'text', text: response.text })
  for (const toolCall of response.toolCalls ?? []) {
    blocks.push({ type: 'tool-call', name: toolCall.name ?? '?', id: toolCall.id ?? '', arguments: toolCall.arguments ?? '' })
  }
  const body = renderBlocks(blocks, { labelText: true })
  if (body) return body
  if (call?.error) return `> ❌ 调用失败：${call.error}`
  return '_（没有任何输出；可能被取消，或模型只返回了结束信号）_'
}

/**
 * Render the prompt journal for one session.
 * @param {object} state recorder state: `{ sessionId, createdAt, cwd, turns }`
 * @returns {string} markdown
 */
export function renderPrompts(state) {
  const turns = [...(state.turns?.values?.() ?? [])].sort((a, b) => a.turn - b.turn)
  const calls = turns.flatMap((turn) => (turn.llmCalls ?? []).map((call) => ({ turn, call })))

  const lines = []
  lines.push('# 提示词记录 / Prompt journal')
  lines.push('')
  lines.push(`> 会话 \`${state.sessionId}\`　·　创建于 ${clock(state.createdAt)}　·　轮次 ${turns.length}　·　模型调用 ${calls.length} 次`)
  lines.push('>')
  lines.push('> 这里只记 **harness 实际发给模型的内容** 与 **模型的原样回答**。')
  lines.push('> 每次调用先列「本次新增」的提示词，再列模型回答：第一次是系统提示 + 用户输入，之后只列增量，')
  lines.push('> 于是 harness 拼装上下文的顺序就成了阅读顺序。上下文被重排（压缩）时会回落为完整提示词并注明。')
  lines.push('')

  if (calls.length === 0) {
    lines.push('_本次会话没有捕获到模型调用。_')
    lines.push('')
    return lines.join('\n')
  }

  let previousMessages = []
  let currentTurn
  for (const { turn, call } of calls) {
    if (turn.turn !== currentTurn) {
      currentTurn = turn.turn
      lines.push(`## 第 ${turn.turn} 轮 · \`${call.provider}/${call.model}\``)
      lines.push('')
    }

    // The system prompt travels as its own session event, not inside
    // `request.messages`; a reader wants it at the head of the conversation.
    const messages = withSystem(turn, call, call.prompt?.messages)
    const { added, mode, skipped } = promptDelta(previousMessages, messages)
    previousMessages = messages

    const startedAt = call.startedAt ?? Date.now()
    const output = Number(call.textChars ?? 0) + Number(call.reasoningChars ?? 0)
    lines.push(`### 调用 ${(turn.llmCalls ?? []).indexOf(call) + 1} · ${clock(startedAt)}（${offset(startedAt, turn.startedAt ?? startedAt)}）`)
    lines.push('')
    lines.push(`> 提示词 ${messages.length} 条 / ${Number(call.messageChars ?? 0).toLocaleString('en-US')} 字符`
      + `　·　工具 ${call.toolCount ?? 0} 个　·　输出 ${output.toLocaleString('en-US')} 字符`)
    lines.push('')

    if (mode === 'rewritten') {
      lines.push('**完整提示词**（与上一次相比上下文被重排，因此列出全部）')
      lines.push('')
    } else if (mode === 'delta') {
      lines.push(added.length > 0
        ? `**本次新增 ${added.length} 条**（前 ${skipped} 条与上一次调用相同，省略）`
        : '**本次新增 0 条**（与上一次调用完全相同）')
      lines.push('')
    } else {
      lines.push(`**完整提示词**（首次调用，共 ${added.length} 条）`)
      lines.push('')
    }

    const offsetIndex = mode === 'delta' ? skipped : 0
    added.forEach((message, index) => {
      lines.push(renderMessage(message, offsetIndex + index + 1))
      lines.push('')
    })

    lines.push('#### 模型回答')
    lines.push('')
    lines.push(renderResponse(call))
    lines.push('')
    lines.push('---')
    lines.push('')
  }

  lines.push('_由 `dsh-architecture-trace` 生成 · 与同目录的 `turn-NN.md` 互补：那里是落盘事实，这里是对话原貌。_')
  lines.push('')
  return lines.join('\n')
}
