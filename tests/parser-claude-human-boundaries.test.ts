import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { compactEntry, groupIntoTurns, parseClaudeFileFull, parseJsonlLine } from '../src/parser.js'
import type { JournalEntry } from '../src/types.js'

const timestamp = (second: number) => `2026-10-05T10:00:${String(second).padStart(2, '0')}.000Z`

function userEntry(second: number, content: string, flags: Record<string, unknown> = {}): JournalEntry {
  return {
    type: 'user',
    uuid: `user-${second}`,
    timestamp: timestamp(second),
    sessionId: 'human-boundaries',
    cwd: '/fixture/project',
    message: { role: 'user', content },
    ...flags,
  }
}

function assistantEntry(second: number): JournalEntry {
  return {
    type: 'assistant',
    uuid: `assistant-${second}`,
    timestamp: timestamp(second),
    sessionId: 'human-boundaries',
    cwd: '/fixture/project',
    message: {
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      id: `response-${second}`,
      content: [],
      usage: { input_tokens: 1000, output_tokens: 100 },
    },
  }
}

describe('Claude human turn boundaries', () => {
  it('keeps harness user records inside the active human turn and retains all billed replies', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-human-boundaries-'))
    const file = join(dir, 'session.jsonl')
    try {
      await copyFile(resolve('tests/fixtures/claude/harness-human-boundaries.jsonl'), file)

      const parsed = await parseClaudeFileFull(file, new Set())
      expect(parsed?.turns).toHaveLength(1)
      expect(parsed?.turns[0]?.userMessage).toBe('Implement a feature')
      expect(parsed?.turns[0]?.calls).toHaveLength(4)
      expect(parsed?.turns[0]?.calls.reduce((sum, call) => sum + call.usage.inputTokens, 0)).toBe(4000)
      expect(parsed?.turns[0]?.calls.reduce((sum, call) => sum + call.usage.outputTokens, 0)).toBe(400)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not replace an implicit usage-bearing turn with a harness record', () => {
    const turns = groupIntoTurns([
      assistantEntry(0),
      compactEntry(userEntry(1, 'A compacted summary', { isCompactSummary: true })),
      assistantEntry(2),
    ], new Set())

    expect(turns).toHaveLength(1)
    expect(turns[0]?.userMessage).toBe('')
    expect(turns[0]?.assistantCalls).toHaveLength(2)
  })

  function expectBoundaryEntryIsIgnored(line: string | Buffer): void {
    const decoded = parseJsonlLine(line)
    expect(decoded).not.toBeNull()
    expect(decoded).toMatchObject({
      isMeta: true,
      isCompactSummary: true,
      origin: { kind: 'task-notification' },
    })
    const compacted = compactEntry(decoded!)
    expect(compacted.isMeta).toBe(true)
    expect(compacted.isCompactSummary).toBe(true)
    expect(compacted.origin).toEqual({ kind: 'task-notification' })
    expect(groupIntoTurns([
      compactEntry(userEntry(0, 'Human prompt')),
      compacted,
      compactEntry(assistantEntry(1)),
    ], new Set())).toHaveLength(1)
  }

  it('preserves boundary metadata through the ordinary decoder and compaction', () => {
    const flags = { isMeta: true, isCompactSummary: true, origin: { kind: 'task-notification' } }
    const small = JSON.stringify({ ...userEntry(0, 'Harness text', flags) })
    expectBoundaryEntryIsIgnored(small)
  })

  it('preserves boundary metadata through the large-line Buffer decoder and compaction', () => {
    const flags = { isMeta: true, isCompactSummary: true, origin: { kind: 'task-notification' } }
    const large = JSON.stringify({ ...userEntry(0, 'Harness text', flags), padding: 'x'.repeat(40_000) })
    expectBoundaryEntryIsIgnored(Buffer.from(large))
  })

  it('keeps real slash-prefixed path prompts as human boundaries', () => {
    const turns = groupIntoTurns([
      compactEntry(userEntry(0, '/Users/uttam/project/src/parser.ts')),
      compactEntry(assistantEntry(1)),
      compactEntry(userEntry(2, 'Please inspect this file')),
      compactEntry(assistantEntry(3)),
    ], new Set())

    expect(turns.map(turn => turn.userMessage)).toEqual([
      '/Users/uttam/project/src/parser.ts',
      'Please inspect this file',
    ])
  })
})
