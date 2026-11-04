import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Candidate, Card, Draft, Presence, Report, Terminal, View, Watch } from '../types'
import { BADGE, BADGE_COLOR, candidateFromRecord, cardOf, cliIdOf, cwdFromTranscript, describeTool, folderName, openPlan, helpersOf, mainAction, parseSentence, resumeCommand, sentencePrompt, sortCards, titleFromTranscript, updatedLabel } from './logic'

const PANE = 'session-board'
const APP = 'ccd_session_mgmt'
// A Button's label has no font size: this draws the same gray as the ✕ beside a larger ☰, its
// three lines placed by hand because the font's glyph sits low.
const MENU_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="28" viewBox="0 0 34 28"><rect width="34" height="28" rx="8" fill="#3b3b3b"/><g fill="#e8e8e8"><rect x="9" y="8" width="16" height="2" rx="1"/><rect x="9" y="13" width="16" height="2" rx="1"/><rect x="9" y="18" width="16" height="2" rx="1"/></g></svg>'
const MENU = [
  { action: 'add', label: '新增' },
  { action: 'edit', label: '編輯' },
  { action: 'delete', label: '刪除' },
] as const
const REFRESH_MS = 3000
const PRESENCE_EVERY = 10 // ticks, so about every 30 seconds
const BAND_EVERY = 4 // ticks: only the band's count is needed while the pane is closed
const HELPERS_SHOWN = 3
const BOSS_EVERY = 3 // about one sentence in three says 老大
const SESSIONS_SHOWN = 30
const CLI_SESSIONS_SHOWN = 15
const FOCUS_SCRIPTS: Record<string, string> = {
  Apple_Terminal: `on run argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is item 1 of argv then
          set selected of t to true
          set index of w to 1
          activate
          return "found"
        end if
      end repeat
    end repeat
  end tell
end run`,
  'iTerm.app': `on run argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is item 1 of argv then
            select w
            tell t to select
            tell s to select
            activate
            return "found"
          end if
        end repeat
      end repeat
    end repeat
  end tell
end run`,
}
const RESUME_SCRIPTS: Record<string, string> = {
  Apple_Terminal: `on run argv
  tell application "Terminal"
    do script (item 1 of argv)
    activate
  end tell
end run`,
  'iTerm.app': `on run argv
  tell application "iTerm2"
    set w to (create window with default profile)
    tell current session of w to write text (item 1 of argv)
    activate
  end tell
end run`,
}
const TRANSCRIPTS_SCANNED = 60 // Most are desktop sessions: enough to find the CLI ones among them.

const cards = atom({ plugin: 'session-board', key: 'cards' } as const, [] as Card[])
const view = atom({ plugin: 'session-board', key: 'view' } as const, 'board' as View)
const candidates = atom({ plugin: 'session-board', key: 'candidates' } as const, [] as Candidate[])
const draft = atom({ plugin: 'session-board', key: 'draft' } as const, null as Draft | null)
const notice = atom({ plugin: 'session-board', key: 'notice' } as const, '')
const isMenuOpen = atom({ plugin: 'session-board', key: 'isMenuOpen' } as const, false)
const isPaneOpen = atom({ plugin: 'session-board', key: 'isPaneOpen' } as const, false)

// Every session: what it says about itself.
let localId: string | undefined
let current: Report | undefined
let turn = ''
let writes: Promise<unknown> = Promise.resolve()
let terminal: Terminal | undefined
const helperActions = new Map<string, string>()
let helpersChanged = false

// The board's session: what it remembers between refreshes.
let timer: { cancel: () => void } | undefined
let ticks = 0
let presence: Record<string, Presence> = {}

function folderOf(home: string): string {
  return `${home}/.claude/session-board`
}

async function callApp($: any, tool: string, args: Record<string, unknown>): Promise<any> {
  const got = await $.mcp.call(APP, tool, args)
  if (got.isError) throw new Error(`${tool} failed`)
  const text = got.content.find((block: any) => block.type === 'text')?.text

  return JSON.parse(text)
}

async function readJson<T>($: any, path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return fallback
  }
}

