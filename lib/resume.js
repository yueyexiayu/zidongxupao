/**
 * Timer, global-capacity, and agent interaction for automatic resume.
 *
 * A slot is acquired when a timer is armed and retained until the resumed turn
 * or goal round closes. Failed or cancelled attempts release the slot; only a
 * successfully delivered attempt consumes the per-agent budget.
 *
 * @module zidongxupao/resume
 */

import {
  MAX_TIMER_DELAY_MS,
  classifyFailure,
  filterAllowsSession,
  formatResumeText,
  isSubagentSession,
  pickDelayMs,
} from './policy.js'

const HUMAN_SOURCE_KINDS = new Set(['user', 'retry'])
const GOAL_START_WATCHDOG_MS = 15_000

/**
 * One scheduled resume.
 * @typedef {object} PendingResume
 * @property {unknown} timer
 * @property {number} delayMs
 * @property {number} scheduledAt
 * @property {number} attempt
 * @property {number} maxAttempts
 * @property {string} failureCode
 * @property {number | undefined} providerRetryAfterMs
 * @property {boolean} hadToolCalls
 */

/**
 * One eligible failure waiting for scheduling or delivery.
 * @typedef {object} ResumeCandidate
 * @property {string} failureCode
 * @property {number | undefined} providerRetryAfterMs
 * @property {boolean} hadToolCalls
 * @property {{ id: any, revision: number } | undefined} goalRef
 */

/** @typedef {object} AgentState
 * @property {any} agent
 * @property {any} session
 * @property {number} consecutive
 * @property {PendingResume | undefined} pending
 * @property {PendingResume | undefined} queuedResume
 * @property {ResumeCandidate | undefined} candidate
 * @property {unknown} watchdog
 * @property {boolean} queued
 * @property {boolean} holdingSlot
 * @property {boolean} activeAutoTurn
 * @property {boolean} disposed
 * @property {boolean} gaveUp
 * @property {string} lastFailureCode
 * @property {string | undefined} lastBlockedReason
 * @property {number} lastAttempt
 */

/**
 * @typedef {object} ResumeDeps
 * @property {any} ctx
 * @property {{ LlmError: Function, createUserMessage: Function }} llm
 * @property {import('./policy.js').ResumeConfig} config
 * @property {(handler: () => void, delayMs: number) => unknown} setTimeout
 * @property {(timer: unknown) => void} clearTimeout
 * @property {() => number} random
 * @property {() => number} now
 */

/** @param {unknown} value */
function describe(value) {
  const text = value instanceof Error ? value.message : String(value)
  return text.replaceAll(/\s+/g, ' ').slice(0, 200)
}

/** @param {any} agent */
function agentLabel(agent) {
  const id = typeof agent?.id === 'string' ? agent.id : 'unknown'
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}

/** @param {any} agent @param {number} turn @returns {boolean | undefined} */
function turnHadToolCalls(agent, turn) {
  if (typeof agent?.session?.snapshotEvents !== 'function') return undefined
  try {
    const events = agent.session.snapshotEvents()
    if (!Array.isArray(events)) return undefined
    return events.some(event =>
      event?.type === 'tool/call' && event.data?.turn === turn)
  } catch {
    return undefined
  }
}

/**
 * @param {ResumeDeps} deps
 */
