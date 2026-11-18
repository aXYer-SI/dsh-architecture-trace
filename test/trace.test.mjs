import assert from 'node:assert/strict'
import { readFile, rm, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const OUTPUT = join(import.meta.dirname, 'out')
await rm(OUTPUT, { recursive: true, force: true })

const listeners = new Map()
const ctx = {
  on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event) },
  effect: (factory) => factory(),
}
const session = { id: 'session-demo', header: { createdAt: Date.now(), cwd: OUTPUT } }

apply(ctx, { outputDir: OUTPUT })
const now = () => Date.now()
const emit = (type, data, seq = 0, time = now()) => listeners.get('session/event')?.(session, { type, seq, time, data })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const runStream = async (request) => {
  const stream = listeners.get('llm/stream')(request, async function* generate() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '示例输出' }
    yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 60, cacheReadTokens: 900 } }
    yield { type: 'finish', reason: 'stop' }
  })
  for await (const _ of stream) { /* drain */ }
}

// ---- step 1：模型 A ------------------------------------------------------
emit('turn/start', { turn: 1 }, 1)
await sleep(5)
emit('step/start', { turn: 1, step: 1 })
emit('request/header', {
  reason: 'initial',
  header: {
    config: { provider: 'deepseek', model: 'deepseek-v4.1-flash', reasoning_effort: 'high' },
    tools: [{ name: 'read', description: '读取工作区文件' }],
  },
})
emit('system/message', {
  turn: 1,
  step: 1,
  message: { role: 'system', content: [{ type: 'text', text: '你是 DeepSeek Harness 的助手。' }] },
})
emit('user/message', { role: 'user', content: [{ type: 'text', text: '帮我看一下 README' }] })

await runStream({
  provider: 'deepseek',
  model: 'deepseek-v4.1-flash',
  sessionId: 'session-demo',
  messages: [{ role: 'user', content: [{ type: 'text', text: '帮我看一下 README' }] }],
  tools: [{ name: 'read', description: '读取工作区文件', parameters: {} }],
})

emit('assistant/message', {
  turn: 1,
  step: 1,
  message: {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: '先定位 README。' },
      { type: 'text', text: '我先读取 README。' },
      { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"README.md"}' },
    ],
  },
  usage: { inputTokens: 1200, outputTokens: 60, cacheReadTokens: 900 },
})
emit('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"file_path":"README.md"}' })
await sleep(260)
emit('tool/result', {
  turn: 1,
  step: 1,
  message: { role: 'tool', toolCallId: 'call-1', isError: false, content: [{ type: 'text', text: '# README\n\n这是一个测试文件。' }] },
})
emit('step/end', { turn: 1, step: 1 })

// ---- 中途切换模型：A → B --------------------------------------------------
emit('request/header', {
  reason: 'change',
  header: {
    config: { provider: 'workbuddy', model: 'glm-5.3', reasoning_effort: 'medium' },
    tools: [{ name: 'read', description: '读取工作区文件' }],
  },
})
emit('step/start', { turn: 1, step: 2 })

await runStream({
  provider: 'workbuddy',
  model: 'glm-5.3',
  sessionId: 'session-demo',
  messages: [{ role: 'user', content: [{ type: 'text', text: '继续' }] }],
  tools: [{ name: 'read', description: '读取工作区文件', parameters: {} }],
})

emit('assistant/message', {
  turn: 1,
  step: 2,
  message: { role: 'assistant', content: [{ type: 'text', text: 'README 里写的是：这是一个测试文件。' }] },
  usage: { inputTokens: 1500, outputTokens: 40 },
})
emit('step/end', { turn: 1, step: 2 })
emit('turn/end', { turn: 1, reason: { kind: 'completed' } })

await sleep(900)

const dir = join(OUTPUT, 'session-demo')
const files = await readdir(dir)
assert.ok(files.includes('turn-01.md'))
const turn = await readFile(join(dir, 'turn-01.md'), 'utf8')

for (const heading of [
  '## 环节导航',
  '## 0 · 概览',
  '## 1 · 模型轨道',
  '## 2 · 全链路时间线',
  '## 3 · 提示词',
  '## 4 · 请求头',
  '## 5 · 模型输出',
  '## 6 · 工具调用明细',
  '## 7 · 模型对话明细',
  '## 8 · 收尾与其它环节',
]) {
  assert.ok(turn.includes(heading), `missing heading: ${heading}`)
}

// layers + model column
assert.match(turn, /🗄 落盘/)
assert.match(turn, /⚡ 内存/)
assert.match(turn, /\| # \| 偏移 \| 来源 \| 事件 \| 模型 \| 摘要 \|/)

// model track: two segments, each with its call counted, one switch
assert.match(turn, /deepseek\/deepseek-v4\.1-flash/)
assert.match(turn, /workbuddy\/glm-5\.3/)
assert.match(turn, /模型切换 \| 🔀 1 次/)
assert.match(turn, /🔀 \*\*模型切换\*\*/)
assert.match(turn, /此处模型已切换/)
assert.match(turn, /模型由/)
assert.match(turn, /相对上一个请求头的变化/)
assert.match(turn, /"deepseek" \| "workbuddy"/, 'header diff shows the model change')
assert.match(turn, /最终模型/)
assert.doesNotMatch(turn, /推断（未见请求头）/, 'no phantom inferred segment')

// durable facts
assert.match(turn, /DeepSeek Harness 的助手/)
assert.match(turn, /call-1/)
assert.match(turn, /耗时 \| 2\d\dms/)
assert.match(turn, /completed/)
assert.match(turn, /✅ 成功/)

console.log('trace.test: sections, layers and mid-turn model switch verified')

const idx = turn.indexOf('## 1 · 模型轨道')
console.log(turn.slice(idx, idx + 700))
