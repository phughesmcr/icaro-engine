// WebRTC spike for docs/browser-hosted-rooms.md (see index.html for how to
// run it). Answers the design's "Spike" questions in the browser it runs in:
//
// 1. Does an unreliable channel ({ ordered: false, maxRetransmits: 0 }) open,
//    and what is sctp.maxMessageSize?
// 2. Are 1,000-1,400 byte unreliable messages delivered, paced and in a
//    burst? (Both peers are in this page, so this shows local limits only,
//    not loss on a real path.)
// 3. While the page is hidden: the cadence of requestAnimationFrame, a
//    main-thread setInterval( 50 ), a Worker's setInterval( 50 ), and data
//    channel delivery driven by each.
// 4. Can a data channel be transferred to a Worker (created here, and
//    received through ondatachannel), and does a module Worker resolve the
//    page's import map?

const TICK_MS = 50;
const TAG_DC_MAIN = 1;
const TAG_DC_WORKER = 2;
const TAG_SIZE_TEST = 9;

const results = {
	environment: {
		userAgent: navigator.userAgent,
		isSecureContext: window.isSecureContext,
		RTCPeerConnection: typeof RTCPeerConnection,
		Worker: typeof Worker,
		wakeLock: 'wakeLock' in navigator,
		started: new Date().toISOString(),
	},
	test1_unreliable_channel: null,
	test2_message_sizes: null,
	test4_transfer: { local_created: null, remote_ondatachannel: null, worker_import_map: null, worker_relative_import_control: null },
	test3_hidden_periods: [],
	errors: [],
};

const out = document.getElementById( 'out' );
const status_el = document.getElementById( 'status' );
const recording_el = document.getElementById( 'recording' );

window.spikeResults = results;

function render() {

	out.textContent = JSON.stringify( results, null, 2 );

}

function sleep( ms ) {

	return new Promise( ( resolve ) => setTimeout( resolve, ms ) );

}

function waitOpen( channel, ms = 5000 ) {

	if ( channel.readyState === 'open' ) return Promise.resolve();
	return new Promise( ( resolve, reject ) => {

		const timer = setTimeout( () => reject( new Error( channel.label + ' did not open within ' + ms + ' ms' ) ), ms );
		channel.addEventListener( 'open', () => {

			clearTimeout( timer );
			resolve();

		}, { once: true } );

	} );

}

// Two peer connections wired to each other. configure( a, b ) creates the
// channels before the offer.
async function connectPair( configure ) {

	const a = new RTCPeerConnection();
	const b = new RTCPeerConnection();
	a.onicecandidate = ( e ) => {

		if ( e.candidate !== null ) b.addIceCandidate( e.candidate ).catch( ( err ) => results.errors.push( 'b.addIceCandidate: ' + err ) );

	};
	b.onicecandidate = ( e ) => {

		if ( e.candidate !== null ) a.addIceCandidate( e.candidate ).catch( ( err ) => results.errors.push( 'a.addIceCandidate: ' + err ) );

	};
	configure( a, b );
	await a.setLocalDescription( await a.createOffer() );
	await b.setRemoteDescription( a.localDescription );
	await b.setLocalDescription( await b.createAnswer() );
	await a.setRemoteDescription( b.localDescription );
	return { a, b };

}

async function selectedCandidateType( pc ) {

	const stats = await pc.getStats();
	let pair_id = null;
	stats.forEach( ( s ) => {

		if ( s.type === 'transport' && s.selectedCandidatePairId !== undefined ) pair_id = s.selectedCandidatePairId;

	} );
	if ( pair_id === null ) {

		stats.forEach( ( s ) => {

			if ( s.type === 'candidate-pair' && s.nominated === true && s.state === 'succeeded' ) pair_id = s.id;

		} );

	}

	if ( pair_id === null ) return 'unknown';
	const pair = stats.get( pair_id );
	const local = pair !== undefined ? stats.get( pair.localCandidateId ) : undefined;
	return local !== undefined ? local.candidateType + '/' + local.protocol : 'unknown';

}

// ---------------------------------------------------------------- test 1

let main_pair = null;
let unreliable_a = null;
let unreliable_b = null;

// Arrival times, page clock, by source
const arrivals = {
	raf: [],
	main_interval: [],
	worker_interval: [],
	dc_main_sent: [],
	dc_main: [],
	dc_worker: [],
};

