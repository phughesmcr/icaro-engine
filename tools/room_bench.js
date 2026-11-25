// Room load bench: starts one game_server.js room and drives it with headless
// WebSocket bots that run, turn, jump, switch weapons and fire, through the
// real client driver (src/net_websocket.js). Reports the room's memory, CPU
// per tick (tools/room_bench_preload.js) and the bytes and messages on the
// wire. Used for docs/always-on-hosting.md; not part of the game or CI.
//
//   deno run -A --unstable-net tools/room_bench.js -map e1m1 -bots 4 -seconds 60
//
// Needs a certificate for the room's WebTransport listener (any self-signed
// one): -cert/-key, default server/cert.pem and server/key.pem.

await import( '../src/gl_rsurf.js' ); // the renderer's module graph, in its safe order (as the tests do)
const client = await import( '../src/net_websocket.js' );
const net = await import( '../src/net.js' );
const { svs } = await import( '../src/server.js' );

const opts = { map: 'start', bots: 4, seconds: 60, warmup: 10, cert: 'server/cert.pem', key: 'server/key.pem', wsport: 27500, port: 27501, maxclients: 0, pak: 'static/pak0.pak' };
for ( let i = 0; i < Deno.args.length; i ++ ) {

	const name = Deno.args[ i ].replace( /^-+/, '' );
	if ( Object.hasOwn( opts, name ) && Deno.args[ i + 1 ] !== undefined ) {

		const v = Deno.args[ ++ i ];
		opts[ name ] = typeof opts[ name ] === 'number' ? Number( v ) : v;

	}

}
if ( opts.maxclients === 0 ) opts.maxclients = Math.max( 2, opts.bots );

// Count every WebSocket frame and byte (payload only: no TCP/IP or WebSocket
// framing overhead)
const wire = { rxMsgs: 0, rxBytes: 0, txMsgs: 0, txBytes: 0 };
const NativeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class extends NativeWebSocket {

	constructor( url, protocols ) {

		super( url, protocols );
		this.addEventListener( 'message', ( e ) => {

			wire.rxMsgs ++;
			wire.rxBytes += e.data.byteLength ?? e.data.length ?? 0;

		} );

	}

	send( data ) {

		wire.txMsgs ++;
		wire.txBytes += data.byteLength ?? data.length ?? 0;
		super.send( data );

	}

};

// Client-side socket pool and net_message, as tests/net_websocket_test.js sets them
let free = null;
for ( let i = 0; i < opts.bots + 2; i ++ ) {

	const s = new net.qsocket_t();
	s.next = free;
	s.disconnected = true;
	free = s;

}
net.set_net_freeSockets( free );
net.set_net_activeconnections( 0 );
svs.maxclients = opts.bots + 2;
net.net_message.data = new Uint8Array( net.NET_MAXMESSAGE );
net.net_message.maxsize = net.NET_MAXMESSAGE;
const quietLog = console.log;
console.log = () => {}; // the client driver's Con_Printf
if ( client.WS_Init() !== 0 ) throw new Error( 'WS_Init failed' );

// Start the room
const preload = new URL( './room_bench_preload.js', import.meta.url ).pathname;
const room = new Deno.Command( Deno.execPath(), {
	args: [
		'run', '-A', '--unstable-net', '--preload', preload, 'server/game_server.js',
		'-room', 'BENCH', '-idletimeout', '0', '-map', opts.map, '-maxclients', String( opts.maxclients ),
		'-pak', opts.pak, '-cert', opts.cert, '-key', opts.key, '-port', String( opts.port ), '-wsport', String( opts.wsport )
	],
	stdout: 'piped', stderr: 'piped', stdin: 'null'
} ).spawn();

const reports = [];
let ready = false;
( async () => {

	let buf = '';
	for await ( const chunk of room.stderr.pipeThrough( new TextDecoderStream() ) ) {

		buf += chunk;
		let nl;
		while ( ( nl = buf.indexOf( '\n' ) ) >= 0 ) {

			const line = buf.slice( 0, nl );
			buf = buf.slice( nl + 1 );
			if ( line.startsWith( 'ROOM_BENCH ' ) ) {

				const r = JSON.parse( line.slice( 11 ) );
				reports.push( r );
				if ( r.kind === 'init' ) ready = true;

			} else if ( line.startsWith( 'Fatal' ) || line.includes( 'Error' ) ) {

				quietLog( '[room] ' + line );

			}

		}

	}

} )();

