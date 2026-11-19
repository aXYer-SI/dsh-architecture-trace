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
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { FORMAT_GUIDE } from './guide.js'
import { renderIndex, renderTurn } from './render.js'
import { renderPrompts } from './prompts.js'

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
  /**
   * Also write `prompts.md`: the messages actually sent to the model, plus the
   * streamed answer, so the harness's prompt construction can be studied.
   */
  capturePrompts: true,
  /**
   * When to switch this plugin's own row back off.
   *
   * - `idle` (default): a turn ended and no new turn started within
   *   `idleMinutes` — the closest thing to "I finished that task".
   * - `turn`: right after every turn ends.
   * - `session`: only when the session is disposed (deleted, or the app quits),
   *   which never happens while a chat window simply stays open.
   * - `false`: never; you turn it off yourself.
   */
  autoDisable: 'idle',
  /** Minutes of inactivity after a turn before `autoDisable: 'idle'` fires. */
  idleMinutes: 5,
  /** Row id this plugin disables in `autoDisable`. */
  entryId: 'architecture-trace',
  /** Where the pending auto-disable deadline is stored; empty = OS temp dir. */
  autoDisableStateFile: '',
}

const pad = (value, width) => String(value).padStart(width, '0')

/**
 * Where the pending auto-disable deadline lives.
 *
 * The timer itself is in memory, and a plugin reload (HMR, a profile edit)
 * drops it. The deadline is therefore written to a small file in the OS temp
 * directory and restored when the plugin loads again.
 */
const autoDisableStateFile = (options) => options.autoDisableStateFile
  ? resolve(String(options.autoDisableStateFile))
  : join(tmpdir(), 'dsh-architecture-trace-auto-disable.json')

