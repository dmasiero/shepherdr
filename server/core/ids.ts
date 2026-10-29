import type { CoreStore } from './store.ts'

/** Stable-machine counters plus permanent combined-app tombstones prevent alias reuse overwriting history. */
export function reserveTaskId(store: CoreStore, machine: string, prefix: string, alias?: string) {
  for (;;) {
    const number = store.next(`task:${machine}:${prefix}`)
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Task numbers are exhausted')
    const localId = `${prefix}-${number}`, id = alias ? `${alias}/${localId}` : localId
    if (store.get('task-id', id) || store.get('task', id)) continue
    store.set('task-id', id, { id, machine, prefix, number })
    return { id, localId, number }
  }
}
