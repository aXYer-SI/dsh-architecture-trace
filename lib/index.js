/**
 * dsh-architecture-trace — record every DSH task as human-readable Markdown.
 *
 * Two layers are captured:
 *   🗄 落盘 — the durable `session/event` feed (DSH's authoritative log).
 *   ⚡ 内存 — in-process activity that never reaches the log: each model call's
 *            request shape and streamed response (`llm/stream`), agent status
 *            transitions, and model-request failures.
 *
 * The Markdown always labels which layer a line came from.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { FORMAT_GUIDE } from './guide.js'
import { renderIndex, renderTurn } from './render.js'

export const name = 'architecture-trace'

const FLUSH_DELAY_MS = 300
const MAX_CHUNK_SAMPLES = 300

const DEFAULT_OPTIONS = {
  /** Absolute output directory; empty means `<session cwd>/dsh-traces`. */
  outputDir: '',
  /**
   * Record the ⚡ in-memory layer at all: model streams, agent status changes and
   * model request failures. Turn it off to keep only the 🗄 durable layer.
   */
  captureRealtime: true,
  /** Capture every model call and its streamed response (⚡ non-durable). */
  captureLlmCalls: true,
  /** Include the durable per-chunk stream stored in `assistant/message`. */
  includeStream: false,
  /** Include raw event JSON and tool `meta` blobs. */
  includeRaw: false,
  /** Character budget for timeline summaries; 0 keeps the whole text. */
  summaryMaxChars: 0,
}

