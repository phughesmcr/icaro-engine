#!/usr/bin/env bash
# Report deno lint problems that a file has now but did not have at a base ref.
# The repo has a large pre-existing lint baseline, so the bar is "no new
# problems", not zero. Findings are compared by rule code + message counts, so
# line shifts from an edit don't count as new problems.
#
#   lint-delta.sh <base-ref> <file>...   # e.g. origin/dev src/sv_phys.js
#   lint-delta.sh --hook                 # PostToolUse: JSON on stdin, base HEAD
#
# Exit 0: nothing new. Exit 2: new problems listed on stderr (PostToolUse
# shows stderr to Claude).
set -uo pipefail

command -v deno >/dev/null || exit 0
command -v jq >/dev/null || exit 0

root=$(cd "$(git rev-parse --show-toplevel 2>/dev/null)" && pwd -P) || exit 0

# Absolute, symlink-resolved path (relative paths are taken from the caller's cwd).
resolve() {
	local d
	d=$(cd "$(dirname "$1")" 2>/dev/null && pwd -P) || return 1
	echo "$d/$(basename "$1")"
}

if [ "${1:-}" = "--hook" ]; then
	base=HEAD
	f=$(jq -r '.tool_input.file_path // empty')
	[ -n "$f" ] || exit 0
	set -- "$f"
else
	base=${1:?usage: lint-delta.sh <base-ref> <file>... | --hook}
	shift
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/lint-delta.XXXXXX") || exit 0
trap 'rm -rf "$tmp"' EXIT

# Lint stdin, emit one "code<TAB>message<TAB>line" row per finding.
lint() {
	NO_COLOR=1 deno lint --json --ext="$1" - 2>/dev/null |
		jq -r '.diagnostics[]? | [.code, .message, (.range.start.line|tostring)] | @tsv'
}

files=()
for f in "$@"; do
	abs=$(resolve "$f") && files+=("$abs")
done
[ ${#files[@]} -gt 0 ] || exit 0
cd "$root" || exit 0

status=0
for f in "${files[@]}"; do
	rel=${f#"$root"/}
	case "$rel" in
		/*) continue ;; # outside this repo
		static/* | docs/* | tests/fixtures/* | .claude/*) continue ;;
		*.js | *.mjs) ext=js ;;
		*.ts) ext=ts ;;
		*) continue ;;
	esac
	[ -f "$rel" ] || continue

	lint "$ext" <"$rel" >"$tmp/now"
	if git cat-file -e "$base:$rel" 2>/dev/null; then
		git show "$base:$rel" | lint "$ext" >"$tmp/was"
	else
		: >"$tmp/was" # new file: every finding is new
	fi

	# Multiset difference on (code, message); report the current line numbers.
	# (FILENAME, not NR == FNR, so an empty "was" file still works.)
	new=$(awk -F'\t' -v rel="$rel" -v was="$tmp/was" '
		FILENAME == was { seen[$1 FS $2]++; next }
		{ k = $1 FS $2; if ( seen[k] > 0 ) seen[k]--; else print "  " rel ":" $3 "  " $1 "  " $2 }
	' "$tmp/was" "$tmp/now")

	if [ -n "$new" ]; then
		echo "New deno lint problems in $rel (vs $base):" >&2
		echo "$new" >&2
		status=2
	fi
done

exit $status
