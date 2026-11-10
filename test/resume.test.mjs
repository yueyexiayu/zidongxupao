import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig } from '../lib/policy.js'
import { createAutoResume } from '../lib/resume.js'
import { FakeLlmError, createAgent, createClock, createFakeContext, createLlmModule } from './helpers.mjs'

function build({ config, random, services = {} } = {}) {
  const clock = createClock(random)
  const context = createFakeContext({ services })
  const resumer = createAutoResume({
    ctx: context.ctx,
    llm: createLlmModule(),
    config: resolveConfig(config),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random: clock.random,
    now: clock.now,
  })
  return { clock, ...context, resumer }
}

function turnEnd(ctx, resumer, agent, turn, reason = { kind: 'completed' }) {
  const event = { type: 'turn/end', data: { turn, reason } }
  ctx.emit('session/event', agent.session, event)
  resumer.onSessionEvent(agent.session, event)
}

test('one failure arms one prompt and consumes the attempt only after delivery', () => {
  const { clock, resumer } = build({ random: () => 0 })
  const agent = createAgent()
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  assert.equal(resumer.pendingCount(), 1)
  assert.equal(resumer.activeCount(), 0, 'a pending delay does not consume a global active slot')
  assert.equal(resumer.consecutiveOf(agent), 0)
  clock.advance(29_999)
  assert.equal(agent.calls.length, 0)
  clock.advance(1)
  assert.equal(agent.calls.length, 1)
  assert.equal(resumer.activeCount(), 1)
  assert.equal(resumer.consecutiveOf(agent), 1)
  assert.equal(agent.calls[0].source.kind, 'user', 'native continuation admission must remain available')
  assert.equal(agent.calls[0].source.autoResume, undefined)
  assert.match(agent.calls[0].content[0].text, /第1次\/上限3/)
})

