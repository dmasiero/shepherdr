import { expect, test } from 'bun:test'
import { createServer, type Socket } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CoreClient } from '../server/core/client.ts'
import { CoreSession } from '../server/core/session.ts'

const methods = ['terminal.run', 'terminal.list', 'terminal.get', 'terminal.label', 'terminal.attach', 'terminal.send', 'terminal.wait', 'events.subscribe', 'doc.get', 'doc.set', 'file.read', 'machine.exec']
function frame(channel: number, body: string | Buffer, kind = 0) {
  const bytes = Buffer.from(body)
  const header = Buffer.alloc(9)
  header.writeUInt32LE(channel); header[4] = kind; header.writeUInt32LE(bytes.length, 5)
  return Buffer.concat([header, bytes])
}
type Call = { id: number; method: string; params: Record<string, unknown> }
const NO_REPLY = Symbol('no reply')


async function fixture(run: (client: CoreClient, wire: { send(channel: number, body: string | Buffer, kind?: number): void }) => Promise<void>,
  respond: (call: Call, socket: Socket) => unknown = () => ({}), command = false) {
  const directory = mkdtempSync(join(tmpdir(), 'shep-core-'))
  const path = join(directory, 'core.sock')
  const sockets = new Set<Socket>()
  let peer: Socket
  const server = createServer(socket => {
    peer = socket; sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    let buffer = Buffer.alloc(0), plain = true
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)])
      if (plain) {
        const newline = buffer.indexOf(10)
        if (newline < 0) return
        const hello = JSON.parse(buffer.subarray(0, newline).toString()) as Call
        buffer = buffer.subarray(newline + 1); plain = false
        socket.write(JSON.stringify({ jsonrpc: '2.0', id: hello.id, result: { version: '0.1.14', generation: 1, framed: true, core: { id: 'fixture', name: 'fixture' }, methods, features: [] } }) + '\n')
      }
      while (buffer.length >= 9) {
        const channel = buffer.readUInt32LE(0), kind = buffer[4], length = buffer.readUInt32LE(5)
        if (buffer.length < length + 9) return
        const payload = buffer.subarray(9, length + 9)
        buffer = buffer.subarray(length + 9)
        if (channel === 0 && kind === 0) {
          const call = JSON.parse(payload.toString()) as Call
          const result = call.method === 'rpc.discover' ? { info: { version: '0.1.14' }, methods: methods.map(name => ({ name })) } : respond(call, socket)
          if (result !== NO_REPLY) socket.write(frame(0, JSON.stringify({ jsonrpc: '2.0', id: call.id, result })))
        } else if (kind === 2) {
          // A real core can have already-sent DATA in flight before it sees the viewer's CLOSE.
          socket.write(frame(channel, 'last output'))
          socket.write(frame(channel, '', 2))
        }
      }
    })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve) })
  let client: CoreClient | undefined
  try {
    if (command) {
      const binary = join(directory, 'hc')
      writeFileSync(binary, `#!${process.execPath}\nimport{connect}from'node:net';const s=connect(${JSON.stringify(path)});process.stdin.pipe(s);s.pipe(process.stdout);s.on('close',()=>process.exit());`, { mode: 0o700 })
      client = await CoreClient.endpoint({ binary, session: 'remote' })
    } else client = await CoreClient.open(path)
    await run(client, { send: (channel, body, kind) => peer.write(frame(channel, body, kind)) })
  } finally {
    client?.close(); for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(directory, { recursive: true, force: true })
  }
}

test('closing a busy attach drains in-flight output and keeps other RPC alive', async () => {
  await fixture(async client => {
    const closed = Promise.withResolvers<void>()
    const received: string[] = []
    const stream = await client.attach('t1', { data: bytes => received.push(bytes.toString()), close: () => closed.resolve() })
    stream.close(); stream.close()
    await closed.promise
    expect(received).toEqual([])
    await expect(client.call('terminal.get', { terminal: 't1' })).resolves.toEqual({ address: 't1' })
  }, call => call.method === 'terminal.attach' ? { channel: 1 } : { address: 't1' })
})

