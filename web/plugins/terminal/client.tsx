// Terminal: an agent's live herdr terminal. A task's is an item of its side panel (a tab beside its chat on a desktop,
// a sheet from the task header's ⋯ on a phone); a coordinator's flips its chat, from the Terminal row of its top-right
// menu. Ctrl+` opens either on a desktop. Every key goes in, Esc too: in a coordinator's while it shows, in a task's
// while its screen has the focus (a click puts it there); Ctrl+` goes back to the chat. A phone or tablet gets
// Termux's extra-keys bar, and a tap brings up its keyboard.
import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type HTMLAttributes } from 'react'
import type { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { act, agentChat, definePlugin, getState, openItem, placeOf, setUI, shownItem, useStore, useUI } from '@client/kernel.ts'
import { CTRL, ic, MenuItem, MenuSeparator, MenuSetting, ModelIcon, shortcut, Small, Tab, Tabs, TermIcon } from '@client/ui.tsx'
import type { Place, TermScreen } from '@shared/types.ts'
import { anyMod, EXTRA_KEYS, modText, NO_MODS, tapMod, typedDiff, withMods, type Mods } from './input.ts'
import { connectTerminal, streamInput } from './stream.ts'
import { keysTerm, termInPlace, termInput, touchScreen, typedInBox } from './shown.ts'
import { tabTermFor } from './tab.ts'
import { atEnd, colsOf, fitFont, foldShown, frame, LINE, MAX, MIN, PAD, toEnd, ZOOM } from './screen.ts'

const KEYMAP: Record<string, string> = {
  Enter: 'enter',
  Escape: 'esc',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
}

/** a browser key event as herdr's key name, or text to type */
export function toKey(e: KeyboardEvent): { keys?: string[]; text?: string } | null {
  if (KEYMAP[e.key]) return { keys: [(e.shiftKey && e.key === 'Tab' ? 'shift+' : '') + KEYMAP[e.key]] }
  if (e.ctrlKey && e.key.length === 1) return { keys: [`ctrl+${e.key.toLowerCase()}`] }
  if (e.altKey && e.key.length === 1) return { keys: [`alt+${e.key.toLowerCase()}`] }
  if (e.key.length === 1 && !e.metaKey) return { text: e.key }
  return null
}

function terminalInput(chat: string, message: Parameters<typeof streamInput>[1]) {
  if (getState().snap?.terminalTransport === 'core') streamInput(chat, message)
  else act({ ...message, chat })
}

/** the task terminal's screen in the side panel: focused, every key goes into it */
const SCREEN = '[data-term-screen]'

/** one cell's width per px of font size, for the monospace font */
let cellRatio = 0
function cellOf(family: string) {
  if (cellRatio) return cellRatio
  const c = document.createElement('canvas').getContext('2d')
  if (!c) return 0.6
  c.font = `100px ${family}`
  return (cellRatio = c.measureText('M'.repeat(20)).width / 2000 || 0.6)
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/** The CLI's screen drawn by a real terminal (xterm.js), read only, at the pane's own columns: nothing wraps. The view
 *  fits the terminal, never the other way round: the agent draws for its own size whoever watches, so opening or
 *  resizing a view disturbs nobody. The font scales so the width fits; too small, it stops at MIN and the screen pans
 *  sideways. A pinch (or Ctrl and the wheel) zooms. fork: each new `pin` brings it to the prompt and follows it again
 *  (SHEP-22). */
function Screen({ screen, stream, pin = 0, flush, className, ...p }: { screen: TermScreen | undefined; stream?: string; pin?: number; flush?: boolean } & HTMLAttributes<HTMLDivElement>) {
  const box = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const [term, setTerm] = useState<Terminal | null>(null)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState<number | null>(null)
  /** following the newest line: scrolled to the bottom (and kept there as lines come in) */
  const stuck = useRef(true)
  const [streamStatus, setStreamStatus] = useState('Reading the terminal…')
  /** the live terminal's own columns, as the server says them */
  const [streamCols, setStreamCols] = useState<number | null>(null)
  const cols = stream ? streamCols ?? 80 : screen ? colsOf(screen) : 80
  const family = useMemo(() => css('--font-mono') || 'monospace', [])
  const whole = width ? fitFont(width, cols, cellOf(family)) : MAX
  const font = zoom ?? Math.min(MAX, Math.max(MIN, whole))
  // the font a pinch started from, and the fingers' distance then
  const pinch = useRef<{ d: number; font: number } | null>(null)
  // the pinch handlers read the size now, and zoom from the whole width up to ZOOM
  const fontRef = useRef(font)
  fontRef.current = font
  const low = useRef(MIN)
  low.current = Math.min(MIN, whole)
  const zoomTo = (f: number) => setZoom(Math.round(Math.min(ZOOM, Math.max(low.current, f)) * 4) / 4)

  useEffect(() => {
    let gone = false
    let made: Terminal | null = null
    Promise.all([import('@xterm/xterm'), import('@xterm/addon-unicode11')]).then(([{ Terminal }, { Unicode11Addon }]) => {
      if (gone || !host.current) return
      const ansi = ['0', '1', '2', '3', '4', '5', '6', '7'].map((n) => css(`--ansi-${n}`))
      const bright = ['0', '1', '2', '3', '4', '5', '6', '7'].map((n) => css(`--ansi-${n}b`))
      const [black, red, green, yellow, blue, magenta, cyan, white] = ansi
      const [brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite] = bright
      made = new Terminal({
        cols: 80,
        rows: stream ? 24 : 1,
        scrollback: stream ? 2000 : 0,
        disableStdin: true,
        cursorBlink: false,
        fontFamily: family,
        fontSize: MAX,
        lineHeight: LINE,
        allowProposedApi: true,
        theme: {
          background: css('--term'),
          foreground: css('--term-fg'),
          selectionBackground: 'rgb(255 255 255 / 0.25)',
          black, red, green, yellow, blue, magenta, cyan, white,
          brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
        },
      })
      made.loadAddon(new Unicode11Addon())
      made.unicode.activeVersion = '11'
      // keys go to herdr by Shepherdr's own handler; the terminal only draws
      made.attachCustomKeyEventHandler(() => false)
      // and the wheel scrolls (or, with Ctrl, zooms) the box around it: left to xterm, it would turn into arrow keys
      made.attachCustomWheelEventHandler(() => false)
      made.open(host.current)
      // its own input box never takes the keyboard: a tap on a phone types through the key row's box
      if (made.textarea) {
        made.textarea.readOnly = true
        made.textarea.tabIndex = -1
      }
      setTerm(made)
    })
    return () => {
      gone = true
      made?.dispose()
    }
  }, [family, stream])

  useEffect(() => {
    const el = box.current
    if (!el) return
    // fork: a phone's keyboard coming up shortens the box: one following the newest line keeps it in view (SHEP-22)
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth)
      bottom()
    })
    ro.observe(el)
    const onScroll = () => (stuck.current = atEnd(el))
    el.addEventListener('scroll', onScroll, { passive: true })
    // two fingers zoom; the page itself never does
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
    const start = (e: TouchEvent) => {
      if (e.touches.length === 2) pinch.current = { d: dist(e.touches), font: fontRef.current }
    }
    const move = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !pinch.current) return
      e.preventDefault()
      zoomTo(pinch.current.font * (dist(e.touches) / pinch.current.d))
    }
    const end = (e: TouchEvent) => {
      if (e.touches.length < 2) pinch.current = null
    }
    // a trackpad's pinch comes as Ctrl and the wheel
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      zoomTo(fontRef.current * Math.exp(-e.deltaY / 100))
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    el.addEventListener('touchend', end, { passive: true })
    el.addEventListener('touchcancel', end, { passive: true })
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      ro.disconnect()
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
      el.removeEventListener('touchend', end)
      el.removeEventListener('touchcancel', end)
      el.removeEventListener('wheel', wheel)
    }
  }, [])

  const bottom = () => {
    if (stuck.current && box.current) box.current.scrollTop = box.current.scrollHeight
  }
  // fork: a tap to type, or a key sent: to the prompt, even from reading back (SHEP-22)
  useEffect(() => {
    if (!pin) return
    stuck.current = true
    toEnd(box.current, term)
  }, [pin])
  /** a live terminal's blank rows fold away, its rows staying where it drew them, and the view follows its last line */
  const fit = (t: Terminal) => {
    const rows = t.element?.querySelectorAll<HTMLElement>('.xterm-rows > div'), drawn = t.element?.querySelector<HTMLElement>('.xterm-screen')
    if (host.current && rows?.length && drawn) host.current.style.height = `${(drawn.offsetHeight / t.rows) * foldShown(t, rows)}px`
    bottom()
  }
  useEffect(() => {
    if (!term) return
    term.options.fontSize = font
    requestAnimationFrame(() => (stream ? fit(term) : bottom()))
  }, [term, font, stream])
  useEffect(() => {
    if (!term || !screen || stream) return
    const { rows, data } = frame(screen.ansi)
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows)
    term.write(data, () => requestAnimationFrame(bottom))
  }, [term, screen, cols, stream])

  useEffect(() => {
    if (!term || !stream) return
    // every draw: new output, or the history scrolled to
    const drawn = term.onRender(() => fit(term))
    const connection = connectTerminal(stream, (bytes, done) => term.write(bytes, done), () => term.reset(), (cols, rows) => {
      // in turn with what was written before it: a first paint at this size comes next
      term.write('', () => { term.reset(); term.resize(cols, rows); setStreamCols(cols) })
    }, setStreamStatus, () => term.modes.applicationCursorKeysMode) // fork: keys as bytes by the cursor mode (SHEP-20)
    return () => { drawn.dispose(); connection.close() }
  }, [term, stream])

  return (
    <div
      ref={box}
      {...p}
      data-cols={cols}
      data-font={font}
      className={clsx('term-screen min-h-0 flex-1 touch-pan-x touch-pan-y overflow-auto bg-term', className)}
      // fork: flush, the last line sits right on the extra-keys bar below, as Termux's prompt (SHEP-26)
      style={{ padding: PAD, paddingBottom: flush ? 2 : PAD }}
    >
      <div ref={host} className="w-max overflow-hidden" />
      {stream ? (streamStatus ? <div className="text-[0.75rem] text-(--ansi-0b)">{streamStatus}</div> : null) : screen ? null : <div className="text-[0.75rem] text-(--ansi-0b) phone:text-[0.8125rem]">Reading the terminal…</div>}
    </div>
  )
}

