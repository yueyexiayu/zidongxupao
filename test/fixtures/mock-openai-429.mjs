import http from 'node:http'

const port = Number(process.env.ZXP_E2E_PORT || 48731)
const counters = new Map()

function textOfMessage(message) {
  if (!Array.isArray(message?.content)) return String(message?.content || '')
  return message.content.map(block => block?.type === 'text' ? block.text : '').join('\n')
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify(body))
}

function success(response, model) {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const id = `chatcmpl-zxp-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)
  response.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content: 'E2E 自动续跑成功' }, finish_reason: null }],
  })}\n\n`)
  response.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  })}\n\n`)
  response.end('data: [DONE]\n\n')
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    return json(response, 200, {
      data: [
        { id: 'zxp-auto', object: 'model' },
        { id: 'zxp-cancel', object: 'model' },
        { id: 'zxp-fallback', object: 'model' },
      ],
    })
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    return json(response, 404, { error: { message: 'not found' } })
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return json(response, 400, { error: { message: 'invalid json' } })
  }
  const model = String(body?.model || '')
  const agentRequest = Array.isArray(body?.tools)
  const count = agentRequest ? (counters.get(model) || 0) + 1 : 0
  if (agentRequest) counters.set(model, count)
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const promptTail = messages.slice(-4).map(message => ({
    role: message?.role,
    text: textOfMessage(message).slice(0, 220),
  }))
  console.log(JSON.stringify({ time: Date.now(), model, agentRequest, count, promptTail }))

  if (!agentRequest) return success(response, model || 'zxp-helper')
  if (model === 'zxp-cancel') {
    return json(response, 429, {
      error: { message: 'controlled rate limit', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
    }, { 'retry-after': '1' })
  }
  if (model === 'zxp-auto' && count === 1) {
    return json(response, 429, {
      error: { message: 'controlled rate limit', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
    }, { 'retry-after': '1' })
  }
  if (model === 'zxp-fallback' && count <= 2) {
    return json(response, 429, {
      error: { message: 'controlled rate limit', type: 'rate_limit_error', code: 'rate_limit_exceeded' },
    }, { 'retry-after': '1' })
  }
  return success(response, model)
})

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ ready: true, port }))
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
