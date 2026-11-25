# Game-room image: one server/game_server.js room per container (step 2 of
# "Plan: rooms on Cloudflare Containers" in docs/always-on-hosting.md).
#
# Build from the repository root, so the root .dockerignore applies:
#   docker build -f server/Dockerfile -t icaro-room .
# Arguments after the image name go to game_server.js (see server/README.md).
#
# Only the allowlist below is copied. Never COPY static/ (or the whole
# repository): registered and rerelease data (static/pak1.pak, hipnotic/,
# rogue/, rerelease/, id1/, mg1/, ...) must never reach an image or a registry.
# The shareware static/pak0.pak is the only game data allowed. Don't add a
# COPY and then delete files in a later RUN: earlier layers keep them.
# tools/check_container_image.sh (CI) fails if the image or the build context
# holds any other .pak.

# Deno 2.9.8, as in .tool-versions; bump both together. The digest pins the
# multi-arch index (amd64 and arm64).
FROM denoland/deno:debian-2.9.8@sha256:a0d88a7fcbd44f062cba2748e19df67d30290ad12aa203c7c1e0b12462c483f0

WORKDIR /app

# The allowlist. deno.json maps "three" to server/browser_shim.js.
COPY deno.json ./
COPY server/ server/
COPY src/ src/
COPY static/pak0.pak static/

# The base image's unprivileged user (DENO_DIR=/deno-dir/ is theirs). The
# cache step compiles the server's TypeScript now rather than at room start.
USER deno
RUN deno cache server/game_server.js

# WebTransport (UDP) and -wsport (TCP) default to 4433.
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
	"server/game_server.js", "-pak", "/app/static/pak0.pak"]
CMD ["-map", "start", "-cert", "/certs/cert.pem", "-key", "/certs/key.pem", \
	"-wsport", "4433", "-wshost", "0.0.0.0"]
