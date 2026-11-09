// SHEP-102: a call on a phone goes on with the screen locked, as far as the web lets it. Bun has no browser, so a fake
// one stands in (an iPhone's Safari as WebKit's own code says it behaves): what the page asks of it is what is checked.
// That a real iPhone then keeps the microphone and the voice going is not provable here.
import { beforeEach, expect, test } from 'bun:test'

// the fake browser, set before call.ts is loaded (it listens to the page's visibility)
const listeners: Record<string, (() => void)[]> = {}
const doc = { visibilityState: 'visible', addEventListener: (e: string, f: () => void) => (listeners[e] ??= []).push(f) }
const fire = (e: string) => (listeners[e] ?? []).forEach((f) => f())
Object.assign(globalThis, {
  document: doc,
  location: { href: 'https://box.example.ts.net/shepherdr/' },
  addEventListener: doc.addEventListener,
})

class FakeSocket {
  static OPEN = 1
  static all: FakeSocket[] = []
  readyState = 0
  bufferedAmount = 0
  sent: unknown[] = []
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  url: string
  constructor(url: string | URL) { this.url = String(url); FakeSocket.all.push(this) }
  send(x: unknown) { this.sent.push(typeof x === 'string' ? JSON.parse(x) : x) }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.() }
  open() { this.readyState = 1; this.onopen?.() }
  say(m: object) { this.onmessage?.({ data: JSON.stringify(m) }) }
}

const node = () => ({ connected: [] as unknown[], connect(to: unknown) { this.connected.push(to) }, disconnect() {}, fftSize: 0, getFloatTimeDomainData() {} })
class FakeContext {
  static last: FakeContext
  state = 'running'
  currentTime = 0
  sampleRate = 48000
  resumed = 0
  destination = { name: 'speaker' }
  onstatechange: (() => void) | null = null
  dest = { stream: { name: 'voice-stream' }, ...node() }
  constructor() { FakeContext.last = this }
  resume() { this.resumed++; this.state = 'running'; return Promise.resolve() }
  close() { this.state = 'closed'; return Promise.resolve() }
  createAnalyser() { return node() }
  createMediaStreamSource() { return node() }
  createScriptProcessor() { return { ...node(), onaudioprocess: null } }
  createMediaStreamDestination() { return this.dest }
  createBuffer(_c: number, n: number) { const data = new Float32Array(n); return { duration: n / 16000, getChannelData: () => data } }
  played: { buffer: { duration: number; getChannelData: () => Float32Array } | null; connected: unknown[]; started: boolean }[] = []
  createBufferSource() { const src = { ...node(), buffer: null, started: false, start() { this.started = true }, stop() {}, onended: null }; this.played.push(src as any); return src }
}

let playRefused = false
class FakeAudio {
  static all: FakeAudio[] = []
  paused = true
  srcObject: unknown = null
  src = ''
  loop = false
  autoplay = false
  onpause: (() => void) | null = null
  attrs: Record<string, string> = {}
  constructor() { FakeAudio.all.push(this) }
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  removeAttribute(k: string) { if (k === 'src') this.src = ''; delete this.attrs[k] }
  load() {}
  play() { if (playRefused) return Promise.reject(new Error('NotAllowedError')); this.paused = false; return Promise.resolve() }
  pause() { this.paused = true }
}

const handlers: Record<string, (() => void) | null> = {}
const mediaSession = { metadata: null as unknown, playbackState: 'none', mic: null as boolean | null,
  setActionHandler(a: string, f: (() => void) | null) { handlers[a] = f },
  setMicrophoneActive(on: boolean) { this.mic = on; return Promise.resolve() } }
const audioSession = { type: 'auto', state: 'active', onstatechange: null as (() => void) | null }
const track = () => ({ readyState: 'live', onended: null as (() => void) | null, stop() { this.readyState = 'ended' } })
let mics = 0
const tracks: ReturnType<typeof track>[] = []
Object.assign(globalThis, {
  WebSocket: FakeSocket,
  AudioContext: FakeContext,
  Audio: FakeAudio,
  MediaMetadata: class { constructor(public init: object) {} },
  navigator: {
    audioSession,
    mediaSession,
    mediaDevices: { getUserMedia: async () => { mics++; const t = track(); tracks.push(t); return { getTracks: () => [t], getAudioTracks: () => [t] } } },
  },
})

