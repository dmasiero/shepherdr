// File paths in a chat's box, the window's and the web app's (SHEP-50): typing "@~/" at a word's start lists the
// entries of the folder typed so far, on the machine that runs this chat's agent (its home, as "~"). Folders first,
// each with a trailing "/"; hidden ones only once the typed part starts with a dot. Tab fills in what every match
// shares, else takes the chosen one; a folder taken goes into it (the list stays open), a file taken puts its plain
// path in the box ("~/dev/shop/a.js "), no "@" and no link: agents read it as is. A name with a space or a backslash
// is typed and put in with a backslash before it ("~/My\ Files/").
// "@" alone is still tasks (core/mentions.js typingTask): "~" is no task ID's letter, so "@~/" never lists tasks.
// Shared core: the source is core/path-pick.js; bin/sync-shared copies it into the mods in lib/COPIES.

// What a folder lists, run as `sh -c LIST x <folder under home>` ("" is home): one entry a line, a folder's with "/";
// at most 2000 (a huge folder still answers at once).
export const LIST = 'cd "$HOME" 2>/dev/null && cd "./$1" 2>/dev/null || exit 1; for f in .* *; do case "$f" in .|..) continue;; esac; '
  + 'if [ -d "$f" ]; then printf "%s/\\n" "$f"; elif [ -e "$f" ] || [ -L "$f" ]; then printf "%s\\n" "$f"; fi; done | head -n 2000';

// At most this many entries match (the list scrolls over them), and this many show at once.
export const MAX = 50;
export const SHOWN = 8;

export const escape = (s) => String(s).replace(/([\s\\])/g, "\\$1");
export const unescape = (s) => String(s).replace(/\\(.)/g, "$1").replace(/\\$/, "");

// The "@~/..." being typed at the end of the box, else null: { raw, dir, part }. raw: as typed after "@"; dir: the
// folder typed so far ("~/dev/"); part: the start of a name in it ("sh"), both without their backslashes.
export function typingPath(text) {
  const m = /(?:^|\s)@(~\/(?:\\.|[^\s\\])*\\?)$/.exec(String(text ?? "").replace(/\n+$/, ""));
  if (!m) return null;
  const raw = m[1], plain = unescape(raw), i = plain.lastIndexOf("/");
  return { raw, dir: plain.slice(0, i + 1), part: plain.slice(i + 1) };
}

// A typed folder as LIST takes it: under home, without "~/".
export const under = (dir) => String(dir).replace(/^~\/?/, "");

// LIST's output as entries.
export const entriesOf = (stdout) => String(stdout ?? "").split("\n").filter((l) => l && l !== "./" && l !== "../");

const isDir = (e) => e.endsWith("/");
const byName = (a, b) => (isDir(b) - isDir(a)) || a.toLowerCase().localeCompare(b.toLowerCase()) || (a < b ? -1 : a > b ? 1 : 0);

// The entries for what is typed: names that start with it (any case), folders first, then by name.
export function matchPaths(entries, part = "", n = MAX) {
  const p = String(part).toLowerCase(), hidden = p.startsWith(".");
  return entries.filter((e) => (hidden || !e.startsWith(".")) && e.toLowerCase().startsWith(p)).sort(byName).slice(0, n);
}

// What every entry starts with, letter for letter.
export function shared(list) {
  if (!list.length) return "";
  let s = list[0];
  for (const e of list) while (!e.startsWith(s)) s = s.slice(0, -1);
  return s;
}

// A picked entry: its path, and whether the list stays open (a folder, to go into).
export const take = (t, entry) => ({ path: t.dir + entry, open: isDir(entry) });

// Tab: what every match shares when that says more than typed and nothing was chosen (moved: Up/Down were pressed),
// else the chosen one (sel). null when nothing matches.
export function tab(t, list, sel = 0, moved = false) {
  if (!list.length) return null;
  if (!moved && list.length > 1) {
    const s = shared(list);
    if (s.length > t.part.length) return { path: t.dir + s, open: true };
  }
  return take(t, list[Math.max(0, Math.min(sel, list.length - 1))]);
}

// The box with the "@~/..." being typed swapped: still open, "@" and the path to go on with; a file taken, its plain
// path and a space.
export function pathInto(text, r) {
  const s = String(text ?? "").replace(/\n+$/, "");
  const m = /(^|\s)@~\/(?:\\.|[^\s\\])*\\?$/.exec(s);
  if (!m) return s;
  const head = s.slice(0, m.index + m[1].length), path = escape(r.path);
  return r.open ? `${head}@${path}` : `${head}${path} `;
}

// The rows to show: at most SHOWN, the chosen one always among them. { from, rows }.
export function windowOf(list, sel, n = SHOWN) {
  const from = Math.max(0, Math.min(sel - n + 1, list.length - n));
  return { from, rows: list.slice(from, from + n) };
}
