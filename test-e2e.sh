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

# ══════════════════════════════════════════════════════════════
# 10. pop — no new events returns empty
# ══════════════════════════════════════════════════════════════
section "10. pop — no new events"
MAX_ID=$(tail -1 "$OUT" | grep -o '"id":[0-9]*' | grep -o '[0-9]*')
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

# ══════════════════════════════════════════════════════════════
# 15. multiple consumers — independent read pointers
# ══════════════════════════════════════════════════════════════
section "15. multiple consumers — independent read pointers"

T2="$TD/multi-consumer-thread"
run_cmd $THREAD init "$T2"
assert_exit0

# Push 3 events
run_cmd $THREAD push --thread "$T2" --source e2e --type message --content "event-A"
assert_exit0
run_cmd $THREAD push --thread "$T2" --source e2e --type message --content "event-B"
assert_exit0
run_cmd $THREAD push --thread "$T2" --source e2e --type message --content "event-C"
assert_exit0

# Subscribe two consumers
run_cmd $THREAD subscribe --thread "$T2" --consumer alpha --handler "true"
assert_exit0
run_cmd $THREAD subscribe --thread "$T2" --consumer beta --handler "true"
assert_exit0

# Both consumers start from 0 — should each see all 3 events
run_cmd $THREAD pop --thread "$T2" --consumer alpha --last-event-id 0
assert_exit0
assert_line_count_eq 3
ALPHA_OUT="$OUT"

run_cmd $THREAD pop --thread "$T2" --consumer beta --last-event-id 0
assert_exit0
assert_line_count_eq 3

# Extract id of 2nd event (alpha advances past first 2)
ALPHA_MAX_ID=$(head -2 "$ALPHA_OUT" | tail -1 | grep -o '"id":[0-9]*' | grep -o '[0-9]*')

# alpha advances past first 2 events; beta stays at 0
# alpha should now see only event-C (1 event)
run_cmd $THREAD pop --thread "$T2" --consumer alpha --last-event-id "$ALPHA_MAX_ID"
assert_exit0
assert_line_count_eq 1
assert_contains "event-C"

# beta still sees all 3 (hasn't advanced its pointer)
run_cmd $THREAD pop --thread "$T2" --consumer beta --last-event-id 0
assert_exit0
assert_line_count_eq 3

# Advance beta past all events
BETA_MAX_ID=$(tail -1 "$OUT" | grep -o '"id":[0-9]*' | grep -o '[0-9]*')

run_cmd $THREAD pop --thread "$T2" --consumer beta --last-event-id "$BETA_MAX_ID"
assert_exit0
assert_empty

summary_and_exit
