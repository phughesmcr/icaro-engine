#!/bin/sh
# Checks the game-room image (server/Dockerfile) for data that must never
# reach an image or a registry: any .pak but LibreQuake's two (which the image
# fetches itself at build time, so this needs network access), and TLS or env
# files. CI runs it (.github/workflows/ci.yml); it needs Docker with BuildKit.
#
#   sh tools/check_container_image.sh          # all checks, then start a room
#   sh tools/check_container_image.sh --no-run # skip starting a room
#
# 1. The build context of this working tree, as .dockerignore filters it,
#    holds only the allowlist (deno.json, deno.lock, server/, src/,
#    tools/fetch_data.js), no .pak at all and no TLS or env files. Read-only:
#    works with registered data present.
# 2. The same for a copy of the tracked and untracked (not ignored) files with
#    decoy paks and keys planted where real ones would be, so the guard is
#    tested even on a clean checkout. The working tree is never written to.
# 3. The image built from that copy holds exactly two .pak in its whole
#    filesystem, LibreQuake's /app/static/librequake/id1/pak0.pak and pak1.pak,
#    LibreQuake's licence texts beside them, and no TLS files under /app.
# 4. A room started in the image with a throwaway certificate initializes
#    and its WebSocket port answers from outside the container.
set -eu

run_room=1
if [ "${1-}" = "--no-run" ]; then run_room=0; fi

root=$(git rev-parse --show-toplevel)
cd "$root"

work=$(mktemp -d "${TMPDIR:-/tmp}/icaro-image-check.XXXXXX")
image="icaro-room-check:$$"
container="icaro-room-check-$$"
cleanup() {
	docker rm -f "$container" >/dev/null 2>&1 || true
	docker rmi -f "$image" >/dev/null 2>&1 || true
	rm -rf "$work"
}
trap cleanup EXIT
# A returning INT/TERM handler would let sh carry on; exit so EXIT cleans up.
trap 'exit 130' INT TERM

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

# Export a directory's build context (after .dockerignore) to $2.
export_context() {
	printf 'FROM scratch\nCOPY . /\n' |
		docker build --quiet -f - --output "type=local,dest=$2" "$1" >/dev/null
}

# Fail unless the exported context at $1 holds only the allowlist.
check_context() {
	label=$1
	ctx=$2
	top=$(cd "$ctx" && find . -mindepth 1 -maxdepth 1 | sed 's|^\./||' | sort | tr '\n' ' ')
	[ "$top" = "deno.json deno.lock server src tools " ] ||
		fail "$label: build context top level is '$top', expected 'deno.json deno.lock server src tools '"
	tools=$(cd "$ctx/tools" && find . -mindepth 1 | sed 's|^\./||' | tr '\n' ' ')
	[ "$tools" = "fetch_data.js " ] ||
		fail "$label: build context tools/ holds '$tools', expected only fetch_data.js"
	paks=$(cd "$ctx" && find . -iname '*.pak' | sed 's|^\./||' | sort | tr '\n' ' ')
	[ -z "$paks" ] ||
		fail "$label: build context holds paks: $paks"
	secrets=$(cd "$ctx" && find . \( -iname '*.pem' -o -iname '*.key' -o -iname '*.crt' -o -name '.env' -o -name '.env.*' \))
	[ -z "$secrets" ] || fail "$label: build context holds TLS or env files: $secrets"
	echo "ok: $label build context holds only the allowlist and no pak"
}

# 1. This working tree's context.
export_context . "$work/ctx-tree"
check_context "working tree" "$work/ctx-tree"

# 2. A copy with decoys. PAK1.PAK, not pak1.pak, at the top of static/: the
# real file here has that name, and both would clash on a case-insensitive
# file system.
mkdir "$work/decoy"
git ls-files -z --cached --others --exclude-standard |
	tar --null -T - -cf - | tar -xf - -C "$work/decoy"
