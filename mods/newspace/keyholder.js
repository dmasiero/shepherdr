// Who last took the keyboard in the window (shared "keyboard.holder" = { who, at }): a chat's box (its areaKey(): its
// pane, or "thread" for a task's chat in the Tasks panel), or the Tasks panel's list or search ("tasks"). The Tasks
// panel is a layout block, not a pane, so Herdr still counts the Assistant chat's pane as focused while the person
// types there; that chat gives its box the keyboard back only while it is the holder (#633).
import { shared, setShared } from "herdr";

export const KEY_HOLDER = "keyboard.holder";

// A press or focus in `who`: it holds the keyboard now (written only when that changes).
// fork: { dialog: true } for a dialog over the panes (the New space one), which no chat takes the keyboard back from.
export function holdKeys(who, { dialog = false } = {}) {
  if (!who || (shared(KEY_HOLDER)?.who === who && Boolean(shared(KEY_HOLDER)?.dialog) === dialog)) return;
  setShared(KEY_HOLDER, { who, at: Date.now(), ...(dialog ? { dialog: true } : {}) });
}

// fork: `who` gave the keyboard back (a dialog closing, from its close()): back to `before`, who held it when the
// dialog opened (null: no one, so the chat under it may take it again).
export function releaseKeys(who, before = null) {
  if (who && shared(KEY_HOLDER)?.who === who) setShared(KEY_HOLDER, before?.who && before.who !== who ? before : null);
}

// Whether someone else than `mine` took the keyboard last.
export const keysElsewhere = (holder, mine) => Boolean(holder?.who && holder.who !== mine);

// fork: whether a dialog over the panes holds the keyboard (holdKeys with dialog).
export const keysInDialog = (holder) => Boolean(holder?.who && holder.dialog);
