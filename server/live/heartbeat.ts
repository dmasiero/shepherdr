// Legacy file adapter. Core supplies its own isolated persistence.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HOME, readJson, writeJson } from '../store.ts'
import { Heartbeats as Model } from '../heartbeat.ts'
export { firstChecklist, heartbeatPrompt } from '../heartbeat.ts'
export const heartbeatFile = (place: string) => join(HOME, 'heartbeat', `${place.replace(/[^\w.-]+/g, '-')}.md`)
export class Heartbeats extends Model {
  constructor() { super({
    read: () => readJson('heartbeats.json', {}), write: value => writeJson('heartbeats.json', value),
    readChecklist: place => existsSync(heartbeatFile(place)) ? readFileSync(heartbeatFile(place), 'utf8') : undefined,
    writeChecklist: (place, text) => { const file = heartbeatFile(place); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text) },
  }) }
}