async function readWatches($: any): Promise<Watch[]> {
  return readJson<Watch[]>($, `${folderOf((await $.env.get('HOME')) ?? '')}/watch.json`, [])
}

async function writeWatches($: any, list: readonly Watch[]): Promise<void> {
  await $.fs.write(`${folderOf((await $.env.get('HOME')) ?? '')}/watch.json`, JSON.stringify(list, null, 2))
}

// The session list, the session's local_ id and whether a session still exists all come from the desktop app.
async function hasApp($: any): Promise<boolean> {
  return (await $.session.surfaces()).includes('desktop')
}

// $PPID of a child is this session's own process, and its terminal is what a window can be found by.
async function whereThisRuns($: any): Promise<Terminal | undefined> {
  try {
    const got = await $.process.run(['sh', '-c', 'echo "$PPID $(ps -o tty= -p $PPID)"'], { timeoutMs: 5000 })
    const [pid, tty] = got.stdout.trim().split(/\s+/)
    if (!tty || tty === '??') return undefined

    return { app: (await $.env.get('TERM_PROGRAM')) ?? '', tty: `/dev/${tty}`, pid: Number(pid), cwd: await $.session.cwd() }
  } catch {
    return undefined
  }
}

async function ownId($: any): Promise<string | undefined> {
  if (!localId) {
    const surfaces: readonly string[] = await $.session.surfaces()
    if (surfaces.includes('desktop')) {
      try {
        localId = (await callApp($, 'get_session', { session_id: 'self' })).sessionId
      } catch {
        return undefined // The app may answer next time; a CLI id here would split this session in two.
      }
    } else if (surfaces.includes('terminal')) {
      localId = cliIdOf(await $.session.id())
      terminal = await whereThisRuns($)
    } else {
      return undefined // A plain -p run draws nowhere: nobody would watch it.
    }
  }

  return localId
}

// Writes run one at a time, so the last thing that happened is the last thing stored.
function report($: any, change: Partial<Report>): Promise<unknown> {
  writes = writes
    .then(async () => {
      const id = await ownId($)
      if (!id) return
      const home = (await $.env.get('HOME')) ?? ''
      current = {
        phase: 'idle',
        activity: '',
        ...current,
        ...change,
        ...(terminal ? { terminal } : {}),
        localId: id,
        at: change.at ?? (await $.clock.now()),
      }
      await $.fs.write(`${folderOf(home)}/reports/${id}.json`, JSON.stringify(current))
    })
    .catch(() => undefined)

  return writes
}

// Subagents call tools too often to write on each call: the refresh tick writes what changed.
async function syncHelpers($: any): Promise<void> {
  helpersChanged = false
  const helpers = helpersOf(await $.agent.list(), helperActions)
  if (JSON.stringify(helpers) !== JSON.stringify(current?.helpers ?? [])) await report($, { helpers })
}

async function isWatched($: any): Promise<boolean> {
  const id = await ownId($)

  return (await readWatches($)).some(one => one.localId === id)
}

async function summarize($: any, answer: string, callsBoss: boolean): Promise<{ kind: any; sentence: string }> {
  try {
    const reply = await $.model.complete({ model: 'haiku', prompt: sentencePrompt(answer, callsBoss), timeoutMs: 20000 })

    return parseSentence(reply.isAnswered ? reply.text : '')
  } catch {
    return parseSentence('')
  }
}

async function refresh($: any, checkPresence = false): Promise<void> {
  const home = (await $.env.get('HOME')) ?? ''
  const watches = await readWatches($)
  // Without the app nothing can tell: every card stays as it is rather than reading as deleted.
  if (checkPresence && (await hasApp($))) {
    const found: Record<string, Presence> = {}
    for (const one of watches) {
      if (resumeCommand(one.localId)) {
        found[one.localId] = 'here'
        continue
      }
      try {
        found[one.localId] = (await callApp($, 'get_session', { session_id: one.localId })).isArchived ? 'archived' : 'here'
      } catch {
        found[one.localId] = 'deleted'
      }
    }
    presence = found
  }
  const next: Card[] = []
  for (const one of watches) {
    const got = await readJson<Report | undefined>($, `${folderOf(home)}/reports/${one.localId}.json`, undefined)
    next.push(cardOf(one, got, presence[one.localId] ?? 'here'))
  }
  const sorted = sortCards(next)
  await update($, cards, old => (JSON.stringify(old) === JSON.stringify(sorted) ? old : sorted))
}

