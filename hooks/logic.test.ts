import { expect, test } from 'claude-code/testing'

import type { Report, Watch } from '../types'
import { badgeLabel, nextRoundBaseline, roundMembers, ASKING_SENTENCE, FAILED_SENTENCE, HEARTBEAT_MS, INTERRUPTED_SENTENCE, askingAt, interruptedAt, LOST_AFTER_MS, LOST_SENTENCE, candidateFromRecord, cardOf, cliIdOf, cwdFromTranscript, titleFromTranscript, describeTool, helpersOf, mainAction, needsHeartbeat, openPlan, parseSentence, pickOrder, resumeCommand, sentencePrompt, groupsOf, isGroupOpen, sortCards, statusOf, togglePin, updatedLabel } from './logic'

const NOW = 1

const watch: Watch = { localId: 'local_a', title: 'A', description: '', link: '', addedAt: 1 }
const ended = (kind: Report['kind'], endedAt = 10): Report => ({
  localId: 'local_a', at: endedAt, phase: 'ended', activity: '', kind, sentence: '好了。', endedAt,
})

test('the status table', () => {
  expect(statusOf(undefined, watch, NOW)).toBe('offline')
  expect(statusOf({ localId: 'a', at: 1, phase: 'idle', activity: '' }, watch, NOW)).toBe('idle')
  expect(statusOf({ localId: 'a', at: 1, phase: 'working', activity: 'x' }, watch, NOW)).toBe('working')
  expect(statusOf({ localId: 'a', at: 1, phase: 'ended', activity: '' }, watch, NOW)).toBe('idle')
  for (const kind of ['decide', 'review', 'blocked', 'unknown'] as const) expect(statusOf(ended(kind), watch, NOW)).toBe('calling')
  expect(statusOf(ended('none'), watch, NOW)).toBe('done')
})

test('知道了 clears this turn only', () => {
  const acked = { ...watch, ackAt: 10 }
  expect(statusOf(ended('decide', 10), acked, NOW)).toBe('done')
  expect(statusOf(ended('decide', 11), acked, NOW)).toBe('calling')
})

