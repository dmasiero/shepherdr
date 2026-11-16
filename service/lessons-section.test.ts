// fork: SHEP-67: the window's Settings › Agents › Lessons (mods/shepherdr-settings/lessons-section.js), drawn with gpui
// stand-ins (fake-gpui.ts: no window runs here): the switch, the budget line, each kept lesson with its task chips, kept
// date and seen count; Edit and Retire run `herdr-task lessons edit|retire <id>`, then the file is read again and pushed;
// a space folds Everywhere's. Fake settings only.
import { beforeEach, expect, mock, test } from "bun:test";
import { built, byId, dispatch, element, fakeGpuiBase, fakeGpuiKit } from "./fake-gpui";
import { fakeHerdr } from "./fake-herdr";

const ran: string[][] = [];
let answer = { code: 0, stdout: "{}", stderr: "" };
mock.module("gpui-kit", () => fakeGpuiKit());
mock.module("gpui-base", () => fakeGpuiBase({
  // a text box that keeps its words
  TextareaState: { new: () => { let v = ""; return { set_value: (x: string) => { v = x; }, value: () => v, set_auto_grow: () => {}, focus: () => {}, on: () => {} }; } },
}));
mock.module("herdr", () => fakeHerdr({
  appHome: () => "/app", theme: () => new Proxy({}, { get: () => "#000" }),
  exec: async (cmd: string, args: string[]) => { ran.push([cmd, ...args]); return answer; },
}));
const { lessonsInit, lessonsSection } = await import("../mods/shepherdr-settings/lessons-section.js");
const C: any = await import("../core/settings.js");

const kept = (id: string, text: string, extra: object = {}) => ({ id, text, key: text, from: ["ACC-1", "ACC-7"], kept_at: Date.UTC(2026, 10, 16, 12), seen: 2, off: false, ...extra });
function viewOf(cfg: any, scope: string | null = null) {
  const v: any = {
    cfg, scope, ls: lessonsInit(), loads: 0, pushes: 0, rows: [] as any[],
    heading: (_t: unknown, text: string) => element("heading").child(text),
    row: (_t: unknown, title: string, about: string, control: any, sc: any) => { v.rows.push({ title, about, control, sc }); return element("row").child(title).child(about).child(control); },
    scoped: (key: string, field: string) => ({ id: `${key}-${field}` }),
    change: (edit: (cfg: any) => void) => edit(v.cfg),
    drop: (own: any, key: string, field: string) => { if (own?.[key]) { delete own[key][field]; if (!Object.keys(own[key]).length) delete own[key]; } },
    layerOf: (cfg: any) => (v.scope ? cfg.spaces?.[v.scope] : cfg.everywhere),
    target: (cfg: any) => (v.scope ? ((cfg.spaces ??= {})[v.scope] ??= {}) : (cfg.everywhere ??= {})),
    load: async () => { v.loads++; },
    pushRemotes: () => { v.pushes++; },
  };
  return v;
}
// every string drawn under an element
const words = (e: any): string[] => (typeof e === "string" ? [e] : e?.kids ? e.kids.flatMap(words) : []);
const cx = { spawn: (f: (cx: any) => Promise<void>) => f(cx), notify: () => {} };
const click = async (id: string) => { const el = byId(id); expect(el).toBeDefined(); dispatch(el, "on_click", cx); await Bun.sleep(0); };

beforeEach(() => { built.length = 0; ran.length = 0; answer = { code: 0, stdout: "{}", stderr: "" }; });

test("the switch, the budget line, and each kept lesson with its chips, kept date and seen count", () => {
  const view = viewOf({ everywhere: { lessons: { kept: [kept("l-1-1", "Record and commit a paid receipt's row without asking."), kept("l-2-1", "Old one.", { off: true })] } } });
  const drawn = words(lessonsSection(view, {}));
  expect(drawn).toContain("Lessons");
  expect(drawn).toContain(C.LESSONS.about);
  expect(drawn).toContain(`In briefs: 1 of 12 · ${"- Record and commit a paid receipt's row without asking.\n".length} of 1,500 characters`);
  expect(drawn).toContain("Record and commit a paid receipt's row without asking.");
  expect(drawn).toEqual(expect.arrayContaining(["ACC-1", "ACC-7", "kept Nov 16 · seen 2", "Edit", "Retire", C.LESSONS.retired(1)]));
  expect(drawn).not.toContain("Old one.");
  expect(view.rows[0].sc).toEqual({ id: "lessons-on" });
});

