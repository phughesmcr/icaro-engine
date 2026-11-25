// Drives the throwaway Durable Object in worker.js to settle the Workers
// Free plan's open questions in docs/always-on-hosting.md:
//
// 1. The CPU limit per invocation (10 ms or 30 s), for an HTTP request and
//    for a WebSocket message.
// 2. Whether setInterval callbacks in a DO share that budget, with no
//    incoming messages ("quiet") and with a message every 50 ms ("busy"),
//    as a room's tick would.
// 3. Whether ArrayBuffers count toward the 128 MB isolate limit.
//
// It runs no game code, and it needs the maintainer's Cloudflare account on
// the Free plan. From tools/do_cpu_probe/:
//
//   npx wrangler login
//   npx wrangler deploy
//   npx wrangler secret put PROBE_TOKEN      (any long random string)
//   PROBE_TOKEN=... deno run --allow-net --allow-env=PROBE_TOKEN probe.js \
//     https://icaro-do-cpu-probe.<your-subdomain>.workers.dev
//   npx wrangler delete                       (when done)
//
// Options: --only=http,ws,timer,memory (default all), and --dry-run, for
// `npx wrangler dev --var PROBE_TOKEN:<token>` on this machine: ramps only to
// 120 ms and runs each timer test for 10 s. wrangler dev enforces none of
// the limits and ran this loop about 18 times slower than Deno, so a dry
// run checks the plumbing only. A full run takes about 6
// minutes and uses a few hundred requests and well under 1% of a day's free
// Durable Object duration. The dashboard's Workers Logs show each
// invocation's real CPU time; this script's millisecond figures are local
// estimates (iterations calibrated on this machine).

import { burn } from './burn.js';

const base = Deno.args.find( ( a ) => a.startsWith( 'http' ) );
const only_arg = Deno.args.find( ( a ) => a.startsWith( '--only=' ) );
const only = only_arg !== undefined ? only_arg.slice( 7 ).split( ',' ) : [ 'http', 'ws', 'timer', 'memory' ];
const token = Deno.env.get( 'PROBE_TOKEN' ) ?? '';
const dry_run = Deno.args.includes( '--dry-run' );
if ( base === undefined || token === '' ) {

	console.error( 'usage: PROBE_TOKEN=... deno run --allow-net --allow-env=PROBE_TOKEN probe.js https://<worker>.workers.dev' );
	Deno.exit( 2 );

}

const report = { base_host: new URL( base ).host, started: new Date().toISOString() };

function url( path, params = {} ) {

	const u = new URL( path, base );
	u.searchParams.set( 'token', token );
	for ( const [ k, v ] of Object.entries( params ) ) u.searchParams.set( k, String( v ) );
	return u;

}

async function get( path, params ) {

	const response = await fetch( url( path, params ) );
	const text = await response.text();
	let body = text;
	try {

		body = JSON.parse( text );

	} catch {

		// Cloudflare's own error pages (e.g. 1102) are HTML; keep the start
		body = text.slice( 0, 200 );

	}

	return { status: response.status, body };

}

function sleep( ms ) {

	return new Promise( ( resolve ) => setTimeout( resolve, ms ) );

}

async function instance() {

	const r = await get( '/info' );
	return r.body !== null && typeof r.body === 'object' ? r.body.instance ?? null : null;

}

// ---------------------------------------------------------------- calibrate

burn( 1e6 );
const cal_iters = 5e7;
const t0 = performance.now();
burn( cal_iters );
const iters_per_ms = Math.round( cal_iters / ( performance.now() - t0 ) );
report.local_iters_per_ms = iters_per_ms;
const iters = ( ms ) => Math.round( ms * iters_per_ms );

const forbidden = await get( '/info' );
if ( forbidden.status === 403 ) {

	console.error( '403: PROBE_TOKEN does not match the Worker secret' );
	Deno.exit( 1 );

}

// ------------------------------------------------- 1. CPU per invocation

const RAMP_MS = [ 1, 5, 9, 15, 30, 60, 120, 500, 2000, 10000, 25000, 40000 ].filter( ( ms ) => dry_run === false || ms <= 120 );
report.dry_run = dry_run;

// reset_before: the burn ran in a fresh instance (the last one died).
// reset_after: the instance changed after the burn returned, e.g. evicted.
function resets( before, during, after ) {

	return { reset_before: during !== null && during !== before, reset_after: during !== null ? after !== during : after !== before };

}

async function rampHttp() {

	const rows = [];
	let failures = 0;
	for ( const ms of RAMP_MS ) {

		const before = await instance();
		const r = await get( '/burn', { iters: iters( ms ) } );
		const after = await instance();
		const ok = r.status === 200 && typeof r.body === 'object' && r.body.result !== undefined;
		const during = ok ? r.body.instance : null;
		const row = { local_ms: ms, status: r.status, ok, ...resets( before, during, after ), detail: ok ? undefined : r.body };
		rows.push( row );
		console.log( 'http', ms, 'ms:', ok ? 'ok' : 'FAILED', row.reset_before ? '(fresh instance)' : '', row.reset_after ? '(instance changed after)' : '' );
		if ( ok === false && ++ failures >= 2 ) break;

	}

	return rows;

}

