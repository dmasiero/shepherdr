// Legacy storage adapter; recurrence and event behavior is shared with standalone core.
import { Automations as Model, type Automation } from '../automations.ts'
import { readJson, writeJson } from '../store.ts'
export type { Automation, Template } from '../automations.ts'
export class Automations extends Model {
  constructor() { super({ read: () => readJson<Automation[]>('automations.json', []), write: list => writeJson('automations.json', list) }) }
}
