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

THREAD="thread"
TD=$(mktemp -d)
PASS=0; FAIL=0
T="$TD/test-thread"

cleanup() { rm -rf "$TD"; }
trap cleanup EXIT

G() { printf "\033[32m  ✓ %s\033[0m\n" "$*"; PASS=$((PASS+1)); }
R() { printf "\033[31m  ✗ %s\033[0m\n" "$*"; FAIL=$((FAIL+1)); }
S() { echo ""; printf "\033[33m━━ %s ━━\033[0m\n" "$*"; }

# ── Pre-flight ────────────────────────────────────────────────
S "Pre-flight"
if $THREAD --version >/dev/null 2>&1; then G "thread binary OK"; else R "thread broken — run npm run build"; exit 1; fi

# ══════════════════════════════════════════════════════════════
# 1. init
# ══════════════════════════════════════════════════════════════
S "1. init"
$THREAD init "$T" >/dev/null 2>&1
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
[[ -f "$T/events.db" ]] && G "events.db created" || R "events.db missing"
[[ -f "$T/events.jsonl" ]] && G "events.jsonl created" || R "events.jsonl missing"

# ══════════════════════════════════════════════════════════════
# 2. init — duplicate exits 1
# ══════════════════════════════════════════════════════════════
S "2. init — duplicate"
$THREAD init "$T" >/dev/null 2>&1
EC=$?
[[ $EC -eq 1 ]] && G "exit=1 for duplicate init" || R "exit=$EC (expected 1)"

# ══════════════════════════════════════════════════════════════
# 3. push — single event
# ══════════════════════════════════════════════════════════════
S "3. push — single event"
OUT="$TD/3.txt"
$THREAD push --thread "$T" --source e2e --type message --content "hello world" >"$OUT" 2>/dev/null
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"

# ══════════════════════════════════════════════════════════════
# 4. push — with subtype
# ══════════════════════════════════════════════════════════════
S "4. push — with subtype"
$THREAD push --thread "$T" --source e2e --type record --subtype toolcall \
  --content '{"tool":"bash","args":["echo hi"]}' >/dev/null 2>&1
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"

# ══════════════════════════════════════════════════════════════
# 5. peek — read all events
# ══════════════════════════════════════════════════════════════
S "5. peek — read all"
OUT="$TD/5.txt"
$THREAD peek --thread "$T" --last-event-id 0 >"$OUT" 2>/dev/null
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
COUNT=$(wc -l <"$OUT" | tr -d ' ')
[[ "$COUNT" -ge 2 ]] && G "at least 2 events returned" || R "expected ≥2 events, got $COUNT"

# ══════════════════════════════════════════════════════════════
# 6. peek --filter
# ══════════════════════════════════════════════════════════════
S "6. peek --filter"
OUT="$TD/6.txt"
$THREAD peek --thread "$T" --last-event-id 0 --filter "type = 'message'" >"$OUT" 2>/dev/null
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
COUNT=$(wc -l <"$OUT" | tr -d ' ')
[[ "$COUNT" -eq 1 ]] && G "filter returns only message events (got $COUNT)" || R "expected 1, got $COUNT"

# ══════════════════════════════════════════════════════════════
# 7. subscribe
# ══════════════════════════════════════════════════════════════
S "7. subscribe"
$THREAD subscribe --thread "$T" --consumer worker-1 --handler "true" >/dev/null 2>&1
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"

# ══════════════════════════════════════════════════════════════
# 8. subscribe — duplicate exits 1
# ══════════════════════════════════════════════════════════════
S "8. subscribe — duplicate"
$THREAD subscribe --thread "$T" --consumer worker-1 --handler "true" >/dev/null 2>&1
EC=$?
[[ $EC -eq 1 ]] && G "exit=1 for duplicate consumer" || R "exit=$EC (expected 1)"

# ══════════════════════════════════════════════════════════════
# 9. pop
# ══════════════════════════════════════════════════════════════
S "9. pop"
OUT="$TD/9.txt"
$THREAD pop --thread "$T" --consumer worker-1 --last-event-id 0 >"$OUT" 2>/dev/null
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
COUNT=$(wc -l <"$OUT" | tr -d ' ')
[[ "$COUNT" -ge 2 ]] && G "pop returns events (got $COUNT)" || R "expected events, got $COUNT"

# ══════════════════════════════════════════════════════════════
# 10. pop — no new events returns empty
# ══════════════════════════════════════════════════════════════
S "10. pop — no new events"
# Get max event id from previous pop
MAX_ID=$(node -e "
const lines = require('fs').readFileSync('$TD/9.txt','utf8').trim().split('\n').filter(Boolean);
const ids = lines.map(l => JSON.parse(l).id).filter(Number.isFinite);
process.stdout.write(String(Math.max(...ids)));
" 2>/dev/null)
OUT="$TD/10.txt"
$THREAD pop --thread "$T" --consumer worker-1 --last-event-id "$MAX_ID" >"$OUT" 2>/dev/null
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
[[ ! -s "$OUT" ]] && G "empty output when no new events" || R "expected empty output"

# ══════════════════════════════════════════════════════════════
# 11. info
# ══════════════════════════════════════════════════════════════
S "11. info"
OUT="$TD/11.txt"
$THREAD info --thread "$T" >"$OUT" 2>/dev/null
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
grep -qi "worker-1" "$OUT" && G "info shows consumer" || R "consumer missing from info"

# ══════════════════════════════════════════════════════════════
# 12. info --json
# ══════════════════════════════════════════════════════════════
S "12. info --json"
OUT="$TD/12.txt"
$THREAD info --thread "$T" --json >"$OUT" 2>/dev/null
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
if node -e "const d=JSON.parse(require('fs').readFileSync('$OUT','utf8')); if(!d.eventCount && d.eventCount!==0) throw 0" 2>/dev/null; then
  G "valid JSON with eventCount"
else
  R "invalid JSON or missing eventCount"
fi

# ══════════════════════════════════════════════════════════════
# 13. unsubscribe
# ══════════════════════════════════════════════════════════════
S "13. unsubscribe"
$THREAD unsubscribe --thread "$T" --consumer worker-1 >/dev/null 2>&1
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"

# ══════════════════════════════════════════════════════════════
# 14. push --batch (stdin NDJSON)
# ══════════════════════════════════════════════════════════════
S "14. push --batch"
printf '{"source":"e2e","type":"message","content":"batch msg 1"}\n{"source":"e2e","type":"message","content":"batch msg 2"}\n' \
  | $THREAD push --thread "$T" --batch >/dev/null 2>&1
EC=$?
[[ $EC -eq 0 ]] && G "exit=0" || R "exit=$EC"
OUT="$TD/14.txt"
$THREAD peek --thread "$T" --last-event-id 0 --filter "type = 'message'" >"$OUT" 2>/dev/null
COUNT=$(wc -l <"$OUT" | tr -d ' ')
[[ "$COUNT" -ge 3 ]] && G "batch events persisted (total message events: $COUNT)" || R "expected ≥3 message events, got $COUNT"

# ══════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════
S "Results"
echo ""
TOTAL=$((PASS + FAIL))
printf "  Passed: \033[32m%d\033[0m\n" "$PASS"
printf "  Failed: %s\n" "$( [[ $FAIL -gt 0 ]] && printf "\033[31m%d\033[0m" "$FAIL" || echo 0 )"
echo "  Total:  $TOTAL"
echo ""
[[ $FAIL -eq 0 ]] && printf "\033[32mAll tests passed!\033[0m\n" && exit 0
printf "\033[31mSome tests failed.\033[0m\n" && exit 1
