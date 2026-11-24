// Ported from: WinQuake/client.h -- client structures and definitions

import { MAX_CL_STATS,
	MAX_MODELS, MAX_SOUNDS, MAX_EDICTS, MAX_LIGHTSTYLES, entity_state_t, packet_entities_t } from './quakedef.js';
import { sizebuf_t } from './common.js';

//=============================================================================

export const SIGNONS = 4; // signon messages to receive before connected

// The one definition of MAX_DLIGHTS and MAX_VISEDICTS: gl_rmain.js and
// gl_rlight.js re-export these.
// Deliberate deviation: 64 as in QuakeSpasm/Ironwail (id: 32). msurface_t
// dlightbits is a word array sized from this (gl_model.js), so lights 32 and
// up get their own bits (gl_rlight.js R_MarkLights).
export const MAX_DLIGHTS = 64;
// Deliberate deviation: the limits below are raised to Ironwail's values
// (id: MAX_BEAMS 24, MAX_TEMP_ENTITIES 64, MAX_STATIC_ENTITIES 128,
// MAX_VISEDICTS 256) so larger maps don't drop entities.
export const MAX_BEAMS = 32;
export const MAX_EFRAGS = 640; // more are allocated on demand (gl_refrag.js R_GetEfrag)
export const MAX_TEMP_ENTITIES = 256; // lightning bolts, etc
export const MAX_STATIC_ENTITIES = 4096; // torches, etc
export const MAX_VISEDICTS = 16384;

export const MAX_MAPSTRING = 2048;
export const MAX_DEMOS = 8;
export const MAX_DEMONAME = 16;

export const NAME_LENGTH = 64;

//
// color shifts
//
export const CSHIFT_CONTENTS = 0;
export const CSHIFT_DAMAGE = 1;
export const CSHIFT_BONUS = 2;
export const CSHIFT_POWERUP = 3;
export const NUM_CSHIFTS = 4;

//
// cactive_t -- connection state
//
export const ca_dedicated = 0; // a dedicated server with no ability to start a client
export const ca_disconnected = 1; // full screen console with no connection
export const ca_connected = 2; // valid netcon, talking to a server

//=============================================================================

export class usercmd_t {

	constructor() {

		this.viewangles = new Float32Array( 3 );

		// intended velocities
		this.forwardmove = 0;
		this.sidemove = 0;
		this.upmove = 0;

	}

}

export class lightstyle_t {

	constructor() {

		this.length = 0;
		this.map = '';

	}

}

export class scoreboard_t {

	constructor() {

		this.name = '';
		this.entertime = 0;
		this.frags = 0;
		this.colors = 0; // two 4 bit fields
		this.translations = new Uint8Array( 256 ); // VID_GRADES * 256 simplified

	}

}

export class cshift_t {

	constructor() {

		this.destcolor = new Int32Array( 3 );
		// C: int percent. Stored in an Int32Array so every write truncates
		// like the C float->int conversion (e.g. V_UpdatePalette's
		// percent -= host_frametime*150 drops by whole units per frame).
		this._percent = new Int32Array( 1 ); // 0-256

	}

	get percent() {

		return this._percent[ 0 ];

	}

	set percent( value ) {

		this._percent[ 0 ] = value;

	}

}

export class dlight_t {

	constructor() {

		this.origin = new Float32Array( 3 );
		this.radius = 0;
		this.die = 0; // stop lighting after this time
		this.decay = 0; // drop this each second
		this.minlight = 0; // don't add when contributing less
		this.key = 0;

	}

}

export class beam_t {

	constructor() {

		this.entity = 0;
		this.model = null;
		this.endtime = 0;
		this.start = new Float32Array( 3 );
		this.end = new Float32Array( 3 );

	}

}

export class kbutton_t {

	constructor() {

		this.down = new Int32Array( 2 ); // key nums holding it down
		this.state = 0; // low bit is down state

	}

}

// packet_entities_t lives in quakedef.js, next to entity_state_t, so the
// server's client_frame_t can share it
export { packet_entities_t };

//
// entity_t - client side entity
//
export class entity_t {

