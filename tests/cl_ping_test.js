// HUD ping measured on the client (CL_CalcPing / CL_GetDisplayPing), the
// QW way: senttime of a command to the arrival of the transport ack for it.

import { realtime } from '../src/host.js';
import {
	CL_StoreCommand, CL_AcknowledgeTransportSequence, CL_AcknowledgeCommand,
	CL_ResetPrediction, CL_GetFrame,
	CL_CalcPing, CL_GetDisplayPing
} from '../src/cl_pred.js';

function idleCmd() {

	return { msec: 0, angles: new Float32Array( 3 ), forwardmove: 0, sidemove: 0, upmove: 0, buttons: 0 };

}

function assertEquals( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

Deno.test( 'CL_CalcPing: averages senttime to transport ack, QW SV_CalcPing style', () => {

	CL_ResetPrediction();
	try {

		const cmd = idleCmd();
		// realtime is the ack's arrival time
		CL_StoreCommand( cmd, realtime - 0.050, 10 ); // sequence 0
		CL_StoreCommand( cmd, realtime - 0.040, 11 ); // sequence 1
		CL_StoreCommand( cmd, realtime - 0.030, 12 ); // sequence 2
		assertEquals( CL_CalcPing(), - 1, 'no ack yet' );

		// The ack names packet 11: command 1 is the newest it covers
		CL_AcknowledgeTransportSequence( 11 );
		assertEquals( CL_GetFrame( 0 ).receivedtime, - 1, 'command 0 was superseded, never stamped' );
		assertEquals( CL_GetFrame( 1 ).receivedtime, realtime, 'command 1 stamped' );
		assertEquals( CL_CalcPing(), 40, 'one sample' );

		// A later datagram acking the same packet doesn't restamp it
		CL_GetFrame( 1 ).receivedtime = realtime - 0.001;
		CL_AcknowledgeTransportSequence( 11 );
		assertEquals( CL_GetFrame( 1 ).receivedtime, realtime - 0.001, 'not restamped' );
		CL_GetFrame( 1 ).receivedtime = realtime;

		CL_AcknowledgeTransportSequence( 12 );
		assertEquals( CL_CalcPing(), 35, 'average of 40 and 30 ms' );

	} finally {

		CL_ResetPrediction();

	}

} );

Deno.test( 'CL_CalcPing: QW odd-latency samples are ignored', () => {

	CL_ResetPrediction();
	try {

		const cmd = idleCmd();
		CL_StoreCommand( cmd, realtime - 2, 0 ); // sequence 0 counts as acknowledged
		CL_StoreCommand( cmd, realtime - 1.5, 1 );
		CL_AcknowledgeTransportSequence( 1 );
		assertEquals( CL_GetFrame( 1 ).receivedtime, realtime, 'stamped' );
		assertEquals( CL_CalcPing(), - 1, 'over 1 s is dropped' );

		CL_StoreCommand( cmd, realtime - 0.020, 2 );
		CL_AcknowledgeTransportSequence( 2 );
		assertEquals( CL_CalcPing(), 20, 'only the sane sample' );

	} finally {

		CL_ResetPrediction();

	}

} );

// Without a transport ack, cl_parse.js acks the command CL_FindAcknowledgedSequence
// guesses from cls_latency, which would make a circular sample
Deno.test( 'CL_CalcPing: the guessed-ack fallback gives no sample', () => {

	CL_ResetPrediction();
	try {

		const cmd = idleCmd();
		CL_StoreCommand( cmd, realtime - 0.2, - 1 );
		CL_StoreCommand( cmd, realtime - 0.1, - 1 );
		CL_AcknowledgeCommand( 1 );
		assertEquals( CL_GetFrame( 1 ).sequence, 1, 'command 1 stored' );

		assertEquals( CL_CalcPing(), - 1, 'CL_CalcPing' );
		assertEquals( CL_GetDisplayPing( 100 ), - 1, 'CL_GetDisplayPing' );

	} finally {

		CL_ResetPrediction();

	}

} );

Deno.test( 'CL_ResetPrediction clears the measurement and the HUD value', () => {

	CL_ResetPrediction();
	try {

		// sequence 0 counts as acknowledged from the start
		CL_StoreCommand( idleCmd(), realtime - 0.025, 0 );
		CL_StoreCommand( idleCmd(), realtime - 0.025, 1 );
		CL_AcknowledgeTransportSequence( 1 );
		assertEquals( CL_GetDisplayPing( 10 ), 25, 'measured' );

		CL_ResetPrediction();
		assertEquals( CL_CalcPing(), - 1, 'CL_CalcPing after reset' );
		assertEquals( CL_GetDisplayPing( 10.5 ), - 1, 'display after reset, inside the old 2 s window' );

	} finally {

		CL_ResetPrediction();

	}

} );

// The reported case: a dedicated server at sys_ticrate 0.05 acks the newest
// command that arrived before each tick; the client sends at 72 Hz and reads
// replies once per 60 Hz frame, over a 30 ms link with +-4 ms of jitter.
// The old NQ sample (sv.time minus the echoed svc_time) is 0 or 50 ms here,
// so the readout jumped between ~0 and ~45.
Deno.test( 'CL_GetDisplayPing: steady on a 30 ms link with a 20 Hz server', () => {

	CL_ResetPrediction();
	try {

		const rtt = 0.030;
		const sendInterval = 1 / 72;
		const readInterval = 1 / 60;
		const tick = 0.05;
		const cmd = idleCmd();

		// +-4 ms of jitter each way, from a fixed-seed LCG
		let seed = 12345;
		const jitter = () => {

			seed = ( Math.imul( seed, 1103515245 ) + 12345 ) >>> 0;
			return ( seed / 0x100000000 - 0.5 ) * 0.008;

		};

		// Commands sent, as [ sequence, senttime, arrival at the server ]
		const sent = [];
		let nextSend = 0;
		let nextTick = 0.0123; // server tick phase is arbitrary
		const replies = []; // [ ackedSequence, arrival at the client ]
		let ackedSeq = - 1;
		const shown = [];

		// Frame time is in the realtime clock, but realtime itself is
		// fixed during tests, so stamp receivedtime the way
		// CL_AcknowledgeTransportSequence would, through the frame buffer.
		for ( let now = 0; now < 20; now += readInterval ) {

			// client reads replies that have arrived (once per frame)
			while ( replies.length > 0 && replies[ 0 ][ 1 ] <= now ) {

				const seq = replies.shift()[ 0 ];
				const frame = CL_GetFrame( seq );
				if ( frame.sequence === seq && frame.receivedtime === - 1 )
					frame.receivedtime = now;

			}

			if ( now > 4 )
				shown.push( CL_GetDisplayPing( now ) );

			// client sends its moves for this frame
			while ( nextSend <= now ) {

				const seq = CL_StoreCommand( cmd, nextSend, sent.length );
				sent.push( [ seq, nextSend, nextSend + rtt / 2 + jitter() ] );
				nextSend += sendInterval;

			}

			// server ticks: ack the newest command that has arrived
			while ( nextTick <= now ) {

				for ( const [ seq, , arrival ] of sent ) {

					if ( arrival <= nextTick && seq > ackedSeq )
						ackedSeq = seq;

				}
				replies.push( [ ackedSeq, nextTick + rtt / 2 + jitter() ] );
				replies.sort( ( a, b ) => a[ 1 ] - b[ 1 ] );
				nextTick += tick;

			}

		}

		let min = Infinity;
		let max = - Infinity;
		let changes = 0;
		for ( let i = 0; i < shown.length; i ++ ) {

			min = Math.min( min, shown[ i ] );
			max = Math.max( max, shown[ i ] );
			if ( i > 0 && shown[ i ] !== shown[ i - 1 ] )
				changes ++;

		}

		// 30 ms of network plus the wait for the tick (up to one 72 Hz send
		// interval) and for the next 60 Hz frame
		if ( min < 30 || max > 30 + 14 + 17 )
			throw new Error( `readout out of range: ${min}..${max}` );
		if ( max - min > 6 )
			throw new Error( `readout not steady: ${min}..${max}` );
		// 16 s shown, refreshed every 2 s
		if ( changes > 8 )
			throw new Error( `readout changed ${changes} times` );

	} finally {

		CL_ResetPrediction();

	}

} );
