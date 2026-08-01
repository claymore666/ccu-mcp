#!/usr/bin/env bash
# AI-attribution gate: this project is published under the maintainer's
# own name (npm, the MCP registry, Smithery), so no commit or PR may
# credit an AI assistant. The rule has been in CLAUDE.md from the start,
# which is exactly why it is enforced mechanically here — a convention
# that lives only in a gitignored file is one distracted rebase away
# from reaching a public branch.
#
# Usage: check-no-ai-attribution.sh <commit-range> [pr-body-file]
#   <commit-range>: any git range, e.g. origin/dev..HEAD
#   [pr-body-file]: optional file holding the PR description
#
# Exit: 0 clean, 1 attribution found, 2 cannot check (bad usage/range).
#
# Four surfaces get checked:
#   1. message trailers crediting an assistant as co-author
#   2. assistant session-link trailers and footers
#   3. "generated with/by <assistant>" marketing lines
#   4. the commit author/committer IDENTITY itself — cherry-pick and
#      rebase PRESERVE authorship, so a rewrite that strips trailers
#      silently keeps a bad author. That is the one a trailer-only gate
#      misses, and it is invisible in `git log --oneline`.
#
# Identity is matched by pattern, NOT against an allowlist of the
# maintainer: external contributors and dependabot author commits here
# too, and they are legitimate.
set -u

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    echo "usage: $0 <commit-range> [pr-body-file]" >&2
    exit 2
fi

RANGE="$1"
BODY="${2-}"
fail=0

if ! git rev-list "$RANGE" >/dev/null 2>&1; then
    echo "FAIL  cannot resolve commit range '$RANGE'" >&2
    exit 2
fi

# Vendor-agnostic on purpose: the rule is "no AI assistant credit", not
# "no one specific product". Adding a vendor here is cheaper than
# discovering the gap after a leak.
VENDORS='claude|anthropic|copilot|chatgpt|openai|gemini|codex|cursor'

# Attribution in free text, as <label>|<pattern> pairs — the label is
# what gets reported, because a raw vendor alternation is unreadable in
# CI output. Each pattern targets a real artifact rather than any
# mention of a vendor, so prose may still discuss these tools without
# tripping the gate (this repo's docs discuss Claude constantly).
text_patterns=(
    "assistant co-author trailer|co-authored-by:[[:space:]]*[^<]*($VENDORS)"
    "assistant co-author trailer|co-authored-by:.*@(anthropic|openai)\.com"
    "assistant session trailer|^[[:space:]]*($VENDORS)-session:"
    "\"generated with/by\" line|generated (with|by) [^[:space:]]*[[:space:]]*($VENDORS)"
    "assistant session link|($VENDORS)\.ai/code/session"
    "robot-emoji generated line|🤖[[:space:]]*generated"
)

scan_text() {
    # $1 = what is being scanned (for the message), $2 = the text.
    # Reports each distinct kind of attribution once, not once per
    # pattern that happens to match it.
    local what="$1" text="$2" entry label pat
    local -a seen=()
    for entry in "${text_patterns[@]}"; do
        label="${entry%%|*}"
        pat="${entry#*|}"
        printf '%s\n' "$text" | grep -qiE "$pat" || continue
        case " ${seen[*]-} " in *" $label "*) continue ;; esac
        seen+=("$label")
        echo "FAIL  $what: contains attribution — $label"
        fail=1
    done
}

for sha in $(git rev-list "$RANGE"); do
    short="${sha:0:8}"

    # Identity: name and email of both author and committer.
    while IFS= read -r ident; do
        role="${ident%%$'\t'*}"
        who="${ident#*$'\t'}"
        if printf '%s\n' "$who" | grep -qiE "($VENDORS)"; then
            echo "FAIL  commit $short: $role identity is '$who' — commits must not be authored by an AI assistant"
            fail=1
        fi
    done < <(git log -1 --format="author	%an <%ae>
committer	%cn <%ce>" "$sha")

    scan_text "commit $short message" "$(git log -1 --format='%B' "$sha")"
done

if [ -n "$BODY" ]; then
    if [ ! -f "$BODY" ]; then
        echo "FAIL  PR body file '$BODY' does not exist" >&2
        exit 2
    fi
    # Strip fenced blocks and inline code spans first: a PR that
    # documents these patterns (this gate's own, for one) quotes them as
    # code, while a real attribution footer never is.
    # shellcheck disable=SC2016  # the backticks are markdown, not shell
    body_prose=$(sed '/^[[:space:]]*```/,/^[[:space:]]*```/d' "$BODY" | sed 's/`[^`]*`//g')
    scan_text "PR body" "$body_prose"
fi

if [ "$fail" -eq 0 ]; then
    echo "AI-attribution gate passed"
fi
exit "$fail"