for f in \
	static/PAK1.PAK static/pak0.pak \
	static/librequake/id1/pak0.pak static/librequake/id1/pak1.pak \
	static/id1/pak0.pak static/id1/pak1.pak \
	static/hipnotic/pak0.pak static/rogue/pak0.pak \
	static/rerelease/id1/pak0.pak static/rerelease/mg1/pak0.pak \
	static/mg1/pak0.pak static/mg3/pak0.pak static/dopa/pak0.pak static/ctf/pak0.pak \
	static/maps/decoy.pak server/decoy.pak server/decoy.PAK src/decoy.pak \
	decoy.pak \
	server/cert.pem server/key.pem server/decoy.key server/decoy.crt \
	server/.env .env; do
	mkdir -p "$work/decoy/$(dirname "$f")"
	echo "decoy: must not reach the image" >"$work/decoy/$f"
done
export_context "$work/decoy" "$work/ctx-decoy"
check_context "decoy copy" "$work/ctx-decoy"

# 3. The image built from the decoy copy, whole file system.
docker build --quiet -f "$work/decoy/server/Dockerfile" -t "$image" "$work/decoy" >/dev/null
docker create --name "$container" "$image" >/dev/null
docker export "$container" | tar -tf - >"$work/image-files"
docker rm "$container" >/dev/null
paks=$(grep -i '\.pak$' "$work/image-files" | sort | tr '\n' ' ' || true)
[ "$paks" = "app/static/librequake/id1/pak0.pak app/static/librequake/id1/pak1.pak " ] ||
	fail "image paks are '$paks', expected only LibreQuake's id1 pak0.pak and pak1.pak"
# Decoys must not have shadowed the fetched paks: the real ones are 95 and 100 MB.
size=$(docker run --rm --entrypoint stat "$image" -c %s /app/static/librequake/id1/pak1.pak 2>/dev/null || echo 0)
[ "$size" -gt 1000000 ] || fail "image pak1.pak is $size bytes: not LibreQuake's"
# LibreQuake's licence texts (BSD 3-clause asks a redistribution to carry its
# notice), with something in them
for f in docs/copying docs/misc-docs/copying docs/readme-important-licence-info; do
	grep -qx "app/static/librequake/id1/$f" "$work/image-files" ||
		fail "image lacks LibreQuake's licence file id1/$f"
	size=$(docker run --rm --entrypoint stat "$image" -c %s "/app/static/librequake/id1/$f" 2>/dev/null || echo 0)
	[ "$size" -gt 100 ] || fail "image's LibreQuake id1/$f is $size bytes"
done
secrets=$(grep -i -E '^app/.*(\.pem|\.key|\.crt|/\.env.*)$' "$work/image-files" || true)
[ -z "$secrets" ] || fail "image holds TLS or env files: $secrets"
echo "ok: image holds no .pak but LibreQuake's two, its licence texts, and no TLS or env files"

# 4. Start a room with the image's default arguments and a throwaway cert
# mounted at /certs. The image runs as uid 1993, so the key must be readable.
[ "$run_room" = 1 ] || exit 0
mkdir "$work/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
	-keyout "$work/certs/key.pem" -out "$work/certs/cert.pem" 2>/dev/null
chmod 644 "$work/certs/key.pem" "$work/certs/cert.pem"
docker run -d --name "$container" -v "$work/certs:/certs:ro" -p 127.0.0.1::4433/tcp "$image" >/dev/null
i=0
while [ $i -lt 60 ]; do
	if docker logs "$container" 2>&1 | grep -q 'Server initialized!'; then
		docker logs "$container" 2>&1 | grep -E 'listening|Server initialized'
		# The WebSocket listener must be reachable from outside the container
		# (-wshost 0.0.0.0, --allow-net): any HTTP status will do.
		hostport=$(docker port "$container" 4433/tcp | head -n 1)
		status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$hostport/" || true)
		[ "$status" != "000" ] && [ -n "$status" ] ||
			fail "the room's WebSocket port $hostport did not answer from outside the container"
		echo "ok: a room started in the image and answers on $hostport (HTTP $status)"
		exit 0
	fi
	if [ "$(docker inspect -f '{{.State.Running}}' "$container")" != true ]; then
		docker logs "$container" >&2
		fail "the room exited before initializing"
	fi
	sleep 1
	i=$((i + 1))
done
docker logs "$container" >&2
fail "the room did not initialize within 60 s"
