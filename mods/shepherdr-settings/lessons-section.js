// fork: SHEP-67: Agents › Lessons (herdr-task's lessons.py; Agents that learn, step 5 of 5, designed in SHEP-62).
// At the foot of the Agents page, at the page's level (Everywhere, or one space): the switch
// (lessons.on: off, workers draft none and briefs carry none; kept lessons stay saved), a line on how much of a brief's
// budget the kept lessons use there (12 lessons, 1,500 characters), then each kept lesson: its words, the tasks it came
// from, when it was kept and how often it went into a brief, with Edit and Retire. A space's page folds Everywhere's
// under "Inherited from Everywhere (n)". Edit and Retire run `herdr-task lessons edit|retire <id>` (it checks the words
// as a draft is: no secret, no name), then the file is read again and pushed to the other machines. Every word, and
// the budget, is core/settings.js's (LESSONS, lessonsView), the web app's own.

import { div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { exec, appHome } from "herdr";
import { TEXT, RADIUS, button, link, toggleSwitch } from "./ui.js";
import { LESSONS, lessonsView, lessonsOn } from "./core/settings.js";

const CLI = () => `${appHome()}/mods/tasks/bin/herdr-task`;

// Made in the window's init (a text box needs a live host call).
export function lessonsInit() {
  const l = { box: TextareaState.new({ placeholder: "" }), editing: null, retiring: null, busy: false, err: {}, open: false };
  l.box.set_auto_grow(2, 5);
  return l;
}

// herdr-task's answer: "" when done, else its refusal in its own words.
async function run(view, l, what, id, text = null) {
  const r = await exec(CLI(), ["lessons", what, id, ...(text != null ? ["--text", text] : []), "--json"])
    .catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  let out = null;
  try { out = JSON.parse(r.stdout); } catch {}
  if (r.code !== 0 || out?.error) return out?.error ?? (r.stderr || "herdr-task failed").replace(/^herdr-task: /, "").trim();
  await view.load();
  view.pushRemotes();
  return "";
}

function act(view, l, what, id, text = null) {
  return (_e, cx) => {
    if (l.busy) return;
    l.busy = true;
    l.err[id] = "";
    cx.spawn(async (cx) => {
      const said = await run(view, l, what, id, text === null ? null : text());
      l.busy = false;
      l.err[id] = said;
      if (!said) { l.editing = null; l.retiring = null; }
      cx.notify();
    });
  };
}

// The switch: the same as what this level would follow anyway unsets it (kept lessons stay either way).
function flip(view, next, cx) {
  const parent = view.scope ? lessonsOn(view.cfg, null) : true;
  view.change((cfg) => {
    if (next === parent) return view.drop(view.layerOf(cfg), "lessons", "on");
    const tg = view.target(cfg);
    tg.lessons = { ...(tg.lessons ?? {}), on: next };
  }, cx);
}

// A task it came from: a small mono chip.
const chip = (t, ref) => div().h(18).px(6).flex_none().flex().items_center().rounded(9).bg(t.hover)
  .text_size(TEXT.id).font_family("monospace").text_color(t.muted).child(ref);

function lessonRow(view, t, l, x, dim) {
  const editing = l.editing === x.id, retiring = l.retiring === x.id;
  const meta = [LESSONS.kept(x.keptAt), x.seen ? LESSONS.seen(x.seen) : "", x.edited ? LESSONS.edited : ""].filter(Boolean).join(" · ");
  const words = editing
    ? v_flex().w_full().gap(8)
      .child(Textarea.new(l.box).w_full().px(10).py(8).rounded(RADIUS.control).border(1).border_color(t.accent).bg(t.background)
        .text_size(TEXT.body).line_height("19px").text_color(t.foreground))
      .child(h_flex().w_full().justify_end().gap(6)
        .child(button(`lesson-cancel-${x.id}`, LESSONS.cancel, { kind: "plain", onClick: () => { l.editing = null; l.err[x.id] = ""; } }))
        .child(button(`lesson-save-${x.id}`, LESSONS.save, { disabled: l.busy, onClick: act(view, l, "edit", x.id, () => l.box.value().trim()) })))
    : div().w_full().text_size(TEXT.body).line_height("19px").text_color(dim || x.left ? t.muted : t.foreground).child(x.text);
  const actions = editing || retiring ? null : h_flex().flex_none().gap(12)
    .child(link(`lesson-edit-${x.id}`, LESSONS.edit, () => { l.editing = x.id; l.retiring = null; l.err[x.id] = ""; l.box.set_value(x.text); l.box.focus(); }))
    .child(link(`lesson-retire-${x.id}`, LESSONS.retire, () => { l.retiring = x.id; l.editing = null; l.err[x.id] = ""; }));
  return v_flex().w_full().gap(6).py(10).border_b(1).border_color(t.border)
    .child(words)
    .child(h_flex().w_full().gap(10).items_center()
      .child(h_flex().flex_1().min_w(0).flex_wrap().gap(4).items_center().text_size(TEXT.label).text_color(t.dim)
        .children(x.from.map((r) => chip(t, r)))
        .when(x.from.length > 0, (el) => el.child(div().child("·")))
        .child(div().child(meta)))
      .when(Boolean(actions), (el) => el.child(actions)))
    .when(Boolean(x.left), (el) => el.child(div().text_size(TEXT.label).text_color(t.dim).child(x.left === "same" ? LESSONS.same : LESSONS.left)))
    .when(retiring, (el) => el.child(h_flex().w_full().gap(8).items_center()
      .child(div().flex_1().min_w(0).text_size(TEXT.label).line_height("17px").text_color(t.muted).child(LESSONS.retireAsk))
      .child(button(`lesson-keep-${x.id}`, LESSONS.cancel, { kind: "plain", onClick: () => { l.retiring = null; } }))
      .child(button(`lesson-retire-yes-${x.id}`, LESSONS.retire, { disabled: l.busy, onClick: act(view, l, "retire", x.id) }))))
    .when(Boolean(l.err[x.id]), (el) => el.child(div().text_size(TEXT.label).line_height("17px").text_color(t.blocked).child(l.err[x.id])));
}

// The switch and the list (view: the Settings window; t: its theme).
export function lessonsSection(view, t) {
  const l = view.ls;
  const v = lessonsView(view.cfg, view.scope);
  const line = (text, color = t.dim) => div().pt(8).text_size(TEXT.label).line_height("17px").text_color(color).child(text);
  return v_flex().w_full()
    .child(view.row(t, LESSONS.title, LESSONS.about,
      toggleSwitch("lessons", v.on, (next, _e, cx) => flip(view, next, cx)), view.scoped("lessons", "on")))
    .child(line(v.on ? LESSONS.budget(v.n, v.chars) : LESSONS.off, v.on ? t.muted : t.dim))
    .child(v.own.length ? v_flex().w_full().children(v.own.map((x) => lessonRow(view, t, l, x, false)))
      : line(view.scope ? LESSONS.noneHere : LESSONS.none))
    .when(v.retired > 0, (el) => el.child(line(LESSONS.retired(v.retired))))
    .when(Boolean(view.scope) && v.inherited.length > 0, (el) => el
      .child(div().pt(12).child(link("lessons-inherited", `${l.open ? "⌄" : "›"} ${LESSONS.inherited(v.inherited.length)}`, () => { l.open = !l.open; })))
      .when(l.open, (el) => el.child(v_flex().w_full().children(v.inherited.map((x) => lessonRow(view, t, l, x, true))))));
}
