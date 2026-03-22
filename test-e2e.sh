#!/usr/bin/env bash
#
# thread CLI End-to-End Test Script — core functionality
#
# Prerequisites:
#   - thread installed: npm run build && npm link
#   - notifier installed (thread push triggers notifier dispatch; notifier need not be running)
#
# Usage: bash test-e2e.sh
#
set -uo pipefail

source "$(dirname "$0")/scripts/e2e-lib.sh"

THREAD="thread"

setup_e2e

T="$TD/test-thread"

# ── Pre-flight ────────────────────────────────────────────────
section "Pre-flight"

require_bin $THREAD "run npm run build"

# ══════════════════════════════════════════════════════════════
# 1. init
# ══════════════════════════════════════════════════════════════
section "1. init"
run_cmd $THREAD init "$T"
assert_exit0
assert_file_exists "$T/events.db" "events.db"
assert_file_exists "$T/events.jsonl" "events.jsonl"

# ══════════════════════════════════════════════════════════════
# 2. init — duplicate exits 1
# ══════════════════════════════════════════════════════════════
section "2. init — duplicate"
run_cmd $THREAD init "$T"
assert_exit 1

# ══════════════════════════════════════════════════════════════
# 3. push — single event
# ══════════════════════════════════════════════════════════════
section "3. push — single event"
run_cmd $THREAD push --thread "$T" --source e2e --type message --content "hello world"
assert_exit0

# ══════════════════════════════════════════════════════════════
# 4. push — with subtype
# ══════════════════════════════════════════════════════════════
section "4. push — with subtype"
run_cmd $THREAD push --thread "$T" --source e2e --type record --subtype toolcall \
  --content '{"tool":"bash","args":["echo hi"]}'
assert_exit0

# ══════════════════════════════════════════════════════════════
# 5. peek — read all events
# ══════════════════════════════════════════════════════════════
section "5. peek — read all"
run_cmd $THREAD peek --thread "$T" --last-event-id 0
assert_exit0
assert_line_count_gte 2

# ══════════════════════════════════════════════════════════════
# 6. peek --filter
# ══════════════════════════════════════════════════════════════
section "6. peek --filter"
run_cmd $THREAD peek --thread "$T" --last-event-id 0 --filter "type = 'message'"
assert_exit0
assert_line_count_eq 1

# ══════════════════════════════════════════════════════════════
# 7. subscribe
# ══════════════════════════════════════════════════════════════
section "7. subscribe"
run_cmd $THREAD subscribe --thread "$T" --consumer worker-1 --handler "true"
assert_exit0

# ══════════════════════════════════════════════════════════════
# 8. subscribe — duplicate exits 1
# ══════════════════════════════════════════════════════════════
section "8. subscribe — duplicate"
run_cmd $THREAD subscribe --thread "$T" --consumer worker-1 --handler "true"
assert_exit 1

# ══════════════════════════════════════════════════════════════
# 9. pop
# ══════════════════════════════════════════════════════════════
section "9. pop"
run_cmd $THREAD pop --thread "$T" --consumer worker-1 --last-event-id 0
assert_exit0
assert_line_count_gte 2
POP_OUT="$OUT"

# ══════════════════════════════════════════════════════════════
# 10. pop — no new events returns empty
# ══════════════════════════════════════════════════════════════
section "10. pop — no new events"
MAX_ID=$(node -e "
const lines = require('fs').readFileSync(process.argv[1],'utf8').trim().split('\n').filter(Boolean);
const ids = lines.map(l => JSON.parse(l).id).filter(Number.isFinite);
process.stdout.write(String(Math.max(...ids)));
" "$POP_OUT" 2>/dev/null)
run_cmd $THREAD pop --thread "$T" --consumer worker-1 --last-event-id "$MAX_ID"
assert_exit0
assert_empty

# ══════════════════════════════════════════════════════════════
# 11. info
# ══════════════════════════════════════════════════════════════
section "11. info"
run_cmd $THREAD info --thread "$T"
assert_exit0
assert_contains "worker-1"

# ══════════════════════════════════════════════════════════════
# 12. info --json
# ══════════════════════════════════════════════════════════════
section "12. info --json"
run_cmd $THREAD info --thread "$T" --json
assert_exit0
assert_json_field "$OUT" "event_count"

# ══════════════════════════════════════════════════════════════
# 13. unsubscribe
# ══════════════════════════════════════════════════════════════
section "13. unsubscribe"
run_cmd $THREAD unsubscribe --thread "$T" --consumer worker-1
assert_exit0

# ══════════════════════════════════════════════════════════════
# 14. push --batch (stdin NDJSON)
# ══════════════════════════════════════════════════════════════
section "14. push --batch"
printf '{"source":"e2e","type":"message","content":"batch msg 1"}\n{"source":"e2e","type":"message","content":"batch msg 2"}\n' \
  | $THREAD push --thread "$T" --batch >/dev/null 2>/dev/null
EC=$?
assert_exit0
run_cmd $THREAD peek --thread "$T" --last-event-id 0 --filter "type = 'message'"
assert_line_count_gte 3

summary_and_exit
