import { expect, test } from 'claude-code/testing'

import type { Report, Watch } from '../types'
import { FAILED_SENTENCE, candidateFromRecord, cardOf, cliIdOf, cwdFromTranscript, titleFromTranscript, describeTool, helpersOf, mainAction, openPlan, parseSentence, resumeCommand, sentencePrompt, sortCards, statusOf, updatedLabel } from './logic'

const watch: Watch = { localId: 'local_a', title: 'A', description: '', link: '', addedAt: 1 }
const ended = (kind: Report['kind'], endedAt = 10): Report => ({
  localId: 'local_a', at: endedAt, phase: 'ended', activity: '', kind, sentence: '好了。', endedAt,
})

test('the status table', () => {
  expect(statusOf(undefined, watch)).toBe('offline')
  expect(statusOf({ localId: 'a', at: 1, phase: 'idle', activity: '' }, watch)).toBe('idle')
  expect(statusOf({ localId: 'a', at: 1, phase: 'working', activity: 'x' }, watch)).toBe('working')
  expect(statusOf({ localId: 'a', at: 1, phase: 'ended', activity: '' }, watch)).toBe('idle')
  for (const kind of ['decide', 'review', 'blocked', 'unknown'] as const) expect(statusOf(ended(kind), watch)).toBe('calling')
  expect(statusOf(ended('none'), watch)).toBe('done')
})

test('知道了 clears this turn only', () => {
  const acked = { ...watch, ackAt: 10 }
  expect(statusOf(ended('decide', 10), acked)).toBe('done')
  expect(statusOf(ended('decide', 11), acked)).toBe('calling')
})

test('the sentence keeps showing on 完成, and cards sort by status', () => {
  expect(cardOf(watch, ended('none'), 'here').sentence).toBe('好了。')
  const a = cardOf({ ...watch, localId: 'done' }, ended('none'), 'here')
  const b = cardOf({ ...watch, localId: 'call' }, ended('decide'), 'here')
  const c = cardOf({ ...watch, localId: 'off' }, undefined, 'here')
  expect(sortCards([c, a, b]).map(card => card.localId)).toEqual(['call', 'done', 'off'])
})

test('a sentence that cannot be read counts as needing the person', () => {
  expect(parseSentence('')).toEqual({ kind: 'unknown', sentence: FAILED_SENTENCE })
  expect(parseSentence('{"kind":"wat","sentence":"x"}').kind).toBe('unknown')
  expect(parseSentence('```json\n{"kind":"review","sentence":"老大，週報好了，請你驗收。"}\n```')).toEqual({
    kind: 'review', sentence: '老大，週報好了，請你驗收。',
  })
  expect(parseSentence('{"kind":"none","sentence":"都好了"}').sentence).toBe('都好了')
})

test('a subagent\'s tool does not count as the session\'s latest action', () => {
  expect(mainAction('Bash', { description: '跑測試', agentId: 'a1' })).toBeUndefined()
  expect(mainAction('Bash', { description: '跑測試' })).toBe('正在跑指令：跑測試')
})

test('the latest action never carries a whole command', () => {
  expect(describeTool('Bash', { command: 'curl -H secret', description: '跑測試' })).toBe('正在跑指令：跑測試')
  expect(describeTool('Bash', { command: 'curl -H secret' })).toBe('正在跑指令')
  expect(describeTool('Edit', { file_path: '/a/report.py' })).toBe('正在編輯 report.py')
  expect(describeTool('mcp__ccd_turn__update_plan', {})).toBeUndefined()
  expect(describeTool('mcp__ccd_turn__wrap_up', {})).toBe('正在收尾')
})

test('only subagents still running are listed, each with its latest action', () => {
  const agents = [
    { id: 'a', description: '對照舊版', status: 'running' },
    { id: 'b', description: '實跑', status: 'pending' },
    { id: 'c', description: '跑完了', status: 'completed' },
    { id: 'd', description: '失敗了', status: 'failed' },
  ] as const
  expect(helpersOf(agents, new Map([['a', '正在編輯 report.py']]))).toEqual([
    { id: 'a', description: '對照舊版', activity: '正在編輯 report.py' },
    { id: 'b', description: '實跑', activity: '' },
  ])
})

test('a running subagent leaves the card asking for the person', () => {
  const helpers = [{ id: 'a', description: '對照舊版', activity: '' }]
  const card = cardOf(watch, { ...ended('decide'), helpers }, 'here')
  expect(card.status).toBe('calling')
  expect(card.helpers).toEqual(helpers)
})

test('only a CLI session offers a resume command', () => {
  expect(resumeCommand(cliIdOf('abc'))).toBe('claude --resume abc')
  expect(resumeCommand('local_abc')).toBeUndefined()
})

test('the app\'s session records become candidates, archived ones do not', () => {
  expect(candidateFromRecord({ sessionId: 'local_a', title: '週報', cwd: '/x/repo' })).toEqual({
    localId: 'local_a', title: '週報', folder: 'repo', link: 'claude://claude.ai/epitaxy/local_a', hasReport: false,
  })
  expect(candidateFromRecord({ sessionId: 'local_a', isArchived: true })).toBeUndefined()
  expect(candidateFromRecord({ title: '沒有 id' })).toBeUndefined()
})

test('a transcript\'s title is its last real title line', () => {
  const lines = [
    JSON.stringify({ type: 'ai-title', aiTitle: '舊' }),
    JSON.stringify({ type: 'user', text: '"type":"ai-title"' }),
    JSON.stringify({ type: 'custom-title', customTitle: '新' }),
    'not json',
  ].join('\n')
  expect(titleFromTranscript(lines)).toBe('新')
  expect(titleFromTranscript('')).toBeUndefined()
  expect(cwdFromTranscript('"cwd":"/Users/a/repo"\n')).toBe('/Users/a/repo')
})

test('only some sentences are asked to say 老大', () => {
  expect(sentencePrompt('x', true)).toContain('這句要自然帶一次')
  expect(sentencePrompt('x', false)).toContain('這句不要出現')
})

test('the update time names the day only when it is not today', () => {
  const at = new Date(2026, 10, 4, 9, 5, 7).getTime()
  expect(updatedLabel(at, new Date(2026, 10, 4, 18, 0, 0).getTime())).toBe('09:05:07')
  expect(updatedLabel(at, new Date(2026, 10, 5, 8, 0, 0).getTime())).toBe('11/04 09:05:07')
})

test('a card carries the time of its last report', () => {
  expect(cardOf(watch, ended('none', 42), 'here').updatedAt).toBe(42)
  expect(cardOf(watch, undefined, 'here').updatedAt).toBeUndefined()
})

test('a running CLI session is gone back to, a closed one is resumed where it ran', () => {
  const id = cliIdOf('abc')
  const terminal = { app: 'iTerm.app', tty: '/dev/ttys003', pid: 1, cwd: "/a/it's" }
  expect(openPlan(id, terminal, true)).toEqual({ kind: 'focus', app: 'iTerm.app', tty: '/dev/ttys003' })
  expect(openPlan(id, { ...terminal, app: 'vscode' }, true)).toEqual({ kind: 'elsewhere', app: 'vscode' })
  expect(openPlan(id, terminal, false)).toEqual({ kind: 'resume', app: 'iTerm.app', command: "cd '/a/it'\\''s' && claude --resume abc" })
  expect(openPlan(id, undefined, false, '/b')).toEqual({ kind: 'resume', app: 'Apple_Terminal', command: "cd '/b' && claude --resume abc" })
  expect(openPlan(id, undefined, false)).toEqual({ kind: 'unknown' })
})
