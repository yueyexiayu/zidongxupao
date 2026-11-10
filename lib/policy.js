/**
 * Pure policy for automatic whole-turn resume. Runtime state and timers live in
 * resume.js so every eligibility, timing, and prompt decision remains directly
 * testable.
 *
 * @module zidongxupao/policy
 */

/** Largest delay Node's timer implementation accepts without coercion. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Default transient failures, mirroring the runtime retry policy. */
export const RETRYABLE_FAILURE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/** Default behavior. Tool-assisted turns receive a smaller resume budget. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  minDelayMs: 30_000,
  maxDelayMs: 60_000,
  maxConsecutive: 3,
  maxConsecutiveAfterToolCalls: 0,
  maxActive: 1,
  maxProviderDelayMs: 15 * 60_000,
  applyToSubagents: true,
  honorProviderRetryAfter: true,
  resumeGoals: true,
  includeSessionIds: Object.freeze([]),
  excludeSessionIds: Object.freeze([]),
})

/**
 * Fully resolved configuration.
 * @typedef {object} ResumeConfig
 * @property {boolean} enabled
 * @property {number} minDelayMs
 * @property {number} maxDelayMs
 * @property {number} maxConsecutive
 * @property {number} maxConsecutiveAfterToolCalls
 * @property {number} maxActive
 * @property {number} maxProviderDelayMs
 * @property {boolean} applyToSubagents
 * @property {boolean} honorProviderRetryAfter
 * @property {boolean} resumeGoals
 * @property {readonly string[]} retryableCodes
 * @property {readonly string[]} includeSessionIds
 * @property {readonly string[]} excludeSessionIds
 */

/** @param {string} message */
function configError(message) {
  return Object.assign(new Error(`zidongxupao: ${message}`), { code: 'INVALID_CONFIG' })
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} name
 * @returns {number}
 */
