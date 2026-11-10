import assert from 'node:assert/strict'
import test from 'node:test'

test('the browser entry registers the input status dock', async () => {
  let loaded
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        loaded = definition
      },
    },
  }
  const style = { id: '', textContent: '' }
  const head = { appendChild() {} }
  globalThis.document = {
    getElementById() { return undefined },
    createElement() { return style },
    head,
  }
  try {
    await import(`../client.js?test=${Date.now()}`)
    assert.equal(loaded.id, 'zidongxupao')
    const elements = []
    const react = {
      createElement(type, props, ...children) { const value = { type, props, children }; elements.push(value); return value },
      useState(value) { return [value, () => {}] },
      useEffect() {},
    }
    const client = loaded.factory(specifier => {
      if (specifier === 'react') return react
      throw new Error(`unexpected require: ${specifier}`)
    })
    assert.deepEqual(client.inject, ['slots'])
    const registrations = []
    const effects = []
    const ctx = {
      effect(body) { effects.push(body()) },
      slots: {
        inject(name, factory) { factory() },
        register(definition, component) { registrations.push({ ...definition, component }) },
      },
    }
    client.apply(ctx)
    assert.equal(effects.length, 1)
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].name, 'conversation.input.dock')
    assert.equal(registrations[0].id, 'zidongxupao-status')
    registrations[0].component({ sessionId: 'session-fixture' })
    assert.equal(elements.at(-1).props.sessionId, 'session-fixture')
  } finally {
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
})