// Test 2 counters: size -> received count
let size_counts = new Map();

function onUnreliableMessage( event ) {

	const t = performance.now();
	const bytes = new Uint8Array( event.data );
	if ( bytes[ 0 ] === TAG_DC_MAIN ) arrivals.dc_main.push( t );
	else if ( bytes[ 0 ] === TAG_SIZE_TEST ) size_counts.set( bytes.length, ( size_counts.get( bytes.length ) ?? 0 ) + 1 );

}

async function test1() {

	main_pair = await connectPair( ( a, b ) => {

		unreliable_a = a.createDataChannel( 'unreliable', { ordered: false, maxRetransmits: 0 } );
		a.createDataChannel( 'reliable' );
		unreliable_a.binaryType = 'arraybuffer';
		b.ondatachannel = ( e ) => {

			if ( e.channel.label === 'unreliable' ) {

				unreliable_b = e.channel;
				unreliable_b.binaryType = 'arraybuffer';
				unreliable_b.onmessage = onUnreliableMessage;

			}

		};

	} );
	await waitOpen( unreliable_a );
	for ( let i = 0; i < 50 && unreliable_b === null; i ++ ) await sleep( 20 );

	results.test1_unreliable_channel = {
		opened: unreliable_a.readyState === 'open',
		ordered: unreliable_a.ordered,
		maxRetransmits: unreliable_a.maxRetransmits,
		maxPacketLifeTime: unreliable_a.maxPacketLifeTime,
		remote_side_ordered: unreliable_b !== null ? unreliable_b.ordered : null,
		remote_side_maxRetransmits: unreliable_b !== null ? unreliable_b.maxRetransmits : null,
		sctp_maxMessageSize_offerer: main_pair.a.sctp !== null ? main_pair.a.sctp.maxMessageSize : null,
		sctp_maxMessageSize_answerer: main_pair.b.sctp !== null ? main_pair.b.sctp.maxMessageSize : null,
		candidate: await selectedCandidateType( main_pair.a ),
	};

}

// ---------------------------------------------------------------- test 2

const SIZES = [ 1000, 1150, 1200, 1300, 1400, 4000, 16000 ];
const PER_SIZE = 300;

async function sendSizes( paced ) {

	size_counts = new Map();
	for ( const size of SIZES ) {

		const packet = new Uint8Array( size );
		packet[ 0 ] = TAG_SIZE_TEST;
		for ( let i = 0; i < PER_SIZE; i ++ ) {

			new DataView( packet.buffer ).setUint32( 1, i, true );
			unreliable_a.send( packet );
			// Paced: about 7 messages per 4 ms, roughly a host sending to 7
			// joiners at 72 Hz with headroom. Burst: all at once.
			if ( paced === true && i % 7 === 6 ) await sleep( 0 );

		}

		await sleep( 300 );

	}

	await sleep( 500 );
	const row = {};
	for ( const size of SIZES ) row[ size ] = ( size_counts.get( size ) ?? 0 ) + '/' + PER_SIZE;
	return row;

}

async function test2() {

	results.test2_message_sizes = {
		note: 'both peers in one page: local buffer limits only, not path MTU loss',
		paced: await sendSizes( true ),
		burst: await sendSizes( false ),
	};

}

// ---------------------------------------------------------------- test 4

let worker = null;
let worker_channel_state = 'none';
let worker_pair = null;

function startWorker() {

	worker = new Worker( new URL( './worker.js', import.meta.url ), { type: 'module' } );
	worker.onmessage = ( event ) => {

		const msg = event.data;
		if ( msg.tick !== undefined ) arrivals.worker_interval.push( performance.now() );
		if ( msg.channel_state !== undefined ) worker_channel_state = msg.channel_state;
		if ( msg.ticks !== undefined && pending_ticks !== null ) {

			pending_ticks( msg );
			pending_ticks = null;

		}

	};
	worker.onerror = ( e ) => results.errors.push( 'worker: ' + e.message );

}

function tryTransfer( target, channel ) {

	try {

		target.postMessage( { channel }, [ channel ] );
		return 'transferred';

	} catch ( e ) {

		return 'failed: ' + e.name + ': ' + e.message;

	}

}

