// fork: the web app with no spaces at all, the last one closed (upstream #747)
import { describe, expect, test } from 'bun:test'
import type { UI } from './kernel.ts'
import type { Place, Snapshot } from '@shared/types.ts'

// the kernel reads the page as it loads: just enough of one
const g = globalThis as Record<string, unknown>
const store = () => ({ getItem: () => null, setItem() {}, removeItem() {} })
Object.assign(g, { location: { search: '', pathname: '/', hash: '', href: 'http://x/' }, localStorage: store(), sessionStorage: store(), innerWidth: 1400, innerHeight: 900, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), history: { state: null, length: 1, replaceState() {}, pushState() {} }, document: { addEventListener() {}, visibilityState: 'visible', hasFocus: () => true, documentElement: { dataset: {}, style: {} }, head: { innerHTML: '' } } })
const { chatName, getState, keysChat, paneChat, placeOf, visibleChats } = await import('./kernel.ts')

const space = { id: 'p:a:shep', name: 'shepherdr', machine: 'a', level: 2, status: 'idle', mode: 'regular', chat: 'p:a:shep' } as unknown as Place
const snap = (places: Place[]) => ({ host: 'a', places, machines: [], tasks: [], needs: [], artifacts: [] }) as unknown as Snapshot
const ui = (more: Partial<UI> = {}) => ({ ...getState().ui, place: 'p:a:shep', ...more }) as UI

describe('no spaces (#747)', () => {
  test('placeOf has none to give, and what reads it on every snapshot copes', () => {
    const none = snap([])
    expect(placeOf(none, 'p:a:shep')).toBeUndefined()
    expect(visibleChats(ui(), none)).toEqual([])
    expect(visibleChats(ui({ device: 'phone', tab: 'chat' }), none)).toEqual([])
    expect(keysChat(ui(), none)).toBe('')
    expect(paneChat(none, { kind: 'place', id: 'p:a:shep' })).toBeNull()
    expect(chatName(none, 'p:a:shep')).toBe('p:a:shep')
  })
  test('a space opened again is the one shown, whatever id the screen kept', () => {
    const one = snap([space])
    expect(placeOf(one, 'p:a:gone')?.id).toBe('p:a:shep')
    expect(visibleChats(ui({ place: 'p:a:gone' }), one)).toEqual(['p:a:shep'])
  })
})
