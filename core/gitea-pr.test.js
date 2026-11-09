// fork (FORK.md, docs/gitea.md): a task's Gitea pull request in the views (web Pull request, the window's task-pr),
// read through tea in the shape gh's answer gets (core/worktree.js giteaPr). A fake tea; the real one is never run.
import { describe, expect, test } from "bun:test";
import { giteaPr, isGitea, VIEW_WORDS } from "./worktree.js";
import { readFileSync } from "node:fs";

const SHA = "a".repeat(40);
const PR = { number: 3, url: "https://gitea.test/o/r/pulls/3", repo: "o/r", forge: "gitea", login: "t", web: "https://gitea.test" };
const pull = { number: 3, title: "SHEP-1 Notes", state: "open", merged: false, html_url: "https://gitea.test/o/r/pulls/3",
  head: { ref: "task/1", sha: SHA }, base: { ref: "main" }, additions: 4, deletions: 1, changed_files: 2 };

function fakeTea(routes) {
  const asked = [];
  const tea = async (args) => {
    asked.push(args);
    const path = args[args.length - 1];
    const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
    return hit ? { code: 0, stdout: JSON.stringify(hit[1]), stderr: "" } : { code: 0, stdout: '{"message":"not found"}', stderr: "" };
  };
  return { tea, asked };
}

describe("a Gitea pull request", () => {
  test("only a record herdr-task made on Gitea counts", () => {
    expect(isGitea(PR)).toBe(true);
    expect(isGitea({ number: 3, url: "u", repo: "o/r" })).toBe(false);
    expect(isGitea({ ...PR, login: undefined })).toBe(false);
  });

  test("its state, size and checks, as gh's answer shows them", async () => {
    const { tea, asked } = fakeTea({
      "repos/o/r/pulls/3": pull,
      [`repos/o/r/commits/${SHA}/status`]: { statuses: [
        { context: "ci / build", status: "success", target_url: "/o/r/actions/runs/7/jobs/0" },
        { context: "ci / lint", status: "failure", target_url: "" },
        { context: "deploy", status: "pending" }] },
    });
    const { pr } = await giteaPr(tea, PR);
    expect(pr).toEqual({ number: 3, title: "SHEP-1 Notes", url: PR.url, state: "open", head: "task/1", base: "main", add: 4, del: 1, files: 2,
      forge: "gitea", checks: [
        { name: "ci / lint", url: null, state: "fail" },
        { name: "deploy", url: null, state: "pending" },
        { name: "ci / build", url: "https://gitea.test/o/r/actions/runs/7/jobs/0", state: "pass" }] });
    expect(asked.every((a) => a[0] === "api" && a[1] === "--login" && a[2] === "t")).toBe(true);
  });

  test("merged, and work in progress", async () => {
    expect((await giteaPr(fakeTea({ "repos/o/r/pulls/3": { ...pull, state: "closed", merged: true } }).tea, PR)).pr.state).toBe("merged");
    expect((await giteaPr(fakeTea({ "repos/o/r/pulls/3": { ...pull, title: "WIP: notes" } }).tea, PR)).pr.state).toBe("draft");
  });

  test("Gitea's error is said, never shown as no pull request", async () => {
    expect(await giteaPr(fakeTea({}).tea, PR)).toEqual({ error: "not found" });
    const down = async () => ({ code: 1, stdout: "", stderr: "Error: login name 't' does not exist\n" });
    expect(await giteaPr(down, PR)).toEqual({ error: "Error: login name 't' does not exist" });
  });

  test("unreadable checks are said", async () => {
    const { pr } = await giteaPr(fakeTea({ "repos/o/r/pulls/3": pull }).tea, PR);
    expect(pr.checksError).toBe("Couldn't read its checks on Gitea.");
  });

  test("the window's Pull request says Gitea's words", () => {
    const window = readFileSync(new URL("../mods/task-pr/main.js", import.meta.url), "utf8");
    for (const w of [VIEW_WORDS.askingGitea, VIEW_WORDS.openOnGitea]) expect(window.includes(w)).toBe(true);
  });
});
