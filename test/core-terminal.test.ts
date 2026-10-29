import { expect, test } from 'bun:test'
import { terminalBridge } from '../server/core/terminal.ts'
import type { CoreSource } from '../server/core/source.ts'

function setup() {
  const agent = { launch: 'one' }, term = { address: 'box/t1', pid: 123, state: 'live' }
  const input: string[] = [], calls: string[] = [], sent: unknown[] = []
  let closed = 0, detach = 0, current = agent
  const source = { agents: { get: () => current, terminal: () => term }, core: {
    attach: async (_terminal: string, sink: { data(bytes: Buffer): void }, cols: number, rows: number) => {
      calls.push(`attach ${cols} ${rows}`); sink.data(Buffer.from('screen'))
      return { input: (bytes: Uint8Array) => input.push(Buffer.from(bytes).toString()), resize: (c: number, r: number) => calls.push(`resize ${c} ${r}`), close: () => { detach++ } }
    }, call: async (method: string) => { calls.push(method) },
  } } as unknown as CoreSource
  const bridge = terminalBridge(source, 'TASK-1/Agent', { send: data => sent.push(data), close: () => { closed++ }, buffered: () => 0 })
  const send = (message: object) => bridge.message(JSON.stringify(message))
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  return { bridge, send, settle, input, calls, sent, replace: () => { current = { launch: 'two' } }, closed: () => closed, detach: () => detach }
}

test('terminal socket attaches, sends once, resizes and drains on close', async () => {
  const x = setup()
  x.send({ type: 'open', id: 1, cols: 80, rows: 24 }); await x.settle()
  expect(x.calls).toEqual(['attach 80 24'])
  expect(Buffer.from(x.sent[0] as Uint8Array).toString()).toBe('screen')
  x.send({ type: 'text', id: 2, text: 'hello' }); await x.settle()
  x.send({ type: 'resize', id: 3, cols: 90, rows: 30 }); await x.settle()
  expect(x.input).toEqual(['hello']); expect(x.calls).toContain('resize 90 30')
  x.send({ type: 'text', id: 2, text: 'hello' }); await x.settle()
  expect(x.input).toEqual(['hello']); expect(x.closed()).toBe(1)
  expect(x.detach()).toBe(1)
})

test('a replaced launch cannot receive old browser input', async () => {
  const x = setup()
  x.send({ type: 'open', id: 1, cols: 80, rows: 24 }); await x.settle()
  x.replace(); x.send({ type: 'text', id: 2, text: 'do something' }); await x.settle()
  expect(x.input).toEqual([]); expect(x.closed()).toBe(1)
})

test('oversized input and invalid sizes close rather than buffering', async () => {
  const a = setup(); a.send({ type: 'open', id: 1, cols: 0, rows: 24 }); await a.settle()
  expect(a.calls).toEqual([]); expect(a.closed()).toBe(1)
  const b = setup(); b.send({ type: 'text', id: 1, text: 'x'.repeat(33_000) }); await b.settle()
  expect(b.input).toEqual([]); expect(b.closed()).toBe(1)
})
