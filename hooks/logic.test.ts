import { expect, test } from 'claude-code/testing'

import type { Report, Watch } from '../types'
import { FAILED_SENTENCE, cardOf, describeTool, helpersOf, mainAction, parseSentence, sortCards, statusOf } from './logic'

const watch: Watch = { localId: 'local_a', title: 'A', description: '', link: '', addedAt: 1 }
const ended = (kind: Report['kind'], endedAt = 10): Report => ({
  localId: 'local_a', at: endedAt, phase: 'ended', activity: '', kind, sentence: '老大，好了。', endedAt,
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
  expect(cardOf(watch, ended('none'), 'here').sentence).toBe('老大，好了。')
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
  expect(parseSentence('{"kind":"none","sentence":"都好了"}').sentence).toBe('老大，都好了')
})

test('a subagent\'s tool does not count as the session\'s latest action', () => {
  expect(mainAction('Bash', { description: '跑測試', agentId: 'a1' })).toBeUndefined()
  expect(mainAction('Bash', { description: '跑測試' })).toBe('正在跑指令：跑測試')
})

test('the latest action never carries a whole command', () => {
  expect(describeTool('Bash', { command: 'curl -H secret', description: '跑測試' })).toBe('正在跑指令：跑測試')
  expect(describeTool('Bash', { command: 'curl -H secret' })).toBe('正在跑指令')
  expect(describeTool('Edit', { file_path: '/a/report.py' })).toBe('正在編輯 report.py')
  expect(describeTool('mcp__ccd_turn__wrap_up', {})).toBeUndefined()
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
