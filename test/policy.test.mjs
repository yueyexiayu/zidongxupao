import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_CONFIG,
  MAX_TIMER_DELAY_MS,
  RETRYABLE_FAILURE_CODES,
  classifyFailure,
  filterAllowsSession,
  formatResumeText,
  isSubagentSession,
  pickDelayMs,
  resolveConfig,
} from '../lib/policy.js'
import { FakeLlmError, createLlmModule } from './helpers.mjs'

test('defaults match the runtime retry taxonomy and conservative global limits', () => {
  const runtime = createLlmModule().resolveRetryPolicy()
  const config = resolveConfig({}, runtime.retryableCodes)
  assert.deepEqual(config.retryableCodes, ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
  assert.equal(config.maxConsecutive, 3)
  assert.equal(config.maxConsecutiveAfterToolCalls, 0)
  assert.equal(config.maxActive, 1)
  assert.equal(config.maxProviderDelayMs, 15 * 60_000)
  assert.equal(config.applyToSubagents, true)
  assert.equal(config.honorProviderRetryAfter, true)
  assert.equal(config.resumeGoals, true)
  assert.equal(Object.isFrozen(config), true)
})

test('retryable codes come from the runtime unless explicitly configured', () => {
  assert.deepEqual(resolveConfig({}, ['STREAM_CLOSED']).retryableCodes, ['STREAM_CLOSED'])
  assert.deepEqual(resolveConfig({ retryableCodes: ['RATE_LIMIT'] }, ['SERVER']).retryableCodes, ['RATE_LIMIT'])
  assert.deepEqual(DEFAULT_CONFIG.includeSessionIds, [])
  assert.deepEqual(RETRYABLE_FAILURE_CODES, ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'])
})

test('malformed configuration fails closed', () => {
  assert.throws(() => resolveConfig({ unknownKey: 1 }), /unknown config key/)
  assert.throws(() => resolveConfig({ minDelayMs: -1 }), /non-negative/)
  assert.throws(() => resolveConfig({ minDelayMs: MAX_TIMER_DELAY_MS + 1 }), /must not exceed/)
  assert.throws(() => resolveConfig({ minDelayMs: 60_000, maxDelayMs: 30_000 }), /greater than or equal/)
  assert.throws(() => resolveConfig({ maxConsecutive: 0 }), /greater than or equal to 1/)
  assert.throws(() => resolveConfig({ maxConsecutiveAfterToolCalls: -1 }), /greater than or equal to 0/)
  assert.throws(() => resolveConfig({ maxActive: 0 }), /greater than or equal to 1/)
  assert.throws(() => resolveConfig({ maxProviderDelayMs: MAX_TIMER_DELAY_MS + 1 }), /must not exceed/)
  assert.throws(() => resolveConfig({ enabled: 'yes' }), /boolean/)
  assert.throws(() => resolveConfig({ retryableCodes: [] }), /must not be empty/)
  assert.throws(() => resolveConfig({ excludeSessionIds: [1] }), /non-empty strings/)
})

test('session filters and subagent policy are explicit', () => {
  const config = resolveConfig({ includeSessionIds: ['a', 'a'], excludeSessionIds: ['b'] })
  assert.deepEqual(config.includeSessionIds, ['a'])
  assert.equal(filterAllowsSession(config, 'a'), true)
  assert.equal(filterAllowsSession(config, 'b'), false)
  assert.equal(filterAllowsSession(config, 'c'), false)
  assert.equal(isSubagentSession({ header: { origin: 'subagent' } }), true)
  assert.equal(isSubagentSession({ header: { origin: 'root' } }), false)
})

test('classification preserves provider Retry-After and supports custom codes', () => {
  const retry = classifyFailure(
    new FakeLlmError('busy', 'RATE_LIMIT', { providerRetryAfterMs: 7_500 }),
    FakeLlmError,
  )
  assert.deepEqual(retry, { trigger: true, code: 'RATE_LIMIT', providerRetryAfterMs: 7_500 })
  assert.deepEqual(
    classifyFailure(new FakeLlmError('closed', 'STREAM_CLOSED'), FakeLlmError, ['STREAM_CLOSED']),
    { trigger: true, code: 'STREAM_CLOSED' },
  )
  assert.equal(classifyFailure(new FakeLlmError('quota', 'QUOTA'), FakeLlmError).trigger, false)
  assert.equal(classifyFailure(Object.assign(new Error('fake'), { code: 'RATE_LIMIT' }), FakeLlmError).trigger, false)
})

test('provider Retry-After becomes the lower bound without exceeding Node timer safety', () => {
  const config = resolveConfig({ minDelayMs: 30_000, maxDelayMs: 60_000 })
  assert.equal(pickDelayMs(config, () => 0, 90_000), 90_000)
  assert.equal(pickDelayMs(config, () => 0.999999999, 45_000), 60_000)
  assert.equal(pickDelayMs({ ...config, honorProviderRetryAfter: false }, () => 0, 90_000), 30_000)
  assert.equal(MAX_TIMER_DELAY_MS, 2_147_483_647)
})

test('the resume text is bounded, labelled, and excludes failure details', () => {
  const text = formatResumeText({ attempt: 2, maxAttempts: 3, failureCode: 'RATE_LIMIT', waitedMs: 42_400 })
  assert.match(text, /【自动续跑·第2次\/上限3】/)
  assert.match(text, /已等待 42 秒/)
  assert.doesNotMatch(text, /SECRET|token=/)
})
