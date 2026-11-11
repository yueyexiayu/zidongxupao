/** Host entry for zidongxupao. */

import { resolveConfig } from './policy.js'
import { createAutoResume } from './resume.js'

export const name = 'zidongxupao'
export const VERSION = '0.2.1'
export const inject = ['loader', 'connection']

const API_PATH = '/api/zidongxupao'
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/

/** @param {unknown} body @param {number} [status] */
function json(body, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** @param {any} llm */
function runtimeRetryableCodes(llm) {
  try {
    const policy = llm?.resolveRetryPolicy?.(undefined, 'zidongxupao.runtime-defaults')
    if (Array.isArray(policy?.retryableCodes) && policy.retryableCodes.length > 0) {
      return Object.freeze([...policy.retryableCodes])
    }
  } catch {
    // A runtime that does not expose the resolver still supports the documented
    // default failure taxonomy through policy.js.
  }
  return undefined
}

/**
 * @param {any} ctx
 * @param {object} [config]
 * @param {{
 *   setTimeout?: (handler: () => void, delayMs: number) => unknown,
 *   clearTimeout?: (timer: unknown) => void,
 *   random?: () => number,
 *   now?: () => number,
 * }} [internals]
 */
export async function apply(ctx, config = {}, internals = {}) {
  const preliminary = resolveConfig(config)
  if (!preliminary.enabled) {
    ctx.logger?.info?.('zidongxupao: disabled by configuration; no listeners registered')
    return
  }
  const llm = await ctx.loader.import('@deepseek-ai/dsh-llm')
  const settings = resolveConfig(config, runtimeRetryableCodes(llm) ?? preliminary.retryableCodes)
  const hostTimers = /** @type {{ setTimeout: Function, clearTimeout: Function }} */ (/** @type {unknown} */ (globalThis))
  const setTimeoutFn = internals.setTimeout ?? ((handler, delayMs) => hostTimers.setTimeout(handler, delayMs))
  const clearTimeoutFn = internals.clearTimeout ?? (timer => hostTimers.clearTimeout(timer))
  const resumer = createAutoResume({
    ctx,
    llm,
    config: settings,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    random: internals.random ?? Math.random,
    now: internals.now ?? (() => Date.now()),
  })

  ctx.effect(function* registerAutoResume() {
    ctx.on('agent/created', payload => resumer.track(payload.agent))
    ctx.on('agent/error', payload => resumer.onError(payload))
    ctx.on('agent/status', payload => resumer.onStatus(payload.agent, payload.status))
    ctx.on('agent/inbox/inserted', payload => resumer.onInboxInserted(payload.agent, payload.message))
    ctx.on('session/event', (session, event) => resumer.onSessionEvent(session, event), { global: true })
    ctx.on('session/disposed', session => resumer.onSessionDisposed(session), { global: true })
    ctx.on('agent/disposed', payload => resumer.onAgentDisposed(payload.agent))
    yield () => resumer.dispose()
  }, 'zidongxupao.listeners')

  ctx.connection.fetch.register({
    path: API_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async request => {
      try {
        const url = new URL(request.url)
        if (request.method === 'GET') {
          const sessionId = url.searchParams.get('sessionId') || ''
          if (!SESSION_ID.test(sessionId)) return json({ ok: false, error: 'invalid session id' }, 400)
          return json({ ok: true, status: resumer.statusForSession(sessionId) })
        }
        if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405)
        const text = await request.text()
        if (new TextEncoder().encode(text).byteLength > 4096) return json({ ok: false, error: 'request too large' }, 413)
        let body
        try {
          body = JSON.parse(text)
        } catch {
          return json({ ok: false, error: 'invalid JSON' }, 400)
        }
        const sessionId = body?.sessionId
        if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
          return json({ ok: false, error: 'invalid session id' }, 400)
        }
        if (body?.action !== 'cancel') return json({ ok: false, error: 'unknown action' }, 400)
        const cancelled = resumer.cancelForSession(sessionId)
        return json({ ok: true, cancelled, status: resumer.statusForSession(sessionId) })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return json({ ok: false, error: message.slice(0, 200) }, 400)
      }
    },
  })

  ctx.logger?.info?.(
    `zidongxupao: ready (wait ${settings.minDelayMs}-${settings.maxDelayMs}ms, ` +
    `max ${settings.maxConsecutive}, max active ${settings.maxActive})`,
  )
}