// The room's console. Count map loads: a bot that walks into an exit changes
// the level, and the bots don't follow a reconnect, so a second load means the
// rest of the run measured a room with no players in it.
let mapLoads = 0;
( async () => {

	let buf = '';
	for await ( const chunk of room.stdout.pipeThrough( new TextDecoderStream() ) ) {

		buf += chunk;
		let nl;
		while ( ( nl = buf.indexOf( '\n' ) ) >= 0 ) {

			const line = buf.slice( 0, nl );
			buf = buf.slice( nl + 1 );
			if ( line.startsWith( 'SpawnServer:' ) ) {

				mapLoads ++;
				if ( mapLoads > 1 ) quietLog( '[room] level changed: ' + line );

			}

		}

	}

} )();

const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );
const startWait = performance.now();
while ( ready === false ) {

	if ( performance.now() - startWait > 60000 ) throw new Error( 'room did not start' );
	await sleep( 50 );

}

// Bots
function angle16( view, off, deg ) {

	view.setInt16( off, ( ( deg * 65536 / 360 ) | 0 ) & 65535, true );

}

const moveBuf = new Uint8Array( 32 );
const moveView = new DataView( moveBuf.buffer );
const cmdMsg = { data: new Uint8Array( 512 ), cursize: 0 };
const enc = new TextEncoder();

function sendStringCmds( bot, cmds ) {

	let n = 0;
	for ( const c of cmds ) {

		cmdMsg.data[ n ++ ] = 4; // clc_stringcmd
		const bytes = enc.encode( c );
		cmdMsg.data.set( bytes, n );
		n += bytes.length;
		cmdMsg.data[ n ++ ] = 0;

	}
	cmdMsg.cursize = n;
	if ( client.WS_QSendMessage( bot.sock, cmdMsg ) === - 1 ) bot.dead = true;

}

// svc_signonnum n anywhere in a reliable message (it ends the serverinfo and
// prespawn messages; Host_Spawn_f's is followed by a few more bytes). A
// false match only sends the next signon command early.
function findSignon( data, len, n ) {

	for ( let i = 0; i + 1 < len; i ++ )
		if ( data[ i ] === 25 && data[ i + 1 ] === n ) return true;
	return false;

}

const bots = [];
for ( let i = 0; i < opts.bots; i ++ ) {

	const sock = await client.WS_Connect( 'ws://127.0.0.1:' + opts.wsport + '/?ip=10.0.0.' + ( i + 1 ) );
	if ( sock === null ) throw new Error( 'bot ' + i + ' could not connect' );
	bots.push( {
		n: i, sock, signon: 0, dead: false, seq: 0, time: 0,
		yaw: Math.random() * 360, turn: 0, side: 0, nextThink: 0, nextImpulse: 0, impulse: 0, unreliable: 0
	} );

}

function botFrame( now ) {

	for ( const bot of bots ) {

		if ( bot.dead ) continue;
		let r;
		while ( ( r = client.WS_QGetMessage( bot.sock ) ) > 0 ) {

			const d = net.net_message.data;
			const len = net.net_message.cursize;
			if ( r === 1 ) {

				const want = bot.signon + 1;
				if ( want <= 3 && findSignon( d, len, want ) ) {

					bot.signon = want;
					if ( want === 1 ) sendStringCmds( bot, [ 'prespawn' ] );
					else if ( want === 2 ) sendStringCmds( bot, [ 'name "bot' + bot.n + '"\n', 'color ' + ( bot.n % 14 ) + ' ' + ( ( bot.n + 3 ) % 14 ) + '\n', 'spawn ' ] );
					else sendStringCmds( bot, [ 'begin' ] );

				}

			} else {

				bot.unreliable ++;
				// svc_time float, svc_serversequence long (SV_SendClientDatagram)
				if ( len >= 10 && d[ 0 ] === 7 && d[ 5 ] === 49 ) {

					const v = new DataView( d.buffer, d.byteOffset, len );
					bot.time = v.getFloat32( 1, true );
					bot.seq = v.getInt32( 6, true );

				}

			}

		}
		if ( r === - 1 ) {

			bot.dead = true;
			continue;

		}
		if ( bot.signon < 3 ) continue;

		// Wander: new turn rate and strafe every 0.5-2 s, a weapon switch every ~4 s
		if ( now > bot.nextThink ) {

			bot.turn = ( Math.random() - 0.5 ) * 12;
			bot.side = Math.random() < 0.3 ? ( Math.random() < 0.5 ? - 350 : 350 ) : 0;
			bot.nextThink = now + 500 + Math.random() * 1500;

		}
		if ( now > bot.nextImpulse ) {

			bot.impulse = 1 + ( ( Math.random() * 8 ) | 0 );
			bot.nextImpulse = now + 3000 + Math.random() * 2000;

		}
		bot.yaw = ( bot.yaw + bot.turn + 360 ) % 360;

		// clc_move (CL_SendMove): time, 3 x angle16, forward/side/up, buttons, impulse, clc_delta
		let o = 0;
		moveBuf[ o ++ ] = 3;
		moveView.setFloat32( o, bot.time, true ); o += 4;
		angle16( moveView, o, Math.sin( now / 900 + bot.n ) * 10 ); o += 2;
		angle16( moveView, o, bot.yaw ); o += 2;
		angle16( moveView, o, 0 ); o += 2;
		moveView.setInt16( o, 320, true ); o += 2;
		moveView.setInt16( o, bot.side, true ); o += 2;
		moveView.setInt16( o, 0, true ); o += 2;
		moveBuf[ o ++ ] = 1 | ( Math.random() < 0.05 ? 2 : 0 ); // attack, sometimes jump
		moveBuf[ o ++ ] = bot.impulse;
		bot.impulse = 0;
		if ( bot.seq !== 0 ) {

			moveBuf[ o ++ ] = 5;
			moveBuf[ o ++ ] = bot.seq & 255;

		}
		if ( client.WS_SendUnreliableMessage( bot.sock, { data: moveBuf, cursize: o } ) === - 1 ) bot.dead = true;

	}

}