async function tick($: any): Promise<void> {
  // Running helpers are checked each tick too: that is how one that ended leaves the card.
  if (helpersChanged || current?.helpers?.length) await syncHelpers($).catch(() => undefined)
  const count = ticks++
  const isOpen = await read($, isPaneOpen)
  if (!isOpen && count % BAND_EVERY !== 0) return
  await refresh($, isOpen && count % PRESENCE_EVERY === 0)
}

function goLive($: any): void {
  if (timer) return
  timer = $.clock.every(REFRESH_MS, () => void tick($).catch(() => undefined))
  void refresh($).catch(() => undefined)
}

async function openBoard($: any): Promise<void> {
  goLive($)
  await update($, isPaneOpen, () => true)
  await $.ui.open({ id: PANE, title: '對話儀表板' })
  await refresh($, true)
}

async function listFolder($: any, path: string): Promise<any[]> {
  try {
    return await $.fs.list(path)
  } catch {
    return []
  }
}

// Without the app: its own records on disk, a format it does not promise to keep, so a failure only shortens the list.
async function desktopFromRecords($: any, home: string): Promise<Candidate[]> {
  const root = `${home}/Library/Application Support/Claude/claude-code-sessions`
  const files: { path: string; at: number }[] = []
  for (const account of await listFolder($, root)) {
    for (const org of await listFolder($, `${root}/${account.name}`)) {
      for (const file of await listFolder($, `${root}/${account.name}/${org.name}`)) {
        if (file.name.startsWith('local_') && file.name.endsWith('.json')) {
          files.push({ path: `${root}/${account.name}/${org.name}/${file.name}`, at: file.mtimeMs })
        }
      }
    }
  }
  const list: Candidate[] = []
  for (const file of files.sort((a, b) => b.at - a.at)) {
    if (list.length >= SESSIONS_SHOWN) break
    const found = candidateFromRecord(await readJson<Record<string, unknown>>($, file.path, {}))
    if (found) list.push(found)
  }

  return list
}

async function grep($: any, args: string[]): Promise<string> {
  return (await $.process.run(['grep', ...args], { timeoutMs: 5000 })).stdout
}

async function cliSessions($: any, home: string): Promise<Candidate[]> {
  const root = `${home}/.claude/projects`
  const files: { path: string; id: string; at: number }[] = []
  for (const folder of await listFolder($, root)) {
    for (const file of await listFolder($, `${root}/${folder.name}`)) {
      if (file.name.endsWith('.jsonl')) {
        files.push({ path: `${root}/${folder.name}/${file.name}`, id: file.name.slice(0, -'.jsonl'.length), at: file.mtimeMs })
      }
    }
  }
  const list: Candidate[] = []
  for (const file of files.sort((a, b) => b.at - a.at).slice(0, TRANSCRIPTS_SCANNED)) {
    if (list.length >= CLI_SESSIONS_SHOWN) break
    if (!(await grep($, ['-m1', '-o', '"entrypoint":"[^"]*"', file.path])).includes('"cli"')) continue
    // No title means no real turn yet, as in a session opened and left: nothing to tell it by.
    const title = titleFromTranscript(await grep($, ['-E', '"type":"(ai|custom)-title"', file.path]))
    if (!title) continue
    const cwd = cwdFromTranscript(await grep($, ['-m1', '-o', '"cwd":"[^"]*"', file.path]))
    list.push({
      localId: cliIdOf(file.id),
      title,
      cwd,
      folder: folderName(cwd),
      link: '',
      hasReport: false,
    })
  }

  return list
}

