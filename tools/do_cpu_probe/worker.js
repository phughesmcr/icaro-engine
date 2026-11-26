// A throwaway Worker + Durable Object that measures the Workers Free plan's
// limits for docs/always-on-hosting.md ("Free plan: a room in a Durable
// Object"). It runs no game code. tools/do_cpu_probe/probe.js drives it; its
// header gives the deploy steps.
//
// Every request needs ?token=<PROBE_TOKEN> (a Worker secret), so nobody else
// can spend the account's free allowance through it. Routes, all forwarded
// to one Durable Object instance:
//
//   GET /info               the instance id (new after a reset)
//   GET /burn?iters=N       burn N loop iterations of CPU in one request
//   GET /ws                 WebSocket (hibernation API). Messages:
//                             {"burn":N}  burn N iterations, reply with result
//                             "ping"      no reply; only resets the CPU budget
//   GET /tick?iters=N&hz=H&seconds=S
//                           start a setInterval in the DO that burns N
//                           iterations H times a second for S seconds, and
//                           saves its progress once a second
//   GET /status             the saved progress, and this instance's id
//   GET /alloc?mb=N         hold N MB more of ArrayBuffers (off-heap)

import { burn } from './burn.js';

export class ProbeRoom {

	constructor( ctx, env ) {

		this.ctx = ctx;
		this.env = env;
		this.instance = crypto.randomUUID();
		this.timer = null;
		this.held = [];

	}

	async fetch( request ) {

		const url = new URL( request.url );
		const n = ( name, fallback ) => {

			const v = Number( url.searchParams.get( name ) ?? fallback );
			return Number.isFinite( v ) && v >= 0 ? Math.floor( v ) : fallback;

		};

		switch ( url.pathname ) {

			case '/info':
				return json( { instance: this.instance } );

			case '/burn': {

				const iters = n( 'iters', 0 );
				return json( { instance: this.instance, iters, result: burn( iters ) } );

			}

			case '/ws': {

				if ( request.headers.get( 'Upgrade' ) !== 'websocket' ) return new Response( 'expected a WebSocket', { status: 426 } );
				const pair = new WebSocketPair();
				this.ctx.acceptWebSocket( pair[ 1 ] );
				return new Response( null, { status: 101, webSocket: pair[ 0 ] } );

			}

			case '/tick': {

				const iters = n( 'iters', 0 );
				const hz = Math.max( 1, Math.min( 100, n( 'hz', 20 ) ) );
				const seconds = Math.min( 600, n( 'seconds', 60 ) );
				if ( this.timer !== null ) clearInterval( this.timer );
				const progress = { instance: this.instance, iters, hz, seconds, started: Date.now(), ticks: 0, last: 0, done: false };
				await this.ctx.storage.put( 'progress', progress );
				this.timer = setInterval( () => {

					burn( iters );
					progress.ticks ++;
					progress.last = Date.now();
					if ( progress.last - progress.started >= seconds * 1000 ) {

						progress.done = true;
						clearInterval( this.timer );
						this.timer = null;

					}

					if ( progress.done || progress.ticks % hz === 0 ) this.ctx.storage.put( 'progress', { ...progress } );

				}, 1000 / hz );
				return json( progress );

			}

			case '/status':
				return json( { instance: this.instance, progress: ( await this.ctx.storage.get( 'progress' ) ) ?? null, held_mb: this.held.length } );

			case '/alloc': {

				const mb = Math.min( 512, n( 'mb', 0 ) );
				for ( let i = 0; i < mb; i ++ ) {

					const buffer = new Uint8Array( 1048576 );
					buffer.fill( i & 255 ); // touch every page
					this.held.push( buffer );

				}

				return json( { instance: this.instance, held_mb: this.held.length } );

			}

		}

		return new Response( 'not found', { status: 404 } );

	}

	webSocketMessage( ws, message ) {

		if ( message === 'ping' ) return;
		let iters = 0;
		try {

			iters = Math.max( 0, Math.floor( Number( JSON.parse( message ).burn ) ) );

		} catch {

			return;

		}

		ws.send( JSON.stringify( { instance: this.instance, iters, result: burn( iters ) } ) );

	}

}

function json( value ) {

	return new Response( JSON.stringify( value ), { headers: { 'content-type': 'application/json' } } );

}

export default {

	async fetch( request, env ) {

		const url = new URL( request.url );
		if ( typeof env.PROBE_TOKEN !== 'string' || env.PROBE_TOKEN === '' || url.searchParams.get( 'token' ) !== env.PROBE_TOKEN ) {

			return new Response( 'forbidden', { status: 403 } );

		}

		const stub = env.PROBE_ROOM.get( env.PROBE_ROOM.idFromName( 'probe' ) );
		try {

			return await stub.fetch( request );

		} catch ( e ) {

			// A DO that went over a limit throws here; pass the reason on
			return json( { error: String( e ), message: e instanceof Error ? e.message : null } );

		}

	},

};
