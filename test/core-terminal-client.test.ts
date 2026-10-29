import { expect, test } from 'bun:test'
import { connectTerminal, streamInput } from '../plugins/terminal/stream.ts'

test('visible terminal input is bounded and is never buffered while disconnected', () => {
  const originalSocket = globalThis.WebSocket
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
  const statuses: string[] = []
  class Socket {
    static OPEN = 1
    static made: Socket[] = []
    readyState = 0
    bufferedAmount = 0
    binaryType = ''
    sent: string[] = []
    onopen?: () => void
    onclose?: () => void
    onerror?: () => void
    onmessage?: (event: { data: string | ArrayBuffer }) => void
    constructor(readonly url: URL) { Socket.made.push(this) }
    send(data: string) { this.sent.push(data) }
    close() { this.readyState = 3; this.onclose?.() }
  }
  globalThis.WebSocket = Socket as unknown as typeof WebSocket
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { href: 'https://private.ts.net/shepherdr/', protocol: 'https:' } })
  let connection: ReturnType<typeof connectTerminal> | undefined
  try {
    connection = connectTerminal('TASK-1/Agent', () => {}, () => {}, () => ({ cols: 80, rows: 24 }), text => statuses.push(text))
    const socket = Socket.made[0]!
    expect(socket.url.pathname).toBe('/shepherdr/api/terminal')
    expect(socket.url.protocol).toBe('wss:')
    streamInput('TASK-1/Agent', { type: 'text', text: 'offline' })
    expect(socket.sent).toEqual([])
    socket.readyState = 1; socket.onopen?.()
    streamInput('TASK-1/Agent', { type: 'text', text: 'once' })
    expect(socket.sent.map(data => JSON.parse(data).type)).toEqual(['open', 'text'])
    socket.bufferedAmount = 100_000
    streamInput('TASK-1/Agent', { type: 'text', text: 'overflow' })
    expect(socket.sent).toHaveLength(2)
    socket.close()
    streamInput('TASK-1/Agent', { type: 'text', text: 'never replay' })
    expect(socket.sent).toHaveLength(2)
    expect(statuses.some(text => text.includes('may have arrived'))).toBe(true)
  } finally {
    connection?.close(); globalThis.WebSocket = originalSocket
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation)
    else Reflect.deleteProperty(globalThis, 'location')
  }
})
