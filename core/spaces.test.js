import { expect, test } from "bun:test";
import { spaceName, tilde, sharedNames, gitTail, inOrder, withOrder, keptOrder, machinesInOrder, byMachineOrder, withMachineOrder, machineOrderOf, sectionMoved, withSectionOrder } from "./spaces.js"; // fork: sectionMoved, withSectionOrder (SHEP-14)

test("two spaces with one name on a machine each show their folder, from ~ (the sidebar's rows, both sides)", () => {
  // built, so the repo's no-home-paths rule has nothing to find
  expect(tilde(["", "home", "u", "dev", "app"].join("/"))).toBe("~/dev/app");
  expect(tilde(["", "Users", "u"].join("/"))).toBe("~");
  expect(tilde("/srv/app")).toBe("/srv/app");
  const rows = [
    { id: "a", machine: null, name: "Home" }, { id: "b", machine: null, name: "home" }, { id: "c", machine: "vm", name: "Home" },
    { id: "d", machine: null, name: "app" }, { id: "e", machine: null, name: "app", linked: true },
  ];
  expect([...sharedNames(rows)].sort()).toEqual(["a", "b"]);
});

test("a space is called as the window's sidebar calls it, never ~", () => {
  expect(spaceName({ name: "web", folder: "/x/y" })).toBe("web");
  expect(spaceName({ name: "~", folder: "/srv/u" }, { home: "/srv/u" })).toBe("Home");
  expect(spaceName({ name: "~", folder: "/tmp/abc/tt-repo" })).toBe("tt-repo");
  expect(spaceName({ name: "~", folder: "/root/" })).toBe("Home");
  expect(spaceName({ name: "", folder: "/srv/app" }, { repo: "app-repo" })).toBe("app-repo");
  expect(spaceName({ name: "dev", folder: "/srv/app" }, { named: false, repo: "app" })).toBe("app");
});

test("after a space's name only its repo and branch where unusual, no ahead/behind counts (SHEP-32)", () => {
  expect(gitTail({ name: "herdr", branch: "spike", ahead: 2, behind: 1 }, { name: "web" })).toEqual({ where: "herdr · spike" });
  expect(gitTail({ name: "web", branch: "main" }, { name: "web" })).toEqual({ where: "" });
  expect(gitTail({ name: "herdr", branch: null }, { name: "herdr", tag: "mini" })).toEqual({ where: "mini · detached" });
});

// SHEP-130: a dragged order holds, whatever Herdr's own order is
const sp = (id, machine = null) => ({ id, machine });
const ids = (l) => l.map((s) => s.id);

test("each machine's spaces show in the dragged order; the machines keep their slots", () => {
  // Herdr's order: this computer's, then vm's from its document, then a space the service made on vm (always last)
  const list = [sp("a"), sp("b"), sp("vm/t"), sp("vm/s"), sp("vm/home", "vm")].map((s) => ({ ...s, machine: s.id.startsWith("vm/") ? "vm" : null }));
  expect(ids(inOrder(list, undefined))).toEqual(["a", "b", "vm/t", "vm/s", "vm/home"]);
  const order = { vm: ["vm/home", "vm/t", "vm/s"], "": ["b", "a"] };
  expect(ids(inOrder(list, order))).toEqual(["b", "a", "vm/home", "vm/t", "vm/s"]);
});

test("a space the order doesn't name keeps its place after the one before it in Herdr's; a gone one is skipped", () => {
  const list = [sp("a"), sp("new"), sp("b"), sp("c")];
  expect(ids(inOrder(list, { "": ["c", "a", "gone", "b"] }))).toEqual(["c", "a", "new", "b"]);
  expect(ids(inOrder([sp("first"), sp("a"), sp("b")], { "": ["b", "a"] }))).toEqual(["first", "b", "a"]);
});

test("a drag keeps the spaces it didn't show (in a section, hidden) where they were, and the other machines' orders", () => {
  const d = withOrder({ pinned: ["x"], order: { vm: ["vm/2", "vm/1"] } }, null, ["c", "a"], ["a", "s", "b", "c"]);
  expect(d.order).toEqual({ vm: ["vm/2", "vm/1"], "": ["c", "a", "s", "b"] });
  expect(d.pinned).toEqual(["x"]);
  expect(withOrder({}, "vm", ["vm/home", "vm/t"]).order).toEqual({ vm: ["vm/home", "vm/t"] });
  expect(keptOrder(["a", "b", "c"], ["c", "a"])).toEqual(["c", "a", "b"]);
});

// SHEP-153: the machines in the order the person dragged them into
test("machines show in the saved order; a new one goes last, a gone one leaves no gap", () => {
  expect(machinesInOrder([null, "vm", "mini"], undefined)).toEqual(["", "vm", "mini"]);
  expect(machinesInOrder([null, "vm", "mini", "new"], ["mini", "gone", "", "vm"])).toEqual(["mini", "", "vm", "new"]);
  const list = [sp("a"), sp("vm/1", "vm"), sp("b"), sp("mini/1", "mini"), sp("vm/2", "vm")];
  expect(ids(byMachineOrder(list, ["mini", "vm"]))).toEqual(["mini/1", "vm/1", "vm/2", "a", "b"]);
  expect(ids(byMachineOrder(list, []))).toEqual(ids(list));
});

test("a machine drag keeps the ones it didn't show where they were, and the rest of the sidebar's data", () => {
  const d = withMachineOrder({ pinned: ["x"], machineOrder: ["", "far", "vm"] }, ["vm", null]);
  expect(d.machineOrder).toEqual(["vm", "", "far"]);
  expect(d.pinned).toEqual(["x"]);
  expect(machineOrderOf({ machineOrder: ["a", 3, "b"] })).toEqual(["a", "b"]);
});

// fork: dragging a section among its machine's (SHEP-14), the window's and the web's

test("a dragged section takes the place of the one it's dropped on, the rest shift toward where it was (SHEP-14)", () => {
  expect(sectionMoved(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
  expect(sectionMoved(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  expect(sectionMoved(["a", "b", "c"], "b", "c")).toEqual(["a", "c", "b"]);
  const same = ["a", "b"];
  expect(sectionMoved(same, "a", "a")).toBe(same);
  expect(sectionMoved(same, "a", "z")).toBe(same);
});

test("a machine's sections reordered keep every other machine's where they were, and nothing else changes (SHEP-14)", () => {
  const d = { pinned: ["p"], icons: { x: "🏠" }, sections: [
    { id: "a", machine: null, name: "A", spaces: ["s1"] }, { id: "v1", machine: "vm", name: "V1", spaces: [] },
    { id: "b", machine: null, name: "B", spaces: [] }, { id: "c", machine: null, name: "C", spaces: ["s2"], icon: "📦" },
  ] };
  const x = withSectionOrder(d, ["c", "a", "b"]);
  expect(x.sections.map((s) => s.id)).toEqual(["c", "v1", "a", "b"]);
  expect(x.sections[0]).toEqual(d.sections[3]);
  expect(x.pinned).toEqual(["p"]);
  expect(x.icons).toEqual({ x: "🏠" });
  expect(d.sections.map((s) => s.id)).toEqual(["a", "v1", "b", "c"]);   // the one it was given stays as it was
  // a partial or stale list: only those it names (and knows) move among their own places
  expect(withSectionOrder(d, ["b", "gone", "a"]).sections.map((s) => s.id)).toEqual(["b", "v1", "a", "c"]);
  expect(withSectionOrder({}, ["a"]).sections).toEqual([]);
});
