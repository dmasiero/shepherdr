import type { CoreSource } from './source.ts'
import { Refusal } from './client.ts'

/** Visible aliases select stable private space IDs; names never grant cross-machine access. */
export function findCoreSpace(source: CoreSource, machine: string, name: string) {
  const matches = source.spaces().filter(space => space.machine === machine &&
    (space.id === name || space.name === name || source.store.get<string>('name', space.id) === name))
  if (matches.length > 1) throw new Refusal('Choose an unambiguous space on your machine')
  return matches[0]
}
