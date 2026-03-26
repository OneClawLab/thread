# thread

A CLI/LIB dual-interface tool for managing persistent event queues backed by SQLite, with consumer subscriptions and async dispatch via `notifier`.

## Dual Interface

**CLI**: Use `thread` command-line tool for direct event queue operations.

**LIB**: Import `@theclawlab/thread` in Node.js to programmatically manage threads (used by xar agent runtime).

## How it works

- Initialize a directory as a thread with `thread init <path>` (CLI) or `ThreadLib.init(path)` (LIB) — the path is the thread ID.
- Push events with `thread push` (CLI) or `ThreadStore.push()` (LIB) — stored in SQLite and appended to `events.jsonl`.
- Register consumers with `thread subscribe` (CLI only) — each consumer has a handler command and an optional SQL filter.
- On each push, `notifier` schedules a `thread dispatch` — which spawns handler commands for consumers with pending events (file-locked, so no duplicate runs).
- Consumers call `thread pop` (CLI) to fetch their events (NDJSON), passing back the last processed event ID for at-least-once delivery.
- Agents call `ThreadStore.peek()` (LIB) to read events without consuming them (for building LLM context).

## Install

### From npm (CLI only)

```bash
npm install -g @theclawlab/thread
```

### From npm (LIB + CLI)

```bash
npm install @theclawlab/thread
```

Then import in Node.js:

```typescript
import { ThreadLib, ThreadStore } from '@theclawlab/thread'

const lib = new ThreadLib()
const store = await lib.open('/path/to/thread')
const event = await store.push({ source: 'agent', type: 'message', content: 'hello' })
await store.peek({ lastEventId: 0 })
store.close()
```

### From source

```bash
npm run build && npm link
```

## Quick start

```bash
# Initialize a thread
thread init /tmp/my-thread

# Register a consumer
thread subscribe \
  --thread /tmp/my-thread \
  --consumer worker-1 \
  --handler "my-handler --thread /tmp/my-thread --consumer worker-1" \
  --filter "type = 'message'"

# Push an event
thread push \
  --thread /tmp/my-thread \
  --source agent-007 \
  --type message \
  --content "hello"

# Check status
thread info --thread /tmp/my-thread

# Consumer pops events (typically called from within handler)
thread pop --thread /tmp/my-thread --consumer worker-1 --last-event-id 0
```

## Commands

| Command | Description |
|---------|-------------|
| `thread init <path>` | Initialize a new thread directory |
| `thread push` | Push one event (or batch via stdin) |
| `thread pop` | Fetch pending events for a consumer (NDJSON) |
| `thread subscribe` | Register a consumer with a handler command |
| `thread unsubscribe` | Remove a consumer subscription |
| `thread info` | Show thread summary and consumer progress |
| `thread dispatch` | (Internal) Spawn handlers for consumers with pending events |

## Data directory

```
<thread-dir>/
├── events.db       # SQLite (WAL mode)
├── events.jsonl    # append-only event log for debugging
├── run/            # consumer lock files
└── logs/           # thread logs (auto-rotated at 10k lines)
```

## Documentation

- [USAGE.md](./USAGE.md) — full CLI reference, event structure, and examples
- [LIB API](#lib-api) — programmatic interface for Node.js

## LIB API

### ThreadLib

Factory class for managing thread directories.

```typescript
import { ThreadLib } from '@theclawlab/thread'

const lib = new ThreadLib()

// Open or auto-create a thread
const store = await lib.open('/path/to/thread')

// Strictly create a new thread (throws if exists)
const store = await lib.init('/path/to/thread')

// Check if thread exists
const exists = await lib.exists('/path/to/thread')

// Delete a thread directory
await lib.destroy('/path/to/thread')
```

### ThreadStore

Per-thread operations interface.

```typescript
import { ThreadStore } from '@theclawlab/thread'

// Push a single event
const event = await store.push({
  source: 'agent-007',
  type: 'message',
  content: 'hello'
})

// Push multiple events in one transaction
const events = await store.pushBatch([
  { source: 'agent', type: 'message', content: 'msg1' },
  { source: 'agent', type: 'record', subtype: 'toolcall', content: '{}' }
])

// Read events without consuming (no consumer registration needed)
const events = await store.peek({
  lastEventId: 0,
  limit: 100,
  filter: "type = 'message'"
})

// Release SQLite connection
store.close()
```

### Types

```typescript
interface ThreadEventInput {
  source: string
  type: 'message' | 'record'
  subtype?: string
  content: string
}

interface ThreadEvent extends ThreadEventInput {
  id: number
  created_at: string
  subtype: string | null
}

interface PeekOptions {
  lastEventId: number
  limit?: number
  filter?: string
}

class ThreadError extends Error {
  code: 'THREAD_ALREADY_EXISTS' | 'THREAD_NOT_INITIALIZED' | 'THREAD_CLOSED'
}
```
