import type { Action, Snapshot, SettingSection } from '../../shared/types.ts'
import type { PluginEntry } from '../../scripts/build-plugins.ts'
import type { PluginContext, ServerPlugin } from '../plugin-api.ts'
import type { CoreStore } from './store.ts'

const NAME = /^[a-z][a-z0-9-]{0,63}$/
const METHOD = /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/
type Host = { store: CoreStore; snapshot(): Snapshot; on(event: 'snapshot', fn: () => void): () => void }
type Loaded = { methods: Map<string, (input: unknown) => unknown | Promise<unknown>>; cleanup: (() => void)[] }

/** Per-server extension lifetime. No import here reads ~/.shepherdr or legacy plugins. */
export class CorePlugins {
  private loaded = new Map<string, Loaded>()
  private failed: Record<string, string> = {}
  private catalog: PluginEntry[] = []
  private stopped = false
  constructor(private host: Host) {}
  async start(catalog: PluginEntry[], loaders: [string, () => Promise<ServerPlugin>][]) {
    this.catalog = catalog
    for (const [name, load] of loaders) {
      if (this.stopped) return
      const entry = catalog.find(item => item.name === name && item.on)
      if (!entry || !NAME.test(name)) continue
      const lifetime: Loaded = { methods: new Map(), cleanup: [] }
      this.loaded.set(name, lifetime)
      const active = () => { if (this.stopped || this.loaded.get(name) !== lifetime) throw Error(`Plugin ${name} is stopped`) }
      const keyOf = (key: string) => { active(); if (typeof key !== 'string' || !key || key.length > 256) throw Error('Invalid plugin state key'); return key }
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([(async () => {
        const plugin = await load()
        active()
        if (plugin.name !== name || entry.from === 'user' && plugin.api !== 2) throw Error('This plugin needs the Shepherdr 2.1 API (api: 2). See docs/plugins.md.')
        const context: PluginContext = {
          api: 2, name,
          snapshot: () => { active(); return structuredClone(this.host.snapshot()) },
          state: {
            get: <T>(key: string) => this.host.store.get<T>(`plugin:${name}`, keyOf(key)),
            set: (key, value) => { keyOf(key); const json = JSON.stringify(value); if (json === undefined || Buffer.byteLength(json) > 1_048_576) throw Error('Plugin state must be JSON, at most 1 MiB'); this.host.store.set(`plugin:${name}`, key, JSON.parse(json)) },
            delete: key => this.host.store.delete(`plugin:${name}`, keyOf(key)),
          },
          onChange: fn => {
            active()
            const off = this.host.on('snapshot', () => { try { active(); void Promise.resolve(fn()).catch(error => this.fail(name, error)) } catch (error) { this.fail(name, error) } })
            lifetime.cleanup.push(off); return off
          },
          handle: (method, fn) => { active(); if (!METHOD.test(method) || typeof fn !== 'function' || lifetime.methods.has(method)) throw Error('Invalid or duplicate plugin method'); lifetime.methods.set(method, fn) },
        }
        const cleanup = await plugin.setup?.(context)
        if (typeof cleanup === 'function') lifetime.cleanup.push(cleanup)
        if (this.stopped || this.loaded.get(name) !== lifetime) this.dispose(lifetime)
        })(), new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(Error('Plugin startup exceeded 5 seconds')), 5000) })])
      } catch (error) { this.fail(name, error) }
      finally { clearTimeout(deadline) }
    }
  }
  private dispose(lifetime: Loaded) { for (const cleanup of lifetime.cleanup.splice(0).reverse()) try { cleanup() } catch { /* the rest must still stop */ } }
  private fail(name: string, error: unknown) {
    this.failed[name] = String(error instanceof Error ? error.message : error).slice(0, 1000)
    const lifetime = this.loaded.get(name); this.loaded.delete(name)
    if (lifetime) this.dispose(lifetime)
  }
  async act(action: Extract<Action, { type: 'plugin' }>) {
    if (this.stopped) throw Error('Plugins are stopping')
    const method = this.loaded.get(action.plugin)?.methods.get(action.method)
    if (!method) throw Error(this.failed[action.plugin] ? `Plugin ${action.plugin} is unavailable: ${this.failed[action.plugin]}` : 'No such enabled plugin method')
    if (!action.cid) throw Error('Plugin actions need a unique command id; keep it when retrying')
    const input = JSON.stringify(action.input ?? null)
    if (Buffer.byteLength(input) > 65_536) throw Error('Plugin input exceeds 64 KiB')
    return this.host.store.command(action.cid, action, async () => {
      const result = await method(JSON.parse(input))
      const json = JSON.stringify(result ?? null)
      if (Buffer.byteLength(json) > 1_048_576) throw Error('Plugin result exceeds 1 MiB')
      return JSON.parse(json)
    })
  }
  section(): SettingSection {
    return { name: 'Plugins', level: 'all', about: 'Built in, and your own from ~/.shepherdr/plugins.', rows: this.catalog.map(item => ({ key: `plugin.${item.name}`, label: item.name, value: item.on ? 'on' : 'off', group: item.from === 'user' ? 'Yours' : 'Built in', ...(this.failed[item.name] || item.broken ? { warn: `Skipped: ${this.failed[item.name] || item.broken}` } : {}) })) }
  }
  stop() { this.stopped = true; for (const lifetime of this.loaded.values()) this.dispose(lifetime); this.loaded.clear() }
}