const call = await import('./call.ts')
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => { call.stopCall(); FakeSocket.all = []; FakeAudio.all = []; playRefused = false; mics = 0 })

const errors: string[] = []
const endedWhy: (string | null)[] = []
let hungUp = 0
const mutes: boolean[] = []
async function start() {
  const p = call.startCall('p:h1', (m) => errors.push(m), undefined, undefined, (why) => endedWhy.push(why), { title: 'the Home Assistant', hangUp: () => hungUp++, mute: (on) => mutes.push(on) })
  const ws = FakeSocket.all.at(-1)!
  ws.open()
  ws.say({ type: 'call', id: 'call-1' })
  await p
  return ws
}

test('the phone is told it is a call, before the microphone, and back to its own choice after', async () => {
  let typeAtMic = ''
  const ask = (globalThis.navigator as any).mediaDevices.getUserMedia
  ;(globalThis.navigator as any).mediaDevices.getUserMedia = async () => { typeAtMic = audioSession.type; return ask() }
  await start()
  ;(globalThis.navigator as any).mediaDevices.getUserMedia = ask
  expect(typeAtMic).toBe('play-and-record')
  call.stopCall()
  expect(audioSession.type).toBe('auto')
})

test("the agent's voice plays through a real <audio> element (kept playing in the background), or the speaker when refused", async () => {
  await start()
  const el = FakeAudio.all.at(-1)!
  expect(el.srcObject).toBe(FakeContext.last.dest.stream)
  expect(el.paused).toBe(false)
  expect(el.attrs.playsinline).toBe('')
  call.stopCall()
  // the end chime plays through it first (SHEP-173)
  await new Promise((r) => setTimeout(r, call.CHIME_MS + 50))
  expect(el.paused).toBe(true)
  // a browser that won't play it: the AudioContext's own output, as before
  playRefused = true
  await start()
  expect(FakeAudio.all.at(-1)!.paused).toBe(true)
  expect(FakeContext.last.dest.connected).toEqual([])
})

test('the lock screen shows the call; its hang up ends it, its mute toggles it', async () => {
  hungUp = 0
  mutes.length = 0
  await start()
  expect((mediaSession.metadata as any).init).toEqual({ title: 'Voice call', artist: 'the Home Assistant', album: 'Shepherdr' })
  expect(mediaSession.playbackState).toBe('playing')
  expect(mediaSession.mic).toBe(true)
  handlers.hangup!()
  handlers.togglemicrophone!()
  expect(hungUp).toBe(1)
  expect(mutes).toEqual([true])
  call.muteCall(true)
  expect(mediaSession.mic).toBe(false)
  call.stopCall()
  expect(mediaSession.metadata).toBeNull()
  expect(handlers.hangup).toBeNull()
})

test('hiding the page never ends the call; an interrupted audio starts again', async () => {
  const ws = await start()
  doc.visibilityState = 'hidden'
  fire('visibilitychange')
  expect(ws.readyState).toBe(1)
  expect(ws.sent.some((m: any) => m?.type === 'end')).toBe(false)
  // iOS interrupts the audio (a lock, a phone call): it is resumed once allowed
  const ctx = FakeContext.last
  ctx.state = 'interrupted'
  ctx.onstatechange!()
  await new Promise((r) => setTimeout(r, 350))
  expect(ctx.resumed).toBeGreaterThan(1)
  const el = FakeAudio.all.at(-1)!
  el.paused = true
  doc.visibilityState = 'visible'
  fire('visibilitychange')
  expect(el.paused).toBe(false)
  // the audio session's interruption ended
  ctx.state = 'suspended'
  audioSession.onstatechange!()
  expect(ctx.state).toBe('running')
})

test('the phone ended the microphone: it is taken again once the page is back', async () => {
  await start()
  expect(mics).toBe(1)
  tracks.at(-1)!.readyState = 'ended'
  doc.visibilityState = 'visible'
  fire('visibilitychange')
  await settle()
  expect(mics).toBe(2)
  expect(tracks.at(-1)!.readyState).toBe('live')
  call.stopCall()
  expect(tracks.at(-1)!.readyState).toBe('ended')
})

