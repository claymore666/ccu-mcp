#!/usr/bin/env bash
# Run every coverage-guided fuzz target against its committed seed corpus.
#
# Used by `npm run fuzz` and by .github/workflows/fuzz.yml, so both run exactly
# the same thing. Requires a built dist/ — the targets import from it.
#
# FUZZ_SECONDS  per-target time budget (default 60)
# FINDINGS_DIR  where libFuzzer writes crashing inputs (default ./findings)
#
# Exit codes, kept distinct on purpose:
#   0  every target ran to its time limit and found nothing
#   1  a target found a crashing input (files land in FINDINGS_DIR)
#   2  a target could NOT run — missing build, missing jazzer, bad target
#
# 1 and 2 must never be conflated. "The fuzzer found a bug" and "the fuzzer
# never started" look identical in a red job, and only one of them means the
# code is broken.
set -uo pipefail

FUZZ_SECONDS="${FUZZ_SECONDS:-60}"
FINDINGS_DIR="${FINDINGS_DIR:-findings}"
TARGETS_DIR="$(dirname "$0")/../fuzz"

if [ ! -d "$(dirname "$0")/../dist" ]; then
    echo "FAIL: dist/ is missing — run 'npm run build' first." >&2
    exit 2
fi

mkdir -p "$FINDINGS_DIR"
found=0
broke=0

for target in "$TARGETS_DIR"/*.fuzz.mjs; do
    [ -e "$target" ] || { echo "FAIL: no fuzz targets found in $TARGETS_DIR" >&2; exit 2; }
    name="$(basename "$target" .fuzz.mjs)"
    corpus="$TARGETS_DIR/corpus/$name"

    if [ ! -d "$corpus" ]; then
        # A missing corpus is not a soft problem. These targets reach magic
        # string keys ("__proto__") and escape sequences that byte-level
        # mutation will not invent on its own; without the seeds the run is
        # theatre that reports green.
        echo "FAIL: $name has no seed corpus at $corpus" >&2
        broke=1
        continue
    fi

    echo "=== $name (${FUZZ_SECONDS}s, $(find "$corpus" -type f | wc -l) seeds) ==="
    rc=0
    npx jazzer "$target" "$corpus" --sync -- \
        -max_total_time="$FUZZ_SECONDS" \
        -artifact_prefix="$FINDINGS_DIR/$name-" \
        -print_final_stats=1 || rc=$?

    if [ "$rc" -eq 0 ]; then
        echo "PASS  $name"
        continue
    fi

    # libFuzzer writes the reproducer before exiting non-zero. Its presence is
    # what separates "found a bug" from "never got off the ground".
    if find "$FINDINGS_DIR" -name "$name-*" -type f | grep -q .; then
        echo "FOUND $name — reproducer in $FINDINGS_DIR"
        found=1
    else
        echo "FAIL  $name exited $rc without writing a reproducer — the fuzzer did not run" >&2
        broke=1
    fi
done

# Infrastructure failure outranks findings: if some targets never ran, a
# "no findings" verdict from the others is not trustworthy.
[ "$broke" -ne 0 ] && exit 2
[ "$found" -ne 0 ] && exit 1
exit 0
