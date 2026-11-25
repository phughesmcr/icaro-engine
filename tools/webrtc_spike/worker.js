// Worker half of the WebRTC spike (see index.html).
//
// - Ticks a 50 ms setInterval, as server/game_server.js does at sys_ticrate
//   0.05, and keeps its own tick times so its timer cadence can be told
//   apart from postMessage delivery to the page. Times are absolute
//   (timeOrigin + now): a Worker's performance.now() starts when the Worker
//   does, not with the page.
// - Posts each tick to the page ("worker-interval").
// - If the page transfers a data channel here, sends a small packet on it
//   every tick ("dc-worker"), as a server in a Worker would.

const TICK_MS = 50;
const ticks = [];
const sent = [];
let channel = null;
let channel_state = 'none';
let seq = 0;

setInterval( function () {

	const t = performance.timeOrigin + performance.now();
	ticks.push( t );
	self.postMessage( { tick: t } );
	if ( channel !== null && channel.readyState === 'open' ) {

		const packet = new Uint8Array( 64 );
		packet[ 0 ] = 2; // source tag: dc-worker
		new DataView( packet.buffer ).setUint32( 1, seq ++, true );
		try {

			channel.send( packet );
			sent.push( t );

		} catch ( e ) {

			channel_state = 'send failed: ' + e;

		}

	}

}, TICK_MS );

self.onmessage = function ( event ) {

	const msg = event.data;
	if ( msg.channel !== undefined ) {

		channel = msg.channel;
		channel_state = 'received (' + channel.readyState + ')';
		channel.onopen = function () {

			channel_state = 'open in worker';
			self.postMessage( { channel_state } );

		};
		channel.onerror = function ( e ) {

			channel_state = 'error: ' + ( e.error !== undefined ? e.error.message : e.type );
			self.postMessage( { channel_state } );

		};
		self.postMessage( { channel_state } );
		if ( channel.readyState === 'open' ) channel.onopen();

	}

	if ( msg.get_ticks === true ) {

		const inside = ( t ) => t >= msg.from && t <= msg.to;
		self.postMessage( { ticks: ticks.filter( inside ), sent: sent.filter( inside ), channel_state } );

	}

};
