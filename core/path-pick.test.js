import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { LIST, entriesOf, matchPaths, pathInto, shared, tab, take, typingPath, under, windowOf } from "./path-pick.js";
import { typingTask } from "./mentions.js";

test('"@~/" at a word start is a path being typed; "@word" stays a task', () => {
  expect(typingPath("@~/")).toEqual({ raw: "~/", dir: "~/", part: "" });
  expect(typingPath("look at @~/dev/sh")).toEqual({ raw: "~/dev/sh", dir: "~/dev/", part: "sh" });
  expect(typingPath("@~/dev/shepherdr/\n")).toEqual({ raw: "~/dev/shepherdr/", dir: "~/dev/shepherdr/", part: "" });
  expect(typingPath("@~/My\\ Files/a")).toEqual({ raw: "~/My\\ Files/a", dir: "~/My Files/", part: "a" });
  expect(typingPath("@~/My\\")?.part).toBe("My"); // a backslash just typed, its space to come
  expect(typingPath("a@~/x")).toBe(null);          // inside a word (an address)
  expect(typingPath("@~")).toBe(null);
  expect(typingPath("@~/dev done")).toBe(null);    // a space ends it
  expect(typingPath("@shep")).toBe(null);
  // the task list never opens on a path, and still opens on a plain @word
  expect(typingTask("@~/")).toBe(null);
  expect(typingTask("@~/dev/")).toBe(null);
  expect(typingTask("@SHEP")).toBe("SHEP");
  expect(typingTask("@")).toBe("");
});

test("a typed folder as LIST takes it, under home", () => {
  expect(under("~/")).toBe("");
  expect(under("~/dev/shop/")).toBe("dev/shop/");
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
  expect(tab(typingPath("@~/dev/a"), ["app.js"], 0)).toEqual({ path: "~/dev/app.js", open: false });
  expect(tab(t, [], 0)).toBe(null);
  expect(take(typingPath("@~/dev/"), "core/")).toEqual({ path: "~/dev/core/", open: true });
});

test("the box after a take: on with @ into a folder, a file's plain path and a space", () => {
  expect(pathInto("see @~/de", { path: "~/dev/", open: true })).toBe("see @~/dev/");
  expect(pathInto("see @~/dev/m", { path: "~/dev/mentions.js", open: false })).toBe("see ~/dev/mentions.js ");
  expect(pathInto("@~/My", { path: "~/My Files/", open: true })).toBe("@~/My\\ Files/");
  expect(pathInto("line one\n@~/a\n", { path: "~/a.txt", open: false })).toBe("line one\n~/a.txt ");
  expect(pathInto("no path here", { path: "~/x", open: false })).toBe("no path here");
});

test("the rows shown keep the chosen one in view", () => {
  const list = Array.from({ length: 20 }, (_, i) => `f${i}`);
  expect(windowOf(list, 0)).toEqual({ from: 0, rows: list.slice(0, 8) });
  expect(windowOf(list, 7).from).toBe(0);
  expect(windowOf(list, 8).from).toBe(1);
  expect(windowOf(list, 19).from).toBe(12);
  expect(windowOf(["a", "b"], 1)).toEqual({ from: 0, rows: ["a", "b"] });
});

test("LIST on a real folder: folders with a slash, hidden ones too, a missing folder fails", () => {
  const home = mkdtempSync(join(tmpdir(), "path-pick-"));
  try {
    mkdirSync(join(home, "dev/shop"), { recursive: true });
    mkdirSync(join(home, "My Files"));
    writeFileSync(join(home, "dev/a.js"), "");
    writeFileSync(join(home, ".hidden"), "");
    symlinkSync(join(home, "dev"), join(home, "link-dev"));
    symlinkSync(join(home, "gone"), join(home, "broken"));
    const run = (rel) => Bun.spawnSync(["sh", "-c", LIST, "x", rel], { env: { HOME: home, PATH: process.env.PATH } });
    const top = run("");
    expect(entriesOf(top.stdout.toString()).sort()).toEqual([".hidden", "My Files/", "broken", "dev/", "link-dev/"]);
    expect(entriesOf(run("dev/").stdout.toString()).sort()).toEqual(["a.js", "shop/"]);
    expect(entriesOf(run("My Files/").stdout.toString())).toEqual([]);
    expect(run("nope/").exitCode).not.toBe(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
