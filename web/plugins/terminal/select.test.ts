// fork: Select text in phone terminal
import { describe, expect, test } from 'bun:test'
import { before, cellAt, dragEnd, edgeAt, menuAt, pointOf, seen, shownEnd, span, stretch, toSelect, wordAt, type Grid } from './select.ts'

const g: Grid = { left: 16, top: 8, width: 10, height: 20, cols: 40, rows: 10, viewportY: 100 }
const cells = (s: string) => [...s]

describe('where a finger is', () => {
  test('the cell under a point, in buffer rows', () => {
    expect(cellAt(16, 8, g)).toEqual({ row: 100, col: 0 })
    expect(cellAt(16 + 35, 8 + 45, g)).toEqual({ row: 102, col: 3 })
  })
  test('off the grid it stays on the screen', () => {
    expect(cellAt(-50, -50, g)).toEqual({ row: 100, col: 0 })
    expect(cellAt(9999, 9999, g)).toEqual({ row: 109, col: 39 })
  })
  test('a handle goes to the nearest boundary, up to the row end', () => {
    expect(edgeAt(16 + 34, 8, g).col).toBe(3)
    expect(edgeAt(16 + 36, 8, g).col).toBe(4)
    expect(edgeAt(9999, 8, g).col).toBe(40)
  })
})

describe('the word under a long press', () => {
  test('a path stays whole, brackets and spaces end it', () => {
    const line = cells('ls (~/dev/shop-2/a.ts) done')
    expect(wordAt(line, 6)).toEqual({ from: 4, to: 21 })
    expect(wordAt(line, 0)).toEqual({ from: 0, to: 2 })
    expect(wordAt(line, 25)).toEqual({ from: 23, to: 27 })
  })
  test('an address stays whole', () => {
    const line = cells('see https://example.com/x?y=1#z now')
    expect(wordAt(line, 10)).toEqual({ from: 4, to: 31 })
  })
  test("an apostrophe inside a word stays in it; quotes around one don't", () => {
    const line = cells("it didn't 'x'")
    expect(wordAt(line, 5)).toEqual({ from: 3, to: 9 })
    expect(wordAt(line, 11)).toEqual({ from: 11, to: 12 })
  })
  test('a space or a separator is one cell', () => {
    const line = cells('a  b|c')
    expect(wordAt(line, 1)).toEqual({ from: 1, to: 2 })
    expect(wordAt(line, 4)).toEqual({ from: 4, to: 5 })
  })
  test('a wide character is one word with its second half', () => {
    const line = ['a', '日', '', '本', '', ' ', 'b']
    expect(wordAt(line, 2)).toEqual({ from: 0, to: 5 })
    expect(wordAt(line, 6)).toEqual({ from: 6, to: 7 })
  })
})

describe('a selection', () => {
  test('ends in order, at least one cell', () => {
    expect(span({ row: 3, col: 5 }, { row: 1, col: 2 }, 40)).toEqual({ start: { row: 1, col: 2 }, end: { row: 3, col: 5 } })
    expect(span({ row: 1, col: 2 }, { row: 1, col: 2 }, 40)).toEqual({ start: { row: 1, col: 2 }, end: { row: 1, col: 3 } })
    expect(span({ row: 1, col: 40 }, { row: 1, col: 40 }, 40)).toEqual({ start: { row: 1, col: 39 }, end: { row: 1, col: 40 } })
    expect(before({ row: 1, col: 9 }, { row: 2, col: 0 })).toBe(true)
  })
  test("as xterm's select: column, row and length over whole rows", () => {
    expect(toSelect({ start: { row: 5, col: 4 }, end: { row: 5, col: 9 } }, 40)).toEqual([4, 5, 5])
    expect(toSelect({ start: { row: 5, col: 30 }, end: { row: 7, col: 2 } }, 40)).toEqual([30, 5, 52])
  })
  test('a held finger stretches it and keeps its word', () => {
    const word = { start: { row: 5, col: 4 }, end: { row: 5, col: 9 } }
    expect(stretch(word, { row: 6, col: 3 }, 40)).toEqual({ start: { row: 5, col: 4 }, end: { row: 6, col: 3 } })
    expect(stretch(word, { row: 4, col: 10 }, 40)).toEqual({ start: { row: 4, col: 10 }, end: { row: 5, col: 9 } })
    expect(stretch(word, { row: 5, col: 6 }, 40)).toEqual(word)
  })
  test('a handle moves its end; dragged past the other, it becomes the start', () => {
    const s = { start: { row: 5, col: 4 }, end: { row: 5, col: 9 } }
    expect(dragEnd(s, 'end', { row: 6, col: 0 }, 40)).toEqual({ span: { start: { row: 5, col: 4 }, end: { row: 6, col: 0 } }, which: 'end' })
    expect(dragEnd(s, 'end', { row: 5, col: 1 }, 40)).toEqual({ span: { start: { row: 5, col: 1 }, end: { row: 5, col: 4 } }, which: 'start' })
    expect(dragEnd(s, 'start', { row: 5, col: 2 }, 40)).toEqual({ span: { start: { row: 5, col: 2 }, end: { row: 5, col: 9 } }, which: 'start' })
  })
})

describe('the handles and the menu', () => {
  test("an end at a row's start shows at the end of the row before", () => {
    expect(shownEnd({ row: 6, col: 0 }, 40)).toEqual({ row: 5, col: 40 })
    expect(shownEnd({ row: 6, col: 3 }, 40)).toEqual({ row: 6, col: 3 })
  })
  test('a handle sits at the foot of its row, none out of sight', () => {
    expect(pointOf({ row: 101, col: 3 }, g)).toEqual({ x: 46, y: 48 })
    expect(pointOf({ row: 99, col: 3 }, g)).toBeNull()
    expect(pointOf({ row: 110, col: 3 }, g)).toBeNull()
  })
  test('a selection out of sight is not seen; one through the screen is', () => {
    expect(seen({ start: { row: 90, col: 0 }, end: { row: 99, col: 5 } }, g)).toBe(false)
    expect(seen({ start: { row: 90, col: 0 }, end: { row: 100, col: 0 } }, g)).toBe(false)
    expect(seen({ start: { row: 0, col: 0 }, end: { row: 200, col: 0 } }, g)).toBe(true)
    expect(seen({ start: { row: 110, col: 0 }, end: { row: 111, col: 0 } }, g)).toBe(false)
  })
  test('the menu goes above a selection, centred on a one-row one, kept inside', () => {
    const box = { width: 400, height: 216 }, menu = { width: 160, height: 40 }
    expect(menuAt({ start: { row: 104, col: 10 }, end: { row: 104, col: 20 } }, g, box, menu)).toEqual({ left: 86, top: 40 })
    expect(menuAt({ start: { row: 104, col: 0 }, end: { row: 104, col: 2 } }, g, box, menu).left).toBe(8)
  })
  test('with no room above it goes under the handles, else over the middle', () => {
    const box = { width: 400, height: 216 }, menu = { width: 160, height: 40 }
    expect(menuAt({ start: { row: 100, col: 0 }, end: { row: 100, col: 5 } }, g, box, menu).top).toBe(28 + 28)
    expect(menuAt({ start: { row: 100, col: 0 }, end: { row: 109, col: 5 } }, g, box, menu).top).toBe(88)
  })
})
