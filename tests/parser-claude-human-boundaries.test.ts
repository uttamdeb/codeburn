import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { clearSessionCache, compactEntry, groupIntoTurns, parseAllSessions, parseClaudeFileFull, parseJsonlLine } from '../src/parser.js'
import { PROVIDER_ENV_VARS, PROVIDER_PARSE_VERSIONS } from '../src/session-cache.js'
import type { DateRange, JournalEntry } from '../src/types.js'
import { readCacheOnDisk, writeCacheOnDisk } from './fixtures/session-cache-io.js'
import { setHome } from './setup/home.js'

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
      expect(parsed?.turns[0]?.userMessage).toBe('Implement a parser change in src/parser.ts')
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

  it('reparses an older cached grouping and reclassifies the retained billed calls', async () => {
    const home = await mkdtemp(join(tmpdir(), 'claude-human-cache-home-'))
    const cacheDir = await mkdtemp(join(tmpdir(), 'claude-human-cache-'))
    const envKeys = [
      'HOME',
      'USERPROFILE',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CONFIG_DIRS',
      'CODEBURN_CACHE_DIR',
      'CODEBURN_DESKTOP_SESSIONS_DIR',
    ] as const
    const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]))

    try {
      setHome(home)
      const claudeDir = join(home, '.claude')
      const projectDir = join(claudeDir, 'projects', 'human-boundaries')
      const sessionPath = join(projectDir, 'human-boundaries.jsonl')
      await mkdir(projectDir, { recursive: true })
      await copyFile(resolve('tests/fixtures/claude/harness-human-boundaries.jsonl'), sessionPath)
      process.env['CLAUDE_CONFIG_DIR'] = claudeDir
      delete process.env['CLAUDE_CONFIG_DIRS']
      process.env['CODEBURN_CACHE_DIR'] = cacheDir
      process.env['CODEBURN_DESKTOP_SESSIONS_DIR'] = join(home, 'desktop-sessions')

      const range: DateRange = {
        start: new Date('2026-10-05T00:00:00.000Z'),
        end: new Date('2026-10-05T23:59:59.999Z'),
      }
      const summarize = async () => {
        const projects = await parseAllSessions(range, 'claude')
        const session = projects.flatMap(project => project.sessions).find(candidate => candidate.sessionId === 'human-boundaries')
        expect(session).toBeDefined()
        return {
          turns: session!.turns.map(turn => ({
            userMessage: turn.userMessage,
            category: turn.category,
            calls: turn.assistantCalls.map(call => call.deduplicationKey),
          })),
          apiCalls: session!.apiCalls,
          totalInputTokens: session!.totalInputTokens,
          totalOutputTokens: session!.totalOutputTokens,
        }
      }

      clearSessionCache()
      const cold = await summarize()
      expect(cold).toMatchObject({
        turns: [{
          userMessage: 'Implement a parser change in src/parser.ts',
          category: 'feature',
          calls: ['response-1', 'response-2', 'response-3', 'response-4'],
        }],
        apiCalls: 4,
        totalInputTokens: 4000,
        totalOutputTokens: 400,
      })

      // The old parser grouped each harness record as a separate human turn.
      // Give the warm cache that old version's fingerprint and turns so the
      // parser-version migration must rebuild them from the transcript.
      const cache = await readCacheOnDisk()
      const section = cache.providers['claude']!
      const file = section.files[sessionPath]!
      const firstTurn = file.turns[0]!
      const calls = file.turns.flatMap(turn => turn.calls)
      const oldPrompts = [
        'Implement a parser change in src/parser.ts',
        'Skill body injected by the harness',
        'Background task is complete',
        'Summary of the prior conversation',
      ]
      file.turns = calls.map((call, index) => ({
        ...firstTurn,
        userMessage: oldPrompts[index]!,
        timestamp: timestamp(index * 2),
        calls: [call],
      }))
      const oldParserVersion = PROVIDER_PARSE_VERSIONS['claude']!.replace(/-human-turn-boundaries-v1$/, '')
      const fingerprintParts = PROVIDER_ENV_VARS['claude']!.map(key => `${key}=${process.env[key] ?? ''}`)
      fingerprintParts.push(`parser=${oldParserVersion}`)
      section.envFingerprint = createHash('sha256').update(fingerprintParts.join('\0')).digest('hex').slice(0, 16)
      await writeCacheOnDisk(cache)

      clearSessionCache()
      expect(await summarize()).toEqual(cold)
    } finally {
      clearSessionCache()
      for (const key of envKeys) {
        const value = previousEnv.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(home, { recursive: true, force: true })
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})
