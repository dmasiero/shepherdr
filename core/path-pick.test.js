// fork: SHEP-50's "@~/" path list, redone on 3.2 (core/path-pick.js).
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LIST, entriesOf, keyOf, matchPaths, pathInto, shared, tab, take, typingPath, whereOf } from "./path-pick.js";
import { typingTask } from "./mentions.js";

test('"@~/" or "@/" at a word start is a path being typed; "@word" stays a task', () => {
  expect(typingPath("@~/")).toEqual({ raw: "~/", dir: "~/", part: "" });
  expect(typingPath("look at @~/dev/sh")).toEqual({ raw: "~/dev/sh", dir: "~/dev/", part: "sh" });
  expect(typingPath("@~/dev/shepherdr/\n")).toEqual({ raw: "~/dev/shepherdr/", dir: "~/dev/shepherdr/", part: "" });
  expect(typingPath("@~/My\\ Files/a")).toEqual({ raw: "~/My\\ Files/a", dir: "~/My Files/", part: "a" });
  expect(typingPath("@~/My\\")?.part).toBe("My"); // a backslash just typed, its space to come
  expect(typingPath("@/")).toEqual({ raw: "/", dir: "/", part: "" });
  expect(typingPath("see @/etc/ho")).toEqual({ raw: "/etc/ho", dir: "/etc/", part: "ho" });
  expect(typingPath("a@~/x")).toBe(null);          // inside a word (an address)
  expect(typingPath("a@/x")).toBe(null);
  expect(typingPath("@~")).toBe(null);
  expect(typingPath("@~/dev done")).toBe(null);    // a space ends it
  expect(typingPath("@shep")).toBe(null);
  expect(typingPath("/help")).toBe(null);           // a / command is no path
  // the task list never opens on a path, and still opens on a plain @word
  expect(typingTask("@~/")).toBe(null);
  expect(typingTask("@~/dev/")).toBe(null);
  expect(typingTask("@SHEP")).toBe("SHEP");
});

test("a typed folder as LIST takes it: under home, or under the root", () => {
  expect(whereOf("~/")).toEqual(["~", ""]);
  expect(whereOf("~/dev/shop/")).toEqual(["~", "dev/shop/"]);
  expect(whereOf("/")).toEqual(["/", ""]);
  expect(whereOf("/etc/")).toEqual(["/", "etc/"]);
  expect(whereOf("dev/")).toBe(null);
  expect(whereOf("~x/")).toBe(null);
});

const entries = ["zeta.txt", "Docs/", ".config/", "dev/", "a.md", ".bashrc", "Downloads/", "desk.txt"];

test("folders first, then by name; hidden ones only for a dot", () => {
  expect(matchPaths(entries, "")).toEqual(["dev/", "Docs/", "Downloads/", "a.md", "desk.txt", "zeta.txt"]);
  expect(matchPaths(entries, "d")).toEqual(["dev/", "Docs/", "Downloads/", "desk.txt"]);
  expect(matchPaths(entries, "do")).toEqual(["Docs/", "Downloads/"]);
  expect(matchPaths(entries, ".")).toEqual([".config/", ".bashrc"]);
  expect(matchPaths(entries, "x")).toEqual([]);
  expect(matchPaths(Array.from({ length: 300 }, (_, i) => `f${i}`), "").length).toBe(50);
});

test("Tab: the shared start first, else the chosen entry; a folder stays open", () => {
  const t = typingPath("@~/D");
  const list = matchPaths(["Documents/", "Downloads/", "Docker/"], t.part);
  expect(shared(list)).toBe("Do");
  expect(tab(t, list, 0)).toEqual({ path: "~/Do", open: true });
  const t2 = typingPath("@~/Do");
  expect(tab(t2, list, 0)).toEqual({ path: "~/Docker/", open: true });  // nothing more shared: the chosen one
  expect(tab(t2, list, 2, true)).toEqual({ path: "~/Downloads/", open: true });
  expect(tab(t, list, 1, true)).toEqual({ path: "~/Documents/", open: true }); // chosen with Down: taken, not the start
  expect(tab(t, list, 0, true)).toEqual({ path: "~/Docker/", open: true });    // Down then Up back to the first: taken too
  expect(tab(typingPath("@~/dev/a"), ["app.js"], 0)).toEqual({ path: "~/dev/app.js", open: false });
  expect(tab(t, [], 0)).toBe(null);
  expect(take(typingPath("@~/dev/"), "core/")).toEqual({ path: "~/dev/core/", open: true });
  expect(take(typingPath("@/e"), "etc/")).toEqual({ path: "/etc/", open: true });
});

