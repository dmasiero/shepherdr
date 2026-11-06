// fork: which emoji of an emoji picker's row a press was on (mods/chat-react's reaction picker and spaces-chat's icon
// picker, icon.js). The pickers draw their emoji as a virtual list of rows of up to `per` cells, and a virtual list's
// rows can't take handlers, so the list only says which row was clicked (on_item_click). Which cell was worked out
// from the press's local_position on the area around the list, which in the window often wasn't from the area's left
// edge: the click did nothing, or picked an emoji about two to the right. Now a strip of press zones lies over the
// list, outside its renderer, one per column and the gaps beside them: GPUI's own hit test says which column the
// pointer is on, as it does for the cells' hover, with no coordinate math.
import { div } from "gpui-kit";

// The zones, over a list inside an area `pad` px in from each side whose rows' cells are `cell` px wide from the
// left: a child of the area (relative) after the list. Every left press in the area lands on exactly one zone, so
// onPress(column, or null beside the columns) runs on every press and never leaves an older press's column behind.
export function columnZones(per, cell, pad, onPress) {
  const zone = (id, col) => div().id(id).h_full().on_mouse_down("left", () => onPress(col));
  return div().absolute().inset_0().flex()
    .child(zone("emoji-col-lead", null).w(pad).flex_none())
    .children(Array.from({ length: per }, (_, i) => zone(`emoji-col-${i}`, i).w(cell).flex_none()))
    .child(zone("emoji-col-rest", null).flex_1());
}

// The emoji a click on `row` (the clicked row: { kind: "row", list }) at `col` (columnZones' last press) was on, or
// null: a header, past a short row's last emoji, or beside the columns.
export function pressedCell(row, col) {
  if (row?.kind !== "row" || !Number.isInteger(col) || col < 0) return null;
  return row.list[col] ?? null;
}