async function test4() {

	startWorker();

	// 4a: created here, transferred before it opens. This channel then
	// carries the Worker's packets in test 3.
	worker_pair = await connectPair( ( a, b ) => {

		const channel = a.createDataChannel( 'worker', { ordered: false, maxRetransmits: 0 } );
		results.test4_transfer.local_created = tryTransfer( worker, channel );
		b.ondatachannel = ( e ) => {

			e.channel.binaryType = 'arraybuffer';
			e.channel.onmessage = ( m ) => {

				if ( new Uint8Array( m.data )[ 0 ] === TAG_DC_WORKER ) arrivals.dc_worker.push( performance.now() );

			};

		};

	} );
	for ( let i = 0; i < 100 && worker_channel_state.startsWith( 'open' ) === false; i ++ ) await sleep( 20 );
	results.test4_transfer.local_created += '; worker reports: ' + worker_channel_state;

	// 4b: received through ondatachannel, transferred from the handler, as
	// a host (the answerer) would get its joiners' channels.
	const probe = new Worker( new URL( './worker.js', import.meta.url ), { type: 'module' } );
	let probe_state = 'none';
	probe.onmessage = ( event ) => {

		if ( event.data.channel_state !== undefined ) probe_state = event.data.channel_state;

	};
	let remote_result = 'no datachannel event';
	const probe_pair = await connectPair( ( a, b ) => {

		a.createDataChannel( 'remote' );
		b.ondatachannel = ( e ) => {

			remote_result = tryTransfer( probe, e.channel );

		};

	} );
	for ( let i = 0; i < 100 && probe_state.startsWith( 'open' ) === false; i ++ ) await sleep( 20 );
	results.test4_transfer.remote_ondatachannel = remote_result + '; worker reports: ' + probe_state;
	probe.terminate();
	probe_pair.a.close();
	probe_pair.b.close();

	// 4c: import map in a module Worker, with a relative-import control
	results.test4_transfer.worker_import_map = await workerImport( './importmap_worker.js' );
	results.test4_transfer.worker_relative_import_control = await workerImport( './relative_worker.js' );

}

function workerImport( path ) {

	return new Promise( ( resolve ) => {

		let w = null;
		try {

			w = new Worker( new URL( path, import.meta.url ), { type: 'module' } );

		} catch ( e ) {

			resolve( 'Worker constructor threw: ' + e );
			return;

		}

		const timer = setTimeout( () => {

			resolve( 'no reply in 3 s' );
			w.terminate();

		}, 3000 );
		w.onmessage = ( e ) => {

			clearTimeout( timer );
			resolve( 'loaded (' + e.data.importmap + ')' );
			w.terminate();

		};
		w.onerror = ( e ) => {

			clearTimeout( timer );
			e.preventDefault();
			resolve( 'module failed to load (' + ( typeof e.message === 'string' && e.message !== '' ? e.message : 'error event, no message' ) + ')' );
			w.terminate();

		};

	} );

}

// ---------------------------------------------------------------- test 3

let pending_ticks = null;
let hidden_since = null;
let dc_seq = 0;

function gapStats( times, from, to ) {

	const inside = times.filter( ( t ) => t >= from && t <= to );
	const seconds = ( to - from ) / 1000;
	const gaps = [];
	for ( let i = 1; i < inside.length; i ++ ) gaps.push( inside[ i ] - inside[ i - 1 ] );
	gaps.sort( ( x, y ) => x - y );
	const pick = ( q ) => gaps.length > 0 ? Math.round( gaps[ Math.min( gaps.length - 1, Math.floor( q * gaps.length ) ) ] ) : null;
	return {
		count: inside.length,
		hz: +( inside.length / seconds ).toFixed( 2 ),
		median_gap_ms: pick( 0.5 ),
		p95_gap_ms: pick( 0.95 ),
		max_gap_ms: gaps.length > 0 ? Math.round( gaps[ gaps.length - 1 ] ) : null,
	};

}

function workerTicks( from, to ) {

	return new Promise( ( resolve ) => {

		// The Worker keeps absolute times; convert both ways
		const origin = performance.timeOrigin;
		const handle = resolve;
		pending_ticks = ( msg ) => handle( {
			ticks: msg.ticks.map( ( t ) => t - origin ),
			sent: msg.sent.map( ( t ) => t - origin ),
			channel_state: msg.channel_state,
		} );
		worker.postMessage( { get_ticks: true, from: origin + from, to: origin + to } );

	} );

}

