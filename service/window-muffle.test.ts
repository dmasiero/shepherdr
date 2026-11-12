// SHEP-51: Settings › Window's "Muffle other audio during calls" from the web: its row under Voice and dictation, and a
// pick kept as Everywhere's voice.muffle in the settings file (a temp one: HERDR_TASK_SETTINGS), which the call reads.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { windowSection, setWindow } from "./window.ts";
import { muffleLevel } from "../core/duck.js";

test("the muffle's row and a pick from the web", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "muffle-set-")), "settings.json");
  const was = process.env.HERDR_TASK_SETTINGS;
  process.env.HERDR_TASK_SETTINGS = file;
  try {
    writeFileSync(file, JSON.stringify({ version: 1, everywhere: { agents: { reactions: true } } }));
    const rows = windowSection(() => undefined).rows;
    const i = rows.findIndex((r) => r.key === "voice.muffle");
    expect(rows[i - 1].key).toBe("addon.voice");
    expect(rows[i].value).toBe("25%");
    expect(rows[i].options).toEqual(["Off", "10%", "25%", "50%"]);
    await setWindow("voice.muffle", "10%", async () => {});
    const kept = JSON.parse(readFileSync(file, "utf8"));
    expect(kept.everywhere.voice).toEqual({ muffle: 10 });
    expect(kept.everywhere.agents).toEqual({ reactions: true });
    expect(muffleLevel(kept)).toBe(10);
    await setWindow("voice.muffle", "Off", async () => {});
    expect(muffleLevel(JSON.parse(readFileSync(file, "utf8")))).toBe(0);
    expect(windowSection(() => undefined).rows.find((r) => r.key === "voice.muffle")!.value).toBe("Off");
    await expect(setWindow("voice.muffle", "70%", async () => {})).rejects.toThrow();
    // with Voice off, its row can't be changed
    const off = JSON.parse(readFileSync(file, "utf8"));
    off.everywhere.off = ["voice"];
    writeFileSync(file, JSON.stringify(off));
    expect(windowSection(() => undefined).rows.find((r) => r.key === "voice.muffle")!.disabled).toBe(true);
  } finally { if (was === undefined) delete process.env.HERDR_TASK_SETTINGS; else process.env.HERDR_TASK_SETTINGS = was; }
});