async function openPicker($: any): Promise<void> {
  await update($, notice, () => '')
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const watched = new Set((await readWatches($)).map(one => one.localId))
    const fromApp = await hasApp($)
    const desktop: Candidate[] = fromApp
      ? (await callApp($, 'list_sessions', { limit: SESSIONS_SHOWN })).map((row: any) => ({
          localId: row.sessionId,
          title: row.title ?? '（未命名）',
          folder: String(row.cwd ?? '').split('/').pop() ?? '',
          link: row.link ?? '',
          hasReport: false,
        }))
      : await desktopFromRecords($, home)
    const found = [...(await cliSessions($, home).catch(() => [])), ...desktop]
    // A new CLI session has no transcript yet, and it is the likeliest one to add.
    const own = fromApp ? undefined : await ownId($)
    const self = found.find(one => one.localId === own)
    const all = own ? [self ?? { localId: own, title: '這個對話', folder: '', link: '', hasReport: true, cwd: await $.session.cwd() }, ...found.filter(one => one !== self)] : found
    const list: Candidate[] = []
    for (const one of all) {
      if (watched.has(one.localId)) continue
      list.push({ ...one, hasReport: await $.fs.exists(`${folderOf(home)}/reports/${one.localId}.json`).catch(() => false) })
    }
    await update($, candidates, () => list)
    await update($, view, () => 'pick' as View)
  } catch {
    await update($, notice, () => '讀不到對話清單，請稍後再試。')
  }
}

async function saveWatch($: any): Promise<void> {
  const form = await read($, draft)
  if (!form?.title.trim()) {
    await update($, notice, () => '標題不能空白。')

    return
  }
  const list = await readWatches($)
  const title = form.title.trim()
  const description = form.description.trim()
  if (list.some(one => one.localId === form.localId)) {
    await writeWatches($, list.map(one => (one.localId === form.localId ? { ...one, title, description } : one)))
  } else {
    await writeWatches($, [...list, { localId: form.localId, link: form.link, title, description, addedAt: await $.clock.now(), ...(form.cwd ? { cwd: form.cwd } : {}) }])
  }
  await update($, notice, () => '')
  await update($, view, () => 'board' as View)
  await refresh($, true)
}

async function isRunning($: any, pid: number): Promise<boolean> {
  return (await $.process.run(['ps', '-o', 'command=', '-p', String(pid)], { timeoutMs: 5000 })).stdout.includes('claude')
}

async function openCard($: any, card: Card): Promise<void> {
  await update($, notice, () => '')
  if (card.link) {
    await $.process.run(['open', card.link], { timeoutMs: 5000 })

    return
  }
  const home = (await $.env.get('HOME')) ?? ''
  const where = (await readJson<Report | undefined>($, `${folderOf(home)}/reports/${card.localId}.json`, undefined))?.terminal
  const plan = openPlan(card.localId, where, where ? await isRunning($, where.pid) : false, card.cwd)
  const fallback = resumeCommand(card.localId)
  if (plan.kind === 'focus' || plan.kind === 'resume') {
    const script = plan.kind === 'focus' ? FOCUS_SCRIPTS[plan.app] : RESUME_SCRIPTS[plan.app]
    const got = await $.process.run(['osascript', '-e', script, plan.kind === 'focus' ? plan.tty : plan.command], { timeoutMs: 10000 })
    if (got.exitCode !== 0) await update($, notice, () => `開不了終端機，請確認系統允許自動操作，或自己執行：${fallback}`)
    else if (plan.kind === 'focus' && !got.stdout.includes('found')) await update($, notice, () => '找不到這個對話的終端機視窗。')
  } else if (plan.kind === 'elsewhere') {
    await update($, notice, () => `這個對話開在 ${plan.app || '其他終端機'}，無法自動跳轉，請自己切過去。`)
  } else {
    await update($, notice, () => `不知道這個對話的資料夾，請到原本的資料夾執行：${fallback}`)
  }
}

async function changeWatch($: any, change: (list: Watch[]) => Watch[]): Promise<void> {
  await writeWatches($, change(await readWatches($)))
  await refresh($)
}

async function pickFromMenu($: any, picked: string): Promise<void> {
  await update($, isMenuOpen, () => false)
  if (picked === 'add') await openPicker($)
  else await update($, view, () => picked as View)
}

