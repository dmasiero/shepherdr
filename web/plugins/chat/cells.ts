// fork: Wide chat tables on phone. Its own module, as other tests mock markdown.tsx whole.
/** a table cell long enough to need a minimum width: a few words or more, not a number, a name or a short word */
export const longCell = (text: string) => text.trim().length > 24
