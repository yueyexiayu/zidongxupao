import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name, VERSION } from '../lib/index.js'
import { FakeLlmError, createAgent, createClock, createFakeContext, createLlmModule } from './helpers.mjs'

function buildContext() {
  return { clock: createClock(), ...createFakeContext({ modules: { '@deepseek-ai/dsh-llm': createLlmModule() } }) }
}

function mount(context, config) {
  return apply(context.ctx, config, {
    setTimeout: context.clock.setTimeout,
    clearTimeout: context.clock.clearTimeout,
    random: context.clock.random,
    now: context.clock.now,
  })
}

test('host metadata and bundled client are declared', () => {
  assert.equal(name, 'zidongxupao')
  assert.equal(VERSION, '0.2.1')
  assert.deepEqual(inject, ['loader', 'connection'])
})

test('apply wires listeners and registers the status API', async () => {
  const context = buildContext()
  await mount(context, { minDelayMs: 20, maxDelayMs: 20 })
  for (const event of [
    'agent/created',
    'agent/error',
    'agent/status',
    'agent/inbox/inserted',
    'session/event',
    'session/disposed',
    'agent/disposed',
  ]) {
    assert.equal(context.listenerCount(event), 1, event)
  }
  assert.ok(context.route('/api/zidongxupao'))
  assert.ok(context.logs.info.some(line => line.includes('max active 1')))
})

test('the status API reports and cancels a pending resume', async () => {
  const context = buildContext()
  await mount(context, { minDelayMs: 50, maxDelayMs: 50 })
  const agent = createAgent({ id: 'agent-api' })
  context.ctx.emit('agent/error', {
    agent,
    turn: 1,
    step: 0,
    error: new FakeLlmError('busy', 'RATE_LIMIT'),
  })
  const route = context.route('/api/zidongxupao')
  const getResponse = await route.fetch(new Request(`http://localhost/api/zidongxupao?sessionId=${agent.session.id}`))
  const getValue = await getResponse.json()
  assert.equal(getValue.ok, true)
  assert.equal(getValue.status.phase, 'waiting')
  assert.equal(getValue.status.attempt, 1)

  const postResponse = await route.fetch(new Request('http://localhost/api/zidongxupao', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: agent.session.id, action: 'cancel' }),
  }))
  const postValue = await postResponse.json()
  assert.equal(postValue.ok, true)
  assert.equal(postValue.cancelled, true)
  assert.equal(postValue.status.blockedReason, 'user-cancelled')
  context.clock.advance(80)
  assert.equal(agent.calls.length, 0)
})

test('the host timer path delivers a labelled user prompt', async () => {
  const context = buildContext()
  await mount(context, { minDelayMs: 10, maxDelayMs: 10 })
  const agent = createAgent()
  context.ctx.emit('agent/error', {
    agent,
    turn: 1,
    step: 0,
    error: new FakeLlmError('429 busy', 'RATE_LIMIT'),
  })
  context.clock.advance(10)
  assert.equal(agent.calls.length, 1)
  assert.equal(agent.calls[0].source.kind, 'user')
  assert.match(agent.calls[0].content[0].text, /自动续跑/)
})

test('non-retryable failures and filtered sessions produce no followup', async () => {
  const context = buildContext()
  await mount(context, { minDelayMs: 10, maxDelayMs: 10, excludeSessionIds: ['agent-excluded'] })
  const quota = createAgent({ id: 'agent-quota' })
  const excluded = createAgent({ id: 'agent-excluded' })
  context.ctx.emit('agent/error', { agent: quota, turn: 1, step: 0, error: new FakeLlmError('quota', 'QUOTA') })
  context.ctx.emit('agent/error', { agent: excluded, turn: 1, step: 0, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  context.clock.advance(10)
  assert.equal(quota.calls.length, 0)
  assert.equal(excluded.calls.length, 0)
})

test('plugin disposal clears an armed timer and the API route', async () => {
  const context = buildContext()
  await mount(context, { minDelayMs: 30, maxDelayMs: 30 })
  const agent = createAgent()
  context.ctx.emit('agent/error', { agent, turn: 1, step: 0, error: new FakeLlmError('busy', 'RATE_LIMIT') })
  context.ctx.dispose()
  assert.equal(context.listenerCount('agent/error'), 0)
  context.clock.advance(80)
  assert.equal(agent.calls.length, 0)
})

test('disabled configuration registers neither listeners nor API', async () => {
  const context = buildContext()
  await mount(context, { enabled: false })
  assert.equal(context.listenerCount('agent/error'), 0)
  assert.equal(context.routes.length, 0)
})

test('invalid configuration rejects startup', async () => {
  const context = buildContext()
  await assert.rejects(mount(context, { maxConsecutive: 0 }), /greater than or equal to 1/)
  await assert.rejects(mount(context, { bogus: true }), /unknown config key/)
})
