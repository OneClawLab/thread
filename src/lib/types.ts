export type { ThreadEventInput, ThreadEvent, PeekOptions }
export type { ThreadErrorCode }
export { ThreadError }

interface ThreadEventInput {
  source: string
  type: 'message' | 'record'
  subtype?: string
  content: string
}

interface ThreadEvent extends Omit<ThreadEventInput, 'subtype'> {
  id: number
  created_at: string
  subtype: string | null
}

interface PeekOptions {
  lastEventId: number
  limit?: number
  filter?: string
}

type ThreadErrorCode =
  | 'THREAD_ALREADY_EXISTS'
  | 'THREAD_NOT_INITIALIZED'
  | 'THREAD_CLOSED'

class ThreadError extends Error {
  readonly code: ThreadErrorCode

  constructor(message: string, code: ThreadErrorCode) {
    super(message)
    this.name = 'ThreadError'
    this.code = code
  }
}
