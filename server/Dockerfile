# Game-room image: one server/game_server.js room per container (step 2 of
# "Plan: rooms on Cloudflare Containers" in docs/always-on-hosting.md).
#
# Build from the repository root, so the root .dockerignore applies:
#   docker build -f server/Dockerfile -t icaro-room .
# Arguments after the image name go to game_server.js (see server/README.md).
#
# Only the allowlist below is copied from the build context, which holds no
# pak at all: registered and rerelease data (hipnotic/, rogue/, rerelease/,
# id1/, mg1/, ...) must never reach an image or a registry. The game data is
# LibreQuake, fetched at build time by the first stage (tools/fetch_data.js:
# the release pinned in src/librequake.js, SHA-256 checked, so the build needs
# network access) and only its two id1 paks and loose maps are copied into the
# final stage. Don't COPY more and then delete files in a later RUN: earlier
# layers keep them. tools/check_container_image.sh (CI) fails if the build
# context holds any .pak, or the image holds any but LibreQuake's two.

# Deno as pinned in .tool-versions; bump both together
# (tests/deno_version_pin_test.js checks it). The digest pins the
# multi-arch index (amd64 and arm64).
FROM denoland/deno:debian-2.9.8@sha256:a0d88a7fcbd44f062cba2748e19df67d30290ad12aa203c7c1e0b12462c483f0 AS data

# Stage 1: fetch LibreQuake. The task's permissions are limited to GitHub and
# static/librequake; zip.js comes from the import map (pinned in deno.lock).
WORKDIR /fetch
COPY deno.json deno.lock ./
COPY src/ src/
COPY tools/fetch_data.js tools/
RUN deno task fetch-data

FROM denoland/deno:debian-2.9.8@sha256:a0d88a7fcbd44f062cba2748e19df67d30290ad12aa203c7c1e0b12462c483f0

WORKDIR /app

# The allowlist. deno.json maps "three" to server/browser_shim.js.
COPY deno.json ./
COPY server/ server/
COPY src/ src/
# LibreQuake's id1: both paks (pak1.pak holds gfx/pop.lmp, without which the
# engine refuses a modified game) and the loose maps (lqdm1 to lqdm13, with
# their .lit files). Not the release zip, music, docs or configs.
COPY --from=data /fetch/static/librequake/id1/pak0.pak /fetch/static/librequake/id1/pak1.pak static/librequake/id1/
COPY --from=data /fetch/static/librequake/id1/maps/ static/librequake/id1/maps/

# The base image's unprivileged user (DENO_DIR=/deno-dir/ is theirs). The
# cache step compiles the server's TypeScript now rather than at room start.
USER deno
RUN deno cache server/game_server.js

# WebTransport (UDP) defaults to 4433; CMD puts -wsport (TCP, off by
# default) on the same port.
EXPOSE 4433/udp 4433/tcp

# tini (from the base image) forwards signals and reaps. Permissions follow
# what room_process_manager.ts gives a room, widened to any port because the
# port is a run-time argument: listen on any port of the wildcard and
# loopback addresses (no outbound hosts), read static/ and /certs (mount the
# TLS cert and key there; never bake them into the image). --no-prompt makes
# a missing permission an error instead of a prompt under `docker run -it`.
# Run-time arguments are appended, so a later -pak overrides this one. They
# replace CMD, the default room: start, WebSocket on 0.0.0.0:4433 (the only
# way in from outside the container while -wshost defaults to loopback).
ENTRYPOINT ["/tini", "--", "deno", "run", "--no-prompt", "--unstable-net", \
	"--allow-net=0.0.0.0,[::],127.0.0.1", \
	"--allow-read=/app/static,/certs", \
	"server/game_server.js", "-pak", "/app/static/librequake/id1/pak0.pak"]
CMD ["-map", "start", "-cert", "/certs/cert.pem", "-key", "/certs/key.pem", \
	"-wsport", "4433", "-wshost", "0.0.0.0"]
