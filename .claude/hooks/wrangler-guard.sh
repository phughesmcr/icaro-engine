#!/usr/bin/env bash
# PreToolUse (Bash): block a wrangler deploy where it would find no Wrangler
# config.
# There, `wrangler deploy` offers to publish the whole folder as a static site;
# from the repository root that is every file, registered game data included.
# Run wrangler from a Worker folder (cloudflare/lobby, cloudflare/client,
# cloudflare/librequake, tools/do_cpu_probe) or pass --config / --cwd.
#
# The check is a safety net, not a parser: it looks for wrangler in command
# position (start, after ; & | ( or a package runner) and takes the folder from
# a leading `cd <dir> &&` or `cd <dir>;` (or `(cd <dir> && ...)`), else the
# hook's cwd. A later `cd` isn't followed: such a deploy is blocked.
#
# Exit 0: allowed. Exit 2: blocked, reason on stderr (shown to Claude).
set -uo pipefail

command -v jq >/dev/null || exit 0

input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
cwd=$(jq -r '.cwd // empty' <<<"$input")
[ -n "$cmd" ] || exit 0
[ -n "$cwd" ] || cwd=$PWD

runner='(npx|bunx|pnpx|pnpm[[:space:]]+(dlx|exec)|yarn([[:space:]]+dlx)?|npm[[:space:]]+exec)[[:space:]]+(--?[^[:space:]]+[[:space:]]+)*'
grep -Eq "(^|[;&|(\`][[:space:]]*|${runner})wrangler([@[:space:]]|$)" <<<"$cmd" || exit 0
# Only the commands that publish: deploy, versions upload, pages deploy, ...
grep -Eq 'wrangler.*[[:space:]](deploy|publish|upload)([[:space:]]|$)' <<<"$cmd" || exit 0

# An explicit config or working folder is the caller's choice.
grep -Eq '(^|[[:space:]])(-c|--config|--cwd)([=[:space:]]|$)' <<<"$cmd" && exit 0

dir=$cwd
if [[ $cmd =~ ^[[:space:]]*\(?[[:space:]]*cd[[:space:]]+([^[:space:];&|]+)[[:space:]]*(\&\&|\;) ]]; then
	target=${BASH_REMATCH[1]}
	target=${target%\"}; target=${target#\"}; target=${target%\'}; target=${target#\'}
	case "$target" in
		/*) dir=$target ;;
		"~"*) dir=$HOME${target#\~} ;;
		*) dir=$cwd/$target ;;
	esac
fi

for f in wrangler.jsonc wrangler.json wrangler.toml; do
	[ -f "$dir/$f" ] && exit 0
done

echo "Blocked: no wrangler.jsonc/json/toml in $dir. From a folder without one, wrangler deploys the whole folder as a static site (from the repository root: registered game data included). cd into the Worker's folder (cloudflare/lobby) first, or pass --config." >&2
exit 2
