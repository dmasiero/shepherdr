// fork: task commands for scripts (FORK.md, server/core/operator-tasks.ts). The operator socket takes at most 16
// command words of 256 characters, so a task's brief and a tell's message travel on stdin. 2.0's spelling still
// works: `task add TITLE --brief TEXT` (or --desc) and `task tell ID TEXT` move their text to stdin here, before
// helper/core-operator.ts reads --home, so a brief or message that says --home stays text.

const MAX = 64 * 1024

export async function taskStdin(args: string[], input: AsyncIterable<Uint8Array> & { isTTY?: boolean } = process.stdin): Promise<[string[], string | undefined]> {
  const verb = args[1]
  if (verb !== 'add' && verb !== 'tell') return [args, undefined]
  let words = args, text: string | undefined
  if (verb === 'tell') {
    // `task tell ID [--home PATH] TEXT...`: a --home with its path stays a command word, the rest is the message.
    words = args.slice(0, 3)
    const said: string[] = []
    for (let i = 3; i < args.length; i++) {
      if (args[i] === '--home' && i + 1 < args.length && !said.length) words.push(args[i]!, args[++i]!)
      else said.push(args[i]!)
    }
    if (said.length) text = said.join(' ')
  } else {
    words = []
    for (let i = 0; i < args.length; i++) {
      const match = args[i]!.match(/^--(?:brief|desc)(?:=([\s\S]*))?$/)
      if (!match) words.push(args[i]!)
      else if (match[1] !== undefined) text = match[1]
      else if (i + 1 < args.length) text = args[++i]
      else throw new Error('Give --brief TEXT, or the brief on stdin')
    }
  }
  if (text === undefined && !input.isTTY) {
    const chunks: Uint8Array[] = []; let size = 0
    for await (const chunk of input) { size += chunk.length; if (size > MAX) throw new Error('Keep the text under 64 KiB'); chunks.push(chunk) }
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  }
  if (text !== undefined && Buffer.byteLength(text) > MAX) throw new Error('Keep the text under 64 KiB')
  return [words, text]
}
