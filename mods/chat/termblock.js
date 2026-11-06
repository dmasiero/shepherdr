// fork: the task view's Terminal shows only its own task's agent (SHEP-8). Its terminal is one layout block
// ("tasks-thread-term") that keeps the last terminal it was pointed at, and a task opened from the Tasks list (or a
// toast) keeps the body on Terminal: the new task showed the previous one's terminal under its own header. The
// header asks this each render and goes back to the task's chat when it says so (Terminal points the block again).
const find = (node, id) => {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const hit = find(c, id); if (hit) return hit; }
  return null;
};

// Whether the body shows a terminal that isn't the shown task's live agent. tree: layout(); addr: the shown task's
// agent (null: none); live: it runs. body/term: the layout's ids for the body stack and the terminal block.
export function wrongTerminal(tree, addr, live, body = "tasks-thread-body", term = "tasks-thread-term") {
  if (find(tree, body)?.active !== term) return false;
  return !addr || !live || find(tree, term)?.content?.terminal !== addr;
}
