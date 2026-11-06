// fork: the emoji pickers (chat-react's reactions, spaces-chat's icon) pick the emoji the press was on: press zones over
// the list (lib/emoji-grid.js) say which column, never a press's local_position. lib/emoji-grid.js imports
// "gpui-kit": a fake div() records each element's styles, children and press handler.
import { expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";

const fakeDiv = () => {
  const el = { styles: {}, kids: [], press: null };
  const api = new Proxy(el, {
    get(target, name) {
      if (name in target) return target[name];
      return (...args) => {
        if (name === "child") target.kids.push(args[0]);
        else if (name === "children") target.kids.push(...args[0]);
        else if (name === "on_mouse_down") { expect(args[0]).toBe("left"); target.press = args[1]; }
        else target.styles[name] = args.length ? args[0] : true;
        return api;
      };
    },
  });
  return api;
};
mock.module("gpui-kit", () => ({ div: fakeDiv }));
const { columnZones, pressedCell } = await import("../lib/emoji-grid.js");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const PER = 9, CELL = 36, PAD = 6, WIDTH = 360; // both pickers' sizes
const emoji = (n) => Array.from({ length: n }, (_, i) => ({ e: `e${i}` }));

// Lay the zones out as flex would in an area WIDTH wide: each zone's [left, right) and its handler.
function laidOut(zones) {
  let x = 0;
  const fixed = zones.kids.filter((z) => !z.styles.flex_1).reduce((s, z) => s + z.styles.w, 0);
  return zones.kids.map((z) => {
    const w = z.styles.flex_1 ? WIDTH - fixed : z.styles.w;
    const out = { left: x, right: x + w, press: z.press };
    x += w;
    return out;
  });
}

// A press at x (from the area's left edge) then a click on `row`, as a picker handles it.
let lastCol = null;
function clickAt(zones, x, row) {
  laidOut(zones).find((z) => x >= z.left && x < z.right).press(); // GPUI's hit test: the zone under the pointer
  return pressedCell(row, lastCol);
}

test("the zones cover the area edge to edge, one per column where the cells are drawn", () => {
  const zones = columnZones(PER, CELL, PAD, (c) => { lastCol = c; });
  expect(zones.styles.absolute && zones.styles.inset_0).toBe(true);
  const z = laidOut(zones);
  expect(z.length).toBe(PER + 2);
  expect(z[0]).toMatchObject({ left: 0, right: PAD });
  for (let i = 0; i < PER; i++) expect(z[i + 1]).toMatchObject({ left: PAD + i * CELL, right: PAD + (i + 1) * CELL });
  expect(z.at(-1)).toMatchObject({ left: PAD + PER * CELL, right: WIDTH });
  for (const zone of z) expect(typeof zone.press).toBe("function");
});

test("a click picks exactly the emoji under it: first, middle and last column, any spot in the cell", () => {
  const zones = columnZones(PER, CELL, PAD, (c) => { lastCol = c; });
  const row = { kind: "row", list: emoji(PER) };
  for (let i = 0; i < PER; i++) {
    for (const dx of [0, 1, CELL / 2, CELL - 1]) expect(clickAt(zones, PAD + i * CELL + dx, row)?.e).toBe(`e${i}`);
  }
});

test("beside the columns, past a short row's end (a search's last row) or on a header picks nothing", () => {
  const zones = columnZones(PER, CELL, PAD, (c) => { lastCol = c; });
  const full = { kind: "row", list: emoji(PER) }, short = { kind: "row", list: emoji(3) };
  expect(clickAt(zones, 2, full)).toBe(null); // the left gutter
  expect(clickAt(zones, PAD + PER * CELL + 4, full)).toBe(null); // right of the last column (the scrollbar's side)
  expect(clickAt(zones, PAD + 2 * CELL + 5, short)?.e).toBe("e2");
  expect(clickAt(zones, PAD + 3 * CELL + 5, short)).toBe(null);
  expect(clickAt(zones, PAD + 5, { kind: "head", name: "Smileys" })).toBe(null);
  expect(pressedCell(undefined, 0)).toBe(null); // a row gone from the list
});

test("a press beside the columns forgets the press before it", () => {
  const zones = columnZones(PER, CELL, PAD, (c) => { lastCol = c; });
  const row = { kind: "row", list: emoji(PER) };
  expect(clickAt(zones, PAD + 4 * CELL + 3, row)?.e).toBe("e4");
  expect(clickAt(zones, WIDTH - 2, row)).toBe(null);
  expect(pressedCell(row, null)).toBe(null); // no press seen (the picker clears it after each click)
});

test("both pickers ask the zones, not the press's position", () => {
  for (const f of ["mods/chat-react/main.js", "mods/spaces-chat/icon.js"]) {
    const s = read(f);
    expect(s).toContain('from "./emoji-grid.js"');
    expect(s).toContain("columnZones(PER, CELL, PAD,");
    expect(s).toContain("pressedCell(");
    expect(s).not.toContain("local_position");
    expect(s).toMatch(/const PER = 9, CELL = 36, HEAD = 28, PAD = 6;/);
  }
});