/** A JSON-safe snapshot: the request's message array may be reused later. */
const cloneMessages = (messages) => {
  try {
    return JSON.parse(JSON.stringify(Array.isArray(messages) ? messages : []))
  } catch {
    return []
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const options = { ...DEFAULT_OPTIONS, ...(config ?? {}) }
  // Runtime overrides for /trace-realtime; they last until the plugin reloads,
  // while the row config stays the persisted default.
  const runtime = {
    realtime: Boolean(options.captureRealtime),
    llmCalls: Boolean(options.captureLlmCalls),
    prompts: Boolean(options.capturePrompts),
  }
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

  /**
   * Write the prompt journal. It is a whole-session document and can be large,
   * so it is written when a turn ends and when the session is disposed — not on
   * every debounced flush of the per-turn files.
   */
  const flushPrompts = async (state) => {
    if (!runtime.prompts) return
    try {
      const dir = join(outputDirFor(state), state.sessionId)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'prompts.md'), renderPrompts(state), 'utf8')
    } catch (error) {
      warn('flush prompts failed', error)
    }
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
        clearAutoDisable()
        void clearAutoDisableDue()
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
        void flushPrompts(state)
        scheduleAutoDisable(state)
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
      case 'text-delta': {
        call.textDeltas += 1
        const text = String(chunk.text ?? '')
        call.textChars += text.length
        if (call.response) call.response.text += text
        break
      }
      case 'reasoning-delta': {
        call.reasoningDeltas += 1
        const text = String(chunk.text ?? '')
        call.reasoningChars += text.length
        if (call.response) call.response.reasoning += text
        break
      }
      case 'tool-call-delta': {
        call.toolDeltas += 1
        if (call.response) {
          const slot = Number.isFinite(chunk?.index) ? Number(chunk.index) : 0
          const entry = call.response.toolCalls[slot] ?? { id: chunk?.id, name: chunk?.name, arguments: '' }
          if (!entry.id && chunk?.id) entry.id = chunk.id
          if (!entry.name && chunk?.name) entry.name = chunk.name
          entry.arguments += String(chunk?.argumentsDelta ?? '')
          call.response.toolCalls[slot] = entry
        }
        break
      }
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

  ctx.on('llm/stream', (request, next) => {
    if (!runtime.realtime || !runtime.llmCalls) return next()
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
          prompt: runtime.prompts ? { messages: cloneMessages(messages) } : undefined,
          response: runtime.prompts ? { text: '', reasoning: '', toolCalls: [] } : undefined,
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

  // --------------------------------------------------- ⚡ 状态与请求失败
  ctx.on('agent/status', (payload) => {
      if (!runtime.realtime) return
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
      if (!runtime.realtime) return next()
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

  /**
   * Disable this plugin's own row after the session ends.
   *
   * The plugin manager owns that state and persists it in the profile, so the
   * next launch starts with the plugin off until someone enables it again. A
   * failure here only logs: recording is over either way.
   */
  /** Leave a breadcrumb: an auto-disable that never ran and one that failed look alike. */
  const noteAutoDisable = async (state, text) => {
    try {
      const base = state ? join(outputDirFor(state), state.sessionId) : join(tmpdir(), 'dsh-architecture-trace')
      const dir = base
      await mkdir(dir, { recursive: true })
      await appendFile(join(dir, 'auto-disable.log'), `${new Date().toISOString()} ${text}\n`, 'utf8')
    } catch (error) {
      warn('auto-disable log failed', error)
    }
  }

  /**
   * Disable this plugin by writing `disabled: true` into its profile override.
   *
   * Calling `pluginManager.setPluginEnabled` from inside the plugin fails with
   * "HMR transactions cannot be nested", so the patch layer is edited directly —
   * the same file the manager writes, and the state that survives a restart.
   */
  const disableSelf = async (state) => {
    // `profileContext` is the only in-process source of the profile path;
    // DSH_PROFILE_DIR is set for shell calls, not for the Host process.
    const profile = ctx.get('profileContext')
    const file = profile?.patchPath
      || (profile?.dir ? join(profile.dir, 'cordis.patch.yml') : '')
      || (process.env.DSH_PROFILE_DIR ? join(process.env.DSH_PROFILE_DIR, 'cordis.patch.yml') : '')
    if (!file) {
      await noteAutoDisable(state, 'skipped: no profile context or DSH_PROFILE_DIR')
      return
    }
    try {
      const text = await readFile(file, 'utf8')
      const lines = text.split(/\r?\n/)
      const idLine = new RegExp(`^- id: ${options.entryId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
      let start = -1
      for (let index = 0; index < lines.length; index += 1) {
        if (idLine.test(lines[index])) start = index
      }
      if (start < 0) {
        await noteAutoDisable(state, 'no profile override to edit; the bundle default applies')
        return
      }
      let end = lines.length
      for (let index = start + 1; index < lines.length; index += 1) {
        if (/^-\s/.test(lines[index])) { end = index; break }
      }
      const block = lines.slice(start, end)
      const at = block.findIndex((line) => /^  disabled:/.test(line))
      if (at >= 0) block[at] = '  disabled: true'
      else block.push('  disabled: true')
      lines.splice(start, end - start, ...block)
      await writeFile(file, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8')
      runtime.realtime = false
      runtime.prompts = false
      await noteAutoDisable(state, 'disabled via cordis.patch.yml')
    } catch (error) {
      await noteAutoDisable(state, `failed to edit cordis.patch.yml: ${String(error?.message ?? error)}`)
      warn('auto-disable failed', error)
    }
  }

  let autoDisableTimer = null

  const clearAutoDisable = () => {
    if (autoDisableTimer !== null) {
      clearTimeout(autoDisableTimer)
      autoDisableTimer = null
    }
  }

  /**
   * Arm the auto-disable countdown for one session.
   *
   * `session/disposed` only fires when a session is torn down (deleted, or the
   * app quits), which never happens after a task in a chat window. The end of a
   * turn is the moment the work actually stops, so `idle` waits a grace period
   * from there and a new turn cancels it.
   */
  const writeAutoDisableDue = async (state, dueAt) => {
    try {
      await writeFile(autoDisableStateFile(options), JSON.stringify({
        dueAt,
        sessionId: state?.sessionId ?? '',
        cwd: state?.cwd ?? '',
      }), 'utf8')
    } catch (error) {
      warn('auto-disable deadline not persisted', error)
    }
  }

  const clearAutoDisableDue = async () => {
    try {
      await rm(autoDisableStateFile(options), { force: true })
    } catch { /* nothing to clear */ }
  }

  const armAutoDisable = (state, delay, { flush = true } = {}) => {
    autoDisableTimer = setTimeout(() => {
      autoDisableTimer = null
      void noteAutoDisable(state, 'fired')
      void clearAutoDisableDue()
      if (!flush) {
        void disableSelf(state)
        return
      }
      void flushAll(state).then(() => flushPrompts(state)).finally(() => disableSelf(state))
    }, Math.max(0, delay))
    autoDisableTimer.unref?.()
  }

  const scheduleAutoDisable = (state) => {
    if (options.autoDisable === false || options.autoDisable === 'session') return
    clearAutoDisable()
    if (options.autoDisable === 'turn') {
      void flushAll(state).then(() => flushPrompts(state)).finally(() => disableSelf(state))
      return
    }
    const minutes = Number(options.idleMinutes)
    const delay = (Number.isFinite(minutes) && minutes >= 0 ? minutes : 5) * 60_000
    void writeAutoDisableDue(state, Date.now() + delay)
    void noteAutoDisable(state, `armed: idle ${minutes} min (${delay} ms)`)
    armAutoDisable(state, delay)
  }

  /**
   * Re-arm a deadline written before a reload. Without this, any plugin reload
   * between the turn end and the deadline silently cancels the countdown.
   */
  const restoreAutoDisable = async () => {
    if (options.autoDisable === false || options.autoDisable === 'session') return
    let record
    try {
      const raw = String(await readFile(autoDisableStateFile(options), 'utf8')).replace(/^\\uFEFF/, '')
      record = JSON.parse(raw)
    } catch { return }
    const dueAt = Number(record?.dueAt) || 0
    if (dueAt <= 0) return
    // A pseudo-state carrying only what logging needs: the restored path must
    // not rewrite turn files it no longer holds in memory.
    const state = record.sessionId ? { sessionId: String(record.sessionId), cwd: record.cwd || undefined } : undefined
    clearAutoDisable()
    if (dueAt <= Date.now()) {
      void clearAutoDisableDue()
      void noteAutoDisable(state, 'restored: deadline already passed')
      await disableSelf(state)
      return
    }
    void noteAutoDisable(state, `restored: ${dueAt - Date.now()} ms left`)
    armAutoDisable(state, dueAt - Date.now(), { flush: false })
  }

  const finalize = (session) => {
    try {
      const state = sessions.get(String(session?.id ?? session))
      if (!state) return
      clearAutoDisable()
      const done = Promise.all([
        flushAll(state),
        flushPrompts(state),
      ]).catch((error) => warn('finalize flush failed', error))
      if (options.autoDisable !== false) void done.finally(() => disableSelf(state))
    } catch (error) {
      warn('finalize failed', error)
    }
  }
  ctx.on('agent/disposed', (payload) => {
    if (payload?.agent?.session) finalize(payload.agent.session)
  })
  ctx.on('session/disposed', (session) => finalize(session))

  // ------------------------------------------------------ /trace-realtime
  // The two layers are a per-session choice: `off` keeps only the durable 🗄
  // events (the plugin stops listening to the model stream), `on` restores the
  // ⚡ layer and prompts.md. The row config remains the persisted default.
  const commands = ctx.get('commands')
  if (commands?.register) {
    try {
      commands.register({
        name: 'trace-realtime',
        description: '切换非落盘（⚡ 内存）记录：on = 落盘 + 非落盘，off = 只记落盘',
        input: { hint: 'on | off（留空查看当前状态）' },
        handler: async ({ rawInput }) => {
          const text = String(rawInput ?? '').trim().toLowerCase()
          if (text === '' || text === 'status' || text === '状态') {
            return {
              kind: 'success',
              text: `当前：${runtime.realtime ? '落盘 + 非落盘（⚡ 模型流、状态、请求失败）' : '只记落盘（🗄）'}`
                + `；prompts.md ${runtime.prompts ? '开' : '关'}。`
                + '\n用 `/trace-realtime on` 或 `/trace-realtime off` 切换（本次运行有效，重载插件后回到配置值）。',
            }
          }
          if (['on', '1', 'true', '开启', '开', 'full'].includes(text)) {
            runtime.realtime = true
            runtime.llmCalls = Boolean(options.captureLlmCalls)
            runtime.prompts = Boolean(options.capturePrompts)
            return { kind: 'success', text: '已开启：落盘 + 非落盘（⚡ 模型流、状态、请求失败）与 prompts.md。' }
          }
          if (['off', '0', 'false', '关闭', '关', 'durable'].includes(text)) {
            runtime.realtime = false
            runtime.prompts = false
            return { kind: 'success', text: '已关闭非落盘记录：只保留 🗄 落盘事件，prompts.md 停止生成。新会话生效；当前轮已写入的内容保留。' }
          }
          return { kind: 'error', text: '用法：/trace-realtime on | off（不带参数查看当前状态）' }
        },
      })
    } catch (error) {
      warn('register /trace-realtime failed', error)
    }
  }

  void restoreAutoDisable()

  ctx.effect(() => () => {
    clearAutoDisable()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    sessions.clear()
    guided.clear()
  }, 'architecture-trace: recorders and timers')
}
