// fork: the window chat's rows sized at zoom 1 (SHEP-13, mods/chat/zoom.js). Herdr reports measured sizes at the
// person's zoom; the list places rows by sizes at zoom 1. At Doug's zoom 1.7 every row got 1.7 times its height.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { zoomOf, listHeight } from "../mods/chat/zoom.js";

const main = readFileSync(new URL("../mods/chat/main.js", import.meta.url), "utf8");

test("the zoom comes from Herdr's settings, 1 when unset or bad", () => {
  expect(zoomOf({ zoom: 1.7 })).toBe(1.7);
  expect(zoomOf({})).toBe(1);
  expect(zoomOf(null)).toBe(1);
  expect(zoomOf({ zoom: 0 })).toBe(1);
  expect(zoomOf({ zoom: "x" })).toBe(1);
});

test("a reported height is the list's size at zoom 1", () => {
  expect(listHeight(26 * 1.7, 1.7)).toBeCloseTo(26, 6);
  expect(listHeight(50, 1)).toBe(50);
  expect(listHeight(50, undefined)).toBe(50);
});

// Doug's screenshot (tickets Assistant, zoom 1.7): the person's one-line message, its band and the gap, then a
// tools row whose words start 5 px in. Screen px between the bubble's foot and the tools row's words.
test("the screenshot's blank under a message: 165 px measured, 71 at its real size", () => {
  const z = 1.7, bubble = 38.8, band = 26, gap = 11, ink = 5;
  // Each row's slot as the list got it, in screen px (the list draws at the zoom).
  const blank = (slot) => z * (slot(bubble) - bubble + slot(band) + slot(gap) + ink);
  const before = blank((h) => h * z);
  const after = blank((h) => listHeight(h * z, z));
  expect(Math.round(before)).toBe(162); // the screenshot: 165
  expect(Math.round(after)).toBe(71);
});

test("the measurer gives the list zoom-1 heights, measured again at another zoom", () => {
  const measurer = main.slice(main.indexOf("  measurer(rows, keys, t) {"));
  expect(measurer).toContain("const h = listHeight(size.height, zoomOf(settings()));");
  expect(measurer).toContain("this.heights.set(keys[i], h);");
  expect(measurer).not.toContain("this.heights.set(keys[i], size.height)");
  expect(main).toContain("if (this.heightsZoom !== zoomOf(settings())) { this.heightsZoom = zoomOf(settings()); this.heightsFor = -1; }");
});

// SHEP-11 put an on_size_change on each row inside the list's renderer: Herdr throws on a handler registered there
// (gpui-kit.d.ts: "No handlers inside the renderer"), and the window showed nothing.
test("the list's row renderer registers no handlers", () => {
  const from = main.indexOf('v_virtual_list("chat-rows"');
  const renderer = main.slice(from, main.indexOf(".track_scroll(this.scroll)", from));
  expect(from).toBeGreaterThan(0);
  expect(renderer).not.toMatch(/\.on_[a-z_]+\(/);
  expect(renderer).not.toContain("cx.notify(");
});