export function createAutoResume(deps) {
  const { ctx, llm, config } = deps
  /** @type {Map<any, AgentState>} */
  const states = new Map()
  /** @type {WeakMap<any, AgentState>} */
  const sessionStates = new WeakMap()
  /** @type {WeakSet<any>} */
  const disposedSessions = new WeakSet()
  /** @type {AgentState[]} */
  const waiting = []
  let activeSlots = 0
  let disposed = false

  /** @param {'info' | 'warn' | 'debug'} level @param {string} message */
  function log(level, message) {
    const logger = ctx?.logger
    const write = logger?.[level]
    if (typeof write === 'function') write.call(logger, `zidongxupao: ${message}`)
  }

  /** @param {any} agent @returns {AgentState | undefined} */
  function ensureState(agent) {
    if (disposed || agent === null || typeof agent !== 'object') return undefined
    const existing = states.get(agent)
    if (existing !== undefined) return existing
    /** @type {AgentState} */
    const state = {
      agent,
      session: agent.session,
      consecutive: 0,
      pending: undefined,
      queuedResume: undefined,
      candidate: undefined,
      watchdog: undefined,
      queued: false,
      holdingSlot: false,
      activeAutoTurn: false,
      disposed: false,
      gaveUp: false,
      lastFailureCode: '',
      lastBlockedReason: undefined,
      lastAttempt: 0,
    }
    states.set(agent, state)
    if (state.session !== null && typeof state.session === 'object') sessionStates.set(state.session, state)
    return state
  }

  /** @param {AgentState} state */
  function sessionAllows(state) {
    const session = state.session
    if (!config.applyToSubagents && isSubagentSession(session)) return false
    if (typeof session?.id === 'string' && !filterAllowsSession(config, session.id)) return false
    return true
  }

  /** @param {any} agent */
  function goalsFor(agent) {
    const scoped = agent?.ctx
    if (scoped !== null && typeof scoped === 'object' && typeof scoped.get === 'function') {
      const goals = scoped.get('goals')
      if (goals !== undefined) return goals
    }
    if (typeof ctx?.get === 'function') return ctx.get('goals')
    return undefined
  }

  /**
   * Distinguish a confirmed absent goal from a failed goal lookup.
   * @param {any} agent
   * @returns {{ kind: 'absent' } | { kind: 'error' } | { kind: 'present', view: any }}
   */
  function goalSnapshot(agent) {
    let goals
    try {
      goals = goalsFor(agent)
    } catch {
      return { kind: 'error' }
    }
    if (goals === undefined || typeof goals.get !== 'function') return { kind: 'absent' }
    let view
    try {
      view = goals.get(agent)
    } catch {
      return { kind: 'error' }
    }
    return view === undefined || view === null ? { kind: 'absent' } : { kind: 'present', view }
  }

  /** @param {AgentState} state */
  function hasQueuedHuman(state) {
    const inbox = state.agent?.inbox
    if (inbox === null || typeof inbox !== 'object') return false
    const nextTurn = Array.isArray(inbox.nextTurn) ? inbox.nextTurn : []
    const nextStep = Array.isArray(inbox.nextStep) ? inbox.nextStep : []
    return [...nextTurn, ...nextStep].some(message => HUMAN_SOURCE_KINDS.has(message?.source?.kind))
  }

  /** @param {AgentState} state */
  function cancellationReason(state) {
    if (disposed || state.disposed) return 'disposed'
    const session = state.session
    if (session !== null && typeof session === 'object' && disposedSessions.has(session)) return 'session-disposed'
    if (state.agent?.status !== 'idle') return 'agent-not-idle'
    if (hasQueuedHuman(state)) return 'queued-human-message'
    const goal = goalSnapshot(state.agent)
    if (goal.kind === 'error') return 'goal-unavailable'
    const expected = state.candidate?.goalRef
    if (goal.kind === 'present' && goal.view.phase === 'active') {
      if (goal.view.activation === 'armed') return 'goal-armed'
      if (expected?.id !== goal.view.id || expected?.revision !== goal.view.revision) return 'goal-changed'
      return undefined
    }
    if (expected !== undefined) return 'goal-changed'
    return undefined
  }

  /** @param {AgentState} state */
  function clearWatchdog(state) {
    if (state.watchdog === undefined) return
    deps.clearTimeout(state.watchdog)
    state.watchdog = undefined
  }

  /** @param {AgentState} state */
  function holdSlot(state) {
    if (state.holdingSlot) return
    state.holdingSlot = true
    activeSlots += 1
  }

  /** @param {AgentState} state */
  function releaseSlot(state) {
    if (!state.holdingSlot) return
    state.holdingSlot = false
    activeSlots = Math.max(0, activeSlots - 1)
    pump()
  }

  /** @param {AgentState} state */
  function removeFromQueue(state) {
    state.queued = false
    const index = waiting.indexOf(state)
    if (index >= 0) waiting.splice(index, 1)
  }

  /**
   * @param {AgentState} state
   * @param {string} reason
   * @param {boolean} [record]
   */
  function cancelPending(state, reason, record = true) {
    const pending = state.pending
    let cancelled = false
    if (pending !== undefined) {
      state.pending = undefined
      deps.clearTimeout(pending.timer)
      log('info', `agent ${agentLabel(state.agent)}: cancelled resume attempt ${pending.attempt} (${reason})`)
      cancelled = true
    }
    if (state.queued) {
      removeFromQueue(state)
      state.queuedResume = undefined
      log('info', `agent ${agentLabel(state.agent)}: removed queued resume (${reason})`)
      cancelled = true
    }
    if (record && cancelled) state.lastBlockedReason = reason
  }

  /** @param {AgentState} state */
  function clearCandidate(state) {
    state.candidate = undefined
  }

  /** @param {AgentState} state */
  function releaseActiveTurn(state) {
    clearWatchdog(state)
    if (!state.activeAutoTurn) return
    state.activeAutoTurn = false
    releaseSlot(state)
  }

  /** @param {AgentState} state @param {ResumeCandidate} candidate */
  function armCandidate(state, candidate) {
    const providerDelayMs = config.honorProviderRetryAfter ? candidate.providerRetryAfterMs : undefined
    if (providerDelayMs !== undefined && providerDelayMs > config.maxProviderDelayMs) {
      state.lastBlockedReason = 'provider-delay-too-long'
      clearCandidate(state)
      log('warn', `agent ${agentLabel(state.agent)}: provider asked for ${providerDelayMs}ms, above the ${config.maxProviderDelayMs}ms limit; automatic resume is disabled for this failure`)
      return
    }
    const delayMs = pickDelayMs(config, deps.random, candidate.providerRetryAfterMs)
    if (delayMs > MAX_TIMER_DELAY_MS) {
      state.lastBlockedReason = 'provider-delay-too-long'
      clearCandidate(state)
      log('warn', `agent ${agentLabel(state.agent)}: delay ${delayMs}ms exceeds Node's timer limit; automatic resume is disabled for this failure`)
      return
    }
    const maxAttempts = Math.min(
      config.maxConsecutive,
      candidate.hadToolCalls ? config.maxConsecutiveAfterToolCalls : config.maxConsecutive,
    )
    if (state.consecutive >= maxAttempts) {
      state.gaveUp = true
      state.lastBlockedReason = candidate.hadToolCalls ? 'tool-call-attempt-limit' : 'attempt-limit'
      clearCandidate(state)
      log('warn', `agent ${agentLabel(state.agent)}: reached the ${maxAttempts}-attempt limit (${candidate.failureCode}); giving up automatic resume`)
      return
    }
    /** @type {PendingResume} */
    const pending = {
      timer: undefined,
      delayMs,
      scheduledAt: deps.now(),
      attempt: state.consecutive + 1,
      maxAttempts,
      failureCode: candidate.failureCode,
      providerRetryAfterMs: candidate.providerRetryAfterMs,
      hadToolCalls: candidate.hadToolCalls,
    }
    state.pending = pending
    try {
      pending.timer = deps.setTimeout(() => fire(state), delayMs)
    } catch (error) {
      state.pending = undefined
      state.lastBlockedReason = 'timer-failed'
      clearCandidate(state)
      log('warn', `agent ${agentLabel(state.agent)}: could not arm resume timer: ${describe(error)}`)
      return
    }
    state.lastBlockedReason = undefined
    log('info', `agent ${agentLabel(state.agent)}: ${candidate.failureCode} failure; resume attempt ${pending.attempt}/${maxAttempts} armed in ${Math.round(delayMs / 1000)}s`)
  }

  /** @param {AgentState} state @param {PendingResume} pending @param {ResumeCandidate} candidate */
  function deliverReady(state, pending, candidate) {
    holdSlot(state)
    const goalResult = deliverGoal(state, candidate)
    if (goalResult === 'delivered') return
    if (goalResult !== 'not-goal') {
      state.lastBlockedReason = goalResult
      log('info', `agent ${agentLabel(state.agent)}: automatic goal resume skipped (${goalResult})`)
      clearCandidate(state)
      releaseSlot(state)
      return
    }
    if (!deliverPrompt(state, pending)) {
      clearCandidate(state)
      releaseSlot(state)
    }
  }

  /** Deliver due candidates when a global active-turn slot is available. */
  function pump() {
    if (disposed) return
    while (activeSlots < config.maxActive && waiting.length > 0) {
      const state = /** @type {AgentState} */ (waiting.shift())
      state.queued = false
      const pending = state.queuedResume
      state.queuedResume = undefined
      if (pending === undefined || !state.candidate || state.disposed) {
        clearCandidate(state)
        continue
      }
      const reason = cancellationReason(state)
      if (reason !== undefined) {
        state.lastBlockedReason = reason
        clearCandidate(state)
        log('info', `agent ${agentLabel(state.agent)}: cancelled queued resume attempt ${pending.attempt} (${reason})`)
        continue
      }
      deliverReady(state, pending, state.candidate)
    }
  }

  /**
   * @param {AgentState} state
   * @param {ResumeCandidate} candidate
   * @returns {'not-goal' | 'delivered' | string}
   */
  function deliverGoal(state, candidate) {
    if (!config.resumeGoals || candidate.goalRef === undefined) return 'not-goal'
    const goals = goalsFor(state.agent)
    if (goals === undefined || typeof goals.get !== 'function' || typeof goals.resume !== 'function') {
      return 'goal-unavailable'
    }
    let view
    try {
      view = goals.get(state.agent)
    } catch {
      return 'goal-unavailable'
    }
    if (view === undefined || view.id !== candidate.goalRef.id || view.revision !== candidate.goalRef.revision) {
      return 'goal-changed'
    }
    if (view.phase !== 'active') return 'goal-not-active'
    if (view.activation === 'armed') return 'goal-armed'
    if (view.roundsStarted >= view.maxGoalRounds) return 'goal-exhausted'
    state.activeAutoTurn = true
    try {
      goals.resume(state.agent, { id: view.id, revision: view.revision })
    } catch (error) {
      state.activeAutoTurn = false
      return `goal-resume-failed:${describe(error)}`
    }
    state.consecutive += 1
    state.lastAttempt = state.consecutive
    clearCandidate(state)
    state.lastBlockedReason = undefined
    if (state.agent?.status === 'running') {
      clearWatchdog(state)
    } else {
      state.watchdog = deps.setTimeout(() => {
        state.watchdog = undefined
        if (!state.activeAutoTurn) return
        if (state.agent?.status === 'running') return
        log('warn', `agent ${agentLabel(state.agent)}: goal resume did not start a turn; releasing its slot`)
        state.lastBlockedReason = 'goal-start-timeout'
        releaseActiveTurn(state)
      }, GOAL_START_WATCHDOG_MS)
    }
    log('info', `agent ${agentLabel(state.agent)}: resumed goal ${String(view.id)} attempt ${state.consecutive}`)
    return 'delivered'
  }

  /** @param {AgentState} state @param {PendingResume} pending */
  function deliverPrompt(state, pending) {
    const waitedMs = Math.max(0, deps.now() - pending.scheduledAt)
    const text = formatResumeText({
      attempt: pending.attempt,
      maxAttempts: pending.maxAttempts,
      failureCode: pending.failureCode,
      waitedMs,
    })
    let message
    try {
      message = llm.createUserMessage({
        content: [{ type: 'text', text }],
        // The public continuation projection requires admitted human work. A
        // labelled user turn keeps the native Continue control available after
        // this automatic attempt fails, while the prompt text remains explicit.
        source: { kind: 'user' },
      })
    } catch (error) {
      state.lastBlockedReason = 'message-build-failed'
      log('warn', `agent ${agentLabel(state.agent)}: could not build resume prompt: ${describe(error)}`)
      return false
    }
    state.activeAutoTurn = true
    try {
      state.agent.followup(message)
    } catch (error) {
      state.activeAutoTurn = false
      state.lastBlockedReason = 'followup-failed'
      log('warn', `agent ${agentLabel(state.agent)}: could not queue resume prompt: ${describe(error)}`)
      return false
    }
    state.consecutive += 1
    state.lastAttempt = state.consecutive
    state.lastBlockedReason = undefined
    clearCandidate(state)
    log('info', `agent ${agentLabel(state.agent)}: queued resume attempt ${pending.attempt}/${pending.maxAttempts} after ${Math.round(waitedMs / 1000)}s (${pending.failureCode})`)
    return true
  }

  /** @param {AgentState} state */
  function fire(state) {
    const pending = state.pending
    if (pending === undefined) return
    state.pending = undefined
    const reason = cancellationReason(state)
    if (reason !== undefined) {
      state.lastBlockedReason = reason
      log('info', `agent ${agentLabel(state.agent)}: cancelled resume attempt ${pending.attempt} (${reason})`)
      clearCandidate(state)
      return
    }
    const candidate = state.candidate
    if (candidate === undefined) {
      state.lastBlockedReason = 'candidate-missing'
      return
    }
    if (activeSlots >= config.maxActive) {
      state.queued = true
      state.queuedResume = pending
      waiting.push(state)
      log('info', `agent ${agentLabel(state.agent)}: resume attempt ${pending.attempt} is waiting for a global active slot`)
      return
    }
    deliverReady(state, pending, candidate)
  }

  /**
   * @param {AgentState} state
   * @param {ResumeCandidate} candidate
   */
  function enqueue(state, candidate) {
    if (state.pending !== undefined || state.queued || state.activeAutoTurn) {
      log('warn', `agent ${agentLabel(state.agent)}: another resume is already active; keeping it`)
      return
    }
    state.candidate = candidate
    state.queued = false
    state.gaveUp = false
    state.lastBlockedReason = undefined
    armCandidate(state, candidate)
  }

  /** @param {{ agent: any, turn: number, error: unknown }} payload */
  function onError(payload) {
    if (!config.enabled || disposed) return
    const { agent, turn, error } = payload
    const state = ensureState(agent)
    if (state === undefined) return
    if (state.activeAutoTurn) releaseActiveTurn(state)
    const { trigger, code, providerRetryAfterMs } = classifyFailure(error, llm.LlmError, config.retryableCodes)
    state.lastFailureCode = code
    if (!trigger) {
      state.consecutive = 0
      state.gaveUp = false
      state.lastBlockedReason = undefined
      cancelPending(state, 'non-retryable-failure', false)
      log('debug', `agent ${agentLabel(agent)}: ${code} is not auto-resumable; no timer armed`)
      return
    }
    if (!sessionAllows(state)) {
      state.consecutive = 0
      clearCandidate(state)
      log('debug', `agent ${agentLabel(agent)}: session filtered; no timer armed`)
      return
    }
    const goal = goalSnapshot(agent)
    if (goal.kind === 'error') {
      state.lastBlockedReason = 'goal-unavailable'
      clearCandidate(state)
      log('warn', `agent ${agentLabel(agent)}: could not read Goal state; automatic resume is disabled for this failure`)
      return
    }
    const goalRef = goal.kind === 'present' && goal.view.phase === 'active'
      ? { id: goal.view.id, revision: goal.view.revision }
      : undefined
    const hadToolCalls = turnHadToolCalls(agent, turn)
    if (hadToolCalls === undefined) {
      state.lastBlockedReason = 'tool-state-unavailable'
      clearCandidate(state)
      log('warn', `agent ${agentLabel(agent)}: could not read tool-call history; automatic resume is disabled for this failure`)
      return
    }
    const maxAttempts = Math.min(
      config.maxConsecutive,
      hadToolCalls ? config.maxConsecutiveAfterToolCalls : config.maxConsecutive,
    )
    if (state.consecutive >= maxAttempts) {
      state.gaveUp = true
      state.lastBlockedReason = hadToolCalls ? 'tool-call-attempt-limit' : 'attempt-limit'
      log('warn', `agent ${agentLabel(agent)}: reached the ${maxAttempts}-attempt limit (${code}); giving up automatic resume`)
      return
    }
    enqueue(state, { failureCode: code, providerRetryAfterMs, hadToolCalls, goalRef })
  }

  /** @param {any} session @param {any} event */
  function onSessionEvent(session, event) {
    if (disposed || event?.type !== 'turn/end') return
    const state = sessionStates.get(session)
    if (state === undefined) return
    clearWatchdog(state)
    if (event.data?.reason?.kind === 'error') {
      if (state.activeAutoTurn) releaseActiveTurn(state)
      return
    }
    releaseActiveTurn(state)
    state.consecutive = 0
    state.gaveUp = false
    state.lastFailureCode = ''
    state.lastAttempt = 0
    state.lastBlockedReason = undefined
    clearCandidate(state)
    cancelPending(state, 'turn-ended', false)
  }

  /** @param {any} agent @param {string} status */
  function onStatus(agent, status) {
    if (disposed || status !== 'running') return
    const state = states.get(agent)
    if (state === undefined) return
    if (state.activeAutoTurn) {
      clearWatchdog(state)
      return
    }
    if (state.pending !== undefined || state.queued) cancelPending(state, 'new-turn-started')
    state.consecutive = 0
    state.gaveUp = false
    state.lastFailureCode = ''
    state.lastAttempt = 0
    state.lastBlockedReason = undefined
    clearCandidate(state)
  }

  /** @param {any} agent @param {any} message */
  function onInboxInserted(agent, message) {
    if (disposed || !HUMAN_SOURCE_KINDS.has(message?.source?.kind)) return
    const state = states.get(agent)
    if (state === undefined || state.activeAutoTurn) return
    cancelPending(state, 'human-input-queued')
    clearCandidate(state)
  }

  /** @param {any} session */
  function onSessionDisposed(session) {
    if (disposed) return
    if (session !== null && typeof session === 'object') disposedSessions.add(session)
    const state = sessionStates.get(session)
    if (state === undefined) return
    state.disposed = true
    clearWatchdog(state)
    cancelPending(state, 'session-disposed')
    releaseActiveTurn(state)
  }

  /** @param {any} agent */
  function onAgentDisposed(agent) {
    const state = states.get(agent)
    if (state === undefined) return
    state.disposed = true
    clearWatchdog(state)
    cancelPending(state, 'agent-disposed')
    releaseActiveTurn(state)
    states.delete(agent)
  }

  /** @param {any} agent */
  function track(agent) {
    const state = ensureState(agent)
    if (state !== undefined && !sessionAllows(state)) {
      state.disposed = true
      states.delete(agent)
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const state of states.values()) {
      state.disposed = true
      clearWatchdog(state)
      const pending = state.pending
      if (pending !== undefined) {
        state.pending = undefined
        deps.clearTimeout(pending.timer)
      }
      state.queuedResume = undefined
    }
    const count = states.size
    states.clear()
    waiting.length = 0
    activeSlots = 0
    log('info', `disposed; cleared pending resume state for ${count} agent(s)`)
  }

  /** @param {any} state */
  function publicStatus(state) {
    const pending = state?.pending
    const queuedResume = state?.queuedResume
    const activeResume = pending ?? queuedResume
    const candidate = state?.candidate
    const maxAttempts = activeResume?.maxAttempts ?? Math.min(
      config.maxConsecutive,
      candidate?.hadToolCalls ? config.maxConsecutiveAfterToolCalls : config.maxConsecutive,
    )
    const phase = pending !== undefined
      ? 'waiting'
      : state?.queued
        ? 'queued'
        : state?.activeAutoTurn
          ? 'running'
          : 'idle'
    return {
      phase,
      attempt: activeResume?.attempt ?? Math.min(state?.consecutive + 1 || 1, config.maxConsecutive),
      delivered: state?.consecutive ?? 0,
      maxAttempts,
      failureCode: activeResume?.failureCode ?? state?.lastFailureCode ?? '',
      delayMs: pending?.delayMs,
      remainingMs: pending === undefined ? undefined : Math.max(0, pending.scheduledAt + pending.delayMs - deps.now()),
      hadToolCalls: activeResume?.hadToolCalls ?? state?.candidate?.hadToolCalls ?? false,
      gaveUp: state?.gaveUp ?? false,
      blockedReason: state?.lastBlockedReason,
    }
  }

  /** @param {string} sessionId */
  function statusForSession(sessionId) {
    for (const state of states.values()) {
      if (state.disposed) continue
      if (state.session?.id === sessionId) return publicStatus(state)
    }
    return publicStatus(undefined)
  }

  /** @param {string} sessionId */
  function cancelForSession(sessionId) {
    for (const state of states.values()) {
      if (state.disposed) continue
      if (state.session?.id !== sessionId) continue
      if (state.pending === undefined && !state.queued) return false
      cancelPending(state, 'user-cancelled')
      clearCandidate(state)
      return true
    }
    return false
  }

  return {
    track,
    onError,
    onStatus,
    onInboxInserted,
    onSessionEvent,
    onSessionDisposed,
    onAgentDisposed,
    dispose,
    statusForSession,
    cancelForSession,
    pendingCount() {
      let count = 0
      for (const state of states.values()) if (state.pending !== undefined) count += 1
      return count
    },
    queuedCount() {
      return waiting.length
    },
    activeCount() {
      return activeSlots
    },
    consecutiveOf(agent) {
      return states.get(agent)?.consecutive
    },
  }
}