async function summariseHidden( from, to ) {

	const worker_reply = await workerTicks( from, to );
	results.test3_hidden_periods.push( {
		hidden_seconds: Math.round( ( to - from ) / 1000 ),
		expected_hz: 1000 / TICK_MS,
		raf: gapStats( arrivals.raf, from, to ),
		main_interval: gapStats( arrivals.main_interval, from, to ),
		worker_interval_own_clock: gapStats( worker_reply.ticks, from, to ),
		worker_interval_arrival_on_page: gapStats( arrivals.worker_interval, from, to ),
		// Sender side: when each packet was sent, on the sender's clock
		dc_main_sent: gapStats( arrivals.dc_main_sent, from, to ),
		dc_worker_sent: gapStats( worker_reply.sent, from, to ),
		// Receiver side: timed on this (hidden) page's main thread, so these
		// mix delivery with the page's own event delays
		dc_main_received_on_page: gapStats( arrivals.dc_main, from, to ),
		dc_worker_received_on_page: gapStats( arrivals.dc_worker, from, to ),
		worker_channel: worker_reply.channel_state,
		worker_pair_connection: worker_pair !== null ? worker_pair.a.connectionState : null,
		main_pair_connection: main_pair !== null ? main_pair.a.connectionState : null,
	} );
	render();

}

function startRecording() {

	function frame( t ) {

		arrivals.raf.push( t );
		requestAnimationFrame( frame );

	}

	requestAnimationFrame( frame );

	setInterval( () => {

		arrivals.main_interval.push( performance.now() );
		if ( unreliable_a !== null && unreliable_a.readyState === 'open' ) {

			const packet = new Uint8Array( 64 );
			packet[ 0 ] = TAG_DC_MAIN;
			new DataView( packet.buffer ).setUint32( 1, dc_seq ++, true );
			unreliable_a.send( packet );
			arrivals.dc_main_sent.push( performance.now() );

		}

	}, TICK_MS );

	document.addEventListener( 'visibilitychange', () => {

		if ( document.visibilityState === 'hidden' ) {

			hidden_since = performance.now();
			recording_el.textContent = 'page hidden since ' + new Date().toLocaleTimeString();

		} else if ( hidden_since !== null ) {

			const from = hidden_since;
			hidden_since = null;
			recording_el.textContent = 'on; ' + ( results.test3_hidden_periods.length + 1 ) + ' hidden period(s) recorded';
			// Skip the first and last second, where the page is mid-transition
			summariseHidden( from + 1000, performance.now() - 1000 ).catch( ( e ) => results.errors.push( 'test3: ' + e ) );

		}

	} );
	recording_el.textContent = 'on';

}

// ---------------------------------------------------------------- page

document.getElementById( 'copy' ).onclick = async () => {

	try {

		await navigator.clipboard.writeText( JSON.stringify( results, null, 2 ) );
		status_el.textContent = 'Copied.';

	} catch ( e ) {

		status_el.textContent = 'Copy failed (' + e.name + '); select the text below instead.';

	}

};

document.getElementById( 'wakelock' ).onclick = async () => {

	try {

		await navigator.wakeLock.request( 'screen' );
		results.environment.wakeLock = 'granted';

	} catch ( e ) {

		results.environment.wakeLock = 'refused: ' + e.name;

	}

	render();

};

async function main() {

	if ( typeof RTCPeerConnection === 'undefined' ) {

		status_el.textContent = 'No RTCPeerConnection here (WebRTC off, or not a secure context?).';
		render();
		return;

	}

	for ( const [ name, run ] of [ [ 'test 1', test1 ], [ 'test 2', test2 ], [ 'test 4', test4 ] ] ) {

		try {

			await run();

		} catch ( e ) {

			results.errors.push( name + ': ' + e );

		}

		render();

	}

	if ( worker !== null ) startRecording();
	else results.errors.push( 'test 3 needs the Worker from test 4' );
	status_el.textContent = 'Tests 1, 2 and 4 done. Test 3: hide the page, then come back.';
	render();

}

main();