// 72 Hz client frames (host_maxfps)
const frameTimer = setInterval( () => botFrame( performance.now() ), 1000 / 72 );

const signal = ( s ) => room.kill( s );
await sleep( opts.warmup * 1000 );
const spawned = bots.filter( ( b ) => b.signon === 3 && b.dead === false ).length;
signal( 'SIGUSR1' );
const w0 = { ...wire, unreliable: bots.reduce( ( a, b ) => a + b.unreliable, 0 ) };
await sleep( opts.seconds * 1000 );
signal( 'SIGUSR2' );
const w1 = { ...wire, unreliable: bots.reduce( ( a, b ) => a + b.unreliable, 0 ) };
const perBot = bots.map( ( b ) => b.unreliable );
await sleep( 300 );

clearInterval( frameTimer );
room.kill( 'SIGTERM' );
await room.status;

const start = reports.findLast( ( r ) => r.kind === 'window-start' );
const end = reports.findLast( ( r ) => r.kind === 'window-end' );
const init = reports.find( ( r ) => r.kind === 'init' );
const secs = ( end.t - start.t ) / 1000;
const cpuMs = ( end.cpuUserMs + end.cpuSystemMs ) - ( start.cpuUserMs + start.cpuSystemMs );
const ticks = end.ticks - start.ticks;
const mb = ( x ) => +( x / 1048576 ).toFixed( 1 );
quietLog( JSON.stringify( {
	map: opts.map,
	bots: opts.bots,
	spawned,
	alive: bots.filter( ( b ) => b.dead === false ).length,
	initMs: init.tickStartMs,
	initRssMB: mb( init.rss ),
	initHeapUsedMB: mb( init.heapUsed ),
	initExternalMB: mb( init.external ),
	rssMB: mb( end.rss ),
	heapUsedMB: mb( end.heapUsed ),
	heapTotalMB: mb( end.heapTotal ),
	externalMB: mb( end.external ),
	peakRssMB: mb( end.peakRss ),
	peakIsolateMB: mb( end.peakIsolate ),
	windowS: +secs.toFixed( 1 ),
	ticks,
	cpuPct: +( cpuMs / ( secs * 1000 ) * 100 ).toFixed( 1 ),
	cpuMsPerTick: +( cpuMs / ticks ).toFixed( 2 ),
	tickMeanMs: +end.tickMeanMs.toFixed( 2 ),
	tickP95Ms: +end.tickP95Ms.toFixed( 2 ),
	tickP99Ms: +end.tickP99Ms.toFixed( 2 ),
	tickMaxMs: +end.tickMaxMs.toFixed( 2 ),
	serverToClientsKBps: +( ( w1.rxBytes - w0.rxBytes ) / secs / 1024 ).toFixed( 1 ),
	clientsToServerKBps: +( ( w1.txBytes - w0.txBytes ) / secs / 1024 ).toFixed( 1 ),
	serverMsgsOutPerS: Math.round( ( w1.rxMsgs - w0.rxMsgs ) / secs ),
	serverMsgsInPerS: Math.round( ( w1.txMsgs - w0.txMsgs ) / secs ),
	unreliablePerBotPerS: +( ( w1.unreliable - w0.unreliable ) / secs / Math.max( 1, opts.bots ) ).toFixed( 1 ),
	unreliableTotalsPerBot: perBot,
	mapLoads
} ) );
Deno.exit( 0 );
