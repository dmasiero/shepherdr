import { expect, test } from "bun:test";
import { artifactOf, artifactStore } from "./compat.ts";

test("a space's artifact store is herdr-artifact's: the repo's main folder, named as the window's Artifacts header", () => {
  expect(artifactStore({ folder: "/h/u" }, "/h/u")).toEqual({ folder: "/h/u", key: "|/h/u", name: "~" });
  expect(artifactStore({ folder: "/h/u/wt/x", git: { repo: "/h/u/dev/app/.git" } }, "/h/u")).toEqual({ folder: "/h/u/dev/app", key: "|/h/u/dev/app", name: "app" });
  // another machine's home reads "~" there too; its key names the machine
  expect(artifactStore({ folder: "/root", machine: "vm" }, "/h/u")).toEqual({ folder: "/root", key: "vm|/root", name: "~" });
  expect(artifactStore({ folder: "/root/dev/site", machine: "vm" }, "/h/u").name).toBe("site");
});

test("each version says its kind and its window picture: a converted one was a panel, then a recipe", () => {
  const a = artifactOf({ id: "x-1a2b", title: "Plan", version: 2, at: 2, folder: "/h/u", files: ["recipe.json"],
    versions: [{ v: 1, at: 1, kind: "custom", picture: 5 }, { v: 2, at: 2, kind: "recipe" }] }, []);
  expect(a.kind).toBe("recipe");
  expect(a.versions.map((x) => [x.n, x.kind, x.picture])).toEqual([[2, "recipe", undefined], [1, "gpui", 5]]);
});

// fork: SHEP-72: a note to an agent with a dialog open is held, said plainly; a failure is its plain message
test("a held note answers in plain words; a refusal reaches the page as its message, never JSON", async () => {
  const { noteAnswer } = await import("./artifacts.ts");
  const held = noteAnswer({ code: 0, out: '{"to": "t19v", "why": "made it", "version": 1, "image": null, "held": "question"}\n', err: "" });
  expect(held).toMatchObject({ ok: true, held: "question", to: "t19v", said: "It's waiting on a question: your note goes to it once that's answered." });
  expect(noteAnswer({ code: 0, out: '{"to": "t2", "why": "made it", "version": 1, "image": null}\n', err: "" })).toEqual({ to: "t2", why: "made it", version: 1, image: null });
  // as Doug's phone got it: hc's JSON inside herdr-artifact's
  const raw = String.raw`{"error": "{\"error\":{\"hint\":\"typing would answer its dialog; read its screen first (hc read t19v), or --force\",\"kind\":\"blocked\",\"message\":\"t19v is blocked (question)\"}}"}`;
  expect(() => noteAnswer({ code: 1, out: raw + "\n", err: "" })).toThrow(/^t19v is blocked \(question\)$/);
  expect(() => noteAnswer({ code: 1, out: '{"error": "The agent that made this artifact has ended."}\n', err: "" })).toThrow(/^The agent that made this artifact has ended\.$/);
  expect(() => noteAnswer({ code: 1, out: "", err: "herdr-artifact: no such artifact\n" })).toThrow("herdr-artifact: no such artifact");
});
