// fork: the web terminal's cursor follows where your keys go. Keys go to the box over the terminal, never xterm's own
// textarea (readOnly, out of the tab order), so xterm always thought itself unfocused and drew its outline cursor,
// never the solid blinking block. The box's focus and blur are handed to xterm's textarea as events: xterm's own
// handlers switch its cursor (and its selection's colour). Its stdin is off, so its focus report (ESC [ I) never goes.

/** tells xterm its terminal has (on) or lost the keys, without focusing it */
export function mirrorFocus(t: { textarea?: { dispatchEvent(e: Event): boolean } } | null | undefined, on: boolean) {
  t?.textarea?.dispatchEvent(new Event(on ? 'focus' : 'blur'))
}