test('event stream handles multiple newline-delimited messages and partial Unicode across DATA frames', async () => {
  await fixture(async (client, wire) => {
    const events: unknown[] = []
    const done = Promise.withResolvers<void>()
    await client.subscribe(event => { events.push(event); if (events.length === 2) done.resolve() })
    const event = { jsonrpc: '2.0', method: 'event', params: { seq: 1, type: 'doc', machine: 'böx', data: { name: 'mail', version: 1 } } }
    const bytes = Buffer.from(JSON.stringify(event) + '\n' + JSON.stringify({ jsonrpc: '2.0', method: 'heartbeat', params: { seq: 1 } }) + '\n')
    const split = bytes.indexOf(Buffer.from('ö')) + 1
    wire.send(2, bytes.subarray(0, split)); wire.send(2, bytes.subarray(split))
    await done.promise
    expect(events[0]).toEqual(event)
  }, () => ({ channel: 2, seq: 0, terminals: [] }))
})

test('timeout does not repeat a write whose completion is unknown', async () => {
  let writes = 0
  await fixture(async client => {
    await expect(client.call('terminal.run', {}, 10)).rejects.toMatchObject({ kind: 'uncertain' })
    expect(writes).toBe(1)
  }, () => {
    writes++
    return NO_REPLY
  })
})

test('turn end state never changes a live terminal into a stopped process', async () => {
  const terminal = { address: 't1', labels: {}, argv: ['agent'], cwd: '/work', created_ms: 1, state: 'live', cols: 80, rows: 24 }
  await fixture(async (client, wire) => {
    const session = new CoreSession(client.path)
    const changed = Promise.withResolvers<void>()
    session.onChange(view => { if (view.seq === 2) changed.resolve() })
    try {
      await session.start()
      const notification = (seq: number, type: string, data: unknown) => JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { seq, type, terminal: 't1', data } }) + '\n'
      wire.send(2, notification(1, 'status', { status: { state: 'idle' }, records: {}, reported: true }) + notification(2, 'turn', { turn: 1, state: 'idle' }))
      await changed.promise
      expect(session.current.terminals.get('t1')).toMatchObject({ state: 'live', status: { state: 'idle' }, turn: 1 })
    } finally { session.stop() }
  }, () => ({ channel: 2, seq: 0, terminals: [terminal] }))
})


test('agent-side documented hc connect uses the same pinned framed protocol', async () => {
  await fixture(async client => {
    expect(await client.call('server.status')).toEqual({ connected: true })
  }, () => ({ connected: true }), true)
})

test('finished events retain process identity for confirmed cleanup, unlike a lost holder', async () => {
  const terminal = { address: 't1', labels: {}, argv: ['agent'], cwd: '/work', created_ms: 1, pid: 123, state: 'live', cols: 80, rows: 24 }
  await fixture(async (client, wire) => {
    const session = new CoreSession(client.path)
    let changed = Promise.withResolvers<void>()
    session.onChange(view => { if (view.seq > 0) changed.resolve() })
    const send = (seq: number, type: string) => wire.send(2, JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { seq, type, terminal: 't1', data: { reason: type === 'lost' ? 'holder_lost' : 'killed', exit_code: 129, finished_ms: 2 } } }) + '\n')
    try {
      await session.start()
      send(1, 'finished'); await changed.promise
      expect(session.current.terminals.get('t1')).toMatchObject({ state: 'finished', pid: 123, foreground: null })
      changed = Promise.withResolvers<void>()
      send(2, 'lost'); await changed.promise
      expect(session.current.terminals.get('t1')?.pid).toBeNull()
    } finally { session.stop() }
  }, () => ({ channel: 2, seq: 0, terminals: [terminal] }))
})
