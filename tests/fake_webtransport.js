// In-memory WebTransport pair for driver tests.
//
// Each direction is a pipe that delivers chunks after a small delay, in
// order, the way a network would. Closing the transport (either end) breaks
// every pipe at once and drops whatever is still in flight, like a QUIC
// CONNECTION_CLOSE, so a test only sees data the drivers flushed before close.

const DEFAULT_DELAY_MS = 2;

class FakePipe {

	constructor( session, delayMs ) {

		this.session = session;
		this.delayMs = delayMs;
		this.controller = null;
		this.ended = false;
		this.stalled = false;
		this._stallWaiters = [];
		this.written = []; // every chunk accepted by the writable side

		this.readable = new ReadableStream( {
			start: ( controller ) => {

				this.controller = controller;

			},
			cancel: () => {

				this.ended = true;

			}
		} );

		this.writable = new WritableStream( {
			write: ( chunk ) => this._write( chunk ),
			close: () => this._deliver( () => {

				this.ended = true;
				this.controller.close();

			} ),
			abort: () => this.break()
		} );

	}

	async _write( chunk ) {

		if ( this.session.isClosed ) throw new Error( 'WebTransport session closed' );
		while ( this.stalled ) {

			await new Promise( ( resolve ) => this._stallWaiters.push( resolve ) );
			if ( this.session.isClosed ) throw new Error( 'WebTransport session closed' );

		}

		const copy = new Uint8Array( chunk );
		this.written.push( copy );
		this._deliver( () => this.controller.enqueue( copy ) );

	}

	_deliver( action ) {

		const run = () => {

			if ( this.ended || this.session.isClosed ) return;
			try { action(); } catch ( _e ) { /* reader cancelled */ }

		};

		if ( this.delayMs > 0 ) this.session.schedule( run, this.delayMs );
		else run();

	}

	setStalled( stalled ) {

		this.stalled = stalled;
		if ( stalled === false ) {

			const waiters = this._stallWaiters;
			this._stallWaiters = [];
			for ( const resolve of waiters ) resolve();

		}

	}

	break() {

		if ( this.ended === false ) {

			this.ended = true;
			try { this.controller.error( new Error( 'WebTransport session closed' ) ); } catch ( _e ) { /* already closed */ }

		}

		this.setStalled( false );

	}

}

class FakeSession {

	constructor( delayMs ) {

		this.delayMs = delayMs;
		this.isClosed = false;
		this.pipes = [];
		this.timers = new Set();
		this.closeCount = 0;
		this._closedResolve = null;
		this.closed = new Promise( ( resolve ) => {

			this._closedResolve = resolve;

		} );

	}

	pipe() {

		const p = new FakePipe( this, this.delayMs );
		this.pipes.push( p );
		return p;

	}

	schedule( fn, ms ) {

		const timer = setTimeout( () => {

			this.timers.delete( timer );
			fn();

		}, ms );
		this.timers.add( timer );

	}

	close() {

		this.closeCount ++;
		if ( this.isClosed ) return;
		this.isClosed = true;
		for ( const timer of this.timers ) clearTimeout( timer );
		this.timers.clear();
		for ( const p of this.pipes ) p.break();
		this._closedResolve( { closeCode: 0, reason: '' } );

	}

}

/**
 * Create a connected client/server pair.
 * @param {object} [options]
 * @param {number} [options.delayMs] one-way delivery delay
 * @param {boolean} [options.datagrams] whether datagrams are supported
 * @param {number} [options.maxDatagramSize]
 * @param {Promise<unknown>} [options.ready] override for both ready promises
 */
export function createFakeWebTransportPair( options = {} ) {

	const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
	const session = new FakeSession( delayMs );
	const ready = options.ready ?? Promise.resolve();
	ready.catch( () => {} );

	const streams = []; // { c2s, s2c }
	let incomingController = null;
	const incomingBidirectionalStreams = new ReadableStream( {
		start( controller ) {

			incomingController = controller;

		}
	} );

	const dgC2S = session.pipe();
	const dgS2C = session.pipe();
	const withDatagrams = options.datagrams !== false;
	const maxDatagramSize = options.maxDatagramSize ?? 1200;

	const client = {
		ready,
		closed: session.closed,
		datagrams: withDatagrams ? {
			readable: dgS2C.readable,
			writable: dgC2S.writable,
			maxDatagramSize
		} : null,
		createBidirectionalStream() {

			if ( session.isClosed ) return Promise.reject( new Error( 'WebTransport session closed' ) );
			const c2s = session.pipe();
			const s2c = session.pipe();
			streams.push( { c2s, s2c } );
			session.schedule( () => {

				try {

					incomingController.enqueue( { readable: c2s.readable, writable: s2c.writable } );

				} catch ( _e ) { /* server stopped accepting */ }

			}, delayMs );
			return Promise.resolve( { readable: s2c.readable, writable: c2s.writable } );

		},
		close() {

			session.close();
			try { incomingController.close(); } catch ( _e ) { /* already closed */ }

		}
	};

	const server = {
		ready,
		closed: session.closed,
		incomingBidirectionalStreams,
		datagrams: withDatagrams ? {
			readable: dgC2S.readable,
			writable: dgS2C.writable,
			maxDatagramSize
		} : null,
		close() {

			client.close();

		}
	};

	return { client, server, session, streams, datagramsToServer: dgC2S, datagramsToClient: dgS2C };

}

// Concatenate every chunk written to a pipe.
export function writtenBytes( pipe ) {

	let length = 0;
	for ( const chunk of pipe.written ) length += chunk.length;
	const out = new Uint8Array( length );
	let offset = 0;
	for ( const chunk of pipe.written ) {

		out.set( chunk, offset );
		offset += chunk.length;

	}

	return out;

}

// Split [len:u16le][payload] frames.
export function splitFrames( bytes ) {

	const frames = [];
	let offset = 0;
	while ( offset + 2 <= bytes.length ) {

		const length = bytes[ offset ] | ( bytes[ offset + 1 ] << 8 );
		if ( offset + 2 + length > bytes.length ) break;
		frames.push( bytes.slice( offset + 2, offset + 2 + length ) );
		offset += 2 + length;

	}

	return frames;

}

export function frame( payload ) {

	const out = new Uint8Array( 2 + payload.length );
	out[ 0 ] = payload.length & 0xff;
	out[ 1 ] = ( payload.length >> 8 ) & 0xff;
	out.set( payload, 2 );
	return out;

}

export function sequencedPacket( sequence, acknowledged, payload ) {

	const packet = new Uint8Array( 9 + payload.length );
	const view = new DataView( packet.buffer );
	packet[ 0 ] = 0x71;
	view.setUint32( 1, sequence >>> 0, true );
	view.setUint32( 5, acknowledged >>> 0, true );
	packet.set( payload, 9 );
	return packet;

}

export function delay( ms ) {

	return new Promise( ( resolve ) => setTimeout( resolve, ms ) );

}

// Poll until predicate() is true or timeoutMs passes.
export async function waitFor( predicate, timeoutMs = 2000, label = 'condition' ) {

	const start = performance.now();
	while ( predicate() !== true ) {

		if ( performance.now() - start > timeoutMs )
			throw new Error( 'Timed out waiting for ' + label );
		await delay( 2 );

	}

}
