import { expect, mock, test } from 'bun:test'

// fork: Tasks button on the right. The space header's Tasks button is its last one, after Artifacts: with no pane open
// it sits where the open pane's Close (X) lands, so one spot opens the task list and closes it again. The phone's
// bottom bar keeps Chat / Tasks / Artifacts.

mock.module('@plugins/chat/markdown.tsx', () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, toHtml: (t: string) => t, linked: (t: string) => t, withLinks: (t: string) => [t] }))
const { installPlugins, registry } = await import('@client/kernel.ts')
const tasks = (await import('./client.tsx')).default
const artifacts = (await import('../artifacts/client.tsx')).default

test('the header has Artifacts, then Tasks last; the bottom bar keeps Tasks first', () => {
  installPlugins([tasks, artifacts], ['tasks', 'artifacts'])
  expect(registry.header.map((h) => h.View.name)).toEqual(['ArtifactsButton', 'TasksButton'])
  expect(registry.bar.map((b) => b.pane)).toEqual(['tasks', 'artifacts'])
})
