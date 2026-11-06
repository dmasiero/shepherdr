// fork (SHEP-11): an Assistant's log full of turns the chat hides, shaped like the renix Assistant's real one: Herdr's
// task news, a blocked notice, <no-reply> and <hc no-reply/> answers, a reaction and its reaction-only reply, an
// Autopilot wake that answered no-reply with a why, and Claude Code's own bookkeeping lines between them. Through the
// shared core and into the web's chat, only what shows comes out: no empty item, no empty message, nothing in between
// the visible neighbours.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compat } from "./compat.ts";
import * as CL from "../core/chat-log.js";
const { LOG, Conversation, records } = CL as any;

const at = (s: number) => new Date(Date.UTC(2026, 10, 6, 22, 0, s)).toISOString();
let n = 0;
const user = (content: string, s: number) => ({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content }, origin: { kind: "human" }, uuid: `u${n++}`, timestamp: at(s) });
const said = (words: string, s: number) => ({ parentUuid: null, isSidechain: false, type: "assistant", uuid: `a${n++}`, timestamp: at(s),
  message: { model: "claude-opus-5-5", id: `m${n++}`, type: "message", role: "assistant", content: [{ type: "text", text: words }], stop_reason: "end_turn" } });
const ran = (command: string, s: number) => ({ parentUuid: null, isSidechain: false, type: "assistant", uuid: `a${n++}`, timestamp: at(s),
  message: { model: "claude-opus-5-5", id: `m${n++}`, type: "message", role: "assistant", content: [{ type: "tool_use", id: `toolu_${n}`, name: "Bash", input: { command } }], stop_reason: "tool_use" } });
const result = (s: number) => ({ parentUuid: null, isSidechain: false, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${n}`, content: "ok" }] }, uuid: `r${n++}`, timestamp: at(s) });
// what Claude Code writes between turns (the real log has these around every hidden turn)
const noise = (s: number) => [
  { parentUuid: null, isSidechain: false, type: "system", subtype: "turn_duration", durationMs: 958, timestamp: at(s) },
  { type: "file-history-snapshot", messageId: `f${n++}`, snapshot: {} },
];
const news = (ref: string, event: string, words: string) => `<herdr-news task="${ref}" event="${event}">${ref} ${words}</herdr-news>`;

async function conv(lines: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "hidden-turns-"));
  const f = join(dir, "log.jsonl");
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const out = await new Response(Bun.spawn(["sh", "-c", LOG, "log", "tail", f, "0"], { stdout: "pipe", stderr: "ignore" }).stdout).text();
  rmSync(dir, { recursive: true });
  const c = new Conversation("claude");
  c.feed(records(out).records);
  return c;
}

const LOG_LINES = [
  user("Fix the fetch, please", 0),
  said("SHEP-10 is ready for you to accept.", 1), ...noise(1),
  user(news("SHEP-10", "done", "is done: merged (Fork tree)"), 2), said("<no-reply>", 3), ...noise(3),
  user("renix full completed - how we looking?", 4),
  ran("grep -n rev pkgs/shepherdr.nix", 5), result(5),
  said("Everything is on nextgate.", 6), ...noise(6),
  user("<hc>t5b shep-9-leak is blocked (question). See: hc read t5b</hc>", 7),
  ran("hc read t5b --lines 60", 8), result(8),
  said("SHEP-9 found the cause.", 9), ...noise(9),
  user(news("SHEP-9", "needs-you", "needs you: Found it (Leak)"), 10), said("<hc no-reply/>", 11), ...noise(11),
  user('<hc from="person" reaction="👍" to="SHEP-9 found the cause."/>', 12), said("<hc no-reply/>", 13),
  user("Thanks", 14), said('<hc react="❤️" to="Thanks"/>', 15), ...noise(15),
  user('<herdr-autopilot reason="schedule" space="sp1">\nAutopilot wake: schedule.\n</herdr-autopilot>', 16),
  said('<hc no-reply why="Waiting on your Accept of SHEP-9"/>', 17), ...noise(17),
  user("Next?", 18),
];

test("hidden turns make no item: only what shows, in order", async () => {
  const c = await conv(LOG_LINES);
  const shown = c.items.filter((x: any) => x.kind !== "mark").map((x: any) => (x.kind === "news" ? `news ${x.ref} ${x.event}` : x.kind === "pilot" ? "pilot" : x.kind === "tools" ? "tools" : `${x.kind}: ${x.text}`));
  expect(shown).toEqual([
    "user: Fix the fetch, please", "agent: SHEP-10 is ready for you to accept.", "news SHEP-10 done",
    "user: renix full completed - how we looking?", "tools", "agent: Everything is on nextgate.",
    "tools", "agent: SHEP-9 found the cause.", "news SHEP-9 needs-you",
    "user: Thanks", "pilot", "user: Next?",
  ]);
  // no message without words to show
  for (const x of c.items) if (x.kind === "user" || x.kind === "agent") expect(String(x.text ?? "").trim()).not.toBe("");
  // the wake keeps its why on its own line
  expect(CL.pilotLine(c.items.find((x: any) => x.kind === "pilot"))).toBe("Autopilot woke · on schedule · Waiting on your Accept of SHEP-9");
  // the reactions land on their messages instead
  const reacts = [...c.reactions.values()].flat().map((r: any) => `${r.by} ${r.emoji}`).sort();
  expect(reacts).toEqual(["agent ❤️", "you 👍"]);
});

test("the web's chat gets no empty message from them", async () => {
  const c = await conv(LOG_LINES);
  const compat = new Compat() as any;
  compat.rows = [
    { space: "local/s1", ref: "SHEP-9", title: "Leak", section: "needs" },
    { space: "local/s1", ref: "SHEP-10", title: "Fork tree", section: "done" },
  ];
  const chat = compat.chat("p:local:s1", { conv: c, start: 0, machine: null, addr: "t9", kind: "claude" }, { labels: {} });
  const rows = chat.messages.map((m: any) => (m.news ? `news ${m.news.ref} ${m.news.what}` : m.activity ? "tools" : m.pilot ? `pilot ${m.pilot}` : `${m.who}: ${m.text}`));
  expect(rows).toEqual([
    "you: Fix the fetch, please", "agent: SHEP-10 is ready for you to accept.", "news SHEP-10 done",
    "you: renix full completed - how we looking?", "tools", "agent: Everything is on nextgate.",
    "tools", "agent: SHEP-9 found the cause.", "news SHEP-9 needs you",
    "you: Thanks", "pilot Autopilot woke · on schedule · Waiting on your Accept of SHEP-9", "you: Next?",
  ]);
  // every message draws something: words, a quiet line, a picture or a card
  for (const m of chat.messages) expect(Boolean(m.text?.trim() || m.news || m.activity || m.pilot || m.brief || m.file || m.images || m.question || m.artifact)).toBe(true);
});