async function drawBoard($: any, e: any): Promise<any> {
  const { Box, Text, Button, Input, Client, Svg } = $.ui.resolve(e)
  const isTerminal = e.surface === 'terminal'
  // The terminal has whole cells only: 1% would round to no bar at all.
  const barWidth = isTerminal ? 1 : '1%'
  const mode = await read($, view)
  const message = await read($, notice)
  const shown = message ? <Text color="red">{message}</Text> : null
  // Stays at the top, so a long list never pushes the way out of reach.
  const titled = (title: string) => (
    <Box flexDirection="row" justifyContent="space-between" alignItems="center">
      <Text bold>{title}</Text>
      <Button key="close" label="✕" onPress={() => void update($, view, () => 'board' as View)} />
    </Box>
  )

  if (mode === 'pick') {
    const list = await read($, candidates)

    return (
      <Box flexDirection="column" gap={1}>
        {titled('選要新增監控的對話')}
        {shown}
        {list.length === 0 && <Text dimColor>沒有可加入的對話。</Text>}
        {list.map(one => (
          <Button
            key={`pick-${one.localId}`}
            onPress={() => {
              void update($, draft, () => ({ localId: one.localId, link: one.link, title: one.title, description: '', isEditing: false, cwd: one.cwd }))
              void update($, view, () => 'form' as View)
            }}
          >
            {one.title} <Text dimColor>{one.folder}{resumeCommand(one.localId) ? '・CLI' : ''}{one.hasReport ? '' : '・未連線'}</Text>
          </Button>
        ))}
      </Box>
    )
  }

  if (mode === 'edit' || mode === 'delete') {
    const list = await read($, cards)

    return (
      <Box flexDirection="column" gap={1}>
        {titled(mode === 'edit' ? '選要編輯的監控' : '選要刪除的監控')}
        {mode === 'delete' && <Text dimColor>只移除卡片，對話本身不受影響。</Text>}
        {list.length === 0 && <Text dimColor>還沒有監控的對話。</Text>}
        {list.map(card => (
          <Button
            key={`${mode}-${card.localId}`}
            onPress={() => {
              if (mode === 'edit') {
                void update($, draft, () => ({
                  localId: card.localId,
                  link: card.link,
                  title: card.title,
                  description: card.description,
                  isEditing: true,
                }))
                void update($, view, () => 'form' as View)
              } else {
                void update($, view, () => 'board' as View)
                void changeWatch($, watches => watches.filter(one => one.localId !== card.localId))
              }
            }}
          >
            {card.title}
          </Button>
        ))}
      </Box>
    )
  }

  if (mode === 'form') {
    const form = await read($, draft)

    return (
      <Box flexDirection="column" gap={1}>
        {titled(form?.isEditing ? '編輯監控' : '新增監控')}
        {shown}
        <Input
          key="form-title"
          label="標題"
          value={form?.title ?? ''}
          onInput={(value: string) => void update($, draft, old => (old ? { ...old, title: value } : old))}
          onSubmit={() => void saveWatch($)}
        />
        <Input
          key="form-description"
          label="描述"
          placeholder="選填"
          value={form?.description ?? ''}
          rows={2}
          onInput={(value: string) => void update($, draft, old => (old ? { ...old, description: value } : old))}
          onSubmit={() => void saveWatch($)}
        />
        <Button key="form-add" variant="primary" onPress={() => void saveWatch($)}>{form?.isEditing ? '儲存' : '新增'}</Button>
      </Box>
    )
  }

  const list = await read($, cards)
  const menuOpen = await read($, isMenuOpen)
  const drawHelpers = (helpers: Card['helpers'] = []) =>
    helpers.length > 0 && (
      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        <Text size="footnote" dimColor>{`子代理 ${helpers.length} 個執行中`}</Text>
        <Box position="relative" flexDirection="column" paddingLeft={2}>
          <Box position="absolute" top={0} bottom={0} left={0} width={barWidth} backgroundColor="#4a4a4a" />
          {helpers.slice(0, HELPERS_SHOWN).map(helper => (
            <Text key={`helper-${helper.id}`} size="footnote">
              {helper.activity ? `${helper.description}：${helper.activity}` : helper.description}
            </Text>
          ))}
          {helpers.length > HELPERS_SHOWN && (
            <Text size="footnote" dimColor>{`還有 ${helpers.length - HELPERS_SHOWN} 個`}</Text>
          )}
        </Box>
      </Box>
    )

  return (
    <Box position="relative" flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Text dimColor>{list.filter(card => card.status === 'calling').length} 個找你・共 {list.length} 個</Text>
        <Box position="relative">
          {!isTerminal ? (
            <>
              <Svg source={MENU_ICON} alt="選單" width={34} height={28} />
              {/* Laid over the drawing: an Svg takes no press, a Client takes no Svg. */}
              <Box position="absolute" top={0} left={0} right={0} bottom={0}>
                <Client key="menu" module="./menu-row.tsx" width="100%" height="100%" props={{ label: ' ', isQuiet: true }} />
              </Box>
            </>
          ) : (
            <Button key="menu" label="☰" onPress={() => void update($, isMenuOpen, open => !open)} />
          )}
        </Box>
      </Box>
      {shown}
      {list.length === 0 && <Text dimColor>還沒有監控的對話。</Text>}
      {list.map(card => (
        <Box key={`card-${card.localId}`} flexDirection="column" borderStyle="round" paddingX={1}>
          {/* The label floats over room the padding keeps free: a shrinking row Box clips its Text on the desktop instead of wrapping it. */}
          <Box position="relative" flexDirection="column" paddingRight={13}>
            {/* One string: a long sentence wraps on the desktop, and this title, split in two children, did not. */}
            <Text bold>{`${card.title}${card.presence === 'archived' ? '（已封存）' : card.presence === 'deleted' ? '（已刪除）' : ''}`}</Text>
            <Box position="absolute" top={0} right={0}>
              <Text bold color="#ffffff" backgroundColor={BADGE_COLOR[card.status]}>
                {` ${BADGE[card.status]} `}
              </Text>
            </Box>
          </Box>
          {card.description !== '' && <Text dimColor>{card.description}</Text>}
          {(card.activity !== '' || card.sentence !== '' || card.status === 'offline') && (
            <Box position="relative" flexDirection="column" marginTop={1} marginLeft={1} paddingLeft={2}>
              {/* A Box has no left-only border, so the quote bar is drawn; it spans every wrapped line, unlike a │ in the text. */}
              <Box position="absolute" top={0} bottom={0} left={0} width={barWidth} backgroundColor="#4a4a4a" />
              {card.activity !== '' && <Text size="footnote">{card.activity}</Text>}
              {card.sentence !== '' && <Text size="footnote">{card.sentence}</Text>}
              {card.status === 'offline' && <Text size="footnote" dimColor>重開這個對話後才會回報。</Text>}
            </Box>
          )}
          {drawHelpers(card.helpers)}
          {/* The time floats like the status label: the desktop did not draw it as the second item of this row. */}
          <Box position="relative" flexDirection="column" minHeight={1} marginTop={1}>
            <Box flexDirection="row" gap={1}>
            {(card.link !== '' || resumeCommand(card.localId)) && card.presence !== 'deleted' && (
              <Button key={`open-${card.localId}`} onPress={() => void openCard($, card)}>
                開啟對話
              </Button>
            )}
            {card.status === 'calling' && (
              <Button
                key={`ack-${card.localId}`}
                onPress={async () => {
                  const at = await $.clock.now()
                  await changeWatch($, watches =>
                    watches.map(one => (one.localId === card.localId ? { ...one, ackAt: at } : one)),
                  )
                }}
              >
                知道了
              </Button>
            )}
            </Box>
            {card.updatedAt !== undefined && (
              <Box position="absolute" bottom={0} right={0}>
                <Text size="footnote" dimColor>{updatedLabel(card.updatedAt, Date.now())}</Text>
              </Box>
            )}
          </Box>
        </Box>
      ))}
      {/* Last in the tree: an absolute Box is painted over those before it, and over nothing after it. */}
      {menuOpen && (
        <Box
          position="absolute"
          top={2}
          right={0}
          width={isTerminal ? 12 : 8}
          flexDirection="column"
          alignItems="stretch"
          gap={isTerminal ? 0 : 1}
          padding={isTerminal ? 0 : 1}
          borderStyle="round"
          backgroundColor="#262626" // No theme key for a panel's background: tuned for the dark theme.
        >
          {MENU.map(item =>
            isTerminal ? (
              <Button key={`menu-${item.action}`} label={item.label} onPress={() => void pickFromMenu($, item.action)} />
            ) : (
              <Client key={`menu-${item.action}`} module="./menu-row.tsx" width="100%" props={{ label: item.label }} />
            ),
          )}
        </Box>
      )}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const answer = await next(e)
    await $.command.register({ name: 'board', description: '在側邊面板開啟對話儀表板' })
    // A reload or a resume keeps what was said; a turn that died with its process has ended.
    const id = await ownId($)
    if (id) {
      const home = (await $.env.get('HOME')) ?? ''
      const old = await readJson<Report | undefined>($, `${folderOf(home)}/reports/${id}.json`, undefined)
      current = old
      // A reload is not news: only a session found stuck working gets a new time.
      await report($, old?.phase === 'working' ? { phase: 'ended', activity: '', helpers: [] } : { at: old?.at, helpers: [] })
      helpersChanged = true
    }
    if ((await $.session.surfaces()).length > 0) goLive($)

    return answer
  })

  // Quitting mid-turn would otherwise leave the card working forever.
  on('session.end', async ($, e, next) => {
    if (current?.phase === 'working') await report($, { phase: 'ended', activity: '', helpers: [] })

    return next(e)
  })

  on('command.run', { command: 'board' }, async $ => {
    await openBoard($)

    return { text: '對話儀表板已開在側邊面板。' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId) {
      helpersChanged = true
    } else {
      turn = e.turnId
      void report($, { phase: 'working', activity: '正在思考...', kind: undefined, sentence: undefined })
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const said = mainAction(e.tool, input)
    if (said) void report($, { phase: 'working', activity: said })
    if (e.agentId) {
      const action = describeTool(e.tool, input)
      if (action) helperActions.set(e.agentId, action)
      helpersChanged = true
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const answer = await next(e)
    if (e.agentId) return answer
    const endedAt = await $.clock.now()
    const thisTurn = e.turnId
    void (async () => {
      if (e.isAborted) {
        await report($, { phase: 'ended', activity: '', endedAt, kind: 'none', sentence: '這輪被中斷了，不用處理。' })

        return
      }
      if (!(await isWatched($))) {
        await report($, { phase: 'ended', activity: '', endedAt, kind: undefined, sentence: undefined })

        return
      }
      await report($, { phase: 'working', activity: '正在整理回報' })
      const said = await summarize($, e.answer, endedAt % BOSS_EVERY === 0)
      // The person may have started another turn while the sentence was being written.
      if (!turn || turn === thisTurn) await report($, { phase: 'ended', activity: '', endedAt, ...said })
    })().catch(() => undefined)

    return answer
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const answer = await next(e)
    await update($, isPaneOpen, () => false)

    return answer
  })

  on('ui.message', async ($, e, next) => {
    if (e.element === 'menu') void update($, isMenuOpen, open => !open)
    if (e.element.startsWith('menu-')) void pickFromMenu($, e.element.slice('menu-'.length))

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => drawBoard($, e))

  // The app gives a mod no place in its toolbar, and draws nothing a mod puts under the prompt:
  // this band is the nearest place left, though the app paints it gray.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Another mod's band (token-weather's) comes from below: keep it, beside the button.
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const { Box, Button } = $.ui.resolve(e)
    const calling = (await read($, cards)).filter(card => card.status === 'calling').length

    return (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center">
        <Box flexGrow={1}>{below}</Box>
        <Button key="open-board" onPress={() => void openBoard($)}>
          {calling > 0 ? `📋 儀表板・${calling} 個找你` : '📋 儀表板'}
        </Button>
      </Box>
    )
  })
}
