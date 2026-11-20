// Mark up's words and its spot in words (Shepherdr 3.0's mods/artifacts/markup.js): click a spot or drag over an area
// of an artifact, write what should change, and Send gives it to the agent that keeps it, with the spot described.
// The window's markup.js is copied into every artifact on its own (herdr-artifact), so it can't import this file: it
// keeps the same words and the same describe(), and core/markup.test.js checks the two stay one.

export const MARKUP = {
  placeholder: "What should change?",
  clear: "Clear spot",
  sending: "Sending…",
  failed: "That didn't go through. Try again.",
  spot: "A note on the marked spot.",
  area: "A note on the marked area.",
  // fork: SHEP-72: the agent has a dialog open (a question, a permission): herdr-artifact holds the note for it
  held: "It's waiting on a question: your note goes to it once that's answered.",
};

// fork: SHEP-72: a failed note's words for the person, from whatever came back: herdr-artifact's {"error": ...} line,
// hc's {"error": {"kind", "message", "hint"}} inside it, or plain words. Only the innermost message, never JSON; the
// hint is for agents.
export function plainNote(raw) {
  let s = String(raw ?? "").trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  for (let i = 0; i < 4 && /^[{"]/.test(s); i++) {
    let v;
    try { v = JSON.parse(s); } catch { break; }
    const e = v && typeof v === "object" ? (v.error ?? v.message) : v;
    if (e && typeof e === "object") s = String(e.message ?? "").trim();
    else if (typeof e === "string") s = e.trim();
    else break;
  }
  return s;
}

// The card's line before anything is marked, and once it went: keeper is the agent's program ("Claude Code"), else
// "the agent".
export const markupHint = (keeper) => `Click a spot or drag over an area, or write to ${keeper} about all of it.`;
export const markupSent = (keeper) => `Sent to ${keeper}. A new version shows here when it's in.`;

const REGION_Y = ["top", "middle", "bottom"], REGION_X = ["left", "center", "right"];

// The spot in words, for the agent: "the 180×80 px area at x 120–300, y 80–160 of the 720×540
// panel (near the top left)".
export function describe(s, size) {
  const W = Math.round(size?.width ?? 0), H = Math.round(size?.height ?? 0);
  const r = (v) => Math.round(v);
  const third = (v, n) => Math.min(2, Math.max(0, Math.floor((v / Math.max(1, n)) * 3)));
  const yx = [REGION_Y[third(s.y + s.h / 2, H)], REGION_X[third(s.x + s.w / 2, W)]];
  const near = yx[0] === "middle" && yx[1] === "center" ? "the middle" : yx[0] === "middle" ? `the middle ${yx[1]}` : yx[1] === "center" ? `the ${yx[0]} center` : `the ${yx[0]} ${yx[1]}`;
  const of = W && H ? ` of the ${W}×${H} panel` : "";
  return s.w || s.h
    ? `the ${r(s.w)}×${r(s.h)} px area at x ${r(s.x)}–${r(s.x + s.w)}, y ${r(s.y)}–${r(s.y + s.h)}${of} (near ${near})`
    : `the point at x ${r(s.x)}, y ${r(s.y)}${of} (near ${near})`;
}
