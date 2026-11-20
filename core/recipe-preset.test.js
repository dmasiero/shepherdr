// SHEP-70 (upstream #1212): a form field may start on a preset value; an untouched field sends it.
import { expect, test } from "bun:test";
import { problems, formReply } from "./recipe.js";

const form = (fields) => problems({ recipe: 1, blocks: [{ type: "form", fields }] });

test("a preset value that fits its kind is accepted", () => {
  expect(form([
    { name: "a", kind: "select", options: ["Keep", "Drop"], value: "Drop" },
    { name: "b", kind: "checkbox", value: true },
    { name: "c", kind: "text", value: "hello" },
    { name: "d", kind: "textarea", value: "" },
    { name: "e", value: "no kind is text" },
    { name: "f", kind: "select", options: ["x"] },
  ])).toEqual([]);
});

test("a preset value that doesn't fit is refused, in words", () => {
  const out = form([{ name: "plan", kind: "select", options: ["Keep", "Drop"], value: "Cancel" }]);
  expect(out).toEqual(['block 1 (form): field "plan": value must be one of its options ("Keep", "Drop").']);
  expect(form([{ name: "p", kind: "select", value: "x" }])[0]).toContain("it has none");
  expect(form([{ name: "ok", kind: "checkbox", value: "yes" }])[0]).toContain("true or false");
  expect(form([{ name: "t", kind: "text", value: 3 }])[0]).toContain("must be words");
  expect(form([{ name: "t", kind: "textarea", value: ["x"] }]).length).toBe(1);
});

const b = { submit: "Send review", fields: [
  { name: "gym", label: "Gym", kind: "select", options: ["Keep", "Cancel"], value: "Keep" },
  { name: "tv", label: "TV", kind: "select", options: ["Keep", "Cancel"], value: "Cancel" },
  { name: "news", label: "News", kind: "select", options: ["Keep", "Cancel"] },
  { name: "auto", label: "Auto-renew", kind: "checkbox", value: true },
  { name: "note", label: "Note", kind: "text", value: "fine" },
] };

test("formReply sends each untouched field's preset", () => {
  expect(formReply(b, {})).toBe("Send review\nGym: Keep\nTV: Cancel\nNews: (empty)\nAuto-renew: yes\nNote: fine");
});

test("formReply sends the person's pick where they changed it", () => {
  expect(formReply(b, { tv: "Keep", news: "Cancel", auto: false, note: "" }))
    .toBe("Send review\nGym: Keep\nTV: Keep\nNews: Cancel\nAuto-renew: no\nNote: (empty)");
});