	constructor() {

		this.forcelink = false; // model changed

		this.update_type = 0;

		this.baseline = new entity_state_t();

		this.msgtime = 0; // time of last update
		this.msg_origins = [ new Float32Array( 3 ), new Float32Array( 3 ) ]; // last two updates (0 is newest)
		this.origin = new Float32Array( 3 );
		this.msg_angles = [ new Float32Array( 3 ), new Float32Array( 3 ) ]; // last two updates (0 is newest)
		this.angles = new Float32Array( 3 );

		this.model = null; // NULL = no model
		this.efrag = null; // linked list of efrags
		this.frame = 0;
		this.syncbase = 0; // for client-side animations
		this.colormap = null;
		this.effects = 0; // light, particles, etc
		this.skinnum = 0; // for Alias models
		this.visframe = 0; // last frame this entity was found in an active leaf

		this.dlightframe = 0; // dynamic lighting
		this.dlightbits = 0;

		// FIXME: could turn these into a union
		this.trivial_accept = 0;
		this.topnode = null; // for bmodels, first world node that splits bmodel, or NULL if not split

		this._lastPESeq = 0; // last server sequence this entity was updated from packet entities (for interpolation)

		// johnfitz -- lerping (FitzQuake/QuakeSpasm render.h; see LERP_*).
		// A new entity starts with nothing to lerp from.
		this.lerpflags = 8 | 2; // LERP_RESETMOVE | LERP_RESETANIM (render.js; not imported: cycle)
		this.lerpstart = 0; // animation lerping
		this.lerptime = 0; // animation lerping
		this.lerpfinish = 0; // lerping -- server sent us a more accurate interval, use it instead of 0.1
		this.previouspose = 0; // animation lerping
		this.currentpose = 0; // animation lerping
		this.movelerpstart = 0; // transform lerping
		this.previousorigin = new Float32Array( 3 ); // transform lerping
		this.currentorigin = new Float32Array( 3 ); // transform lerping
		this.previousangles = new Float32Array( 3 ); // transform lerping
		this.currentangles = new Float32Array( 3 ); // transform lerping
		this._lerphdr = null; // aliashdr the poses above index (port-only guard)

	}

}

//
// efrag_t
//
export class efrag_t {

	constructor() {

		this.leaf = null;
		this.leafnext = null;
		this.entity = null;
		this.entnext = null;

	}

}

//
// the client_static_t structure is persistant through an arbitrary number
// of server connections
//
export class client_static_t {

	constructor() {

		this.state = ca_disconnected;

		// personalization data sent to server
		this.mapstring = '';
		this.spawnparms = ''; // to restart a level

		// demo loop control
		this.demonum = 0; // C global is zero-initialized; -1 means don't play demos
		this.demos = new Array( MAX_DEMOS ).fill( '' ); // when not playing

		// demo recording info must be here, because record is started before
		// entering a map (and clearing client_state_t)
		this.demorecording = false;
		this.demoplayback = false;
		this.timedemo = false;
		this.forcetrack = - 1; // -1 = use normal cd track
		this.demofile = null; // ArrayBuffer or file handle
		this.demodata = null; // Uint8Array for demo file data
		this.demopos = 0; // current read position in demo data
		this.td_lastframe = 0; // to meter out one message a frame
		this.td_startframe = 0; // host_framecount at start
		this.td_starttime = 0; // realtime at second frame of timedemo

		// connection information
		this.signon = 0; // 0 to SIGNONS
		this.netcon = null;
		this.message = new sizebuf_t(); // writing buffer to send to server

	}

}

//
// the client_state_t structure is wiped completely at every
// server signon
//
export class client_state_t {

