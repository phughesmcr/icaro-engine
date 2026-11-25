// In-memory RTCPeerConnection and RTCDataChannel for driver tests
// (src/net_webrtc.js).
//
// An offer and the answer to it link two FakeRTCPeerConnections by their SDP:
// once the offerer sets the answer as its remote description, every channel
// the offerer created gets a twin on the answerer (ondatachannel), and both
// ends open. Messages are delivered after a small delay. send() copies the
// bytes at call time, as browsers do. Tests can drop or delay the next
// messages on a channel (dropNext, extraDelayMs) and set bufferedAmount.
// close() on a channel closes both ends after the messages in flight; close()
// on a peer connection closes its channels without local events, and the
// remote ends see their channels close.

const DEFAULT_DELAY_MS = 1;

let nextId = 1;
const bySdp = new Map(); // offer or answer SDP -> FakeRTCPeerConnection

export class FakeRTCDataChannel {

	constructor( label, options = {}, delayMs = DEFAULT_DELAY_MS ) {

		this.label = label;
		this.ordered = options.ordered !== false;
		this.maxRetransmits = options.maxRetransmits ?? null;
		this.delayMs = delayMs;
		this.readyState = 'connecting';
		this.bufferedAmount = 0;
		this.binaryType = 'blob';
		this.onopen = null;
		this.onmessage = null;
		this.onclose = null;
		this.onerror = null;
		this.peer = null;
		this.sent = []; // every message passed to send(), as copies
		this.dropNext = 0; // drop this many of the next sends
		this.extraDelayMs = 0; // added to each delivery while set
		this.sendError = null; // thrown by send() while set

	}

	send( data ) {

		if ( this.readyState !== 'open' ) throw new Error( 'InvalidStateError: channel not open' );
		if ( this.sendError !== null ) throw this.sendError;

		let copy;
		if ( typeof data === 'string' ) {

			copy = data;
			this.sent.push( data );

		} else {

			const view = data instanceof ArrayBuffer ? new Uint8Array( data ) : new Uint8Array( data.buffer, data.byteOffset, data.byteLength );
			const bytes = view.slice();
			this.sent.push( bytes );
			copy = bytes.buffer;

		}

		if ( this.dropNext > 0 ) {

			this.dropNext --;
			return;

		}

		const peer = this.peer;
		if ( peer === null ) return;
		setTimeout( () => {

			// Messages in flight still arrive while the remote end closes
			if ( peer.readyState === 'closed' || peer.readyState === 'connecting' ) return;
			if ( peer.onmessage !== null ) peer.onmessage( { data: copy } );

		}, this.delayMs + this.extraDelayMs );

	}

	// Both ends close after the messages already in flight
	close() {

		if ( this.readyState === 'closing' || this.readyState === 'closed' ) return;
		this.readyState = 'closing';
		const peer = this.peer;
		setTimeout( () => {

			this._closed();
			if ( peer !== null ) peer._closed();

		}, this.delayMs + 1 );

	}

	_open() {

		if ( this.readyState !== 'connecting' ) return;
		this.readyState = 'open';
		if ( this.onopen !== null ) this.onopen( { type: 'open' } );

	}

	_closed() {

		if ( this.readyState === 'closed' ) return;
		this.readyState = 'closed';
		if ( this.onclose !== null ) this.onclose( { type: 'close' } );

	}

}

export class FakeRTCPeerConnection {

	constructor( config = {} ) {

		this.id = nextId ++;
		this.config = config;
		this.localDescription = null;
		this.remoteDescription = null;
		this.connectionState = 'new';
		this.channels = [];
		this.candidatesAdded = [];
		this.onicecandidate = null;
		this.ondatachannel = null;
		this.onconnectionstatechange = null;
		this.remote = null;
		this.closed = false;
		this.delayMs = DEFAULT_DELAY_MS;
		FakeRTCPeerConnection.instances.push( this );

	}

