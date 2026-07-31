#!/usr/bin/env bash
# Tests for check-no-ai-attribution.sh: a throwaway git repo with
# deliberately-bad commits, so the identity checks are exercised
# against real git metadata rather than synthetic text.
#
# Run standalone (`bash scripts/test-check-no-ai-attribution.sh`) or via
# the `gate-scripts` job in .github/workflows/ci.yml. The CI gates are
# code too — a silently-toothless gate is worse than no gate.
set -u

GATE="$(cd "$(dirname "$0")" && pwd)/check-no-ai-attribution.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

REPO="$TMP/repo"
mkdir -p "$REPO"
git init -q -b main "$REPO"
git -C "$REPO" config user.name "Chris"
git -C "$REPO" config user.email "chris@example.com"
# The maintainer signs commits; the fixture repo has no key and must not
# try to use one.
git -C "$REPO" config commit.gpgsign false

failures=0

# commit <subject-and-body> [author-name] [author-email]
commit() {
    local msg="$1" name="${2-Chris}" email="${3-chris@example.com}"
    echo "$RANDOM" >> "$REPO/file.txt"
    git -C "$REPO" add -A
    GIT_AUTHOR_NAME="$name" GIT_AUTHOR_EMAIL="$email" \
    GIT_COMMITTER_NAME="$name" GIT_COMMITTER_EMAIL="$email" \
        git -C "$REPO" commit -q -m "$msg"
}

check() {
    local name="$1" want_exit="$2"
    shift 2
    (cd "$REPO" && bash "$GATE" "$@") > "$TMP/out" 2>&1
    local got=$?
    if [ "$got" -eq "$want_exit" ]; then
        echo "PASS: $name"
    else
        echo "FAIL: $name (want exit $want_exit, got $got)"
        sed 's/^/    /' "$TMP/out"
        failures=$((failures + 1))
    fi
}

commit "feat: the baseline commit"
BASE=$(git -C "$REPO" rev-parse HEAD)

commit "fix: an ordinary change

Explains itself over several lines, mentions no assistant."
check "clean history passes" 0 "$BASE..HEAD"

# 1. co-author trailer
commit "fix: something

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
check "co-author trailer fails" 1 "$BASE..HEAD"
grep -q 'co-author trailer' "$TMP/out" || { echo "FAIL: missing trailer diagnostic"; failures=$((failures+1)); }
git -C "$REPO" reset -q --hard "$BASE"

# 2. session trailer
commit "fix: something

Claude-Session: https://example.invalid/session_0123"
check "session trailer fails" 1 "$BASE..HEAD"
git -C "$REPO" reset -q --hard "$BASE"

# 3. generated-with line
commit "fix: something

Generated with Claude Code"
check "generated-with line fails" 1 "$BASE..HEAD"
git -C "$REPO" reset -q --hard "$BASE"

# 4. clean message, assistant IDENTITY — the case a trailer-only gate
#    misses entirely, because rebase and cherry-pick preserve authorship.
commit "fix: a perfectly clean message" "Claude" "noreply@anthropic.com"
check "assistant author identity fails despite clean message" 1 "$BASE..HEAD"
grep -q 'identity' "$TMP/out" || { echo "FAIL: missing identity diagnostic"; failures=$((failures+1)); }
git -C "$REPO" reset -q --hard "$BASE"

# Legitimate non-maintainer authors must NOT trip the gate: external
# contributors and dependabot commit here too (and dependabot's PRs are
# auto-merged, so a false positive there would jam the whole flow).
commit "build(deps): bump something" "dependabot[bot]" "49699333+dependabot[bot]@users.noreply.github.com"
commit "fix: an outside contribution" "Jane Contributor" "jane@example.org"
check "external and bot authors pass" 0 "$BASE..HEAD"
git -C "$REPO" reset -q --hard "$BASE"

# Prose that merely discusses the tools is not attribution. This repo is
# an MCP server FOR Claude — its commits name it constantly.
commit "docs: note which assistants the project does not credit

The rule is that no AI assistant, Claude or otherwise, may be credited
in commits. This message discusses that policy and must stay legal."
check "prose mentioning assistants passes" 0 "$BASE..HEAD"
git -C "$REPO" reset -q --hard "$BASE"

# PR body scanning.
commit "fix: clean commit for body tests"

printf 'Ordinary description.\n\nNothing to see here.\n' > "$TMP/body-clean.md"
check "clean PR body passes" 0 "$BASE..HEAD" "$TMP/body-clean.md"

printf 'Some description.\n\n🤖 Generated with Claude Code\n' > "$TMP/body-bad.md"
check "PR body attribution fails" 1 "$BASE..HEAD" "$TMP/body-bad.md"
grep -q 'PR body' "$TMP/out" || { echo "FAIL: missing PR-body diagnostic"; failures=$((failures+1)); }

printf 'Session footer.\n\nhttps://claude.ai/code/session_01ABC\n' > "$TMP/body-session.md"
check "PR body session link fails" 1 "$BASE..HEAD" "$TMP/body-session.md"

# A PR that DOCUMENTS the patterns quotes them as code — including this
# gate's own PR. Fenced blocks and inline spans are stripped first.
cat > "$TMP/body-doc.md" <<'EOF'
This gate rejects the following in commit messages:

```
Co-Authored-By: Claude <noreply@anthropic.com>
Generated with Claude Code
```

It also rejects `Claude-Session:` trailers and `claude.ai/code/session` links.
EOF
check "PR body documenting the patterns in code spans passes" 0 "$BASE..HEAD" "$TMP/body-doc.md"

# Harness errors are distinguishable from findings.
check "unresolvable range exits 2" 2 "no-such-ref..HEAD"
check "missing body file exits 2" 2 "$BASE..HEAD" "$TMP/does-not-exist.md"
(cd "$REPO" && bash "$GATE") >/dev/null 2>&1
if [ $? -eq 2 ]; then
    echo "PASS: usage error exits 2"
else
    echo "FAIL: usage error should exit 2"
    failures=$((failures + 1))
fi

if [ "$failures" -ne 0 ]; then
    echo "$failures attribution-gate test(s) failed"
    exit 1
fi
echo "All AI-attribution-gate tests passed"