function openSocket() {

	const u = url( '/ws' );
	u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
	const ws = new WebSocket( u );
	return new Promise( ( resolve, reject ) => {

		ws.onopen = () => resolve( ws );
		ws.onerror = () => reject( new Error( 'WebSocket failed to open' ) );

	} );

}

function wsBurn( ws, n, timeout_ms ) {

	return new Promise( ( resolve ) => {

		const timer = setTimeout( () => resolve( { ok: false, detail: 'no reply in ' + timeout_ms + ' ms' } ), timeout_ms );
		ws.onmessage = ( e ) => {

			clearTimeout( timer );
			resolve( { ok: true, detail: JSON.parse( e.data ) } );

		};
		ws.onclose = ( e ) => {

			clearTimeout( timer );
			resolve( { ok: false, detail: 'closed ' + e.code + ' ' + e.reason } );

		};
		ws.send( JSON.stringify( { burn: n } ) );

	} );

}

async function rampWs() {

	const rows = [];
	let failures = 0;
	let ws = await openSocket();
	for ( const ms of RAMP_MS ) {

		const before = await instance();
		const r = await wsBurn( ws, iters( ms ), ms * 4 + 10000 );
		const after = await instance();
		const during = r.ok ? r.detail.instance : null;
		const row = { local_ms: ms, ok: r.ok, ...resets( before, during, after ), detail: r.ok ? undefined : r.detail };
		rows.push( row );
		console.log( 'ws', ms, 'ms:', r.ok ? 'ok' : 'FAILED', row.reset_before ? '(fresh instance)' : '', row.reset_after ? '(instance changed after)' : '' );
		if ( r.ok === false ) {

			if ( ++ failures >= 2 ) break;
			try {

				ws.close();

			} catch {

				// already closed
			}

			ws = await openSocket();

		}

	}

	ws.close();
	return rows;

}

// --------------------------------------------- 2. timer callbacks' CPU

async function timerRun( label, tick_ms, seconds, busy ) {

	const start = await get( '/tick', { iters: iters( tick_ms ), hz: 20, seconds } );
	const started_instance = start.body.instance;
	let ws = null;
	let pinger = null;
	let pings = 0;
	if ( busy === true ) {

		ws = await openSocket();
		pinger = setInterval( () => {

			if ( ws.readyState === WebSocket.OPEN ) {

				ws.send( 'ping' );
				pings ++;

			}

		}, 50 );

	}

	console.log( 'timer', label + ':', tick_ms, 'ms a tick at 20 Hz for', seconds, 's', busy ? 'with pings' : 'with no requests' );
	await sleep( ( seconds + 5 ) * 1000 );
	if ( pinger !== null ) clearInterval( pinger );
	if ( ws !== null ) ws.close();
	const status = await get( '/status' );
	const p = status.body.progress;
	const row = {
		label,
		local_ms_per_tick: tick_ms,
		seconds,
		busy,
		pings,
		expected_ticks: seconds * 20,
		ticks: p !== null ? p.ticks : null,
		ran_seconds: p !== null ? +( ( p.last - p.started ) / 1000 ).toFixed( 1 ) : null,
		done: p !== null ? p.done : null,
		reset: status.body.instance !== started_instance,
	};
	console.log( '  ->', row.ticks, 'of', row.expected_ticks, 'ticks', row.reset ? '(instance reset)' : '' );
	return row;

}

async function timers() {

	const short = dry_run ? 10 : null;
	return [
		// A room's tick at about 2x the M4 Pro's busy average
		await timerRun( 'quiet, light', 2, short ?? 60, false ),
		// 400 ms of CPU a second: crosses 30 s of CPU at about 75 s
		await timerRun( 'quiet, heavy', 20, short ?? 120, false ),
		await timerRun( 'busy, heavy', 20, short ?? 120, true ),
	];

}

// ------------------------------------------------ 3. ArrayBuffer memory

async function memory() {

	const rows = [];
	const first = await instance();
	for ( let step = 0; step < 8; step ++ ) {

		const r = await get( '/alloc', { mb: 32 } );
		const now = await instance();
		const held = typeof r.body === 'object' ? r.body.held_mb ?? null : null;
		rows.push( { asked_total_mb: ( step + 1 ) * 32, held_mb: held, status: r.status, reset: now !== first, detail: held === null ? r.body : undefined } );
		console.log( 'memory', ( step + 1 ) * 32, 'MB:', held !== null ? 'held ' + held : 'FAILED', now !== first ? '(instance reset)' : '' );
		if ( now !== first || held === null ) break;

	}

	return rows;

}

// ---------------------------------------------------------------- run

if ( only.includes( 'http' ) ) report.cpu_per_http_request = await rampHttp();
if ( only.includes( 'ws' ) ) report.cpu_per_websocket_message = await rampWs();
if ( only.includes( 'timer' ) ) report.timer_callbacks = await timers();
// Last: it leaves the instance holding memory until it is evicted
if ( only.includes( 'memory' ) ) report.arraybuffer_memory = await memory();

console.log( JSON.stringify( report, null, 2 ) );
