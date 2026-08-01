#!/usr/bin/env bash
# Regression test for the actionlint gate: assert actionlint still flags
# the known-bad fixture, in particular the secrets-context-in-a-step-
# level-`if:` trap, which GitHub rejects at PARSE time and thereby
# silently disables every trigger of the workflow. If this script fails,
# the linter has lost the teeth we rely on — treat it like a failing
# unit test, not a flaky check.
#
# Usage: test-actionlint.sh [path-to-actionlint]
#
# Exit: 0 linter has its teeth, 1 it lost them, 2 cannot test.
#
# The 2 matters. This test asserts a *non-zero* exit from actionlint, so
# a missing binary exits 127 and sails through that assertion — the run
# would then die on the grep and blame the linter for a regression when
# the tool was simply absent. The binary is checked up front, and
# "cannot test" is its own exit code so it can never be read as either
# outcome. CI installs actionlint before calling this, so a 2 there
# means the install step broke and the job should go red — which it
# does, since any non-zero fails the step.
set -u

ACTIONLINT="${1:-actionlint}"
FIXTURE="$(dirname "$0")/testdata/bad-workflow.yml"
OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

if ! command -v "$ACTIONLINT" >/dev/null 2>&1; then
    echo "FAIL  cannot test: '$ACTIONLINT' not found on PATH" >&2
    echo "      install it with: go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12" >&2
    exit 2
fi

if [ ! -f "$FIXTURE" ]; then
    echo "FAIL  cannot test: fixture $FIXTURE is missing" >&2
    exit 2
fi

"$ACTIONLINT" -no-color "$FIXTURE" >"$OUT" 2>&1
rc=$?

if [ "$rc" -eq 0 ]; then
    echo "FAIL: actionlint exited 0 on $FIXTURE — it must flag the fixture"
    exit 1
fi

# 126/127 mean the shell couldn't execute it at all (not on PATH after
# the check above, or not executable) — never a lint verdict.
if [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
    echo "FAIL  cannot test: '$ACTIONLINT' could not be executed (exit $rc)" >&2
    cat "$OUT" >&2
    exit 2
fi

if ! grep -q 'context "secrets" is not allowed' "$OUT"; then
    echo "FAIL: actionlint no longer flags 'secrets' in a step-level if:"
    echo "--- actionlint output:"
    cat "$OUT"
    exit 1
fi

echo "PASS: actionlint flags the known-bad fixture (including the secrets-in-step-if trap)"
