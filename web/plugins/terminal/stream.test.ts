// fork: Ctrl+D closes the terminal. The page's side of the stream: an `exited` from the service closes it for good (no
// reconnect, which would start a fresh shell) and calls `exited`; a socket that only closes reconnects as before.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { connectTerminal } from './stream.ts'

class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  bufferedAmount = 0
  binaryType = ''
  sent: any[] = []
  onopen?: () => void
  onmessage?: (e: { data: unknown }) => void
  onclose?: () => void
  onerror?: () => void
  constructor(public url: URL) { FakeSocket.all.push(this) }
  open() { this.readyState = 1; this.onopen?.() }
  say(m: object) { this.onmessage?.({ data: JSON.stringify(m) }) }
  send(d: string) { this.sent.push(JSON.parse(d)) }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.() }
}

const saved = { WebSocket: globalThis.WebSocket, location: (globalThis as any).location }
beforeEach(() => {
  FakeSocket.all = []
  ;(globalThis as any).WebSocket = FakeSocket
  ;(globalThis as any).location = { href: 'http://127.0.0.1/', protocol: 'http:' }
})
afterEach(() => { (globalThis as any).WebSocket = saved.WebSocket; (globalThis as any).location = saved.location })

function open(chat: string) {
  let ended = 0
  const link = connectTerminal(chat, () => {}, () => {}, () => {}, () => {}, () => false, () => { ended++ })
  FakeSocket.all[0].open()
  return { link, ended: () => ended }
}

test('an exited shell closes the terminal and never reconnects', async () => {
  const t = open('sh:p1')
  FakeSocket.all[0].say({ type: 'exited' })
  expect(t.ended()).toBe(1)
  await Bun.sleep(400)
  expect(FakeSocket.all.length).toBe(1)
  t.link.close()
})

test('a dropped socket is no exit: it reconnects to the same terminal', async () => {
  const t = open('sh:p1')
  FakeSocket.all[0].close()
  await Bun.sleep(400)
  expect(t.ended()).toBe(0)
  expect(FakeSocket.all.length).toBe(2)
  expect(FakeSocket.all[1].url.searchParams.get('chat')).toBe('sh:p1')
  t.link.close()
})
