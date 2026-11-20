// SHEP-76: a secret card's Decline (the web's, as the window's): keep(level, name, null, card) tells the agent it was
// declined, clears its ask and leaves a quiet "Declined" line in its chat; it never runs herdr-secret (no rm of a kept
// secret). An agent with a dialog open (hc's "blocked") gets the line held in herdr-task's held messages (as SHEP-72's
// Mark up notes), never typed into the dialog. A fake hub, hc, herdr-secret and hold: nothing reaches a real agent.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Secrets } from "./secrets.ts";

const ADDR = "t1";
function world(send: { code: number; stdout: string; stderr: string } = { code: 0, stdout: "{}", stderr: "" }, held = true) {
  const dir = mkdtempSync(join(tmpdir(), "shep76-"));
  const log = join(dir, "hc.log");
  const hc = join(dir, "hc");
  writeFileSync(hc, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`, { mode: 0o755 });
  const sent: { to: string; text: string }[] = [], holds: { to: string; text: string }[] = [], secret: string[][] = [];
  const hub = {
    terminals: new Map([[ADDR, { address: ADDR, state: "live", labels: { "herdr.secret.ask.UNITED_SMS_CODE": "the code by text" } }]]),
    async send(to: string, text: string) { sent.push({ to, text }); return send; },
  };
  const s = new Secrets(hub as any, () => ({ count: 0, remote: false }),
    async (to, text) => { holds.push({ to, text }); return held; },
    async (args: string[]) => { secret.push(args); return { code: 0, out: "[]", err: "" }; });
  const hcLog = () => { try { return readFileSync(log, "utf8").trim().split("\n"); } catch { return []; } };
  return { s, sent, holds, secret, hcLog, hc };
}

async function withHc<T>(hc: string, fn: () => Promise<T>) {
  const was = process.env.SHEPHERDR_HC;
  process.env.SHEPHERDR_HC = hc;
  try { return await fn(); } finally { process.env.SHEPHERDR_HC = was; }
}

test("Decline with a card: the agent hears it was declined, its ask is cleared, no secret is removed", async () => {
  const w = world();
  await withHc(w.hc, () => w.s.keep("all", "UNITED_SMS_CODE", null, { address: ADDR }));
  expect(w.sent).toHaveLength(1);
  expect(w.sent[0].to).toBe(ADDR);
  expect(w.sent[0].text).toContain("Declined: UNITED_SMS_CODE");
  expect(w.hcLog()).toEqual([`label ${ADDR} herdr.secret.ask.UNITED_SMS_CODE=`]);
  // herdr-secret never ran: no rm (nor anything else) for a card's Decline
  expect(w.secret).toEqual([]);
  expect(w.holds).toEqual([]);
  expect(w.s.endsOf(ADDR).map((e) => e.name)).toEqual(["UNITED_SMS_CODE"]);
});

test("without a card, null still removes the kept secret (Settings' Remove), as before", async () => {
  const w = world();
  await withHc(w.hc, () => w.s.keep("all", "UNITED_SMS_CODE", null));
  expect(w.secret).toEqual([["rm", "UNITED_SMS_CODE"]]);
  expect(w.sent).toEqual([]);
});

test("an agent with a dialog open: the declined line is held for it, never forced, and the ask still goes", async () => {
  const blocked = { code: 1, stdout: "", stderr: JSON.stringify({ error: { kind: "blocked", message: "a dialog is open" } }) };
  const w = world(blocked);
  await withHc(w.hc, () => w.s.keep("all", "UNITED_SMS_CODE", null, { address: ADDR }));
  expect(w.holds).toHaveLength(1);
  expect(w.holds[0]).toEqual({ to: ADDR, text: w.sent[0].text });
  expect(w.hcLog()).toEqual([`label ${ADDR} herdr.secret.ask.UNITED_SMS_CODE=`]);
  expect(w.secret).toEqual([]);
});

test("a hold that can't be kept, or another refusal: it says why and the ask stays", async () => {
  const blocked = { code: 1, stdout: "", stderr: JSON.stringify({ error: { kind: "blocked", message: "a dialog is open" } }) };
  const w = world(blocked, false);
  await expect(withHc(w.hc, () => w.s.keep("all", "UNITED_SMS_CODE", null, { address: ADDR }))).rejects.toThrow("waiting on a question");
  expect(w.hcLog()).toEqual([]);
  const gone = world({ code: 1, stdout: "", stderr: JSON.stringify({ error: { kind: "not_found", message: "No such terminal." } }) });
  await expect(withHc(gone.hc, () => gone.s.keep("all", "UNITED_SMS_CODE", null, { address: ADDR }))).rejects.toThrow("No such terminal.");
  expect(gone.hcLog()).toEqual([]);
  expect(gone.s.endsOf(ADDR)).toEqual([]);
});
