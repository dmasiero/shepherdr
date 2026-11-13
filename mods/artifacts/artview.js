// The artifact viewer (the person's decision): a chat card, Ctrl+K and a task's proof open an
// artifact here; the Artifacts sidebar shows one in place instead (mods/artifacts). The image
// viewer's shell: mods/chat-image's toolbar (props.artifact, its artifact-bar.js) over the
// artifact's own mod, on a backdrop in the theme's colors. From a chat (its card, or Ctrl+K over
// the shown chat pane) it covers that chat pane only, exactly like an opened image; with no
// pane to cover, the whole window. From a dialog (the Accept card's Proof) it opens as a modal
// of a fitting size over that dialog instead (artifact.modal), and closing it returns there.
// Shared: the source is lib/artview.js; bin/sync-shared copies it into each mod in lib/COPIES.
// Edit lib/artview.js, never a mod's copy, then run bin/sync-shared.

import { exec, appHome, openOverlay, theme, shared, setShared, panes, focused, settings } from "herdr";
import { toast, plainError } from "./ui.js";

const CLI = () => `${appHome()}/mods/artifacts/bin/herdr-artifact`;

// The artifact helper (herdr-artifact, --json); a failure throws its own words.
export async function artifactCli(machine, args) {
  const r = await exec(CLI(), [...(machine ? ["--on", machine] : []), ...args, "--json"]);
  let out = null;
  try { out = JSON.parse(r.stdout.trim().split("\n").pop() || "null"); } catch {}
  if (r.code !== 0 || !out || out.error) throw new Error(out?.error || r.stderr?.trim() || "");
  return out;
}

// The latest version's mod name, from any version's (art-<id>--v<n>).
export const baseMod = (mod) => String(mod).replace(/--v\d+$/, "");

// The viewer's layout: the toolbar over the artifact's own mod, on the backdrop.
export function viewerLayout(artifact) {
  return {
    type: "column", background: `${theme().background}f2`, children: [
      { type: "block", size: { px: 48 }, content: { mod: "chat-image", props: { artifact } } },
      { type: "column", padding: [8, 24], children: [
        { type: "block", radius: 8, background: "background", border: { width: 1, color: "border" }, content: { mod: artifact.mod } }] }],
  };
}

// The modal's size: up to 900×700, and always 40 px clear of the window's edges (the viewport is
// in pixels at this zoom; an overlay's size is at zoom 1).
const MODAL = { width: 900, height: 700 };
function modalSize() {
  let v = null;
  try { v = globalThis.window?.viewport_size?.(); } catch {}
  const zoom = Number(settings()?.zoom) || 1;
  const room = (px, max) => (px > 0 ? Math.max(320, Math.min(max, Math.round(px / zoom) - 80)) : max);
  return { width: room(v?.width, MODAL.width), height: room(v?.height, MODAL.height) };
}

// An artifact opened from a dialog: a modal over it, its toolbar (title, version, X) over the
// artifact's own mod, which scrolls inside. Esc, the X or a click beside it closes it, back to
// the dialog as it was.
function showModal(artifact) {
  openOverlay({ kind: "dialog", ...modalSize(), layout: {
    type: "column", background: "popover", divider: { width: 1, color: "border" }, children: [
      { type: "block", size: { px: 48 }, content: { mod: "chat-image", props: { artifact } } },
      { type: "block", background: "background", content: { mod: artifact.mod } }] } });
}

// Herdr's zoom (View › Zoom). Where things are in the window (a press's place, an element's
// bounds: an area's x, y, width and height) is in pixels at the zoom, while an overlay's width
// and height are at zoom 1 and only its `at` is in the window's pixels (SHEP-42, SHEP-53).
export const zoomOf = () => Number(settings()?.zoom) || 1;

// An area ({ x, y, width, height, zoom }: in the window's pixels at that zoom) still where it was
// noted: the same zoom as now. Another zoom moved and resized everything (Ctrl +/-), so it isn't.
export const areaFits = (a) => Boolean(a) && Math.abs((Number(a.zoom) || 0) - zoomOf()) < 0.001;

// Where the viewer opens and how big: over the area (its top left in the window's pixels, its
// size back at zoom 1, so it covers exactly that area at any zoom), or the whole window (shares
// of it) without one, or when it was noted at another zoom.
export function viewerPlace(area) {
  if (!areaFits(area)) return { width: 1, height: 1, at: { x: 0, y: 0 } };
  const z = zoomOf();
  return { width: Math.round(area.width / z), height: Math.round(area.height / z), at: { x: Math.round(area.x), y: Math.round(area.y) } };
}