const pad = (value, width) => String(value).padStart(width, '0')

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const options = { ...DEFAULT_OPTIONS, ...(config ?? {}) }
  /** sessionId -> recorder state */
  const sessions = new Map()
  /** outputDir -> whether the format guide has been written there */
  const guided = new Set()
  const timers = new Map()

  const warn = (message, error) => {
    try {
      console.warn(`[architecture-trace] ${message}`, error ?? '')
    } catch { /* logging must never break the hook */ }
  }

  const outputDirFor = (state) => {
    if (options.outputDir) return resolve(String(options.outputDir))
    const base = state.cwd || process.cwd()
    return join(base, 'dsh-traces')
  }

  const createState = (sessionId, cwd) => ({
    sessionId: String(sessionId),
    createdAt: Date.now(),
    cwd,
    currentTurn: null,
    turns: new Map(),
    dirtyTurns: new Set(),
  })

  const stateOf = (session) => {
    const key = String(session.id)
    let state = sessions.get(key)
    if (!state) {
      state = createState(key, session.header?.cwd)
      sessions.set(key, state)
    }
    if (!state.cwd && session.header?.cwd) state.cwd = session.header.cwd
    return state
  }

  /** State for an id seen only through a non-durable event (no Session object). */
  const stateForId = (sessionId) => {
    const key = String(sessionId ?? '_unbound')
    let state = sessions.get(key)
    if (!state) {
      state = createState(key, undefined)
      sessions.set(key, state)
    }
    return state
  }

  const turnOf = (state, turnNumber) => {
    const number = Number(turnNumber)
    let turn = state.turns.get(number)
    if (!turn) {
      turn = {
        turn: number,
        startedAt: undefined,
        endedAt: undefined,
        lastTime: undefined,
        firstTime: undefined,
        reason: undefined,
        events: [],
        steps: [],
        systemMessages: [],
        userMessages: [],
        assistantMessages: [],
        attempts: [],
        toolCalls: [],
        toolResults: {},
        headers: [],
        contexts: [],
        llmCalls: [],
        others: [],
      }
      state.turns.set(number, turn)
    }
    return turn
  }

  /** Append one ⚡ non-durable entry to both the turn timeline and its own list. */
  const pushRealtime = (state, turn, time, type, data) => {
    const entry = { seq: -1, time, type, data, realtime: true }
    turn.events.push(entry)
    if (turn.firstTime === undefined) turn.firstTime = time
    turn.lastTime = Math.max(turn.lastTime ?? 0, time)
    turn.others.push(entry)
    state.dirtyTurns.add(turn.turn)
  }

  const note = (turn, event) => {
    const data = event.data ?? {}
    switch (event.type) {
      case 'system/message': {
        const text = (data.message?.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
        turn.systemMessages.push({ seq: event.seq, time: event.time, text })
        break
      }
      case 'user/message':
        turn.userMessages.push({ seq: event.seq, time: event.time, blocks: data.content ?? [] })
        break
      case 'assistant/message':
        turn.assistantMessages.push({
          seq: event.seq,
          time: event.time,
          step: data.step,
          blocks: data.message?.content ?? [],
          usage: data.usage,
          interrupted: data.interrupted,
          stream: data.stream ?? [],
        })
        break
      case 'assistant/attempt':
        turn.attempts.push({ seq: event.seq, time: event.time, step: data.step, stream: data.stream ?? [] })
        break
      case 'tool/call':
        turn.toolCalls.push({
          seq: event.seq,
          time: event.time,
          callId: data.callId,
          name: data.name,
          arguments: data.arguments,
        })
        break
      case 'tool/result': {
        const callId = data.message?.toolCallId
        if (callId) {
          turn.toolResults[callId] = {
            seq: event.seq,
            time: event.time,
            content: data.message?.content ?? [],
            isError: Boolean(data.message?.isError),
            error: data.error,
            meta: data.meta,
          }
        }
        break
      }
      case 'request/header':
        turn.headers.push({ seq: event.seq, time: event.time, reason: data.reason, header: data.header })
        break
      case 'request/context':
        turn.contexts.push({ seq: event.seq, time: event.time, context: data })
        break
      case 'step/start':
        turn.steps.push({ step: data.step, startedAt: event.time, endedAt: undefined })
        break
      case 'step/end': {
        const step = turn.steps.find((entry) => entry.step === data.step && entry.endedAt === undefined)
        if (step) step.endedAt = event.time
        break
      }
      default:
        if (event.type !== 'turn/start' && event.type !== 'turn/end') {
          turn.others.push({ seq: event.seq, time: event.time, type: event.type, data, realtime: false })
        }
    }
  }

  const flushTurn = async (state, turn) => {
    const dir = join(outputDirFor(state), state.sessionId)
    await mkdir(dir, { recursive: true })
    if (!guided.has(dir)) {
      guided.add(dir)
      await writeFile(join(outputDirFor(state), '00-格式说明.md'), FORMAT_GUIDE, 'utf8')
    }
    await writeFile(join(dir, `turn-${pad(turn.turn, 2)}.md`), renderTurn(turn, {
      sessionId: state.sessionId,
      sessionCreatedAt: state.createdAt,
      cwd: state.cwd,
      includeStream: options.includeStream,
      includeRaw: options.includeRaw,
      summaryMaxChars: options.summaryMaxChars,
      captureRealtime: options.captureRealtime,
    }), 'utf8')
    state.dirtyTurns.delete(turn.turn)
  }

  const flushAll = async (state) => {
    for (const turnNumber of [...state.dirtyTurns]) {
      const turn = state.turns.get(turnNumber)
      if (turn) await flushTurn(state, turn).catch((error) => warn('flush turn failed', error))
    }
    const dir = join(outputDirFor(state), state.sessionId)
    await mkdir(dir, { recursive: true }).catch(() => {})
    await writeFile(join(dir, 'index.md'), renderIndex(state), 'utf8').catch((error) => warn('flush index failed', error))
  }

  const scheduleFlush = (state) => {
    const key = state.sessionId
    if (timers.has(key)) return
    const timer = setTimeout(() => {
      timers.delete(key)
      void flushAll(state)
    }, FLUSH_DELAY_MS)
    timer.unref?.()
    timers.set(key, timer)
  }

  // ------------------------------------------------------------ 🗄 落盘事件
  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      const state = stateOf(session)
      const data = event.data ?? {}

      if (event.type === 'turn/start') {
        state.currentTurn = Number(data.turn)
        const started = turnOf(state, state.currentTurn)
        started.startedAt = event.time
      }

      const turnNumber = Number.isFinite(Number(data.turn)) ? Number(data.turn) : state.currentTurn
      if (!Number.isFinite(turnNumber)) return
      const turn = turnOf(state, turnNumber)
      if (turn.firstTime === undefined) turn.firstTime = event.time
      turn.lastTime = event.time
      turn.events.push({ seq: event.seq, time: event.time, type: event.type, data, realtime: false })

      if (event.type === 'turn/end') {
        turn.endedAt = event.time
        turn.reason = data.reason
      }

      note(turn, event)
      state.dirtyTurns.add(turnNumber)

      if (event.type === 'turn/end') {
        void flushTurn(state, turn).catch((error) => warn('flush on turn/end failed', error))
      }
      scheduleFlush(state)
    } catch (error) {
      warn('record failed', error)
    }
  })

  // --------------------------------------------------------- ⚡ 模型调用流
  const observeChunk = (call, chunk) => {
    const now = Date.now()
    call.chunkCount += 1
    switch (chunk?.type) {
      case 'text-delta':
        call.textDeltas += 1
        call.textChars += String(chunk.text ?? '').length
        break
      case 'reasoning-delta':
        call.reasoningDeltas += 1
        call.reasoningChars += String(chunk.text ?? '').length
        break
      case 'tool-call-delta':
        call.toolDeltas += 1
        break
      case 'usage':
        call.usage = chunk.usage
        break
      case 'finish':
        call.finishReason = chunk.reason
        break
      default:
        break
    }
    if (call.samples.length < MAX_CHUNK_SAMPLES) {
      const chars = Number(String(chunk?.text ?? '').length + String(chunk?.argumentsDelta ?? '').length)
      call.samples.push({ t: now, type: String(chunk?.type ?? '?'), chars })
    } else {
      call.samplesTruncated = true
    }
  }

  if (options.captureRealtime && options.captureLlmCalls) {
    ctx.on('llm/stream', (request, next) => {
      let call = null
      let state = null
      let turn = null
      try {
        const sessionId = request?.sessionId
        state = stateForId(sessionId ?? '_unbound')
        turn = turnOf(state, state.currentTurn ?? 0)
        const messages = Array.isArray(request?.messages) ? request.messages : []
        let chars = 0
        for (const message of messages) {
          for (const block of message?.content ?? []) {
            if (typeof block?.text === 'string') chars += block.text.length
          }
        }
        call = {
          provider: String(request?.provider ?? '?'),
          model: String(request?.model ?? '?'),
          reasoningEffort: request?.reasoningEffort,
          maxTokens: request?.maxTokens,
          sessionBound: Boolean(sessionId),
          startedAt: Date.now(),
          firstChunkAt: undefined,
          endedAt: undefined,
          messageCount: messages.length,
          messageChars: chars,
          toolCount: Array.isArray(request?.tools) ? request.tools.length : 0,
          chunkCount: 0,
          textDeltas: 0,
          reasoningDeltas: 0,
          toolDeltas: 0,
          textChars: 0,
          reasoningChars: 0,
          usage: undefined,
          finishReason: undefined,
          error: undefined,
          samples: [],
          samplesTruncated: false,
        }
        turn.llmCalls.push(call)
        pushRealtime(state, turn, call.startedAt, 'llm/call', {
          provider: call.provider,
          model: call.model,
          messageCount: call.messageCount,
          toolCount: call.toolCount,
          sessionId: sessionId ?? null,
        })
      } catch (error) {
        warn('llm/stream pre-record failed', error)
      }

      const source = next()
      return (async function* iterate() {
        try {
          for await (const chunk of source) {
            if (call) {
              try {
                if (!call.firstChunkAt) {
                  call.firstChunkAt = Date.now()
                  pushRealtime(state, turn, call.firstChunkAt, 'llm/first-chunk', { ttft: `${call.firstChunkAt - call.startedAt}ms` })
                }
                observeChunk(call, chunk)
              } catch (error) {
                warn('llm/stream chunk record failed', error)
              }
            }
            yield chunk
          }
          if (call) {
            call.endedAt = Date.now()
            pushRealtime(state, turn, call.endedAt, 'llm/finish', {
              finishReason: call.finishReason ?? 'end',
              usage: call.usage ?? null,
              chunks: call.chunkCount,
            })
            scheduleFlush(state)
          }
        } catch (error) {
          if (call) {
            call.endedAt = Date.now()
            call.error = String(error?.message ?? error)
            pushRealtime(state, turn, call.endedAt, 'llm/finish', { error: call.error })
            scheduleFlush(state)
          }
          throw error
        }
      })()
    })
  }

  // --------------------------------------------------- ⚡ 状态与请求失败
  if (options.captureRealtime) {
    ctx.on('agent/status', (payload) => {
      try {
        const sessionId = payload?.agent?.session?.id ?? payload?.agent?.sessionId ?? payload?.agent?.id
        if (!sessionId) return
        const state = stateForId(sessionId)
        const turn = turnOf(state, state.currentTurn ?? 0)
        pushRealtime(state, turn, Date.now(), 'agent/status', { status: payload?.status })
        scheduleFlush(state)
      } catch (error) {
        warn('agent/status record failed', error)
      }
    })

    ctx.on('agent/request-error', (payload, next) => {
      try {
        const sessionId = payload?.agent?.session?.id ?? payload?.agent?.sessionId ?? payload?.agent?.id
        if (sessionId) {
          const state = stateForId(sessionId)
          const turn = turnOf(state, Number.isFinite(Number(payload?.turn)) ? Number(payload.turn) : (state.currentTurn ?? 0))
          const failure = payload?.failure
          pushRealtime(state, turn, Date.now(), 'agent/request-error', {
            provider: payload?.provider,
            message: failure?.message ?? failure?.code ?? String(failure ?? ''),
          })
          scheduleFlush(state)
        }
      } catch (error) {
        warn('agent/request-error record failed', error)
      }
      return next()
    })
  }

  const finalize = (session) => {
    try {
      const state = sessions.get(String(session?.id ?? session))
      if (state) void flushAll(state)
    } catch (error) {
      warn('finalize failed', error)
    }
  }
  ctx.on('agent/disposed', (payload) => {
    if (payload?.agent?.session) finalize(payload.agent.session)
  })
  ctx.on('session/disposed', (session) => finalize(session))

  ctx.effect(() => () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    sessions.clear()
    guided.clear()
  }, 'architecture-trace: recorders and timers')
}