test("Edit runs herdr-task lessons edit with the new words, then reads the file again and pushes it", async () => {
  const view = viewOf({ everywhere: { lessons: { kept: [kept("l-1-1", "Say where the files are.")] } } });
  lessonsSection(view, {});
  await click("lesson-edit-l-1-1");
  expect(view.ls.editing).toBe("l-1-1");
  expect(view.ls.box.value()).toBe("Say where the files are.");
  view.ls.box.set_value("  Say where the files are when you ask me to review. ");
  built.length = 0;
  lessonsSection(view, {});
  await click("lesson-save-l-1-1");
  expect(ran).toEqual([["/app/mods/tasks/bin/herdr-task", "lessons", "edit", "l-1-1", "--text", "Say where the files are when you ask me to review.", "--json"]]);
  expect([view.ls.editing, view.loads, view.pushes]).toEqual([null, 1, 1]);
});

test("Retire asks first; a refusal shows in herdr-task's words and changes nothing", async () => {
  const view = viewOf({ everywhere: { lessons: { kept: [kept("l-1-1", "Say where the files are.")] } } });
  lessonsSection(view, {});
  await click("lesson-retire-l-1-1");
  expect(ran).toEqual([]);
  built.length = 0;
  expect(words(lessonsSection(view, {}))).toContain(C.LESSONS.retireAsk);
  answer = { code: 1, stdout: JSON.stringify({ error: "This machine's Shepherdr settings are a copy." }), stderr: "" };
  await click("lesson-retire-yes-l-1-1");
  expect(ran[0].slice(1)).toEqual(["lessons", "retire", "l-1-1", "--json"]);
  expect(view.ls.err["l-1-1"]).toBe("This machine's Shepherdr settings are a copy.");
  expect(view.ls.retiring).toBe("l-1-1");
  expect(view.loads).toBe(0);
});

test("off: says so, and the switch keeps kept lessons; in a space, Everywhere's value unsets its own", async () => {
  const cfg: any = { everywhere: { lessons: { on: false, kept: [kept("l-1-1", "Say where the files are.")] } }, spaces: { sp1: { lessons: { on: true } } } };
  const every = viewOf(cfg);
  expect(words(lessonsSection(every, {}))).toContain(C.LESSONS.off);
  // Everywhere back on: on is the default, so it's unset and the kept lesson stays
  every.rows[0].control.calls.find(([n]: [string]) => n === "on_click")[1][0]({}, { stop_propagation: () => {}, notify: () => {} });
  expect(cfg.everywhere.lessons).toEqual({ kept: [expect.objectContaining({ id: "l-1-1" })] });
  // the space's own on is now the same as Everywhere's: unset, it follows again; it folds Everywhere's lesson
  const sp = viewOf(cfg, "sp1");
  const drawn = words(lessonsSection(sp, {}));
  expect(drawn).toContain(C.LESSONS.noneHere);
  expect(drawn.some((w) => w.includes(C.LESSONS.inherited(1)))).toBe(true);
  sp.rows[0].control.calls.find(([n]: [string]) => n === "on_click")[1][0]({}, { stop_propagation: () => {}, notify: () => {} });
  expect(cfg.spaces.sp1.lessons.on).toBe(false);
  sp.rows.length = 0;
  lessonsSection(sp, {});
  sp.rows[0].control.calls.find(([n]: [string]) => n === "on_click")[1][0]({}, { stop_propagation: () => {}, notify: () => {} });
  expect(cfg.spaces.sp1.lessons).toBeUndefined();
});

// the service's action (service/actions.ts lessonAct): only keep, edit, drop or retire, a lesson's id, and words for an
// edit, before any herdr-task runs; a task's draft needs its task here
test("the web's lesson action refuses what isn't one before running anything", async () => {
  const { lessonAct } = await import("./actions.ts");
  const compat: any = { taskOf: () => null };
  await expect(lessonAct({ what: "rm", id: "l-1-1" }, compat)).rejects.toThrow("Not something a lesson can do.");
  await expect(lessonAct({ what: "retire", id: "--json; rm" }, compat)).rejects.toThrow("Not a lesson.");
  await expect(lessonAct({ what: "edit", id: "l-1-1", text: "   " }, compat)).resolves.toEqual({ ok: false, error: "Give it some words: one short rule." });
  await expect(lessonAct({ what: "keep", id: "l-1-1", task: "ACC-9" }, compat)).rejects.toThrow("That task isn't here any more.");
});