function TerminalView({ chatKey, panel }: { chatKey: string; panel?: boolean }) {
  const ui = useUI()
  const keyboard = useUI((u) => u.keyboard)
  const screen = useStore((s) => s.terms[chatKey])
  const streaming = useStore((s) => s.snap?.terminalTransport === 'core')
  const input = useRef<HTMLTextAreaElement>(null)
  // a mouse or keyboard types into a task's terminal while its screen has the focus; a finger (any touch screen, a
  // landscape iPad too), through the hidden box
  const { typed, touch } = termInput(ui.device, !!panel, touchScreen())
  /** bumped on a tap and on each thing typed: the screen goes to the prompt, just above the keyboard */
  const [pin, setPin] = useState(0)
  const toPrompt = () => setPin((n) => n + 1)
  // fork: the extra keys' sticky Ctrl and Alt (SHEP-23): engaged, they go on the next key or letter, then let go
  const [mods, showMods] = useState(NO_MODS)
  const modsNow = useRef(NO_MODS)
  const setMods = (m: Mods) => showMods((modsNow.current = m))
  const keys = (keys: string[]) => {
    if (touch && anyMod(modsNow.current)) {
      keys = [withMods(keys[0], modsNow.current), ...keys.slice(1)]
      setMods(NO_MODS)
    }
    terminalInput(chatKey, { type: 'keys', keys })
    if (touch) toPrompt()
  }
  /** fork: the touch box (SHEP-20): a word being composed stays in it, and `sent` is what of it already went in */
  const composing = useRef(false)
  const sent = useRef('')
  /** text typed, by the keyboard or the bar's −. fork: with Ctrl or Alt engaged, its first new letter goes in as
   *  that combo (SHEP-23); says whether one did */
  const type = (text: string) => {
    const parts = modText(text, modsNow.current)
    for (const part of parts) terminalInput(chatKey, 'keys' in part ? { type: 'keys', ...part } : { type: 'text', ...part })
    if (parts.length) toPrompt()
    const modded = parts.some((part) => 'keys' in part)
    if (modded) setMods(NO_MODS)
    return modded
  }
  const typeBox = (el: HTMLTextAreaElement) => {
    const modded = type(typedDiff(sent.current, el.value))
    // the combo's letter is used up: a word the keyboard was composing starts afresh
    if (composing.current && !modded) sent.current = el.value
    else el.value = sent.current = ''
  }
  useEffect(() => {
    const el = input.current
    if (!el) return
    // Backspace on an empty box changes nothing, so no input comes: Android's keyboard sends only this
    const before = (e: InputEvent) => {
      if (e.inputType === 'deleteContentBackward' && !el.value) {
        e.preventDefault()
        keys(['backspace'])
      }
    }
    el.addEventListener('beforeinput', before)
    return () => el.removeEventListener('beforeinput', before)
  }, [touch, chatKey])
  return (
    <>
      <Screen
        key={chatKey}
        screen={screen}
        stream={streaming ? chatKey : undefined}
        pin={pin}
        flush={touch}
        role="log"
        aria-label="Terminal"
        tabIndex={typed ? 0 : undefined}
        data-term-screen={typed ? chatKey : undefined}
        onClick={(e) => {
          if (touch) {
            input.current?.focus()
            toPrompt()
          } else if (typed) (e.currentTarget as HTMLElement).focus()
        }}
        className={clsx(typed && 'cursor-text focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-line2')}
      />
      {touch ? (
        <>
          <textarea
            ref={input}
            name="terminal-input"
            aria-label="Type into the terminal"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            enterKeyHint="send"
            className="pointer-events-none absolute size-px opacity-0"
            // fork: left to itself (SHEP-20): a keyboard composing a word (Android's) keeps it in the box, and what
            // changes goes in
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={(e) => {
              composing.current = false
              typeBox(e.currentTarget)
            }}
            onInput={(e) => typeBox(e.currentTarget)}
            onKeyDown={(e) => {
              // a keyboard composing a word has the key: what it does shows in the box
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              // a tablet's keyboard: Ctrl keys go in as on a desktop (Alt alone, or AltGr's Ctrl+Alt, types its character)
              if (e.ctrlKey && !e.altKey) {
                const t = toKey(e.nativeEvent)
                if (t?.keys) {
                  e.preventDefault()
                  keys(t.keys)
                }
                return
              }
              const k = KEYMAP[e.key]
              if (k) {
                e.preventDefault()
                keys([k])
              }
            }}
          />
          {/* fork: Termux's extra-keys bar (SHEP-26), two rows of seven in groups with ENTER bottom-right (SHEP-32), the terminal's own background (dark in either theme), with no line between them. The app
              takes the visible viewport's height (viewport.ts) and the phone's bottom bar goes with the keyboard up,
              so the bar, last in the view, docks on the keyboard's top. A press keeps the focus in the box, so the
              keyboard stays as it was, and CTRL and ALT stick for the next key (SHEP-23) */}
          <div role="group" aria-label="Extra keys" className="grid shrink-0 grid-cols-7 bg-term pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] text-white select-none [-webkit-touch-callout:none]">
            {EXTRA_KEYS.flat().map((x) => {
              const mod = 'mod' in x ? x.mod : null
              return (
                <button
                  key={x.name}
                  type="button"
                  aria-label={x.name}
                  aria-pressed={mod ? mods[mod] : undefined}
                  // the press never takes the focus from the box: the keyboard stays as it was, up or down
                  onPointerDown={(e) => e.preventDefault()}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if ('key' in x) return keys([x.key])
                    if ('text' in x) return void type(x.text)
                    const m = tapMod(modsNow.current, x.mod)
                    setMods(m)
                    // engaged with the keyboard down: it comes up for the letter
                    if (m[x.mod] && document.activeElement !== input.current) {
                      input.current?.focus({ preventScroll: true })
                      toPrompt()
                    }
                  }}
                  // the arrows thin, the words bold, as Termux's
                  className={clsx('h-11 min-w-0 touch-manipulation text-center text-[clamp(0.75rem,3.6vw,0.9375rem)] tracking-wide whitespace-nowrap active:bg-white/15 aria-pressed:bg-white/20 aria-pressed:text-sky-300', /^[←↑↓→]$/.test(x.label) ? 'font-normal' : 'font-bold')}
                >
                  {x.label}
                </button>
              )
            })}
          </div>
          {/* the hint while the keyboard is down; up, the bar sits right on it, as Termux's */}
          {keyboard ? null : <Small className="truncate px-4 pt-1.5 pb-2 text-fg3">Tap to type · pinch to zoom</Small>}
        </>
      ) : (
        <Small className="truncate px-4 pt-2 pb-3 text-fg3">{`${typed ? 'Click to type' : 'Keys go to the terminal'} · ${shortcut(CTRL, '`')} back to the chat`}</Small>
      )}
    </>
  )
}