test('the socket drops: the call goes back to it quietly, says Reconnecting meanwhile, no error', async () => {
  errors.length = 0
  const ws = await start()
  ws.close()
  expect(call.callPhase()).toBe('reconnecting')
  await new Promise((r) => setTimeout(r, 300))
  const again = FakeSocket.all.at(-1)!
  expect(again).not.toBe(ws)
  expect(again.url).toBe('wss://box.example.ts.net/shepherdr/api/voice?chat=p%3Ah1&resume=call-1')
  again.open()
  again.say({ type: 'resumed', id: 'call-1' })
  expect(call.callPhase()).toBe('listening')
  expect(errors).toEqual([])
  // back on screen while getting back: it tries at once rather than waiting
  again.close()
  const n = FakeSocket.all.length
  fire('visibilitychange')
  expect(FakeSocket.all.length).toBe(n + 1)
  expect(FakeSocket.all.at(-1)!.url).toContain('resume=call-1')
  // the call is gone on the server (SHEP-173: the service started again on an update): it ends, saying why in plain words
  endedWhy.length = 0
  FakeSocket.all.at(-1)!.open()
  FakeSocket.all.at(-1)!.say({ type: 'ended', why: 'the connection was lost' })
  FakeSocket.all.at(-1)!.close()
  await new Promise((r) => setTimeout(r, 400))
  expect(endedWhy).toEqual(['the connection was lost'])
  expect(errors).toEqual([])
})

test('End tells the server to end it now (not hold it for the page)', async () => {
  const ws = await start()
  call.stopCall()
  expect(ws.sent.at(-1)).toEqual({ type: 'end' })
  expect(ws.readyState).toBe(3)
})

test("a socket that never got a call (the server refused it) is an error at once, no retrying", async () => {
  errors.length = 0
  const p = call.startCall('p:h1', (m) => errors.push(m))
  FakeSocket.all.at(-1)!.close()
  await p
  expect(errors).toEqual(['The voice connection failed.'])
})

test('SHEP-113: the call shows Listening, Thinking, Working (what, in plain words) and Speaking from its real events', async () => {
  const ws = await start()
  ws.say({ type: 'state', state: 'listening' })
  expect([call.callPhase(), call.callDoing()]).toEqual(['listening', ''])
  ws.say({ type: 'state', state: 'thinking' })
  expect(call.callPhase()).toBe('thinking')
  ws.say({ type: 'state', state: 'working', doing: 'checking tasks' })
  expect([call.callPhase(), call.callDoing()]).toEqual(['working', 'checking tasks'])
  // its "On it." plays: Speaking while it plays, and still Working after (the tool runs on)
  const ctx = FakeContext.last
  ws.onmessage?.({ data: new Int16Array(1600).buffer })
  expect(call.callPhase()).toBe('speaking')
  ctx.currentTime = 1
  expect([call.callPhase(), call.callDoing()]).toEqual(['working', 'checking tasks'])
  // the tool's result: thinking about the answer, then listening once it's said
  ws.say({ type: 'state', state: 'thinking' })
  expect([call.callPhase(), call.callDoing()]).toEqual(['thinking', ''])
  ws.say({ type: 'state', state: 'listening' })
  expect(call.callPhase()).toBe('listening')
})

test('SHEP-124: a voice action minimizes the full-screen call, but not call_view, a look, or a click that opened it', async () => {
  const { stepsAside } = await import('./call.ts')
  // opening things while full screen: minimized, so the person sees it
  expect(stepsAside({ kind: 'artifact', artifact: 'a1' }, true, true, true)).toBe(true)
  expect(stepsAside({ kind: 'screen', do: 'click', ref: 'e3' }, true, true, true)).toBe(true)
  // failed: nothing changed
  expect(stepsAside({ kind: 'space', place: 'sp1' }, false, true, true)).toBe(false)
  // reading the screen changes nothing; call_view sets the view itself
  expect(stepsAside({ kind: 'screen', do: 'look' }, true, true, true)).toBe(false)
  expect(stepsAside({ kind: 'call', full: true }, true, false, true)).toBe(false)
  // the bug: a screen click on "Open the call full screen" went full screen, then was minimized at once
  expect(stepsAside({ kind: 'screen', do: 'click', ref: 'e9' }, true, false, true)).toBe(false)
})