test("the box after a take: on with @ into a folder, a file's plain path and a space", () => {
  expect(pathInto("see @~/de", { path: "~/dev/", open: true })).toBe("see @~/dev/");
  expect(pathInto("see @~/dev/m", { path: "~/dev/mentions.js", open: false })).toBe("see ~/dev/mentions.js ");
  expect(pathInto("@~/My", { path: "~/My Files/", open: true })).toBe("@~/My\\ Files/");
  expect(pathInto("line one\n@~/a\n", { path: "~/a.txt", open: false })).toBe("line one\n~/a.txt ");
  expect(pathInto("see @/etc/ho", { path: "/etc/hosts", open: false })).toBe("see /etc/hosts ");
  expect(pathInto("no path here", { path: "~/x", open: false })).toBe("no path here");
});

test("the list's keys: Up/Down choose (round), Tab and Enter take, Escape closes, the rest pass", () => {
  const t = typingPath("@~/w"), list = ["work-a/", "work-b/", "wiki.md"];
  const k = (key, more = {}) => ({ key, shift: false, sends: false, ...more });
  expect(keyOf(t, list, 0, false, k("ArrowDown"))).toEqual({ sel: 1, moved: true });
  expect(keyOf(t, list, 0, false, k("ArrowUp"))).toEqual({ sel: 2, moved: true });
  expect(keyOf(t, list, 2, true, k("ArrowDown"))).toEqual({ sel: 0, moved: true });
  expect(keyOf(t, list, 0, false, k("Tab"))).toEqual({ took: { path: "~/work-a/", open: true } }); // nothing more shared than "w": the chosen one
  expect(keyOf(t, ["work-a/", "work-b/"], 0, false, k("Tab"))).toEqual({ took: { path: "~/work-", open: true } });
  expect(keyOf(t, list, 1, true, k("Tab"))).toEqual({ took: { path: "~/work-b/", open: true } });
  expect(keyOf(t, list, 2, true, k("Enter", { sends: true }))).toEqual({ took: { path: "~/wiki.md", open: false } });
  expect(keyOf(t, list, 0, false, k("Escape"))).toEqual({ closed: true });
  expect(keyOf(t, list, 0, false, k("Tab", { shift: true }))).toBe(null);
  expect(keyOf(t, list, 0, false, k("Enter", { shift: true }))).toBe(null); // Shift+Enter: a new line
  expect(keyOf(t, list, 0, false, k("a"))).toBe(null);
  expect(keyOf(t, [], 0, false, k("Tab"))).toBe(null);   // nothing listed: Tab is the page's
  expect(keyOf(null, list, 0, false, k("Tab"))).toBe(null);
});

test("LIST on a real folder: folders with a slash, hidden ones too, a missing folder fails; / is the root", () => {
  const home = mkdtempSync(join(tmpdir(), "path-pick-"));
  try {
    mkdirSync(join(home, "dev/shop"), { recursive: true });
    mkdirSync(join(home, "My Files"));
    writeFileSync(join(home, "dev/a.js"), "");
    writeFileSync(join(home, ".hidden"), "");
    symlinkSync(join(home, "dev"), join(home, "link-dev"));
    symlinkSync(join(home, "gone"), join(home, "broken"));
    const run = (base, rel) => Bun.spawnSync(["sh", "-c", LIST, "x", base, rel], { env: { HOME: home, PATH: process.env.PATH } });
    expect(entriesOf(run("~", "").stdout.toString()).sort()).toEqual([".hidden", "My Files/", "broken", "dev/", "link-dev/"]);
    expect(entriesOf(run("~", "dev/").stdout.toString()).sort()).toEqual(["a.js", "shop/"]);
    expect(entriesOf(run("~", "My Files/").stdout.toString())).toEqual([]);
    expect(run("~", "nope/").exitCode).not.toBe(0);
    // the root: the same folder by its full path
    const rel = home.replace(/^\//, "") + "/dev/";
    expect(entriesOf(run("/", rel).stdout.toString()).sort()).toEqual(["a.js", "shop/"]);
    expect(entriesOf(run("/", "").stdout.toString())).toContain("tmp/");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
