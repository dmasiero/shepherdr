// A recipe artifact's form in the window (mods/artifacts/recipe-view.js, #1026): herdr-app refuses an InputState made
// during render, and the view made each form field's lazily in render(), so every recipe with a form failed
// herdr-artifact's check and nothing was published. Each text field's state is now made in init(), the select's options
// are picked with a click, and the form's reply carries every field's value.
// No window runs here: gpui and herdr are stand-ins, and InputState.new throws while render() runs, as herdr-app does.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeHerdr } from "./fake-herdr";
import { built, byId, fakeGpuiBase, fakeGpuiKit, handler } from "./fake-gpui";

let rendering = false;
const made: any[] = [];
class GuardedInputState {
  static new(o: any) {
    if (rendering) throw new Error("InputState.new(...) cannot run during render; create state in init() or in an event handler and keep it on the view");
    const s = { o, text: "", value: () => s.text };
    made.push(s);
    return s;
  }
}
const theme = new Proxy({}, { get: () => "#000000" });
mock.module("herdr", () => fakeHerdr({ theme: () => theme }));
mock.module("gpui-kit", () => fakeGpuiKit());
mock.module("gpui-base", () => fakeGpuiBase({ InputState: GuardedInputState }));

// An installed recipe artifact as herdr-artifact lays it out: the view, recipe.js, recipe-data.js and artifact.js.
const ROOT = join(import.meta.dir, "..");
const dir = mkdtempSync(join(tmpdir(), "recipe-form-"));
copyFileSync(join(ROOT, "mods/artifacts/recipe-view.js"), join(dir, "recipe-view.js"));
copyFileSync(join(ROOT, "core/recipe.js"), join(dir, "recipe.js"));
writeFileSync(join(dir, "artifact.js"), "export const sent = [];\nexport const asset = (p) => p;\nexport async function reply(t) { sent.push(t); return true; }\n");
const recipe = {
  recipe: 1, title: "Review sheet",
  blocks: [
    { type: "form", id: "f", submit: "Send review", fields: [
      { name: "note", label: "Note", kind: "text" },
      { name: "status", label: "Status", kind: "select", options: ["OK", "Fix", "Skip"] },
    ] },
    // forms inside tabs and details get theirs from init() too
    { type: "tabs", id: "t", tabs: [{ label: "More", blocks: [{ type: "form", id: "g", fields: [{ name: "why", label: "Why", kind: "textarea" }, { name: "done", kind: "checkbox" }] }] }] },
    { type: "details", id: "d", summary: "Extra", blocks: [{ type: "form", id: "h", fields: [{ name: "x" }] }] },
  ],
};
writeFileSync(join(dir, "recipe-data.js"), `export default ${JSON.stringify(recipe)};\n`);
const { default: RecipeView } = await import(join(dir, "recipe-view.js"));
const { sent } = await import(join(dir, "artifact.js"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const cx: any = { notify: () => {}, spawn: (f: any) => f(cx) };
function view() {
  const v: any = Object.create(RecipeView.prototype);
  v.init();
  return v;
}
function render(v: any) {
  built.length = 0;
  rendering = true;
  try { return v.render(cx); } finally { rendering = false; }
}

describe("a recipe's form in the window (#1026)", () => {
  beforeEach(() => { made.length = 0; sent.length = 0; });

  test("every text field's state is made in init, none during render", () => {
    const v = view();
    expect(made.map((s) => s.o.placeholder).sort()).toEqual(["Note", "Why", "x"]);
    expect(made.find((s) => s.o.placeholder === "Why").o.multi_line).toBe(true);
    expect(() => render(v)).not.toThrow();
    // a details block unfolded and another tab picked draw their forms without making state either
    v.open.add("d");
    expect(() => render(v)).not.toThrow();
    expect(made.length).toBe(3);
  });

  test("a select shows its options; a click picks one, and the reply carries both fields", async () => {
    const v = view();
    render(v);
    expect([0, 1, 2].every((i) => byId(`sel-f-status-${i}`))).toBe(true);
    handler(byId("sel-f-status-1"), "on_click")!({}, cx);
    made.find((s) => s.o.placeholder === "Note").text = "Looks good";
    render(v);
    handler(byId("fs-f"), "on_click")!({}, cx);
    await Promise.resolve();
    expect(sent).toEqual(["Send review\nNote: Looks good\nStatus: Fix"]);
  });
});
