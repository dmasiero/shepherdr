# Phone calls through Asterisk

Call Shepherdr from a phone on your own PBX and talk to it as with the web app's call (the Voice add-on): the same
ElevenLabs voice agent, the same tools (look, send, act), and the same updates from the chats it sent to. A phone has
no screen, so the call can't open or show anything: it says what it finds instead, and its "here" is the Home
Assistant of the machine that takes the call.

It uses Asterisk's [AudioSocket](https://docs.asterisk.org/Configuration/Channel-Drivers/AudioSocket/): Asterisk
opens a TCP connection to the Shepherdr service and streams the call's audio both ways (8 kHz slin; the service
turns it into the voice agent's 16 kHz and back). Nothing is recorded, and neither the audio nor the keys pressed are
logged.

Who may call is the PBX's job: the dialplan asks for an access code before it hands the call over. Shepherdr only
takes connections from the PBX addresses you list, and an allowed connection goes straight into the call, as the web
app's call button does.

## Turn it on

It's off by default, and it's per machine: only the machine whose service should take calls has the file. Pick the
one that serves the web app (`shepherdr web status` says which).

**The setting**, `~/.config/shepherdr/phone.json` on that machine:

```json
{ "on": true, "port": 9092, "bind": "tailnet", "pbx": ["<PBX_ADDRESS>"] }
```

- `pbx`: the address (or addresses) the PBX connects from, as this machine sees it. Every other address is refused
  before anything is said. With none, it stays off.
- `bind`: where the service listens. `tailnet` (the default) is this machine's Tailscale address; if the PBX isn't on
  your tailnet, write this machine's LAN address instead. It never listens on every address (`0.0.0.0`) unless you
  write that.
- `port`: 9092 (AudioSocket's usual port) unless set.

The PBX must reach that address and port over TCP: open it in the machine's firewall for the PBX's address only. The
service picks a change up within 15 s (`service.log` says `phone: taking AudioSocket calls on …`). Voice off in
Settings › Window › Add-ons stops it too. `"on": false`, or no file, is off.

## The dialplan

Extension 246 ("AIO", AI Operator) answers, asks for the access code, and hands the call to Shepherdr. In
`extensions.conf`, in the context your phones dial from:

```
exten => 246,1,Answer()
 same => n,Authenticate(<ACCESS_CODE>)
 same => n,AudioSocket(40325ec2-5efd-4bd3-805f-53576e581d13,<SHEPHERDR_ADDRESS>:9092)
 same => n,Hangup()
```

- `<ACCESS_CODE>`: the digits callers key in. `Authenticate()` plays "enter password", gives three tries, then hangs
  up; nothing reaches Shepherdr until the code is right. Keep the file readable by Asterisk only, and Asterisk's
  verbose log private (it shows each step's arguments); `Authenticate()`'s `d` option keeps the code in AstDB instead
  of the file.
- The id: any UUID (one from `uuidgen`); Shepherdr doesn't check it.
- `<SHEPHERDR_ADDRESS>:9092`: the Shepherdr machine's `bind` address and `port`.

Reload with `asterisk -rx "dialplan reload"` and dial 246. After the code, the voice agent says hello, as on the web.

Ending: say you want to hang up (the agent asks first, as on the web) or hang up the phone; either side ends it. A call
counts as on for updates (the service waits for it to end before restarting on new code).

## How it works

`service/phone.ts`: the listener (Bun TCP, the allowed addresses only), the AudioSocket framing (1-byte type, 2-byte
big-endian length, payload: `0x01` id, `0x10` audio, `0x03` DTMF, `0x00` hangup, `0xff` error), and the call's page:
on Asterisk's first frame (the id) it hands the call to `voiceCall` (`service/voice.ts`), the one the web's
`/api/voice` socket runs, with `where.client = "phone"`. The caller's 20 ms frames go up to 16 kHz; the agent's voice
comes down to 8 kHz and goes out one 20 ms frame at a time. DTMF frames are ignored. A connection that sends no id
within 5 s is hung up. Tests: `service/phone.test.ts` (a fake AudioSocket client and a fake voice agent).
