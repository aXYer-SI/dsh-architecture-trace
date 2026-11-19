import assert from 'node:assert/strict'
import { mkdir, readFile, rm, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { eventSummary, oneLine } from '../lib/render.js'

const OUTPUT = join(import.meta.dirname, 'out')
await rm(OUTPUT, { recursive: true, force: true })

const listeners = new Map()
const disableCalls = []
const PROFILE_DIR = join(import.meta.dirname, 'out-profile')
await rm(PROFILE_DIR, { recursive: true, force: true })
await mkdir(PROFILE_DIR, { recursive: true })
await writeFile(join(PROFILE_DIR, 'cordis.patch.yml'),
  '- id: architecture-trace\n  name: "dsh-architecture-trace"\n  config:\n    autoDisable: "idle"\n  disabled: false\n', 'utf8')
process.env.DSH_PROFILE_DIR = PROFILE_DIR
const commandRegistrations = []
const commands = {
  register(definition) { commandRegistrations.push(definition); return () => {} },
}
const ctx = {
  on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event) },
  effect: (factory) => factory(),
  get: (name) => (name === 'commands' ? commands : undefined),
}
const session = { id: 'session-demo', header: { createdAt: Date.now(), cwd: OUTPUT } }

apply(ctx, { outputDir: OUTPUT, autoDisable: 'turn', autoDisableStateFile: join(OUTPUT, 'auto-disable.json') })
const now = () => Date.now()
const emit = (type, data, seq = 0, time = now()) => listeners.get('session/event')?.(session, { type, seq, time, data })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const runStream = async (request, finish = 'stop') => {
  const stream = listeners.get('llm/stream')(request, async function* generate() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '示例输出' }
    yield { type: 'usage', usage: { inputTokens: 1200, outputTokens: 60, cacheReadTokens: 900 } }
    yield { type: 'finish', reason: finish }
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
  messages: [
    { role: 'user', content: [{ type: 'text', text: '帮我看一下 README' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我先读取 README。' },
        { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"README.md"}' },
      ],
    },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: '# README\n\n这是一个测试文件。' }] },
  ],
  tools: [{ name: 'read', description: '读取工作区文件', parameters: {} }],
}, { kind: 'tool-calls' })

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
assert.match(turn, /\| # \| 偏移<br>Offset \| 来源<br>Source \| 事件<br>Event \| 模型<br>Model \| 摘要<br>Abstract \|/)

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

// finish reasons arrive as strings and as event objects; neither may print as [object Object]
assert.doesNotMatch(turn, /\[object Object\]/)
assert.match(turn, /调用结束：stop/)
assert.match(turn, /调用结束：tool-calls/)

// summaries keep the whole text unless a limit is configured
assert.equal(oneLine('x'.repeat(200), 0).length, 200, 'a zero limit keeps everything')
assert.match(oneLine('x'.repeat(200), 50), /^x{50}…$/)
const longSummary = eventSummary({ type: 'user/message', data: { content: [{ type: 'text', text: '完整的摘要'.repeat(40) }] } })
assert.doesNotMatch(longSummary, /…/, 'the default summary is not truncated')
assert.ok(longSummary.includes('完整的摘要'.repeat(40)))

// captureRealtime: false keeps only the durable layer
const listeners2 = new Map()
const ctx2 = {
  on: (event, listener) => { listeners2.set(event, listener); return () => listeners2.delete(event) },
  effect: (factory) => factory(),
  get: () => undefined,
}
const OUTPUT2 = join(import.meta.dirname, 'out-durable')
apply(ctx2, { outputDir: OUTPUT2, captureRealtime: false, autoDisable: false })
// The hooks stay registered (the runtime switch can turn them back on) but
// record nothing while the switch is off.
assert.equal(listeners2.has('llm/stream'), true, 'the stream hook stays registered')
assert.equal(listeners2.has('agent/status'), true, 'the status hook stays registered')
assert.equal(listeners2.has('agent/request-error'), true, 'the request-error hook stays registered')
assert.equal(listeners2.has('session/event'), true, 'the durable hook stays')

const session2 = { id: 'session-durable', header: { createdAt: Date.now(), cwd: OUTPUT2 } }
let seq2 = 1
const emit2 = (type, data) => listeners2.get('session/event')(session2, { type, seq: seq2++, time: Date.now(), data })
const longUserText = '长文本摘要测试'.repeat(40)
emit2('turn/start', { turn: 1 })
emit2('step/start', { turn: 1, step: 1 })
emit2('user/message', { role: 'user', content: [{ type: 'text', text: longUserText }] })
emit2('step/end', { turn: 1, step: 1 })
emit2('turn/end', { turn: 1, reason: { kind: 'completed' } })
await sleep(900)

const durableTurn = await readFile(join(OUTPUT2, 'session-durable', 'turn-01.md'), 'utf8')
assert.doesNotMatch(durableTurn, /⚡ 内存 \|/, 'no in-memory rows in the timeline')
assert.ok(durableTurn.includes(longUserText), 'the full summary is written')

// ---- prompt journal: harness prompts + model answers in one file ----------
const prompts = await readFile(join(dir, 'prompts.md'), 'utf8')
assert.match(prompts, /# 提示词记录 \/ Prompt journal/)
assert.match(prompts, /\*\*完整提示词\*\*（首次调用，共 2 条）/, 'first call shows the whole prompt')
assert.match(prompts, /## 第 1 轮 · `deepseek\/deepseek-v4\.1-flash`/)
assert.match(prompts, /\*\*本次新增 2 条\*\*（前 2 条与上一次调用相同，省略）/, 'second call shows only the delta')
assert.match(prompts, /你是 DeepSeek Harness 的助手/)
assert.match(prompts, /这是一个测试文件/, 'the tool result is part of the next prompt')
assert.match(prompts, /#### 模型回答/)
assert.match(prompts, /示例输出/, 'the streamed answer is recorded')
assert.match(prompts, /🔧 请求工具/, 'tool-call deltas are reconstructed')

// ---- /trace-realtime: switch the in-memory layer at runtime ---------------
const realtimeCommand = commandRegistrations.find((command) => command.name === 'trace-realtime')
assert.ok(realtimeCommand, 'the realtime switch command is registered')
assert.match((await realtimeCommand.handler({ rawInput: '' })).text, /落盘/, 'no argument reports the state')
assert.match((await realtimeCommand.handler({ rawInput: 'off' })).text, /只保留/, 'off switches to durable only')

const cmdSession = { id: 'session-cmd', header: { createdAt: Date.now(), cwd: OUTPUT } }
let seqCmd = 0
const emitCmd = (type, data) => listeners.get('session/event')(cmdSession, { type, seq: ++seqCmd, time: Date.now(), data })
emitCmd('turn/start', { turn: 1 })
const cmdStream = listeners.get('llm/stream')(
  { provider: 'x', model: 'y', sessionId: 'session-cmd', messages: [] },
  async function* generate() { yield { type: 'text-delta', text: '不该被记录' } },
)
for await (const _chunk of cmdStream) { /* drain */ }
emitCmd('turn/end', { turn: 1, reason: { kind: 'completed' } })
await sleep(600)
const cmdTurn = await readFile(join(OUTPUT, 'session-cmd', 'turn-01.md'), 'utf8')
assert.doesNotMatch(cmdTurn, /⚡ 内存 \|/, 'no in-memory rows after the switch is off')
assert.match(cmdTurn, /本轮没有捕获到模型调用/, 'the empty section explains itself')

// ---- auto-disable: a finished turn writes disabled: true into the profile --
await sleep(300)
const patched = await readFile(join(PROFILE_DIR, 'cordis.patch.yml'), 'utf8')
assert.match(patched, /disabled: true/, 'turn/end disables the row in the profile patch')
assert.doesNotMatch(patched, /disabled: false/, 'the old value is replaced')

// ---- idle mode waits, and a new turn cancels the countdown ----------------
const listeners3 = new Map()
const ctx3 = {
  on: (event, listener) => { listeners3.set(event, listener); return () => listeners3.delete(event) },
  effect: (factory) => factory(),
  get: () => undefined,
}
apply(ctx3, { outputDir: join(import.meta.dirname, 'out-idle'), autoDisable: 'idle', idleMinutes: 0.002, autoDisableStateFile: join(import.meta.dirname, 'out-idle', 'auto-disable.json') })
const session3 = { id: 'session-idle', header: { createdAt: Date.now(), cwd: OUTPUT } }
let seq3 = 0
const emit3 = (type, data) => listeners3.get('session/event')(session3, { type, seq: ++seq3, time: Date.now(), data })
emit3('turn/start', { turn: 1 })
emit3('turn/end', { turn: 1, reason: { kind: 'completed' } })
await sleep(40)
emit3('turn/start', { turn: 2 })
await writeFile(join(PROFILE_DIR, 'cordis.patch.yml'),
  '- id: architecture-trace\n  name: "dsh-architecture-trace"\n  disabled: false\n', 'utf8')
await sleep(320)
assert.match(await readFile(join(PROFILE_DIR, 'cordis.patch.yml'), 'utf8'), /disabled: false/,
  'a new turn cancels the idle countdown')
emit3('turn/end', { turn: 2, reason: { kind: 'completed' } })
await sleep(500)
assert.match(await readFile(join(PROFILE_DIR, 'cordis.patch.yml'), 'utf8'), /disabled: true/,
  'an idle turn countdown fires and disables the row')

console.log('trace.test: sections, layers, model switch, full summaries, durable-only mode and the realtime switch verified')

const idx = turn.indexOf('## 1 · 模型轨道')
console.log(turn.slice(idx, idx + 700))