	constructor() {

		this.movemessages = 0; // since connecting to this server
		this.cmd = new usercmd_t(); // last command sent to the server

		// information for local display
		this.stats = new Int32Array( MAX_CL_STATS ); // health, etc
		this.items = 0; // inventory bit flags
		this.item_gettime = new Float32Array( 32 ); // cl.time of acquiring item, for blinking
		this.faceanimtime = 0; // use anim frame if cl.time < this

		this.cshifts = [];
		this.prev_cshifts = [];
		for ( let i = 0; i < NUM_CSHIFTS; i ++ ) {

			this.cshifts.push( new cshift_t() );
			this.prev_cshifts.push( new cshift_t() );

		}

		// the client maintains its own idea of view angles, which are
		// sent to the server each frame. The server sets punchangle when
		// the view is temporarliy offset, and an angle reset commands at the start
		// of each level and after teleporting.
		this.mviewangles = [ new Float32Array( 3 ), new Float32Array( 3 ) ]; // during demo playback viewangles is lerped between these
		this.viewangles = new Float32Array( 3 );
		// port addition: angles of the last svc_setangle. The packet-entity
		// path carries no player angles, so V_CalcIntermissionRefdef uses
		// these in place of the server's player angles (see view.js).
		this.setangles = new Float32Array( 3 );

		this.mvelocity = [ new Float32Array( 3 ), new Float32Array( 3 ) ]; // update by server, used for lean+bob (0 is newest)
		this.velocity = new Float32Array( 3 ); // lerped between mvelocity[0] and [1]

		this.punchangle = new Float32Array( 3 ); // temporary offset

		// pitch drifting vars
		this.idealpitch = 0;
		this.pitchvel = 0;
		this.nodrift = false;
		this.driftmove = 0;
		this.laststop = 0;

		this.viewheight = 0;
		this.crouch = 0; // local amount for smoothing stepups

		this.paused = false; // send over by server
		this.onground = false;
		this.inwater = false;

		this.intermission = 0; // don't change view angle, full screen, etc
		this.completed_time = 0; // latched at intermission start

		this.mtime = new Float64Array( 2 ); // the timestamp of last two messages
		this.time = 0; // clients view of time, should be between
						// servertime and oldservertime to generate
						// a lerp point for other data
		this.oldtime = 0; // previous cl.time, time-oldtime is used
						// to decay light values and smooth step ups

		this.last_received_message = 0; // (realtime) for net trouble icon

		//
		// information that is static for the entire time connected to a server
		//
		this.model_precache = new Array( MAX_MODELS ).fill( null );
		this.sound_precache = new Array( MAX_SOUNDS ).fill( null );

		this.levelname = ''; // for display on solo scoreboard
		this.viewentity = 0; // cl_entities[cl.viewentity] = player
		this.maxclients = 0;
		this.gametype = 0;

		// refresh related state
		this.worldmodel = null; // cl_entities[0].model
		this.free_efrags = null;
		this.num_entities = 0; // held in cl_entities array
		this.num_statics = 0; // held in cl_staticentities array
		this.viewent = new entity_t(); // the gun model

		this.cdtrack = 0;
		this.looptrack = 0; // cd audio

		// frag scoreboard
		this.scores = null; // [cl.maxclients]

	}

}

//=============================================================================
// Global instances
//=============================================================================

export const cls = new client_static_t();
export const cl = new client_state_t();

// FIXME: put these on hunk?
export const cl_efrags = [];
for ( let i = 0; i < MAX_EFRAGS; i ++ ) cl_efrags.push( new efrag_t() );

export const cl_entities = [];
for ( let i = 0; i < MAX_EDICTS; i ++ ) cl_entities.push( new entity_t() );

export const cl_static_entities = [];
for ( let i = 0; i < MAX_STATIC_ENTITIES; i ++ ) cl_static_entities.push( new entity_t() );

export const cl_lightstyle = [];
for ( let i = 0; i < MAX_LIGHTSTYLES; i ++ ) cl_lightstyle.push( new lightstyle_t() );

export const cl_dlights = [];
for ( let i = 0; i < MAX_DLIGHTS; i ++ ) cl_dlights.push( new dlight_t() );

export const cl_temp_entities = [];
for ( let i = 0; i < MAX_TEMP_ENTITIES; i ++ ) cl_temp_entities.push( new entity_t() );

export const cl_beams = [];
for ( let i = 0; i < MAX_BEAMS; i ++ ) cl_beams.push( new beam_t() );

export let cl_numvisedicts = 0;
export const cl_visedicts = new Array( MAX_VISEDICTS ).fill( null );

export function set_cl_numvisedicts( val ) {

	cl_numvisedicts = val;

}