function readDelay(value, fallback, name) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw configError(`${name} must be a non-negative finite number`)
  }
  const delay = Math.floor(value)
  if (delay > MAX_TIMER_DELAY_MS) {
    throw configError(`${name} must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  return delay
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} name
 * @param {number} minimum
 */
function readInteger(value, fallback, name, minimum) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw configError(`${name} must be a safe integer greater than or equal to ${minimum}`)
  }
  return value
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @param {string} name
 */
function readBoolean(value, fallback, name) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw configError(`${name} must be a boolean`)
  return value
}

/**
 * @param {unknown} value
 * @param {string} name
 * @param {readonly string[]} fallback
 * @returns {readonly string[]}
 */
function readStringArray(value, name, fallback) {
  if (value === undefined) return fallback
  if (!Array.isArray(value)) throw configError(`${name} must be an array of non-empty strings`)
  const seen = new Set()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw configError(`${name} entries must be non-empty strings`)
    }
    seen.add(entry)
  }
  return Object.freeze([...seen])
}

/**
 * Validate and normalize plugin configuration.
 * @param {object} [input]
 * @param {readonly string[]} [runtimeRetryableCodes]
 * @returns {ResumeConfig}
 */
export function resolveConfig(input = {}, runtimeRetryableCodes = RETRYABLE_FAILURE_CODES) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw configError('config must be an object')
  }
  const known = new Set([
    'enabled',
    'minDelayMs',
    'maxDelayMs',
    'maxConsecutive',
    'maxConsecutiveAfterToolCalls',
    'maxActive',
    'maxProviderDelayMs',
    'applyToSubagents',
    'honorProviderRetryAfter',
    'resumeGoals',
    'retryableCodes',
    'includeSessionIds',
    'excludeSessionIds',
  ])
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw configError(`unknown config key "${key}"`)
  }
  const minDelayMs = readDelay(input.minDelayMs, DEFAULT_CONFIG.minDelayMs, 'minDelayMs')
  const maxDelayMs = readDelay(input.maxDelayMs, DEFAULT_CONFIG.maxDelayMs, 'maxDelayMs')
  if (maxDelayMs < minDelayMs) throw configError('maxDelayMs must be greater than or equal to minDelayMs')
  const retryableCodes = readStringArray(input.retryableCodes, 'retryableCodes', runtimeRetryableCodes)
  if (retryableCodes.length === 0) throw configError('retryableCodes must not be empty')
  return Object.freeze({
    enabled: readBoolean(input.enabled, DEFAULT_CONFIG.enabled, 'enabled'),
    minDelayMs,
    maxDelayMs,
    maxConsecutive: readInteger(input.maxConsecutive, DEFAULT_CONFIG.maxConsecutive, 'maxConsecutive', 1),
    maxConsecutiveAfterToolCalls: readInteger(
      input.maxConsecutiveAfterToolCalls,
      DEFAULT_CONFIG.maxConsecutiveAfterToolCalls,
      'maxConsecutiveAfterToolCalls',
      0,
    ),
    maxActive: readInteger(input.maxActive, DEFAULT_CONFIG.maxActive, 'maxActive', 1),
    maxProviderDelayMs: readDelay(
      input.maxProviderDelayMs,
      DEFAULT_CONFIG.maxProviderDelayMs,
      'maxProviderDelayMs',
    ),
    applyToSubagents: readBoolean(input.applyToSubagents, DEFAULT_CONFIG.applyToSubagents, 'applyToSubagents'),
    honorProviderRetryAfter: readBoolean(
      input.honorProviderRetryAfter,
      DEFAULT_CONFIG.honorProviderRetryAfter,
      'honorProviderRetryAfter',
    ),
    resumeGoals: readBoolean(input.resumeGoals, DEFAULT_CONFIG.resumeGoals, 'resumeGoals'),
    retryableCodes,
    includeSessionIds: readStringArray(input.includeSessionIds, 'includeSessionIds', Object.freeze([])),
    excludeSessionIds: readStringArray(input.excludeSessionIds, 'excludeSessionIds', Object.freeze([])),
  })
}

/**
 * Classify one failed turn using the runtime's exact LlmError class.
 * @param {unknown} error
 * @param {Function} LlmError
 * @param {readonly string[]} retryableCodes
 * @returns {{ trigger: boolean, code: string, providerRetryAfterMs?: number }}
 */
export function classifyFailure(error, LlmError, retryableCodes = RETRYABLE_FAILURE_CODES) {
  if (typeof LlmError !== 'function' || !(error instanceof LlmError)) {
    return { trigger: false, code: 'UNKNOWN' }
  }
  const llmError = /** @type {{ failure?: { code?: unknown, providerRetryAfterMs?: unknown }, code?: unknown }} */ (error)
  const code = typeof llmError.failure?.code === 'string' && llmError.failure.code.length > 0
    ? llmError.failure.code
    : llmError.code
  if (typeof code !== 'string' || code.length === 0) return { trigger: false, code: 'UNKNOWN' }
  const retryAfter = llmError.failure?.providerRetryAfterMs
  const providerRetryAfterMs = typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.ceil(retryAfter)
    : undefined
  return {
    trigger: retryableCodes.includes(code),
    code,
    ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }),
  }
}

/**
 * Choose a wait. Provider guidance takes precedence when it is longer than the
 * local jittered window and valid for Node's timer.
 * @param {ResumeConfig} config
 * @param {() => number} random
 * @param {number | undefined} providerRetryAfterMs
 * @returns {number}
 */
export function pickDelayMs(config, random, providerRetryAfterMs) {
  const { minDelayMs, maxDelayMs } = config
  let delayMs = minDelayMs
  if (maxDelayMs > minDelayMs) {
    const raw = Number(random())
    const unit = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 0.999999999) : 0
    const span = maxDelayMs - minDelayMs + 1
    delayMs = Math.min(maxDelayMs, minDelayMs + Math.floor(unit * span))
  }
  if (config.honorProviderRetryAfter && providerRetryAfterMs !== undefined) {
    delayMs = Math.max(delayMs, providerRetryAfterMs)
  }
  return delayMs
}

/**
 * @param {ResumeConfig} config
 * @param {string} sessionId
 */
export function filterAllowsSession(config, sessionId) {
  if (config.excludeSessionIds.includes(sessionId)) return false
  return config.includeSessionIds.length === 0 || config.includeSessionIds.includes(sessionId)
}

/** @param {any} session */
export function isSubagentSession(session) {
  return session?.header?.origin === 'subagent'
}

/**
 * @param {object} facts
 * @param {number} facts.attempt
 * @param {number} facts.maxAttempts
 * @param {string} facts.failureCode
 * @param {number} facts.waitedMs
 */
export function formatResumeText({ attempt, maxAttempts, failureCode, waitedMs }) {
  const seconds = Math.max(0, Math.round(waitedMs / 1000))
  return `【自动续跑·第${attempt}次/上限${maxAttempts}】上一回合因上游 ${failureCode} 失败，已等待 ${seconds} 秒。请从中断处继续完成原任务，不要重复已完成的步骤；如无法继续，请直接说明原因。`
}
