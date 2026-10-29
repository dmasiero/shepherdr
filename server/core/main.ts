import { existsSync, renameSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CoreSource } from './source.ts'
import { coreConfig, type CoreConfig } from './config.ts'
import type { RunRecord } from './launcher.ts'

export async function runCoreServer(config: CoreConfig, boot: string = randomUUID()) {
  // Reused presentation and push code resolves its private state only after these values are set.
  process.env.SHEPHERDR_HOME = config.home
  process.env.SHEPHERDR_PORT = String(config.port)
  const source = new CoreSource(config)
  await source.start()
  const { startApp } = await import('../app.ts')
  const { Push } = await import('../push.ts')
  const server = startApp({ source, port: config.port, host: '127.0.0.1', dist: join(import.meta.dir, '../../dist'), push: new Push(),
    health: () => ({ product: 'shepherdr-core', boot, pid: process.pid, core: source.connected() }) })
  const record: RunRecord = { pid: process.pid, boot, home: config.home, port: server.port!, root: join(import.meta.dir, '../..') }
  const temporary = join(config.home, `run.${boot}.tmp`)
  writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
  renameSync(temporary, join(config.home, 'run.json'))
  let stopping = false
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => {
    if (stopping) return
    stopping = true
    await source.drain()
    source.stop(); server.stop(true)
    // Agents and core are intentionally independent of this process.
    const path = join(config.home, 'run.json')
    try { if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).boot === boot) rmSync(path) } catch { /* preserve another start's record */ }
    process.exit(0)
  })
  return { server, source }
}

if (import.meta.main) {
  try { await runCoreServer(coreConfig(process.argv.slice(2)), process.env.SHEPHERDR_BOOT_ID || randomUUID()) }
  catch (error) { console.error((error as Error).message); process.exitCode = 1 }
}
