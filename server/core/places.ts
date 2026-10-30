import { asEmoji, NAME_MAX, nameProblem, type Action, type Machine, type Place } from '../../shared/types.ts'
import { deleteSection, moveSpace, newSection, PINNED, renameSection, sectionProblem, setOrder, sortPlaces, type PlaceOrder, type SectionDefs } from '../../shared/order.ts'
import type { CoreSource } from './source.ts'

/** Sidebar organization is product metadata; it never renames a core machine or repository. */
export class CorePlaces {
  constructor(private source: CoreSource) {}
  present(places: Place[], machines: Machine[]) {
    const named = <T extends { id: string; name: string }>(item: T) => ({ ...item, name: this.source.store.get<string>('name', item.id) || item.name })
    return sortPlaces(places.map(named), machines.map(machine => ({ ...named(machine), ownName: machine.name, emoji: this.source.store.get<string>('emoji', machine.id) || undefined })),
      this.source.store.get<PlaceOrder>('meta', 'place-order') ?? {}, this.source.store.get<SectionDefs>('meta', 'place-sections') ?? {})
  }
  act(action: Extract<Action, { type: 'rename' | 'order' | 'move' | 'section' }>) {
    const store = this.source.store, order = Object.assign(Object.create(null), store.get<PlaceOrder>('meta', 'place-order')), defs: SectionDefs = Object.assign(Object.create(null), store.get<SectionDefs>('meta', 'place-sections'))
    const { places, machines = [] } = this.source.snapshot()
    const fail = (error: string) => ({ ok: false as const, error })
    let id: string | undefined
    switch (action.type) {
      case 'rename': {
        if (typeof action.name !== 'string') return fail('Nothing to rename.')
        const name = action.name.replace(/\s+/g, ' ').trim(), emoji = action.emoji === undefined ? undefined : asEmoji(action.emoji)
        if (emoji === null) return fail('One emoji at a time.')
        if (defs[action.id] || action.id === PINNED) {
          const bad = renameSection(defs, action.id, name, emoji)
          if (bad) return fail(bad)
          break
        }
        const machine = machines.find(item => item.id === action.id), place = places.find(item => item.id === action.id)
        if (!machine && !place) return fail('Nothing to rename.')
        if (emoji !== undefined && !machine) return fail('Only a machine takes an emoji, one at a time.')
        if (name.length > NAME_MAX) return fail(`A name fits ${NAME_MAX} characters.`)
        if (machine && name && machines.some(item => item.id !== machine.id && item.name.toLowerCase() === name.toLowerCase())) return fail(`A machine is called ${name} already.`)
        const bad = place && name ? nameProblem(name, places.filter(item => item.machine === place.machine && item.id !== place.id).map(item => item.name)) : undefined
        if (bad) return fail(bad)
        store.db.transaction(() => {
          if (name) store.set('name', action.id, name); else store.delete('name', action.id)
          if (emoji !== undefined) { if (emoji) store.set('emoji', action.id, emoji); else store.delete('emoji', action.id) }
        })()
        this.source.emit('snapshot'); return { ok: true }
      }
      case 'order':
        if (typeof action.under !== 'string' || !Array.isArray(action.ids) || !action.ids.every(item => typeof item === 'string')) return fail('No order to keep.')
        setOrder(order, action.under, action.ids); break
      case 'move': {
        if (typeof action.id !== 'string' || typeof action.to !== 'string') return fail('Nothing to move.')
        const bad = moveSpace(order, defs, places, machines, action.id, action.to, typeof action.before === 'string' ? action.before : undefined)
        if (bad) return fail(bad)
        break
      }
      case 'section':
        if (action.op === 'delete') {
          if (!defs[action.id] || action.id === PINNED) return fail(action.id === PINNED ? 'Pinned stays.' : 'No such section.')
          deleteSection(defs, order, action.id)
        } else {
          const name = typeof action.name === 'string' ? action.name.replace(/\s+/g, ' ').trim() : '', emoji = action.emoji === undefined ? '' : asEmoji(action.emoji)
          const machine = typeof action.machine === 'string' && action.machine ? action.machine : undefined
          if (emoji === null) return fail('One emoji at a time.')
          if (machine && !machines.some(item => item.machine === machine)) return fail('No such machine.')
          const bad = sectionProblem(defs, name, machine)
          if (bad) return fail(bad)
          id = newSection(defs, order, { name, ...(emoji ? { emoji } : {}), ...(machine ? { machine } : {}) }, machines)
        }
    }
    store.db.transaction(() => { store.set('meta', 'place-order', order); store.set('meta', 'place-sections', defs) })()
    this.source.emit('snapshot'); return { ok: true, ...(id ? { id } : {}) }
  }
}
