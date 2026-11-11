# Phone calls through Asterisk

Call Shepherdr from a phone on your own PBX and talk to it as with the web app's call (the Voice add-on): the same
ElevenLabs voice agent, the same tools (look, send, act), and the same updates from the chats it sent to. A phone has
no screen, so the call can't open or show anything: it says what it finds instead, and its "here" is the Home
Assistant of the machine that takes the call.

It uses Asterisk's [AudioSocket](https://docs.asterisk.org/Configuration/Channel-Drivers/AudioSocket/): Asterisk
opens a TCP connection to the Shepherdr service and streams the call's audio both ways (8 kHz slin; the service
turns it into the voice agent's 16 kHz and back). Nothing is recorded, and neither the PIN nor the audio is logged.

## Turn it on

It's off by default, and it's per machine: only the machine whose service should take calls has the file. Pick the
one that serves the web app (it keeps your secrets by default, which the PIN is one of).

1. **The PIN.** In Settings › Secrets (Everywhere), keep `SHEPHERDR_PHONE_PIN`, or from a terminal on that machine
   `herdr-secret set SHEPHERDR_PHONE_PIN` (the value on stdin). It is either:
   - **digits** (4 to 20): the caller types them on the phone's keys, then `#` (or just the last digit). This needs an
     Asterisk whose AudioSocket sends DTMF (frame type `0x03`); `*` starts over. Three wrong tries hang up.
   - **a UUID** (`uuidgen`): the dialplan passes it as the call's AudioSocket id, so the call starts with no keys.
     Anyone who can reach that extension can then call, so keep the extension itself behind the PBX's own checks.

   No `SHEPHERDR_PHONE_PIN` in this machine's vault: every call is refused.
2. **The setting**, `~/.config/shepherdr/phone.json` on that machine:

   ```json
   { "on": true, "port": 9092, "bind": "tailnet", "pbx": ["100.101.102.103"] }
   ```

   - `pbx`: the address (or addresses) the PBX connects from. Every other address is refused before anything is
     said; an address with five failed calls in ten minutes is refused for ten minutes.
   - `bind`: where the service listens. `tailnet` (the default) is this machine's Tailscale address; any other
     address can be written out. It never listens on every address (`0.0.0.0`) unless you write that.
   - `port`: 9092 unless set.

   The service picks a change up within 15 s (`service.log` says `phone: taking AudioSocket calls on …`). Voice off
   in Settings › Window › Add-ons stops it too. `"on": false`, or no file, is off.

## The dialplan

An extension that answers and hands the call to Shepherdr, in `extensions.conf` (777 here; put it in the context your
phones dial from). With a digit PIN, any UUID will do as the id (one from `uuidgen`):

```
exten => 777,1,Answer()
 same => n,AudioSocket(40325ec2-5efd-4bd3-805f-53576e581d13,100.64.0.20:9092)
 same => n,Hangup()
```

With a UUID PIN, the id is the PIN itself (keep it out of a file others can read, e.g. in an `#include`d file only
Asterisk reads, or `GLOBAL` from AstDB):

```
exten => 777,1,Answer()
 same => n,AudioSocket(1b4e28ba-2fa1-11d2-883f-0016d3cca427,100.64.0.20:9092)
 same => n,Hangup()
```

`100.64.0.20:9092` is the Shepherdr machine's `bind` address and `port`. Reload with `asterisk -rx "dialplan reload"`
and dial 777. A short high tone asks for a digit PIN; a low one says no, then it hangs up. Then the voice agent says
hello, as on the web.

Ending: say you want to hang up (the agent asks first, as on the web) or hang up the phone; either side ends it. A call
counts as on for updates (the service waits for it to end before restarting on new code).

## How it works

`service/phone.ts`: the listener (Bun TCP, the allowed addresses only), the AudioSocket framing (1-byte type, 2-byte
big-endian length, payload: `0x01` id, `0x10` audio, `0x03` DTMF, `0x00` hangup, `0xff` error), the PIN, and the
call's page: it hands the call to `voiceCall` (`service/voice.ts`), the one the web's `/api/voice` socket runs, with
`where.client = "phone"`. The caller's 20 ms frames go up to 16 kHz; the agent's voice comes down to 8 kHz and goes out
one 20 ms frame at a time. Tests: `service/phone.test.ts` (a fake AudioSocket client and a fake voice agent).
