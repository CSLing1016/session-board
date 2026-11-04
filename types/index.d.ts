export type Kind = 'decide' | 'review' | 'blocked' | 'none' | 'unknown'
export type Status = 'calling' | 'working' | 'done' | 'idle' | 'offline'
export type Presence = 'here' | 'archived' | 'deleted'

// Where a CLI session runs, so a card can go back to it.
export type Terminal = { app: string; tty: string; pid: number; cwd: string }

// A subagent still running in a session.
export type Helper = { id: string; description: string; activity: string }

// What a session writes about itself, one file per session.
export type Report = {
  localId: string
  at: number
  phase: 'idle' | 'working' | 'ended'
  activity: string
  kind?: Kind
  sentence?: string
  endedAt?: number
  helpers?: Helper[]
  terminal?: Terminal
}

// What the person chose to watch.
export type Watch = {
  localId: string
  title: string
  description: string
  link: string
  addedAt: number
  ackAt?: number
  cwd?: string
}

export type Card = Watch & {
  status: Status
  activity: string
  sentence: string
  presence: Presence
  helpers: Helper[]
  updatedAt?: number
}

export type Candidate = { localId: string; title: string; folder: string; link: string; hasReport: boolean; cwd?: string }
export type View = 'board' | 'pick' | 'edit' | 'delete' | 'form'
export type Draft = { localId: string; link: string; title: string; description: string; isEditing: boolean; cwd?: string }

declare module 'claude-code' {
  interface PluginState {
    'session-board': {
      cards: Card[]
      view: View
      candidates: Candidate[]
      draft: Draft | null
      notice: string
      isMenuOpen: boolean
      isPaneOpen: boolean
    }
  }
}
