import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { CORE_VERSION } from './protocol.ts'
import type { CoreFiles } from './files.ts'
import type { CoreEndpoint } from './client.ts'

export interface RemoteRuntime { root: string; home: string; bun: string; hc: string; path: string; session?: string; socket?: string; endpoint: CoreEndpoint }
const PARTS = ['helper/core-cli.ts', 'helper/core-hook.ts', 'helper/core-review.ts', 'helper/core-secret.ts', 'server/core/home.ts', 'server/core/client.ts', 'server/core/protocol.ts', 'server/core/envelope.ts', 'server/core/mailbox.ts', 'server/core/request.ts']
const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`

/** Provision only private agent helper files through core exec. No SSH client, listener, worker or service. */
export class CoreRemotes {
  constructor(private readonly files: CoreFiles, private readonly installation: string,
    private readonly profile: (machine: string) => { session?: string | null; version?: string }) {}
  async bun(machine: string) {
    const find = `command -v bun || { test -x "$HOME/.bun/bin/bun" && printf '%s\\n' "$HOME/.bun/bin/bun"; }`
    const bun = (await this.files.exec(machine, ['sh', '-c', find])).toString('utf8').trim()
    if (!bun || bun.includes('\n')) throw new Error('Install Bun on this machine before starting a Shepherdr agent')
    return bun
  }
  async prepare(machine: string): Promise<RemoteRuntime> {
    const profile = this.profile(machine)
    if (profile.version !== CORE_VERSION) throw new Error(`This machine must run core ${CORE_VERSION}; no binary or service was changed`)
    const bun = await this.bun(machine)
    const metadata = JSON.parse((await this.files.exec(machine, [bun, '-e', `const o=require('node:os'),f=require('node:fs');const hc=Bun.which('hc');if(!hc)throw Error('hc is missing from this core environment');const v=Bun.spawnSync([hc,'--version']);if(v.exitCode)throw Error('hc version failed');console.log(JSON.stringify({home:f.realpathSync(o.homedir()),bun:process.execPath,hc,path:process.env.PATH||'',version:v.stdout.toString().trim(),session:process.env.HC_SESSION,socket:process.env.HC_SOCKET}))`])).toString('utf8')) as { home: string; bun: string; hc: string; path: string; version: string; session?: string; socket?: string }
    if (!metadata.version.endsWith(` ${CORE_VERSION}`) && metadata.version !== CORE_VERSION) throw new Error(`Remote hc must be pinned to ${CORE_VERSION}; nothing was installed`)
    const source = join(import.meta.dir, '../..')
    const parts = Object.fromEntries(PARTS.map(path => [path, readFileSync(join(source, path), 'utf8')]))
    const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)
    const root = join(metadata.home, '.local/share/shepherdr-agents', this.installation, digest)
    parts['bin/shepherdr'] = `#!/bin/sh\nexec ${quote(metadata.bun)} ${quote(join(root, 'helper/core-cli.ts'))} "$@"\n`
    const script = `const f=require('node:fs'),p=require('node:path');const x=JSON.parse(await Bun.stdin.text());const ensure=d=>{f.mkdirSync(d,{recursive:true,mode:0o700});const s=f.lstatSync(d);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)||f.realpathSync(d)!==d)throw Error('Agent runtime must be a private real directory')};ensure(x.root);for(const [name,text]of Object.entries(x.parts)){if(name.includes('..')||p.isAbsolute(name))throw Error('Bad helper path');const file=p.join(x.root,name);ensure(p.dirname(file));if(f.existsSync(file)){const s=f.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)||f.readFileSync(file,'utf8')!==text)throw Error('Existing helper differs; left untouched')}else f.writeFileSync(file,text,{mode:name.startsWith('bin/')?0o700:0o600,flag:'wx'})}console.log('provisioned')`
    await this.files.exec(machine, [metadata.bun, '-e', script], undefined, Buffer.from(JSON.stringify({ root, parts })))
    const session = profile.session ?? metadata.session
    const endpoint = { binary: metadata.hc, session, socket: metadata.socket }
    const check = `const {CoreClient}=await import(${JSON.stringify(join(root, 'server/core/client.ts'))});const c=await CoreClient.endpoint(${JSON.stringify(endpoint)});try{const s=await c.call('server.status');if(s.core.id!==${JSON.stringify(machine)})throw Error('Remote helper reached a different core identity');console.log('identity verified')}finally{c.close()}`
    await this.files.exec(machine, [metadata.bun, '-e', check])
    return { ...metadata, root, session, endpoint }
  }
  async privateFile(machine: string, runtime: RemoteRuntime, path: string, text: string) {
    if (!path.startsWith(runtime.root + '/sessions/')) throw new Error('Private launch file is outside its runtime')
    const script = `const f=require('node:fs'),p=require('node:path');const name=process.argv.at(-1),dir=p.dirname(name);f.mkdirSync(dir,{recursive:true,mode:0o700});const s=f.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)||f.realpathSync(dir)!==dir)throw Error('Launch directory is not private');f.writeFileSync(name,await Bun.stdin.text(),{mode:0o600,flag:'wx'})`
    await this.files.exec(machine, [runtime.bun, '-e', script, '--', path], undefined, Buffer.from(text))
  }
}
