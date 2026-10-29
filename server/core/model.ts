import type { Mode } from '../../shared/types.ts'

export type AgentKind = 'claude' | 'codex'
export interface CoreSpace {
  id: string
  name: string
  machine: string
  folder: string
  home?: boolean
  base: string
  prefix: string
  mode: Mode
  added: number
}
export interface CoreAgent {
  chat: string
  space: string
  machine: string
  role: 'coordinator' | 'task' | 'reviewer'
  kind: AgentKind
  model?: string
  effort?: string
  terminal?: string
  pid?: number
  launch: string
  grant: string
  hook: string
  transcript?: string
  session?: string
  started: number
  state: 'starting' | 'idle' | 'working' | 'blocked'
  permission?: string
}
export interface AgentHook {
  id: string
  event: string
  at: number
  session?: string
  transcript?: string
  agent?: string
  model?: string
  tool?: string
}