// Shows an artifact whose mod is already in this app: over artifact.area (a chat pane, as the
// image viewer opens; see viewerPlace) when it has one, else the whole window; a modal when
// artifact.modal. The area and modal stay in the toolbar's props, so stepping versions reopens it
// in the same place.
export function showViewer(artifact) {
  if (artifact.modal) return showModal(artifact);
  openOverlay({ kind: "popup", frame: "none", ...viewerPlace(artifact.area), layout: viewerLayout(artifact) });
}

// Opens a: { id, title, version, latest?, machine, modal? }: its mod made in this app first (pulled
// from its machine), that version when it's older than the latest. area: the chat pane to cover
// (null: the whole window); modal: a fitting modal instead (from a dialog); show: what shows it
// once pulled (default the viewer).
export function openViewer(a, area = null, show = showViewer) {
  const machine = a.machine ?? null;
  const older = a.latest && a.version && a.version < a.latest;
  return artifactCli(null, ["pull", a.id, ...(machine ? ["--from", machine] : []), ...(older ? ["--version", String(a.version)] : [])])
    .then((out) => show({ mod: out.mod, base: baseMod(out.mod), id: a.id, title: a.title, version: a.version, latest: a.latest ?? a.version, machine, ...(area ? { area } : {}), ...(a.modal ? { modal: true } : {}) }))
    .catch((e) => { toast({ title: "Artifact didn't open", body: plainError(e), level: "error" }); });
}

// Where each chat is in the window, and whether it has the keyboard (shared "chat.areas": { [key]:
// { area: { x, y, width, height } | null, focus, at } }; key: its pane, or "thread" for the task's
// chat inside the Tasks panel), so Ctrl+K opens an artifact over the chat it was pressed in, as a
// card there would. A chat notes its area from the pointer (a move or press on it, the event's
// bounds), only when it changed, and forgets it on a resize (null) until the pointer is back; it
// notes its box getting or losing the keyboard (focus, at: when). An area is in the window's
// pixels at the zoom it was noted at (its zoom): one from another zoom isn't used (areaFits).
const AREAS = "chat.areas";
const KEYS = ["x", "y", "width", "height", "zoom"];
const same = (a, b) => (a && b ? KEYS.every((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0)) < (k === "zoom" ? 0.001 : 1)) : a === b);

export function noteChatArea(key, patch) {
  const all = shared(AREAS) ?? {}, was = all[key] ?? {};
  if (!key) return;
  const live = panes().filter((p) => p.mod === "chat").map((p) => p.pane);
  if (key !== "thread" && !live.includes(key)) return;
  const now = { area: was.area ?? null, focus: was.focus ?? false, at: was.at ?? 0, ...patch };
  // A new area is at this zoom; one kept from before has its own (none: from before zooms were noted, never fits).
  if (patch.area) now.area = { ...Object.fromEntries(KEYS.slice(0, 4).map((k) => [k, Math.round(patch.area[k])])), zoom: patch.area.zoom ?? zoomOf() };
  if (same(now.area ?? null, was.area ?? null) && now.focus === (was.focus ?? false) && now.at === (was.at ?? 0)) return;
  const next = Object.fromEntries(Object.entries(all).filter(([k]) => k === "thread" || live.includes(k)));
  next[key] = now;
  setShared(AREAS, next);
}

// The chat an artifact opens over from Ctrl+K (opened at `since`): the focused pane when it's a
// chat (the zoomed pane only, when one is), or the task's chat in the Tasks panel when the
// keyboard was there instead (its box let go of it as Ctrl+K opened, after the pane's did). null
// when the keyboard was in no chat, or its place isn't known yet (or was noted at another zoom).
export function chatArea(since = Date.now()) {
  const all = shared(AREAS) ?? {}, f = focused();
  const tab = panes().filter((p) => p.tab === f?.tab);
  const shown = tab.some((p) => p.zoomed) ? tab.filter((p) => p.zoomed) : tab;
  const pane = shown.some((p) => p.pane === f?.pane && p.mod === "chat") ? all[f.pane] : null;
  const th = all.thread;
  const thread = th && (th.focus || th.at >= since - 1500) ? th : null;
  const pick = [pane, thread].filter((x) => areaFits(x?.area)).sort((a, b) => (b.focus - a.focus) || (b.at - a.at))[0];
  return pick?.area ?? null;
}