// SHEP-29: a headset's button toggles mute. The call screen's own mute path stands in (muteCall + its Muted state).
const gap = () => new Promise((r) => setTimeout(r, call.PRESS_GAP_MS + 20))
let screenMuted = false
async function startScreen() {
  screenMuted = false
  const p = call.startCall('p:h1', () => undefined, undefined, undefined, undefined, { title: 'Shepherdr', hangUp: () => undefined,
    mute: (on) => { call.muteCall(on); screenMuted = on } })
  const ws = FakeSocket.all.at(-1)!
  ws.open()
  ws.say({ type: 'call', id: 'call-1' })
  await p
}
const headset = (key: string) => listeners.keydown.forEach((f) => (f as unknown as (e: object) => void)({ key, repeat: false, preventDefault() {} }))
const state = () => [screenMuted, mediaSession.mic]

test('SHEP-29: presses as pause, pause, pause (an always-playing session) mute, unmute, mute', async () => {
  await startScreen()
  const seen = []
  for (let i = 0; i < 3; i++) { handlers.pause!(); seen.push(state()); await gap() }
  expect(seen).toEqual([[true, false], [false, true], [true, false]])
  // the session stays a live call the whole time
  expect(mediaSession.playbackState).toBe('playing')
})

test('SHEP-29: a mix of play, pause and the mic toggle is one toggle each', async () => {
  await startScreen()
  const seen = []
  for (const a of ['play', 'pause', 'togglemicrophone', 'play']) { handlers[a]!(); seen.push(screenMuted); await gap() }
  expect(seen).toEqual([true, false, true, false])
})

test('SHEP-29: one press delivered twice (Media Session, then keydown) within 300 ms counts once', async () => {
  await startScreen()
  handlers.pause!()
  headset('MediaPlayPause')
  expect(screenMuted).toBe(true)
  await gap()
  headset('HeadsetHook')
  handlers.play!()
  expect(screenMuted).toBe(false)
})

test("SHEP-29: the call screen's Mute and the headset agree", async () => {
  await startScreen()
  // muted on screen: the next press unmutes
  call.muteCall(true); screenMuted = true
  handlers.pause!()
  expect(state()).toEqual([false, true])
  await gap()
  // unmuted on screen again after a press: the next press mutes
  handlers.pause!()
  await gap()
  call.muteCall(false); screenMuted = false
  handlers.play!()
  expect(state()).toEqual([true, false])
})

test('SHEP-29: no call, no toggle: the keys and handlers do nothing', async () => {
  await startScreen()
  call.stopCall()
  expect(handlers.pause).toBeNull()
  expect(handlers.play).toBeNull()
  headset('MediaPlayPause')
  expect(screenMuted).toBe(false)
  // other keys during a call are left alone
  await startScreen()
  headset('a')
  headset('MediaTrackNext')
  expect(screenMuted).toBe(false)
})

// SHEP-30: the headset's button with Shepherdr in the background (Android Chrome). Chrome's media session, which
// Android gives the button to, comes only from a media element it counts: a looping silent WAV for the whole call.
// A Chrome on Android stands in: no WebKit audioSession. That Android then routes a real press to it is not provable here.
async function onAndroid(f: () => Promise<void>) {
  const nav = globalThis.navigator as any
  const was = nav.audioSession
  delete nav.audioSession
  try { await f() } finally { nav.audioSession = was }
}
const holds = () => FakeAudio.all.filter((a) => a.loop)

test('SHEP-30: a looping silent WAV starts in the tap that starts the call, and stops at hang-up', () => onAndroid(async () => {
  const p = call.startCall('p:h1', () => undefined, undefined, undefined, undefined, { title: 'Shepherdr', hangUp: () => undefined, mute: () => undefined })
  // before the microphone is asked for (no await yet): still the user's tap, and its buttons are on already
  const [el] = holds()
  expect(el.paused).toBe(false)
  expect(el.src).toStartWith('blob:')
  expect(el.srcObject).toBeNull()
  expect(el.attrs.playsinline).toBe('')
  expect(handlers.pause).toBeFunction()
  expect(mediaSession.playbackState).toBe('playing')
  const ws = FakeSocket.all.at(-1)!
  ws.open()
  ws.say({ type: 'call', id: 'call-1' })
  await p
  // the voice keeps its own element
  expect(FakeAudio.all.filter((a) => a.srcObject === FakeContext.last.dest.stream)).toHaveLength(1)
  expect(holds()).toEqual([el])
  call.stopCall()
  expect(el.paused).toBe(true)
  expect(el.src).toBe('')
  // a new call: a new one, the old one stays stopped
  await startScreen()
  expect(holds()).toHaveLength(2)
  expect(el.paused).toBe(true)
  expect(holds()[1].paused).toBe(false)
}))

