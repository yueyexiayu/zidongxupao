/**
 * Test doubles for the auto-resume plugin: a fake LlmError/module, a fake
 * Cordis context with the effect/on lifecycle the plugin uses, a fake agent,
 * and a deterministic clock. No DSH package is imported here on purpose.
 */

/** Minimal stand-in for the runtime's LlmError (same observable fields). */
export class FakeLlmError extends Error {
  /**
   * @param {string} message - human-readable failure summary.
   * @param {string} code - stable failure code.
   * @param {{ status?: number, providerRetryAfterMs?: number }} [options] - optional provider facts.
   */
  constructor(message, code, options = {}) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.failure = {
      message,
      code,
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs }),
    }
  }
}

let messageSeq = 0

/** Build the fake `@deepseek-ai/dsh-llm` surface the plugin consumes. */
export function createLlmModule() {
  return {
    LlmError: FakeLlmError,
    resolveRetryPolicy() {
      return { retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'] }
    },
    /**
     * @param {{ content: unknown[], source: object }} input - message input.
     * @returns {object} a frozen-ish user message shaped like the runtime's.
     */
    createUserMessage({ content, source }) {
      messageSeq += 1
      return { id: `message-${messageSeq}`, role: 'user', content, source }
    },
  }
}

/**
 * Deterministic timer/clock pair; advancing runs due handlers in deadline order.
 * @param {() => number} [random] - injected random source (defaults to 0).
 */
export function createClock(random = () => 0) {
  let now = 0
  let nextId = 0
  /** @type {Map<number, { at: number, delayMs: number, handler: () => void }>} */
  const timers = new Map()
  return {
    now: () => now,
    /**
     * @param {() => void} handler - timer callback.
     * @param {number} delayMs - delay in milliseconds.
     * @returns {number} timer id.
     */
    setTimeout(handler, delayMs) {
      nextId += 1
      timers.set(nextId, { at: now + delayMs, delayMs, handler })
      return nextId
    },
    /** @param {number} id - timer id. */
    clearTimeout(id) {
      timers.delete(id)
    },
    random,
    /** @param {number} ms - milliseconds to advance. */
    advance(ms) {
      now += ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at)
        if (due.length === 0) return
        for (const [id, timer] of due) {
          if (!timers.has(id)) continue
          timers.delete(id)
          timer.handler()
        }
      }
    },
    pending: () => timers.size,
    armedDelays: () => [...timers.values()].map(timer => timer.delayMs),
  }
}

/**
 * Build a fake agent whose followup records messages.
 * @param {{ id?: string, status?: string, origin?: string }} [options] - identity/status overrides.
 */
export function createAgent({ id = 'agent-1', status = 'idle', origin = 'root' } = {}) {
  /** @type {any[]} */
  const calls = []
  const agent = {
    id,
    session: {
      id,
      header: { origin },
      snapshotEvents: () => [],
    },
    status,
    inbox: { nextTurn: [], nextStep: [] },
    /** @param {any} message - queued message. */
    followup(message) {
      calls.push(message)
    },
    calls,
  }
  return agent
}

/**
 * Build a fake Host context with the exact lifecycle surface the plugin uses:
 * `on` (disposer-returning), generator-aware `effect`, `get`, `logger`, `loader`.
 * @param {{ modules?: Record<string, unknown>, services?: Record<string, unknown> }} [options] - fake registries.
 */
export function createFakeContext({ modules = {}, services = {} } = {}) {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map()
  /** @type {Function[]} */
  const disposers = []
  const routes = []
  /** @type {{ info: string[], warn: string[], debug: string[], error: string[] }} */
  const logs = { info: [], warn: [], debug: [], error: [] }

  const ctx = {
    loader: {
      /** @param {string} specifier - module specifier. */
      async import(specifier) {
        if (!(specifier in modules)) throw new Error(`unexpected module import: ${specifier}`)
        return modules[specifier]
      },
    },
    /**
     * @param {string} name - event name.
     * @param {Function} callback - listener.
     */
    on(name, callback) {
      let set = listeners.get(name)
      if (set === undefined) {
        set = new Set()
        listeners.set(name, set)
      }
      set.add(callback)
      /** @returns {void} */
      const off = () => {
        listeners.get(name)?.delete(callback)
      }
      disposers.push(off)
      return off
    },
    /**
     * Execute an effect body; generator bodies run to completion and every
     * yielded or returned disposer joins the plugin teardown list.
     * @param {() => any} body - effect body.
     */
    effect(body) {
      const result = body()
      /** @param {unknown} value - candidate disposer. */
      const collect = value => {
        if (typeof value === 'function') disposers.push(/** @type {Function} */ (value))
      }
      if (result !== null && typeof result === 'object' && typeof result[Symbol.iterator] === 'function') {
        for (const value of result) collect(value)
      } else {
        collect(result)
      }
    },
    /** @param {string} name - service name. */
    get(name) {
      return services[name]
    },
    connection: {
      fetch: {
        register(route) {
          routes.push(route)
        },
      },
    },
    logger: {
      /** @param {string} message - log line. */
      info(message) { logs.info.push(message) },
      /** @param {string} message - log line. */
      warn(message) { logs.warn.push(message) },
      /** @param {string} message - log line. */
      debug(message) { logs.debug.push(message) },
      /** @param {string} message - log line. */
      error(message) { logs.error.push(message) },
    },
    /**
     * Fire one registered event.
     * @param {string} name - event name.
     * @param {...unknown} args - event arguments.
     */
    emit(name, ...args) {
      for (const callback of [...(listeners.get(name) ?? [])]) callback(...args)
    },
    /** Simulate plugin unload. */
    dispose() {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        if (dispose !== undefined) dispose()
      }
      listeners.clear()
    },
  }
  return {
    ctx,
    logs,
    services,
    routes,
    /** @param {string} path */
    route(path) {
      return routes.find(route => route.path === path)
    },
    /** @param {string} name - event name. */
    listenerCount: name => listeners.get(name)?.size ?? 0,
  }
}