/** A phone has no room for 3.0's tab bar: its ⋯ lists the space's tabs (the Assistant's first, the shown one ticked),
 *  then Chat or Terminal, which a wider header shows as its own switch. Wider, the tab bar has the tabs. */
function PlaceTerm({ place }: { place: Place }) {
  const ui = useUI()
  const tabsShown = useStore((s) => s.snap?.look?.tabs !== false)
  if (ui.device !== 'phone') return null
  const other = !!ui.term?.startsWith('t:') && (place.tabs ?? []).some((t) => t.term === ui.term)
  const on = ui.term === place.chat
  const go = (term: string | null) => setUI({ term, arts: null, menu: false, plus: null, pick: null })
  const tabs = [{ term: null as string | null, name: place.assistantTab?.name ?? 'Assistant', cli: place.assistantTab?.cli }, ...(place.tabs ?? [])]
  return (
    <>
      {/* Settings › Window › Show tabs off: the space's tabs aren't listed */}
      {tabsShown && tabs.length > 1
        ? tabs.map((t) => {
            const shown = t.term ? ui.term === t.term : !other
            return (
              <MenuItem key={t.term ?? 'assistant'} role="menuitemradio" aria-checked={shown} icon={t.cli ? <ModelIcon className={ic} /> : <TermIcon className={ic} />} hint={shown ? '✓' : undefined} onClick={() => go(t.term ?? (on ? place.chat : null))}>
                {t.name}
              </MenuItem>
            )
          })
        : null}
      {/* the shown tab's Chat | Terminal, as the same two choices (another tab's: Claude Code's and Codex's) */}
      {other ? (
        ['claude', 'codex'].includes(place.tabs?.find((t) => t.term === ui.term)?.cli ?? '') ? (
          <MenuSetting name="Show" icon={<TermIcon className={ic} />} choices={(['chat', 'terminal'] as const).map((v) => ({
            label: v === 'chat' ? 'Chat' : 'Terminal', on: (ui.tabView?.[ui.term!] ?? 'terminal') === v,
            onClick: () => setUI((u) => ({ tabView: { ...u.tabView, [u.term!]: v }, menu: false })),
          }))} />
        ) : null
      ) : (
        <MenuSetting name="Show" icon={<TermIcon className={ic} />} choices={[
          { label: 'Chat', on: !on, onClick: () => go(null) },
          { label: 'Terminal', on, onClick: () => go(place.chat) },
        ]} />
      )}
      <MenuSeparator />
    </>
  )
}