test('the sentence keeps showing on 完成, and cards sort by status', () => {
  expect(cardOf(watch, ended('none'), 'here', NOW).sentence).toBe('好了。')
  const a = cardOf({ ...watch, localId: 'done' }, ended('none'), 'here', NOW)
  const b = cardOf({ ...watch, localId: 'call' }, ended('decide'), 'here', NOW)
  const c = cardOf({ ...watch, localId: 'off' }, undefined, 'here', NOW)
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
  const card = cardOf(watch, { ...ended('decide'), helpers }, 'here', NOW)
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
  expect(cardOf(watch, ended('none', 42), 'here', NOW).updatedAt).toBe(42)
  expect(cardOf(watch, undefined, 'here', NOW).updatedAt).toBeUndefined()
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

test('a list to pick from has the current session first, then the newest added', () => {
  const card = (localId: string, addedAt: number) => cardOf({ ...watch, localId, addedAt }, undefined, 'here', NOW)
  const order = pickOrder([card('old', 1), card('me', 2), card('new', 3)], 'me').map(one => one.localId)
  expect(order).toEqual(['me', 'new', 'old'])
  expect(pickOrder([card('old', 1), card('new', 3)]).map(one => one.localId)).toEqual(['new', 'old'])
})

const working = (at: number, aliveAt?: number): Report => ({ localId: 'a', at, aliveAt, phase: 'working', activity: '正在跑指令' })

test('a working session that stopped reporting alive is lost, and comes back with its next beat', () => {
  expect(statusOf(working(0, 1000), watch, 1000 + LOST_AFTER_MS)).toBe('working')
  expect(statusOf(working(0, 1000), watch, 1001 + LOST_AFTER_MS)).toBe('lost')
  expect(statusOf(working(0, 5000), watch, 1001 + LOST_AFTER_MS)).toBe('working')
})

test('a session on a version without heartbeats is never called lost', () => {
  expect(statusOf(working(1000), watch, 1e12)).toBe('working')
})

test('a turn cut short asks for the person, and 知道了 clears it', () => {
  const cut = { ...working(1), ...interruptedAt(50) } as Report
  expect(statusOf(cut, watch, 60)).toBe('calling')
  expect(cardOf(watch, cut, 'here', 60).sentence).toBe(INTERRUPTED_SENTENCE)
  expect(statusOf(cut, { ...watch, ackAt: 50 }, 60)).toBe('done')
})

test('a question to the person shows as 找你 and is never lost while it waits', () => {
  const asking = { ...working(1), ...askingAt(50) } as Report
  expect(statusOf(asking, watch, 1e12)).toBe('calling')
  expect(cardOf(watch, asking, 'here', 1e12).sentence).toBe(ASKING_SENTENCE)
  expect(needsHeartbeat(asking, 1e12)).toBe(false)
})

test('a session that is not working is never lost, however old its report', () => {
  expect(statusOf(ended('decide', 1), watch, 1e12)).toBe('calling')
  expect(statusOf(ended('none', 1), watch, 1e12)).toBe('done')
  expect(statusOf({ localId: 'a', at: 1, phase: 'idle', activity: '' }, watch, 1e12)).toBe('idle')
})

test('a lost card says so, drops what it was doing, keeps its time and sorts right after 找你', () => {
  const helpers = [{ id: 'h', description: '查資料', activity: '' }]
  const lost = cardOf(watch, { ...working(7, 8), helpers }, 'here', 8 + LOST_AFTER_MS + 1)
  expect(lost.sentence).toBe(LOST_SENTENCE)
  expect(lost.activity).toBe('')
  expect(lost.helpers).toEqual([])
  expect(lost.updatedAt).toBe(7)
  const others = [cardOf(watch, working(1e12, 1e12), 'here', 1e12), cardOf(watch, ended('decide'), 'here', 1e12)]
  expect(sortCards([{ ...lost, status: 'lost' }, ...others]).map(card => card.status)).toEqual(['calling', 'lost', 'working'])
})

test('only a working session beats, and only once the last sign of life is old enough', () => {
  expect(needsHeartbeat(undefined, 1e12)).toBe(false)
  expect(needsHeartbeat(ended('none', 1), 1e12)).toBe(false)
  expect(needsHeartbeat(working(0, 1000), 999 + HEARTBEAT_MS)).toBe(false)
  expect(needsHeartbeat(working(0, 1000), 1000 + HEARTBEAT_MS)).toBe(true)
  expect(needsHeartbeat(working(1000), 1000 + HEARTBEAT_MS)).toBe(true)
})

test('the pin flips on the chosen session only, and keeps the rest of its watch', () => {
  const other = { ...watch, localId: 'local_b' }
  const once = togglePin([watch, other], 'local_a')
  expect(once).toEqual([{ ...watch, isPinned: true }, other])
  expect(togglePin(once, 'local_a')[0]?.isPinned).toBe(false)
})

test('within a status the latest update comes first, and a card with none comes last', () => {
  const card = (localId: string, at?: number) => ({ ...cardOf({ ...watch, localId }, at ? ended('none', at) : undefined, 'here', NOW), status: 'done' as const })
  expect(sortCards([card('none'), card('old', 5), card('new', 9)]).map(one => one.localId)).toEqual(['new', 'old', 'none'])
})

test('statuses that may need the person start open, and a change to one stays with it', () => {
  expect((['calling', 'lost', 'working'] as const).every(status => isGroupOpen(status, {}))).toBe(true)
  expect((['done', 'idle', 'offline'] as const).some(status => isGroupOpen(status, {}))).toBe(false)
  expect(isGroupOpen('calling', { calling: false })).toBe(false)
  expect(isGroupOpen('done', { done: true })).toBe(true)
})

test('cards group by status in the board order, and an empty status has no group', () => {
  const card = (status: 'calling' | 'done', localId: string) => ({ ...cardOf({ ...watch, localId }, undefined, 'here', NOW), status })
  const groups = groupsOf(sortCards([card('done', 'd'), card('calling', 'c')]))
  expect(groups.map(group => [group.status, group.cards.map(one => one.localId)])).toEqual([['calling', ['c']], ['done', ['d']]])
})

test('the label counts this round\'s subagents, and goes back to the status when none run', () => {
  const helper = (id: string) => ({ id, description: '', activity: '' })
  expect(badgeLabel({ status: 'working', helpers: [helper('a'), helper('b'), helper('c')], helpersTotal: 5 })).toBe('子代理 (2/5)')
  expect(badgeLabel({ status: 'calling', helpers: [helper('a')], helpersTotal: 2 })).toBe('子代理 (1/2)')
  expect(badgeLabel({ status: 'calling', helpers: [], helpersTotal: 2 })).toBe('🙋 找你')
  expect(badgeLabel({ status: 'working', helpers: [helper('a')], helpersTotal: 0 })).toBe('子代理 (0/1)')
})

test('a round counts from zero only when no subagent runs, and one finishing does not reset it', () => {
  const first = nextRoundBaseline([{ id: 'old', status: 'completed' }], new Set())
  const round = [{ id: 'old', status: 'completed' as const }, { id: 'a', status: 'completed' as const }, { id: 'b', status: 'running' as const }]
  expect(nextRoundBaseline(round, first)).toBe(first)
  const done = round.map(agent => ({ ...agent, status: 'completed' as const }))
  expect(nextRoundBaseline(done, first)).not.toBe(first)
  expect(roundMembers(done, nextRoundBaseline(done, first), new Set()).size).toBe(0)
})

test('the count keeps a finished subagent that dropped off the list', () => {
  const baseline = new Set(['old'])
  const three = roundMembers([{ id: 'old' }, { id: 'a' }, { id: 'b' }, { id: 'c' }], baseline, new Set())
  expect(three.size).toBe(3)
  expect(roundMembers([{ id: 'old' }, { id: 'c' }], baseline, three).size).toBe(3)
})

test('while subagents run a card is only 找你 or 工作中, and they keep the session beating', () => {
  const helpers = [{ id: 'h', description: '查資料', activity: '' }]
  const alive = { aliveAt: 100 }
  expect(statusOf({ ...ended('none', 50), ...alive, helpers }, watch, 100)).toBe('working')
  expect(statusOf({ localId: 'a', at: 1, ...alive, phase: 'idle', activity: '', helpers }, watch, 100)).toBe('working')
  expect(statusOf({ ...ended('decide', 50), ...alive, helpers }, watch, 100)).toBe('calling')
  expect(statusOf({ ...ended('decide', 50), ...alive, helpers }, { ...watch, ackAt: 50 }, 100)).toBe('working')
  expect(needsHeartbeat({ ...ended('none', 50), ...alive, helpers }, 100 + HEARTBEAT_MS)).toBe(true)
})

test('subagents of a session gone silent leave the card: a calling one stays calling, others are lost', () => {
  const helpers = [{ id: 'h', description: '查資料', activity: '' }]
  const later = 100 + LOST_AFTER_MS + 1
  const calling = cardOf(watch, { ...ended('decide', 50), aliveAt: 100, helpers }, 'here', later)
  expect([calling.status, calling.helpers]).toEqual(['calling', []])
  const quiet = cardOf(watch, { ...ended('none', 50), aliveAt: 100, helpers }, 'here', later)
  expect([quiet.status, quiet.helpers]).toEqual(['lost', []])
  expect(statusOf(ended('none', 50), watch, later)).toBe('done')
})