test('SHEP-30: its WAV is silent and longer than 5 s (a "content" player to Chrome, not a one-shot sound)', async () => {
  const wav = new DataView(await call.silentWav().arrayBuffer())
  const text = (at: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => wav.getUint8(at + i)))
  expect([text(0), text(8), text(12), text(36)]).toEqual(['RIFF', 'WAVE', 'fmt ', 'data'])
  const rate = wav.getUint32(24, true), bytesPerSecond = wav.getUint32(28, true), size = wav.getUint32(40, true)
  expect(size / bytesPerSecond).toBeGreaterThan(5)
  expect([wav.getUint16(20, true), wav.getUint16(22, true), rate, wav.getUint16(34, true)]).toEqual([1, 1, 8000, 16])
  for (let i = 44; i < wav.byteLength; i += 2) if (wav.getInt16(i, true) !== 0) throw new Error(`not silent at ${i}`)
})

test('SHEP-30: a press in the background (the session\'s pause, then play) mutes and unmutes through press()', () => onAndroid(async () => {
  await startScreen()
  const [el] = holds()
  handlers.pause!()
  expect(state()).toEqual([true, false])
  // Chrome's own handling would pause it: the handlers take the press instead, it plays on
  expect(el.paused).toBe(false)
  await gap()
  handlers.play!()
  expect(state()).toEqual([false, true])
  // the same press as a keydown too (back on screen): counted once
  await gap()
  handlers.pause!()
  headset('MediaPlayPause')
  expect(screenMuted).toBe(true)
}))

test('SHEP-30: paused by something else (another app\'s sound), it plays again once the page is back; not after hang-up', () => onAndroid(async () => {
  await startScreen()
  const [el] = holds()
  el.paused = true
  doc.visibilityState = 'visible'
  fire('visibilitychange')
  expect(el.paused).toBe(false)
  call.stopCall()
  fire('visibilitychange')
  expect(el.paused).toBe(true)
}))

test('SHEP-30: on an iPhone (WebKit audioSession) nothing extra plays: only the voice', async () => {
  await startScreen()
  expect(holds()).toEqual([])
  expect(FakeAudio.all).toHaveLength(1)
})

// SHEP-173: a call never ends in silence: a short chime, through the call's own audio (its <audio> element, which a
// phone keeps playing in the background), then the audio closes.
test('SHEP-173: every end chimes through the call audio, then it closes', async () => {
  await start()
  const ctx = FakeContext.last
  const el = FakeAudio.all.at(-1)!
  call.stopCall()
  const chime = ctx.played.at(-1)!
  expect(chime.started).toBe(true)
  // through the voice's meter, so into the <audio> element: heard in the background too
  expect(chime.connected.length).toBe(1)
  expect(chime.connected[0]).not.toBe(ctx.destination)
  const pcm = chime.buffer!.getChannelData()
  expect(pcm.length / 16000).toBeGreaterThan(0.3)
  expect(Math.max(...pcm.map(Math.abs))).toBeGreaterThan(0.1)
  // still open while it plays; closed after
  expect([ctx.state, el.paused]).toEqual(['running', false])
  await new Promise((r) => setTimeout(r, call.CHIME_MS + 50))
  expect([ctx.state, el.paused]).toEqual(['closed', true])
})

test('SHEP-173: an end by itself says why (the limit, the line); after the person\'s yes it says nothing', async () => {
  endedWhy.length = 0
  let ws = await start()
  ws.say({ type: 'ended', why: 'it reached the 2-hour limit' })
  ws.close()
  await new Promise((r) => setTimeout(r, 400))
  ws = await start()
  ws.say({ type: 'ended' })
  ws.close()
  await new Promise((r) => setTimeout(r, 400))
  expect(endedWhy).toEqual(['it reached the 2-hour limit', null])
})