	createDataChannel( label, options = {} ) {

		const channel = new FakeRTCDataChannel( label, options, this.delayMs );
		this.channels.push( channel );
		return channel;

	}

	createOffer() {

		return Promise.resolve( { type: 'offer', sdp: 'v=0 fake-offer-' + this.id } );

	}

	createAnswer() {

		if ( this.remoteDescription === null )
			return Promise.reject( new Error( 'InvalidStateError: no remote description' ) );
		return Promise.resolve( { type: 'answer', sdp: 'v=0 fake-answer-' + this.id } );

	}

	setLocalDescription( description ) {

		this.localDescription = { type: description.type, sdp: description.sdp };
		bySdp.set( description.sdp, this );

		// Trickle one host candidate, then end-of-candidates
		setTimeout( () => {

			if ( this.closed === true || this.onicecandidate === null ) return;
			const init = { candidate: 'candidate:' + this.id + ' 1 udp 1 127.0.0.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 };
			this.onicecandidate( { candidate: { ...init, toJSON: () => ( { ...init } ) } } );
			if ( this.onicecandidate !== null ) this.onicecandidate( { candidate: null } );

		}, this.delayMs );

		return Promise.resolve();

	}

	setRemoteDescription( description ) {

		if ( typeof description?.sdp !== 'string' || description.sdp.startsWith( 'v=0' ) === false )
			return Promise.reject( new Error( 'OperationError: bad SDP' ) );

		this.remoteDescription = { type: description.type, sdp: description.sdp };

		if ( description.type === 'answer' ) {

			const answerer = bySdp.get( description.sdp );
			if ( answerer !== undefined ) setTimeout( () => _link( this, answerer ), this.delayMs );

		}

		return Promise.resolve();

	}

	addIceCandidate( candidate ) {

		if ( this.remoteDescription === null )
			return Promise.reject( new Error( 'InvalidStateError: no remote description' ) );
		this.candidatesAdded.push( candidate );
		return Promise.resolve();

	}

	close() {

		if ( this.closed === true ) return;
		this.closed = true;
		this.connectionState = 'closed';
		for ( const channel of this.channels ) {

			channel.readyState = 'closed';
			const peer = channel.peer;
			if ( peer !== null ) setTimeout( () => peer._closed(), this.delayMs );

		}

	}

	// Test helper: the ICE transport fails
	fail() {

		this.connectionState = 'failed';
		if ( this.onconnectionstatechange !== null ) this.onconnectionstatechange();

	}

}

FakeRTCPeerConnection.instances = [];

function _link( offerer, answerer ) {

	if ( offerer.closed === true || answerer.closed === true ) return;
	offerer.remote = answerer;
	answerer.remote = offerer;
	offerer.connectionState = 'connected';
	answerer.connectionState = 'connected';

	for ( const channel of offerer.channels ) {

		const twin = new FakeRTCDataChannel( channel.label, { ordered: channel.ordered, maxRetransmits: channel.maxRetransmits }, channel.delayMs );
		channel.peer = twin;
		twin.peer = channel;
		answerer.channels.push( twin );
		if ( answerer.ondatachannel !== null ) answerer.ondatachannel( { channel: twin } );
		twin._open();
		channel._open();

	}

}

// Game packet helpers: [magic][sequence:u32le][ack:u32le][payload]
export function packetSequence( bytes ) {

	return new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength ).getUint32( 1, true ) | 0;

}

export function packetAck( bytes ) {

	return new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength ).getUint32( 5, true ) | 0;

}

export function gamePacket( sequence, ack, payload ) {

	const bytes = new Uint8Array( 9 + payload.length );
	const view = new DataView( bytes.buffer );
	bytes[ 0 ] = 0x71;
	view.setUint32( 1, sequence >>> 0, true );
	view.setUint32( 5, ack >>> 0, true );
	bytes.set( payload, 9 );
	return bytes;

}
