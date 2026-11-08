// fork: the New space dialog holds the keyboard (lib/keyholder.js, shared "keyboard.holder") so the Assistant chat
// under it stops taking the keyboard back into its box on a redraw. lib/keyholder.js imports "herdr": a fake
// shared store stands in for it.
import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

const store = new Map();
mock.module("herdr", () => ({ shared: (k) => store.get(k) ?? null, setShared: (k, v) => store.set(k, v), home: () => "/nowhere", readTextFile: async () => null }));
const { KEY_HOLDER, holdKeys, releaseKeys, keysElsewhere, keysInDialog } = await import("../lib/keyholder.js");
const holder = () => store.get(KEY_HOLDER) ?? null;
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the dialog holds the keyboard while open, and gives it back to who had it on close", () => {
  store.clear();
  holdKeys("p1"); // the person typed in the Assistant chat (pane p1)
  expect(keysInDialog(holder())).toBe(false);
  const before = holder();
  holdKeys("newspace", { dialog: true }); // the New space dialog opens
  expect(keysInDialog(holder())).toBe(true);
  expect(keysElsewhere(holder(), "p1")).toBe(true);
  holdKeys("newspace", { dialog: true }); // its field focused again: unchanged
  expect(holder().who).toBe("newspace");
  releaseKeys("newspace", before); // Esc, Cancel, Create or a click beside it
  expect(holder()).toEqual(before);
  expect(keysInDialog(holder())).toBe(false);
  releaseKeys("newspace", before); // Herdr's own close() after the dialog's: someone else holds it, left alone
  expect(holder()).toEqual(before);
});

test("with no one holding it before, closing frees the keyboard for the chat under it", () => {
  store.clear();
  holdKeys("newspace", { dialog: true });
  releaseKeys("newspace", null);
  expect(holder()).toBe(null);
  expect(keysElsewhere(holder(), "p1")).toBe(false);
});

test("a press elsewhere after the dialog took the keyboard isn't undone by its close", () => {
  store.clear();
  holdKeys("newspace", { dialog: true });
  holdKeys("tasks"); // e.g. the Tasks panel's search, pressed after
  expect(keysInDialog(holder())).toBe(false);
  releaseKeys("newspace", null);
  expect(holder().who).toBe("tasks");
});

test("the New space dialog holds the keyboard as a dialog and releases it on close; the chat checks for a dialog", () => {
  const dialog = read("mods/newspace/main.js");
  expect(dialog).toContain('holdKeys(KEYS, { dialog: true })');
  expect(dialog).toMatch(/close\(\) \{\s*releaseKeys\(KEYS, this\.keysBefore\);/);
  const chat = read("mods/chat/main.js");
  const draw = chat.slice(chat.indexOf("  draw(cx) {"), chat.indexOf("this.wasFocused = paneFocused;"));
  // Both of the chat's render-time takebacks (the box coming back, the pane focused again) wait while a dialog holds it.
  expect(draw).toContain("const dialog = keysInDialog(shared(KEY_HOLDER));");
  expect(draw.match(/this\.box\.focus\(\)/g).length).toBe(3);
  expect(draw.match(/if \(!dialog && paneFocused/g).length).toBe(2);
});
