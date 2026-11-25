// fork: the key row under the terminal on a phone (esc, tab, ctrl, the arrows, enter) leaves the on-screen keyboard as
// it was. A press focused the terminal's type box after sending its key, so a tap with the keyboard down brought it up
// (covering the terminal), and the press itself moved focus to the button first, so with the keyboard up it dropped
// and came back. Now a press never takes focus (its mousedown is cancelled: a touch's comes after the finger lifts), and
// only a mouse's click hands the keys to the terminal, as before on a desktop.

/** after a key-row press: should the terminal's box take the keys? Only for a mouse, or a key's Enter or Space with no
 *  pointer at all; never for a finger or a pen, whose press would bring up the phone's keyboard. */
export const focusAfterPress = (pointerType: string) => pointerType !== 'touch' && pointerType !== 'pen'

/** the row's handlers: a press keeps the focus where it was (the box keeps the keys, and the keyboard stays up, or down);
 *  `last()` is how the latest press was made, for focusAfterPress */
export function keyRow() {
  let type = ''
  return {
    onPointerDown: (e: { pointerType: string }) => { type = e.pointerType },
    onMouseDown: (e: { preventDefault(): void }) => e.preventDefault(),
    /** how the press that is clicking now was made; a click with no pointer before it (Enter on a focused key) is '' */
    last: () => { const t = type; type = ''; return t },
  }
}