test('a cancelled timer does not burn the attempt budget', () => {
  const { clock, resumer } = build({ random: () => 0 })
  const agent = createAgent()
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  resumer.onInboxInserted(agent, { source: { kind: 'user' } })
  assert.equal(resumer.pendingCount(), 0)
  assert.equal(resumer.consecutiveOf(agent), 0)
  resumer.onError({ agent, turn: 2, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  clock.advance(30_000)
  assert.equal(agent.calls[0].content[0].text.includes('第1次'), true)
})

test('provider Retry-After lengthens the next wait', () => {
  const { clock, resumer } = build({ random: () => 0, config: { minDelayMs: 10, maxDelayMs: 20 } })
  const agent = createAgent()
  resumer.onError({
    agent,
    turn: 1,
    error: new FakeLlmError('slow down', 'RATE_LIMIT', { providerRetryAfterMs: 90 }),
  })
  clock.advance(89)
  assert.equal(agent.calls.length, 0)
  clock.advance(1)
  assert.equal(agent.calls.length, 1)
  assert.match(agent.calls[0].content[0].text, /已等待 0 秒/)
})

test('global active limit queues other agents until the first resumed turn closes', () => {
  const { clock, ctx, resumer } = build({ random: () => 0, config: { minDelayMs: 10, maxDelayMs: 10, maxActive: 1 } })
  const first = createAgent({ id: 'agent-first' })
  const second = createAgent({ id: 'agent-second' })
  resumer.onError({ agent: first, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  resumer.onError({ agent: second, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  assert.equal(resumer.pendingCount(), 2)
  assert.equal(resumer.queuedCount(), 0)
  clock.advance(10)
  assert.equal(resumer.pendingCount(), 0)
  assert.equal(resumer.queuedCount(), 1)
  assert.equal(first.calls.length, 1)
  assert.equal(second.calls.length, 0, 'the first resumed turn retains the global slot')
  turnEnd(ctx, resumer, first, 2)
  assert.equal(resumer.queuedCount(), 0)
  assert.equal(resumer.pendingCount(), 0)
  assert.equal(second.calls.length, 1)
})

test('cancelling a queued session removes it without consuming or blocking the queue', () => {
  const { clock, ctx, resumer } = build({ random: () => 0, config: { minDelayMs: 10, maxDelayMs: 10, maxActive: 1 } })
  const first = createAgent({ id: 'agent-first' })
  const second = createAgent({ id: 'agent-second' })
  const third = createAgent({ id: 'agent-third' })
  for (const agent of [first, second, third]) {
    resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  }
  clock.advance(10)
  assert.equal(resumer.queuedCount(), 2)
  assert.equal(resumer.cancelForSession(second.session.id), true)
  turnEnd(ctx, resumer, first, 2)
  assert.equal(second.calls.length, 0)
  assert.equal(third.calls.length, 1)
})

test('tool-assisted turns are not resumed by default', () => {
  const { clock, resumer } = build({ random: () => 0, config: { minDelayMs: 10, maxDelayMs: 10 } })
  const agent = createAgent()
  agent.session.snapshotEvents = () => [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'x', name: 'bash', arguments: '{}' } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'tool/call', data: { turn: 2, step: 1, callId: 'y', name: 'bash', arguments: '{}' } },
  ]
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  clock.advance(10)
  assert.equal(agent.calls.length, 0)
  assert.equal(resumer.statusForSession(agent.session.id).blockedReason, 'tool-call-attempt-limit')
})

test('an explicit tool-assisted budget allows the configured number of resumes', () => {
  const { clock, resumer } = build({
    random: () => 0,
    config: { minDelayMs: 10, maxDelayMs: 10, maxConsecutiveAfterToolCalls: 1 },
  })
  const agent = createAgent()
  agent.session.snapshotEvents = () => [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'x', name: 'bash', arguments: '{}' } },
    { type: 'turn/start', data: { turn: 2 } },
    { type: 'tool/call', data: { turn: 2, step: 1, callId: 'y', name: 'bash', arguments: '{}' } },
  ]
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  clock.advance(10)
  assert.equal(agent.calls.length, 1)
  resumer.onError({ agent, turn: 2, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  assert.equal(resumer.pendingCount(), 0)
  assert.equal(resumer.statusForSession(agent.session.id).blockedReason, 'tool-call-attempt-limit')
})

test('subagents can be excluded without a session-id allowlist', () => {
  const { clock, resumer } = build({ config: { minDelayMs: 10, maxDelayMs: 10, applyToSubagents: false } })
  const agent = createAgent({ origin: 'subagent' })
  resumer.track(agent)
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  clock.advance(10)
  assert.equal(agent.calls.length, 0)
  assert.equal(resumer.statusForSession(agent.session.id).phase, 'idle')
})

test('an armed goal owns continuation and prevents the plugin from racing it', () => {
  const goals = {
    get: () => ({ id: 'goal-1', revision: 3, phase: 'active', activation: 'armed', roundsStarted: 0, maxGoalRounds: 4 }),
    resume: () => { throw new Error('must not resume an armed goal') },
  }
  const { clock, resumer } = build({ config: { minDelayMs: 10, maxDelayMs: 10 }, services: { goals } })
  const agent = createAgent()
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  clock.advance(10)
  assert.equal(agent.calls.length, 0)
  assert.equal(resumer.statusForSession(agent.session.id).blockedReason, 'goal-armed')
})

test('a goal lookup failure stops instead of falling back to a user prompt', () => {
  let reads = 0
  const goals = {
    get: () => {
      reads += 1
      if (reads === 1) {
        return { id: 'goal-1', revision: 3, phase: 'active', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 4 }
      }
      throw new Error('goal unavailable')
    },
    resume: () => {},
  }
  const { clock, resumer } = build({ config: { minDelayMs: 10, maxDelayMs: 10 }, services: { goals } })
  const agent = createAgent()
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  clock.advance(10)
  assert.equal(agent.calls.length, 0)
  assert.equal(resumer.statusForSession(agent.session.id).blockedReason, 'goal-unavailable')
})

test('a failed goal resumes through GoalService instead of injecting a user prompt', () => {
  const calls = []
  const goals = {
    get: () => ({ id: 'goal-1', revision: 3, phase: 'active', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 4 }),
    resume(agent, ref) { calls.push({ agent, ref }) },
  }
  const { clock, resumer } = build({ config: { minDelayMs: 10, maxDelayMs: 10 }, services: { goals } })
  const agent = createAgent()
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  clock.advance(10)
  assert.equal(agent.calls.length, 0)
  assert.deepEqual(calls.map(call => call.ref), [{ id: 'goal-1', revision: 3 }])
  assert.equal(resumer.consecutiveOf(agent), 1)
})

test('a goal lookup failure during failure capture does not fall back to a user prompt', () => {
  const goals = {
    get: () => { throw new Error('goal unavailable') },
    resume: () => {},
  }
  const { clock, resumer } = build({ config: { minDelayMs: 10, maxDelayMs: 10 }, services: { goals } })
  const agent = createAgent()
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  clock.advance(10)
  assert.equal(resumer.pendingCount(), 0)
  assert.equal(agent.calls.length, 0)
  assert.equal(resumer.statusForSession(agent.session.id).blockedReason, 'goal-unavailable')
})

test('a goal lookup failure before delivery does not fall back to a user prompt', () => {
  let reads = 0
  const goals = {
    get: () => {
      reads += 1
      if (reads === 1) return undefined
      throw new Error('goal unavailable')
    },
    resume: () => {},
  }
  const { clock, resumer } = build({ config: { minDelayMs: 10, maxDelayMs: 10 }, services: { goals } })
  const agent = createAgent()
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  clock.advance(10)
  assert.equal(agent.calls.length, 0)
  assert.equal(resumer.statusForSession(agent.session.id).blockedReason, 'goal-unavailable')
})

test('a goal that appears after capture does not fall back to a user prompt', () => {
  let reads = 0
  const goals = {
    get: () => {
      reads += 1
      return reads === 1
        ? undefined
        : { id: 'goal-new', revision: 1, phase: 'active', activation: 'disarmed', roundsStarted: 0, maxGoalRounds: 4 }
    },
    resume: () => {},
  }
  const { clock, resumer } = build({ config: { minDelayMs: 10, maxDelayMs: 10 }, services: { goals } })
  const agent = createAgent()
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  clock.advance(10)
  assert.equal(agent.calls.length, 0)
  assert.equal(resumer.statusForSession(agent.session.id).blockedReason, 'goal-changed')
})

test('a bound goal disappearing before delivery does not fall back to a user prompt', () => {
  let reads = 0
  const goals = {
    get: () => {
      reads += 1
      return reads === 1
        ? { id: 'goal-1', revision: 3, phase: 'active', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 4 }
        : undefined
    },
    resume: () => {},
  }
  const { clock, resumer } = build({ config: { minDelayMs: 10, maxDelayMs: 10 }, services: { goals } })
  const agent = createAgent()
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  clock.advance(10)
  assert.equal(agent.calls.length, 0)
  assert.equal(resumer.statusForSession(agent.session.id).blockedReason, 'goal-changed')
})

test('an unreadable tool-call history fails closed', () => {
  const { clock, resumer } = build({ random: () => 0, config: { minDelayMs: 10, maxDelayMs: 10 } })
  const agent = createAgent()
  agent.session.snapshotEvents = () => { throw new Error('event store unavailable') }
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  clock.advance(10)
  assert.equal(resumer.pendingCount(), 0)
  assert.equal(agent.calls.length, 0)
  assert.equal(resumer.statusForSession(agent.session.id).blockedReason, 'tool-state-unavailable')
})

test('a later error from the automatic turn releases its slot and arms the next attempt', () => {
  const { clock, resumer } = build({ random: () => 0, config: { minDelayMs: 10, maxDelayMs: 10 } })
  const agent = createAgent()
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  clock.advance(10)
  assert.equal(agent.calls.length, 1)
  resumer.onError({ agent, turn: 2, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  assert.equal(resumer.pendingCount(), 1)
  clock.advance(10)
  assert.equal(agent.calls.length, 2)
  assert.match(agent.calls[1].content[0].text, /第2次\/上限3/)
})

test('human input and new turns cancel pending or queued work without spending an attempt', () => {
  const { clock, resumer } = build({ random: () => 0 })
  const agent = createAgent()
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  resumer.onStatus(agent, 'running')
  assert.equal(resumer.pendingCount(), 0)
  assert.equal(resumer.consecutiveOf(agent), 0)
  clock.advance(60_000)
  assert.equal(agent.calls.length, 0)
})

test('a manual turn start clears an exhausted automatic-resume budget', () => {
  const { clock, resumer } = build({ random: () => 0, config: { minDelayMs: 10, maxDelayMs: 10, maxConsecutive: 1 } })
  const agent = createAgent()
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  clock.advance(10)
  resumer.onError({ agent, turn: 2, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  assert.equal(resumer.statusForSession(agent.session.id).gaveUp, true)

  resumer.onStatus(agent, 'running')
  assert.equal(resumer.statusForSession(agent.session.id).gaveUp, false)
  assert.equal(resumer.statusForSession(agent.session.id).blockedReason, undefined)
  resumer.onError({ agent, turn: 3, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  assert.equal(resumer.pendingCount(), 1)
})

test('non-retryable failures reset a prior retryable streak', () => {
  const { clock, resumer } = build({ random: () => 0 })
  const agent = createAgent()
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  clock.advance(30_000)
  resumer.onError({ agent, turn: 2, error: new FakeLlmError('quota', 'QUOTA') })
  assert.equal(resumer.consecutiveOf(agent), 0)
  resumer.onError({ agent, turn: 3, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  clock.advance(30_000)
  assert.match(agent.calls[1].content[0].text, /第1次\/上限3/)
})

test('status and user cancellation target one session', () => {
  const { clock, resumer } = build({ random: () => 0 })
  const agent = createAgent({ id: 'agent-status' })
  resumer.onError({ agent, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  const status = resumer.statusForSession(agent.session.id)
  assert.equal(status.phase, 'waiting')
  assert.equal(status.attempt, 1)
  assert.equal(resumer.cancelForSession(agent.session.id), true)
  assert.equal(resumer.statusForSession(agent.session.id).blockedReason, 'user-cancelled')
  clock.advance(60_000)
  assert.equal(agent.calls.length, 0)
})

test('a provider wait beyond the timer limit stops this failure', () => {
  const { clock, resumer } = build({ config: { minDelayMs: 10, maxDelayMs: 10 } })
  const agent = createAgent()
  resumer.onError({
    agent,
    turn: 1,
    error: new FakeLlmError('wait', 'RATE_LIMIT', { providerRetryAfterMs: 2_147_483_648 }),
  })
  clock.advance(2_200_000_000)
  assert.equal(agent.calls.length, 0)
  assert.equal(resumer.statusForSession(agent.session.id).blockedReason, 'provider-delay-too-long')
})

test('dispose clears timers, queue state, and active slots', () => {
  const { clock, resumer } = build({ random: () => 0, config: { maxActive: 2 } })
  const first = createAgent({ id: 'first' })
  const second = createAgent({ id: 'second' })
  resumer.onError({ agent: first, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  resumer.onError({ agent: second, turn: 1, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  resumer.dispose()
  assert.equal(resumer.pendingCount(), 0)
  assert.equal(resumer.queuedCount(), 0)
  assert.equal(resumer.activeCount(), 0)
  clock.advance(60_000)
  assert.equal(first.calls.length + second.calls.length, 0)
})
