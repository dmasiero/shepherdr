# Voice calls: muffling other audio

While a call runs in the window, other apps' sound (music in a browser, a player, a video) goes quieter while the
call's voice speaks and while you speak, and comes back up after. The call's updates are heard over the music from
across the room, and your replies reach the call. Like Superwhisper's Muffle.

**Setting:** Settings › Window › Add-ons, under Voice and dictation: *Muffle other audio during calls*: Off, 10%, 25%
(the default) or 50%. Everywhere's `voice.muffle` in `~/.config/shepherdr/settings.json` (0 is off). A change applies
to a call already running within about 2 s.

**Why 25%:** the share is of each app's own volume as its slider shows it (pavucontrol's, GNOME's), so 25% is about
36 dB down: the voice is clear over loud music from another room, while you can still hear the music is on. 10% is
near silence; 50% (about 18 dB down) suits quiet background music close by.

## How it works (Linux: PipeWire or PulseAudio)

- `mods/chat/voice.ts` decides when: while the agent's voice plays (and 1 s after), and while you speak (and 1 s after),
  never while you're muted. Your speech is the mic's level well above the room's own (`speechGate` in `core/duck.js`:
  three times a floor it learns while nothing is muffled, twice in a row to start, held by a lower line). Music leaking
  into the mic that starts loud can pass for speech once: when the call hears no words from it within 5 s, the gate
  takes that level as the room's and it doesn't happen again.
- `core/duck.js` (`ducker`) does the muffling: every other app's playback stream (`pactl -f json list sink-inputs`) goes
  to its share in 250 ms, then back to exactly its own volume over 800 ms. Never touched: the call's own sound (its
  `pw-play` is marked `herdr.call`, role Communication) and virtual streams (a filter's or loopback's output, such as
  Superwhisper's own muffle sink: the apps feeding it are muffled at their own streams).
- Streams that start while muffled go down too; one you (or the app) change meanwhile is yours: it is never put back
  over your change.
- PipeWire remembers an app's last volume. A stream that ends while muffled would make that app's next stream start
  quiet, so the muffle puts its remembered volume back (a moment of silence played as that app with `paplay`, set to
  its own volume) or, if the app plays again during the call, starts it from its own.
- Put back when the call ends in any way: hung up, the window closed (the call ends once the chat stops showing), or
  the call's process killed. What to put back is kept in `<app home>/data/call-muffle/<pid>.json`; a small watcher the
  call starts waits for its process and runs `bun mods/chat/muffle.ts restore`, and every call runs it first too.
  Restoring sets a stream back only if it's still at the muffled volume.
- Needs `pactl` 16 or later (its JSON); without it, calls go on unmuffled.

## Elsewhere

- **macOS:** no `pactl`, and macOS has no per-app volume to set. The window's call runs through Apple's voice
  processing (`herdr-audio call`), which already lowers other apps' sound by itself while the call runs (Apple's
  "other audio ducking"); this setting doesn't change it. A later step could pass the level to
  `AVAudioVoiceProcessingOtherAudioDuckingConfiguration` (macOS 14+).
- **The web call (phone):** a browser can't change other apps' volume, so nothing is muffled there.

## Trying it on a Linux machine

1. Play music (a browser tab, Spotify) and open `pavucontrol` › Playback, or watch
   `watch -n0.2 'pactl list sink-inputs | grep -E "application.name|Volume:"'`.
2. Start a call in the window's chat. As the voice says "Hi, go ahead." the music drops to a quarter of its slider, then
   comes back about a second after it stops. Talk: it drops again while you speak.
3. While the music is muffled, set it to 60% yourself: the muffle leaves it at 60%. Hang up mid-sentence: everything comes
   back at once. Settings › Window: Off turns it off within 2 s.
