import { expect, test } from 'claude-code/testing'

import type { Card } from '../types'

const PANE = {
  plugin: 'session-board',
  component: 'Pane',
  requestId: 'session-board',
  props: {
    title: '對話儀表板',
    isFocused: false,
    bodyColumns: 53,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 39 },
    view: {},
  },
} as const

const CALLING: Card = {
  localId: 'local_a',
  title: '週報',
  description: '每週五交',
  link: 'claude://x',
  addedAt: 1,
  status: 'calling',
  activity: '',
  sentence: '老大，週報做好了，請你驗收。',
  presence: 'here',
  helpers: [],
}

test('an empty board says so and offers to add, on every surface', async ($, on) => {
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /還沒有監控/ }))?.text).toBe('還沒有監控的對話。')
    expect(await ui.find({ key: 'menu' })).toBeTruthy()
    await ui.unmount()
  }
})

test('a card that is calling shows its sentence and 知道了', async ($, on) => {
  on('state.get', (_, e) => ({
    value: e.key === 'cards' ? { value: [CALLING], version: 1 } : { value: undefined, version: 0 },
  }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /請你驗收/ }))?.text).toBe(CALLING.sentence)
  expect(await ui.find({ type: 'Button', key: 'ack-local_a' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'open-local_a' })).toBeTruthy()
  await ui.unmount()
})

test('a card lists its running subagents, three at most', async ($, on) => {
  const helpers = ['甲', '乙', '丙', '丁'].map(name => ({ id: name, description: name, activity: '正在讀 a.py' }))
  on('state.get', (_, e) => ({
    value: e.key === 'cards' ? { value: [{ ...CALLING, helpers }], version: 1 } : { value: undefined, version: 0 },
  }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /執行中/ }))?.text).toBe('子代理 4 個執行中')
  expect((await ui.find({ type: 'Text', text: /丙/ }))?.text).toBe('丙：正在讀 a.py')
  expect(await ui.find({ type: 'Text', text: /丁/ })).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /還有/ }))?.text).toBe('還有 1 個')
  await ui.unmount()
})

const BAND = {
  plugin: 'session-board',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 60, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

test('the band offers the board and counts who is calling', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  on('state.get', (_, e) => ({
    value: e.key === 'cards' ? { value: [CALLING], version: 1 } : { value: undefined, version: 0 },
  }))
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Button', key: 'open-board' }))?.text).toContain('1 個找你')
  await ui.unmount()
})

test('the menu holds only the three actions, and ✕ leaves from the top', async $ => {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'menu-delete' })).toBeFalsy()
  await ui.post('picked', { in: 'menu' })
  expect(await ui.find({ key: 'menu-add' })).toBeTruthy()
  expect(await ui.find({ key: 'menu-edit' })).toBeTruthy()
  await ui.post('picked', { in: 'menu-delete' })
  expect((await ui.find({ type: 'Text', text: /選要刪除/ }))?.text).toBe('選要刪除的監控')
  await ui.press({ key: 'close' })
  expect(await ui.find({ key: 'menu' })).toBeTruthy()
  await ui.unmount()
})

test('another mod in the band stays, beside the button', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>晴 42%</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /晴/ }))?.text).toBe('晴 42%')
  expect(await ui.find({ type: 'Button', key: 'open-board' })).toBeTruthy()
  await ui.unmount()
})
