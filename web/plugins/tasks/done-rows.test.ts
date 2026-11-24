import { expect, test } from 'bun:test'
import { doneRows } from './done-rows.ts'

// fork: Ready card after chat replies. A task with its pull request open is never closed unmerged by the menu's first
// Mark as done: that one merges (or says why not); Done, not merged stays, named as what it does.

const pr = { number: 130, url: 'https://github.com/o/r/pull/130' }

test('an open pull request: Mark as done merges, Done, not merged is its own row', () => {
  for (const s of ['working', 'ready', 'needs']) {
    expect(doneRows({ pr }, s)).toEqual([{ label: 'Mark as done and merge', how: 'accept' }, { label: 'Done, not merged', how: 'close' }])
  }
})

test('no pull request, or one closed on GitHub: the one Mark as done, as before', () => {
  expect(doneRows({}, 'working')).toEqual([{ label: 'Mark as done', how: 'close' }])
  expect(doneRows({ pr: { ...pr, closed: true } }, 'ready')).toEqual([{ label: 'Mark as done', how: 'close' }])
})

test('done or archived: none', () => {
  expect(doneRows({ pr }, 'done')).toEqual([])
  expect(doneRows({ pr }, 'archived')).toEqual([])
})