/** 3.0's Chat | Terminal in the Assistant's header (a desktop's or tablet's) */
function ChatOrTerminal({ place }: { place: Place }) {
  const device = useUI((u) => u.device)
  const term = useUI((u) => u.term === place.chat)
  const shown = useUI((u) => (u.term?.startsWith('t:') ? u.term : null))
  const view = useUI((u) => (shown ? u.tabView?.[shown] : undefined))
  if (device === 'phone') return null
  if (shown) {
    // another tab: Claude Code's and Codex's have it too (3.0's pane header: a chat reads their own session logs)
    const tab = place.tabs?.find((t) => t.term === shown)
    if (!tab || !['claude', 'codex'].includes(tab.cli ?? '')) return null
    const chat = view === 'chat'
    const pick = (v: 'chat' | 'terminal') => setUI((ui) => ({ tabView: { ...ui.tabView, [shown]: v }, menu: false, pick: null }))
    return (
      <Tabs label="Chat or terminal" className="shrink-0">
        <Tab on={chat} onClick={() => pick('chat')}>Chat</Tab>
        <Tab on={!chat} onClick={() => pick('terminal')}>Terminal</Tab>
      </Tabs>
    )
  }
  const go = (t: boolean) => setUI({ term: t ? place.chat : null, arts: null, menu: false, plus: null, pick: null })
  return (
    <Tabs label="Chat or terminal" className="shrink-0">
      <Tab on={!term} onClick={() => go(false)}>Chat</Tab>
      <Tab on={term} onClick={() => go(true)}>Terminal</Tab>
    </Tabs>
  )
}

