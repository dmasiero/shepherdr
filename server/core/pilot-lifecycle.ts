import type { CoreSource } from './source.ts'
import type { CoreAgent } from './model.ts'
import type { CorePilotRun } from './pilot-policy.ts'

/** Stop authority first; process cleanup is retried from private launch records after reconnect/restart. */
export class CorePilotLifecycle {
  private transitions = new Map<string, Promise<void>>()
  constructor(private source: CoreSource) {}
  busy(place: string) { return this.transitions.has(place) }
  private transition(place: string, work: () => Promise<void>) {
    const old = this.transitions.get(place)
    if (old) return old
    const next = work().finally(() => this.transitions.delete(place))
    this.transitions.set(place, next); return next
  }
  stop(id: string, keepWorkers = false) {
    const run = this.source.pilots.policy.get(id)
    if (!run) throw Error('No such Autopilot run')
    // Persist every stop before waiting for another transition. A default stop may tighten keep-workers.
    const stopped = this.source.pilots.policy.stop(id, keepWorkers)
    this.denyPermissions(stopped)
    return this.transition(run.place, () => this.cleanup(id))
  }
  private records(run: CorePilotRun) {
    const all = [...this.source.store.all<CoreAgent>('pilot-capture'), ...this.source.agents.all()]
    return [...new Map(all.filter(agent => agent.pilot?.run === run.id && agent.space === run.place && agent.machine === run.machine).map(agent => [agent.launch, agent])).values()]
  }
  private denyPermissions(run: CorePilotRun) {
    for (const agent of this.records(run)) if (run.state !== 'workers' || agent.role === 'coordinator') this.source.denyPermissions(agent, 'Autopilot stopped this agent')
  }
  private async cleanup(id: string) {
    const run = this.source.pilots.policy.get(id)
    if (!run || !['workers', 'stopping', 'failed'].includes(run.state)) return
    this.denyPermissions(run)
    if (!this.source.machineConnected(run.machine)) return // Absence in a disconnected snapshot is never proof of exit.
    let pending = false
    for (const agent of this.records(run)) {
      const latest = this.source.pilots.policy.get(id)!
      if (latest.state === 'workers' && agent.role !== 'coordinator') continue
      const terminal = this.source.agents.terminal(agent)
      if (!terminal) { pending = true; continue } // An uncertain terminal.run can still publish its holder.
      if (terminal.state === 'finished') continue
      if (agent.pid !== undefined && terminal.pid !== agent.pid) throw Error('Contained process identity changed; cleanup is not confirmed')
      pending = true
      await this.source.core.call('terminal.kill', { terminal: terminal.address })
    }
    const latest = this.source.pilots.policy.get(id)!
    if (pending || latest.state !== run.state) return
    if (latest.state !== 'workers') this.source.pilots.policy.stopped(id)
    const space = this.source.space(run.place)
    // Do not replace a newer run or start an unrestricted agent as an automatic recovery side effect.
    if (space && this.source.pilots.policy.current(space.id)?.id !== id && this.source.pilots.policy.current(space.id)) return
    if (space?.mode === 'autopilot') {
      space.mode = 'regular'; this.source.store.set('space', space.id, space)
      this.source.emit('snapshot')
    }
  }
  async tick() {
    for (const run of this.source.pilots.policy.all()) {
      if (['on', 'workers'].includes(run.state)) {
        try { this.source.pilots.policy.live(run.id) } catch { /* Private policy persists the limit failure. */ }
      }
      if (['workers', 'stopping', 'failed'].includes(this.source.pilots.policy.get(run.id)!.state)) await this.transition(run.place, () => this.cleanup(run.id))
    }
  }
  async drain() { await Promise.allSettled([...this.transitions.values()]) }
}
