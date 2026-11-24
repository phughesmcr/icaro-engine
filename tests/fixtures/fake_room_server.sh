#!/bin/sh
# Stand-in for `deno run ... game_server.js` used by tests/server_lobby_test.js.
# Ignores the deno flags, prints the readiness lines room_process_manager.ts
# waits for, then reports player counts read from FAKE_ROOM_PLAYERS_FILE
# (if set) every 0.1s. Exits shortly after SIGTERM, or when stdin closes.
nonce=""
while [ $# -gt 0 ]; do
	if [ "$1" = "-statusnonce" ]; then nonce="$2"; shift; fi
	shift
done
trap 'sleep 0.3; exit 0' TERM
echo "WebTransport server listening on port 0"
echo "@@ICARO_STATUS $nonce {\"players\":0,\"active\":true}"
# Parent watch: exit when stdin reaches EOF. (A background job's stdin is
# /dev/null unless redirected explicitly, hence fd 3.)
exec 3<&0
( cat <&3 > /dev/null; kill $$ 2>/dev/null ) &
while true; do
	if [ -n "$FAKE_ROOM_PLAYERS_FILE" ] && [ -f "$FAKE_ROOM_PLAYERS_FILE" ]; then
		echo "@@ICARO_STATUS $nonce {\"players\":$(cat "$FAKE_ROOM_PLAYERS_FILE"),\"active\":true}"
	fi
	sleep 0.1
done
