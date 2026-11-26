import { afterEach, expect, test } from 'bun:test'
import { artifactBack, getState, go, openArtifact, openTask, setUI, togglePane } from './kernel.ts'

// fork: Artifact back to its task. An artifact's ← goes back to where it was opened from, like a browser's Back: a
// proof opened from a task's chat goes back to that chat, not to the space's (empty) Artifacts list.
const place = (id: string) => ({ id, name: id, machine: 'vm', level: 0, status: 'idle', mode: 'regular', chat: `p:${id}` })
const snap = { name: '', host: 'vm', user: '', everything: 'home', places: [place('home'), place('shop'), place('garden')], machines: [], tasks: [{ id: 'vm:SHOP-2', name: 'Fix login', place: 'shop', on: 'vm', status: 'ready', proof: 'proof1', agent: { chat: 'vm:SHOP-2/worker' } }], artifacts: [], settings: {} }
Object.assign(getState(), { snap })

afterEach(() => setUI({ at: 'shop', pane: null, task: null, art: null, artFrom: null, max: null, phone: false, artWide: false }))
const back = () => {
  const b = artifactBack(getState().ui)
  setUI(b.to)
  return b.label
}

test("a proof opened from a task's chat goes back to that task", () => {
  setUI({ at: 'shop' })
  openTask('vm:SHOP-2')
  openArtifact('proof1')
  expect(getState().ui).toMatchObject({ pane: 'artifacts', art: 'proof1', task: null })
  expect(back()).toBe('Back to the task')
  expect(getState().ui).toMatchObject({ pane: 'tasks', task: 'vm:SHOP-2', art: null, artFrom: null })
})

test('from the Artifacts list, the Tasks list or the space chat, it goes back there', () => {
  setUI({ at: 'shop' })
  togglePane('artifacts')
  openArtifact('a1')
  expect(back()).toBe('Back to artifacts')
  expect(getState().ui).toMatchObject({ pane: 'artifacts', art: null })
  togglePane('tasks')
  openArtifact('a1')
  expect(back()).toBe('Back to tasks')
  expect(getState().ui).toMatchObject({ pane: 'tasks', task: null, art: null })
  togglePane(null)
  openArtifact('a1')
  expect(back()).toBe('Back to the chat')
  expect(getState().ui).toMatchObject({ pane: null, task: null, art: null })
})

test('opened from a link, or kept from another space, it goes to the Artifacts list as before', () => {
  setUI({ at: 'shop', pane: 'artifacts', art: 'a1', artFrom: null })
  expect(back()).toBe('Back to artifacts')
  expect(getState().ui).toMatchObject({ pane: 'artifacts', art: null })
  openTask('vm:SHOP-2')
  openArtifact('proof1')
  go('garden')
  expect(getState().ui.art).toBe('proof1')
  expect(back()).toBe('Back to artifacts')
  expect(getState().ui).toMatchObject({ at: 'garden', pane: 'artifacts', art: null, task: null })
})
