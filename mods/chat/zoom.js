// fork (SHEP-13): the window chat's row heights at the person's zoom. Herdr reports an element's size
// (on_size_change) in pixels at its zoom (settings.json "zoom", View › Zoom), while a virtual list places rows by
// sizes at zoom 1, as `.h()` and every other size in a mod are: at zoom 1.7 each measured row got 1.7 times its
// height, a blank of 0.7 times the row under every row (Doug's tickets Assistant: 316 px under an opened tools
// row). artview.js divides the viewport by the zoom the same way.

// The zoom Herdr draws at, from its settings: 1 when unset or not a number.
export function zoomOf(settings) {
  const z = Number(settings?.zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

// A reported height as the list's size for that row: at zoom 1.
export function listHeight(reported, zoom) {
  return reported / (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
}
