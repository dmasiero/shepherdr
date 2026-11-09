// fork: a task's Terminal view shows only that task's own agent (SHEP-8, mods/chat/termblock.js). The task view's
// terminal is one layout block that keeps the last terminal it showed: TIC-2's (t57) under SHEP-7's header (t56).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { wrongTerminal } from "../mods/chat/termblock.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
// The shipped layout's task body, its active child and its terminal block set as the window leaves them.
const tree = (active, terminal) => {
  const t = JSON.parse(read("layouts/shepherdr.json"));
  const find = (n) => (!n || typeof n !== "object" ? null : n.id === "tasks-thread-body" ? n : (n.children ?? []).map(find).find(Boolean) ?? null);
  const body = find(t);
  body.active = active;
  body.children.find((c) => c.id === "tasks-thread-term").content = { terminal };
  return t;
};

test("the shipped layout has the body stack and terminal block the check names", () => {
  const t = tree("tasks-thread-term", "t56");
  expect(JSON.stringify(t)).toContain('"id":"tasks-thread-chat"');
  expect(wrongTerminal(t, "t56", true)).toBe(false);
});

test("a task opened while Terminal showed another task's agent: the wrong terminal", () => {
  // SHEP-7 (done, its agent t56 still live) opened after TIC-2's Terminal (t57)
  expect(wrongTerminal(tree("tasks-thread-term", "t57"), "t56", true)).toBe(true);
  // another machine's agent of the same number is another terminal too
  expect(wrongTerminal(tree("tasks-thread-term", "m3oracle/t56"), "t56", true)).toBe(true);
});

test("its own live agent on Terminal, or its chat shown: nothing to fix", () => {
  expect(wrongTerminal(tree("tasks-thread-term", "t56"), "t56", true)).toBe(false);
  expect(wrongTerminal(tree("tasks-thread-chat", "t57"), "t56", true)).toBe(false);
  expect(wrongTerminal(tree("tasks-thread-files", "t57"), "t56", true)).toBe(false);
});

test("no agent, or one that ended, never shows a terminal", () => {
  expect(wrongTerminal(tree("tasks-thread-term", "t57"), null, false)).toBe(true);
  expect(wrongTerminal(tree("tasks-thread-term", "t56"), "t56", false)).toBe(true);
});

test("the header and the Tasks list use it", () => {
  expect(read("mods/chat/panel.js")).toMatch(/term && wrongTerminal\(layout\(\), addr, live\) && !this\.busy\) cx\.timer\.after\(0, \(\) => showWorkerChat\(\)\)/);
  // upstream's #756 (3.1.28) opens a task on its chat itself, in place of the fork's hook
  expect(read("mods/tasks/main.js")).toMatch(/if \(hasNode\(layout\(\), "tasks-thread-body"\)\) run\("layout\.select", \{ stack: "tasks-thread-body", child: "tasks-thread-chat" \}\)/);
});
