# thread

A Linux CLI tool for managing persistent event queues backed by SQLite, with consumer subscriptions and async dispatch via `notifier`.

## How it works

- Initialize a directory as a thread with `thread init <path>` — the path is the thread ID.
- Push events with `thread push` — stored in SQLite and appended to `events.jsonl`.
- Register consumers with `thread subscribe` — each consumer has a handler command and an optional SQL filter.
- On each push, `notifier` schedules a `thread dispatch` — which spawns handler commands for consumers with pending events (file-locked, so no duplicate runs).
- Consumers call `thread pop` to fetch their events (NDJSON), passing back the last processed event ID for at-least-once delivery.

## Install

### From npm

```bash
npm install -g @theclawlab/thread
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