/** back to the task's chat from its terminal: its message box takes the focus */
function toChat(chat: string) {
  ;(document.activeElement as HTMLElement | null)?.blur()
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(`textarea[name=message][data-chat="${CSS.escape(chat)}"]`)?.focus())
}

export default definePlugin({
  name: 'terminal',
  setup(reg) {
    reg.placeMenu.push({ order: 60, View: PlaceTerm })
    reg.placeHeader.push({ order: 15, View: ChatOrTerminal })
    reg.taskPanel.push({ id: 'terminal', order: 10, label: 'Terminal', Icon: TermIcon, View: ({ chatKey }) => <TerminalView chatKey={chatKey} panel /> })
    reg.chatBody.push({ when: termInPlace, View: TerminalView })
    // Shepherdr 3: one of the space's other tabs, in place of its chat (t:<terminal>)
    // fork: only in the column of the space that owns the tab, never a task panel's chat (SHEP-27; tab.ts)
    reg.chatBody.push({ when: (ui, key) => tabTermFor(ui.term, ui.tabView, key, getState().snap?.places ?? []), View: ({ chatKey: _ }: { chatKey: string }) => <TerminalView chatKey={useUI((u) => u.term!)} /> })
    reg.keys.push({
      order: 0,
      handle: ({ e, ui, snap }) => {
        if (typedInBox(e)) return true
        if (ui.device !== 'desktop') return false
        const task = agentChat(ui, snap)?.chat
        const focused = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(SCREEN)?.dataset.termScreen
        if (e.ctrlKey && e.key === '`') {
          e.preventDefault()
          // a task's: its panel opens on the terminal, which takes the focus; pressed in it, back to the chat
          if (task && !ui.term) {
            if (focused) return toChat(task), true
            openItem('terminal')
            requestAnimationFrame(() => document.querySelector<HTMLElement>(SCREEN)?.focus())
            return true
          }
          const c = placeOf(snap, ui.place).chat
          setUI({ term: ui.term === c ? null : c, arts: null, kb: true })
          return true
        }
        if (focused && shownItem(getState().ui, snap) === 'terminal') {
          const k = toKey(e)
          if (!k) return true
          e.preventDefault()
          if (k.keys) terminalInput(focused, { type: 'keys', keys: k.keys })
          else if (k.text) terminalInput(focused, { type: 'text', text: k.text })
          return true
        }
        const term = keysTerm(ui)
        if (!term) return false
        const k = toKey(e)
        if (!k) return true
        e.preventDefault()
        if (k.keys) terminalInput(term, { type: 'keys', keys: k.keys })
        else if (k.text) terminalInput(term, { type: 'text', text: k.text })
        return true
      },
    })
  },
})
