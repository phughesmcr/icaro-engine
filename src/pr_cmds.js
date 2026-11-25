// Ported from: WinQuake/pr_cmds.c -- QuakeC built-in functions

import { SV_BroadcastPrintf } from './host.js';
import {
	Con_Printf, Con_DPrintf, COM_Parse, com_token,
	MSG_WriteByte, MSG_WriteChar, MSG_WriteShort, MSG_WriteLong,
	MSG_WriteCoord, MSG_WriteAngle, MSG_WriteString,
} from './common.js';
import {
	VectorCopy, VectorSubtract, VectorNormalize, VectorMA, VectorScale, VectorAdd,
	DotProduct, Length, AngleVectors, vec3_origin, anglemod, M_PI,
} from './mathlib.js';
import { MAX_MODELS, MAX_SOUNDS, MAX_LIGHTSTYLES } from './quakedef.js';
import {
	OFS_RETURN, OFS_PARM0, OFS_PARM1, OFS_PARM2, OFS_PARM3,
	OFS_PARM4,
} from './pr_comp.js';
import {
	pr_global_struct,
	pr_argc, pr_xfunction,
	PR_GetString, PR_SetTrace, PR_SetXFunction,
	G_FLOAT, G_FLOAT_SET, G_INT, G_INT_SET, G_VECTOR, G_STRING, G_EDICT, G_EDICTNUM,
	EDICT_NUM, NUM_FOR_EDICT,
	EDICT_TO_PROG, PROG_TO_EDICT,
	RETURN_EDICT,
	E_STRING,
	sv,
	PR_SetBuiltins,
	PR_SetTempString,
	pr_functions, STRINGTEMP_LENGTH,
	PR_ZoneString, PR_UnzoneString, PR_ClearZoneStrings,
} from './progs.js';
import { PF_sprintf_internal, Q_FloatToInt } from './pr_sprintf.js';
import {
	ED_Alloc, ED_Free, ED_Print, ED_PrintNum, ED_PrintEdicts,
} from './pr_edict.js';
import { PR_HostError, PR_RunError } from './pr_exec.js';
import { SV_Move, SV_LinkEdict, SV_PointContents } from './world.js';
import { SV_movestep, SV_CheckBottom, SV_MoveToGoal as SV_MoveToGoal_Real, SV_Move_SetCallbacks } from './sv_move.js';
import { SV_StartSound, SV_StartParticle, sv_aim, SV_ReserveSignonSpace, SV_LocalSound } from './sv_main.js';
import { Cbuf_AddText } from './cmd.js';
import { Cvar_VariableValue, Cvar_Set } from './cvar.js';
import { FL_ONGROUND, FL_FLY, FL_SWIM, svs, ss_loading, ss_active, teamplay } from './server.js';
import { Mod_ForName, Mod_PointInLeaf, Mod_LeafPVS } from './gl_model.js';
import {
	svc_print, svc_centerprint, svc_stufftext, svc_lightstyle,
	svc_spawnstatic, svc_spawnstaticsound,
} from './protocol.js';

/*
===============================================================================

						BUILT-IN FUNCTIONS

===============================================================================
*/

function PF_VarString( first ) {

	// Use array.join() instead of string concatenation to avoid O(n²) allocations
	const parts = [];
	for ( let i = first; i < pr_argc; i ++ ) {

		parts.push( G_STRING( OFS_PARM0 + i * 3 ) );

	}

	return parts.join( '' );

}

/*
=================
PF_error

This is a TERMINAL error, which will kill off the entire server.
Dumps self.

error(value)
=================
*/
function PF_error() {

	const s = PF_VarString( 0 );
	Con_Printf( '======SERVER ERROR in %s:\n%s\n',
		PR_GetString( pr_xfunction.s_name ), s );
	const ed = PROG_TO_EDICT( pr_global_struct.self );
	ED_Print( ed );

	PR_HostError( 'Program error' );

}

/*
=================
PF_objerror

Dumps out self, then an error message. The program is aborted and self is
removed, but the level can continue.

objerror(value)
=================
*/
function PF_objerror() {

	const s = PF_VarString( 0 );
	Con_Printf( '======OBJECT ERROR in %s:\n%s\n',
		PR_GetString( pr_xfunction.s_name ), s );
	const ed = PROG_TO_EDICT( pr_global_struct.self );
	ED_Print( ed );
	ED_Free( ed );

	// Deviation from id's C, which called Host_Error( "Program error" ) here
	// and ended the level. Ironwail and QuakeSpasm comment it out (johnfitz:
	// "by design, this should not be fatal"): self is freed and play goes on.

}

/*
==============
PF_makevectors

Writes new values for v_forward, v_up, and v_right based on angles
makevectors(vector)
==============
*/
function PF_makevectors() {

	const ang = G_VECTOR( OFS_PARM0 );
	const forward = pr_global_struct.v_forward;
	const right = pr_global_struct.v_right;
	const up = pr_global_struct.v_up;
	AngleVectors( ang, forward, right, up );

}

/*
=================
PF_setorigin

setorigin (entity, origin)
=================
*/
function PF_setorigin() {

	const e = G_EDICT( OFS_PARM0 );
	const org = G_VECTOR( OFS_PARM1 );
	VectorCopy( org, e.v.origin );
	SV_LinkEdict( e, false );

}

/*
=================
PF_setsize

the size box is rotated by the current angle

setsize (entity, minvector, maxvector)
=================
*/
function PF_setsize() {

	const e = G_EDICT( OFS_PARM0 );
	const min = G_VECTOR( OFS_PARM1 );
	const max = G_VECTOR( OFS_PARM2 );

	for ( let i = 0; i < 3; i ++ ) {

		if ( min[ i ] > max[ i ] )
			PR_RunError( 'backwards mins/maxs' );

	}

	VectorCopy( min, e.v.mins );
	VectorCopy( max, e.v.maxs );
	VectorSubtract( max, min, e.v.size );

	SV_LinkEdict( e, false );

}

/*
=================
PF_setmodel

setmodel(entity, model)
=================
*/
function PF_setmodel() {

	const e = G_EDICT( OFS_PARM0 );
	const m = G_STRING( OFS_PARM1 );

	// check to see if model was properly precached
	let i = 0;
	if ( sv.model_precache ) {

		for ( i = 0; i < sv.model_precache.length; i ++ ) {

			if ( sv.model_precache[ i ] == null ) break;
			if ( sv.model_precache[ i ] === m ) break;

		}

		if ( i >= sv.model_precache.length || sv.model_precache[ i ] == null )
			PR_RunError( 'no precache: %s\n', m );

	}

	e.v.model = G_INT( OFS_PARM1 );
	e.v.modelindex = i;

	// Set mins/maxs from model if available
	if ( sv.models && sv.models[ i ] ) {

		const mod = sv.models[ i ];
		VectorCopy( mod.mins, e.v.mins );
		VectorCopy( mod.maxs, e.v.maxs );
		VectorSubtract( mod.maxs, mod.mins, e.v.size );

	} else {

		VectorCopy( vec3_origin, e.v.mins );
		VectorCopy( vec3_origin, e.v.maxs );
		VectorCopy( vec3_origin, e.v.size );

	}

	SV_LinkEdict( e, false );

}

/*
=================
PF_bprint

broadcast print to everyone on server

bprint(value)
=================
*/
function PF_bprint() {

	const s = PF_VarString( 0 );
	SV_BroadcastPrintf( '%s', s );

}

/*
=================
PF_sprint

single print to a specific client

sprint(clientent, value)
=================
*/
function PF_sprint() {

	const entnum = G_EDICTNUM( OFS_PARM0 );
	const s = PF_VarString( 1 );

	if ( entnum < 1 || entnum > ( svs.maxclients || 1 ) ) {

		Con_Printf( 'tried to sprint to a non-client\n' );
		return;

	}

	const client = svs.clients[ entnum - 1 ];
	if ( client ) {

		MSG_WriteByte( client.message, svc_print );
		MSG_WriteString( client.message, s );

	}

}

/*
=================
PF_centerprint

single print to a specific client

centerprint(clientent, value)
=================
*/
function PF_centerprint() {

	const entnum = G_EDICTNUM( OFS_PARM0 );
	const s = PF_VarString( 1 );

	if ( entnum < 1 || entnum > ( svs.maxclients || 1 ) ) {

		Con_Printf( 'tried to sprint to a non-client\n' );
		return;

	}

	const client = svs.clients[ entnum - 1 ];
	if ( client ) {

		MSG_WriteByte( client.message, svc_centerprint );
		MSG_WriteString( client.message, s );

	}

}

/*
=================
PF_normalize

vector normalize(vector)
=================
*/
function PF_normalize() {

	const value1 = G_VECTOR( OFS_PARM0 );

	let len = value1[ 0 ] * value1[ 0 ] + value1[ 1 ] * value1[ 1 ] + value1[ 2 ] * value1[ 2 ];
	len = Math.sqrt( len );

	const ret = G_VECTOR( OFS_RETURN );
	if ( len === 0 ) {

		ret[ 0 ] = ret[ 1 ] = ret[ 2 ] = 0;

	} else {

		len = 1 / len;
		ret[ 0 ] = value1[ 0 ] * len;
		ret[ 1 ] = value1[ 1 ] * len;
		ret[ 2 ] = value1[ 2 ] * len;

	}

}

/*
=================
PF_vlen

scalar vlen(vector)
=================
*/
function PF_vlen() {

	const value1 = G_VECTOR( OFS_PARM0 );

	let len = value1[ 0 ] * value1[ 0 ] + value1[ 1 ] * value1[ 1 ] + value1[ 2 ] * value1[ 2 ];
	len = Math.sqrt( len );

	G_FLOAT_SET( OFS_RETURN, len );

}

/*
=================
PF_vectoyaw

float vectoyaw(vector)
=================
*/
function PF_vectoyaw() {

	const value1 = G_VECTOR( OFS_PARM0 );
	let yaw;

	if ( value1[ 1 ] === 0 && value1[ 0 ] === 0 ) {

		yaw = 0;

	} else {

		yaw = ( Math.atan2( value1[ 1 ], value1[ 0 ] ) * 180 / M_PI ) | 0;
		if ( yaw < 0 )
			yaw += 360;

	}

	G_FLOAT_SET( OFS_RETURN, yaw );

}

/*
=================
PF_vectoangles

vector vectoangles(vector)
=================
*/
function PF_vectoangles() {

	const value1 = G_VECTOR( OFS_PARM0 );
	let yaw, pitch;

	if ( value1[ 1 ] === 0 && value1[ 0 ] === 0 ) {

		yaw = 0;
		if ( value1[ 2 ] > 0 )
			pitch = 90;
		else
			pitch = 270;

	} else {

		yaw = ( Math.atan2( value1[ 1 ], value1[ 0 ] ) * 180 / M_PI ) | 0;
		if ( yaw < 0 )
			yaw += 360;

		const forward = Math.sqrt( value1[ 0 ] * value1[ 0 ] + value1[ 1 ] * value1[ 1 ] );
		pitch = ( Math.atan2( value1[ 2 ], forward ) * 180 / M_PI ) | 0;
		if ( pitch < 0 )
			pitch += 360;

	}

	G_FLOAT_SET( OFS_RETURN, pitch );
	G_FLOAT_SET( OFS_RETURN + 1, yaw );
	G_FLOAT_SET( OFS_RETURN + 2, 0 );

}

/*
=================
PF_Random

Returns a number from 0<= num < 1

random()
=================
*/
function PF_random() {

	G_FLOAT_SET( OFS_RETURN, Math.random() );

}

/*
=================
PF_particle

particle(origin, color, count)
=================
*/
function PF_particle() {

	const org = G_VECTOR( OFS_PARM0 );
	const dir = G_VECTOR( OFS_PARM1 );
	const color = G_FLOAT( OFS_PARM2 );
	const count = G_FLOAT( OFS_PARM3 );
	SV_StartParticle( org, dir, color, count );

}

/*
=================
PF_ambientsound
=================
*/
function PF_ambientsound() {

	const pos = G_VECTOR( OFS_PARM0 );
	const samp = G_STRING( OFS_PARM1 );
	const vol = G_FLOAT( OFS_PARM2 );
	const attenuation = G_FLOAT( OFS_PARM3 );

	// find the sound in the precache list
	let soundnum;
	for ( soundnum = 0; soundnum < MAX_SOUNDS; soundnum ++ ) {

		if ( sv.sound_precache[ soundnum ] == null ) break;
		if ( samp === sv.sound_precache[ soundnum ] ) break;

	}

	if ( soundnum >= MAX_SOUNDS || sv.sound_precache[ soundnum ] == null ) {

		Con_Printf( 'no precache: %s\n', samp );
		return;

	}

	SV_ReserveSignonSpace( 17 ); // Ironwail's size, for svc_spawnstaticsound2

	// write it to the signon buffer
	MSG_WriteByte( sv.signon, svc_spawnstaticsound );
	for ( let i = 0; i < 3; i ++ )
		MSG_WriteCoord( sv.signon, pos[ i ] );

	MSG_WriteByte( sv.signon, soundnum );
	MSG_WriteByte( sv.signon, ( vol * 255 ) | 0 );
	MSG_WriteByte( sv.signon, ( attenuation * 64 ) | 0 );

}

/*
=================
PF_sound

Each entity can have eight independent sound sources, like voice,
weapon, feet, etc.
=================
*/
function PF_sound() {

	const entity = G_EDICT( OFS_PARM0 );
	const channel = G_FLOAT( OFS_PARM1 ) | 0;
	const sample = G_STRING( OFS_PARM2 );
	const volume = ( G_FLOAT( OFS_PARM3 ) * 255 ) | 0;
	const attenuation = G_FLOAT( OFS_PARM4 );

	// id has Sys_Error; Host_Error is Ironwail's (deliberate deviation), so a
	// bad QuakeC sound() call ends the map instead of killing the engine
	if ( volume < 0 || volume > 255 )
		PR_HostError( 'SV_StartSound: volume = ' + volume );

	if ( attenuation < 0 || attenuation > 4 )
		PR_HostError( 'SV_StartSound: attenuation = ' + attenuation.toFixed( 6 ) );

	if ( channel < 0 || channel > 7 )
		PR_HostError( 'SV_StartSound: channel = ' + channel );

	SV_StartSound( entity, channel, sample, volume, attenuation );

}

/*
=================
PF_break

break()
=================
*/
function PF_break() {

	Con_Printf( 'break statement\n' );
	// In C this dumps to debugger; in JS we just log
	// deno-lint-ignore no-debugger
	debugger;

}

/*
=================
PF_traceline

Used for use tracing and shot targeting

traceline (vector1, vector2, tryents, ignore)
=================
*/
function PF_traceline() {

	const v1 = G_VECTOR( OFS_PARM0 );
	const v2 = G_VECTOR( OFS_PARM1 );
	const nomonsters = G_FLOAT( OFS_PARM2 ) | 0;
	const ent = G_EDICT( OFS_PARM3 );

	// Deliberate deviation from id, taken from Ironwail/QuakeSpasm: some
	// progs.dat pass NaN vectors, which would poison the trace. Zero them in
	// place (G_VECTOR is a view on the globals), warning when developer is set.
	const v1nan = Number.isNaN( v1[ 0 ] ) || Number.isNaN( v1[ 1 ] ) || Number.isNaN( v1[ 2 ] );
	const v2nan = Number.isNaN( v2[ 0 ] ) || Number.isNaN( v2[ 1 ] ) || Number.isNaN( v2[ 2 ] );
	if ( v1nan || v2nan ) {

		Con_DPrintf( 'NAN in traceline:\nv1(' + v1[ 0 ].toFixed( 6 ) + ' ' + v1[ 1 ].toFixed( 6 ) + ' ' + v1[ 2 ].toFixed( 6 )
			+ ') v2(' + v2[ 0 ].toFixed( 6 ) + ' ' + v2[ 1 ].toFixed( 6 ) + ' ' + v2[ 2 ].toFixed( 6 )
			+ ')\nentity ' + NUM_FOR_EDICT( ent ) + '\n' );
		if ( v1nan )
			v1[ 0 ] = v1[ 1 ] = v1[ 2 ] = 0;
		if ( v2nan )
			v2[ 0 ] = v2[ 1 ] = v2[ 2 ] = 0;

	}

	const trace = SV_Move( v1, vec3_origin, vec3_origin, v2, nomonsters, ent );

	pr_global_struct.trace_allsolid = trace.allsolid ? 1 : 0;
	pr_global_struct.trace_startsolid = trace.startsolid ? 1 : 0;
	pr_global_struct.trace_fraction = trace.fraction;
	VectorCopy( trace.endpos, pr_global_struct.trace_endpos );
	VectorCopy( trace.plane.normal, pr_global_struct.trace_plane_normal );
	pr_global_struct.trace_plane_dist = trace.plane.dist;
	if ( trace.ent != null )
		pr_global_struct.trace_ent = EDICT_TO_PROG( trace.ent );
	else
		pr_global_struct.trace_ent = EDICT_TO_PROG( sv.edicts[ 0 ] );
	pr_global_struct.trace_inopen = trace.inopen ? 1 : 0;
	pr_global_struct.trace_inwater = trace.inwater ? 1 : 0;

}

/*
=================
PF_checkclient

Returns a client (or object that has a client enemy) that would be a
valid target.
=================
*/
let checkpvs = null;

// Scratch vectors for builtins (Golden Rule #4). None of these builtins runs
// QuakeC while its scratch is live, except PF_walkmove, whose SV_movestep
// calls touch functions only after its last use of move.
const newcheck_org = new Float32Array( 3 );
const checkclient_view = new Float32Array( 3 );
const findradius_eorg = new Float32Array( 3 );
const walkmove_move = new Float32Array( 3 );
const droptofloor_end = new Float32Array( 3 );
const aim_start = new Float32Array( 3 );
const aim_dir = new Float32Array( 3 );
const aim_end = new Float32Array( 3 );
const aim_bestdir = new Float32Array( 3 );

function PF_newcheckclient( check ) {

	// cycle to the next one
	if ( check < 1 )
		check = 1;
	if ( check > svs.maxclients )
		check = svs.maxclients;

	let i;
	if ( check === svs.maxclients )
		i = 1;
	else
		i = check + 1;

	let ent;
	for ( ; ; i ++ ) {

		if ( i === svs.maxclients + 1 )
			i = 1;

		ent = EDICT_NUM( i );

		if ( i === check )
			break; // didn't find anything else

		if ( ent.free )
			continue;
		if ( ent.v.health <= 0 )
			continue;
		if ( ( ent.v.flags | 0 ) & 128 ) // FL_NOTARGET
			continue;

		// anything that is a client, or has a client as an enemy
		break;

	}

	// get the PVS for the entity
	if ( sv.worldmodel ) {

		const org = newcheck_org;
		VectorAdd( ent.v.origin, ent.v.view_ofs, org );
		const leaf = Mod_PointInLeaf( org, sv.worldmodel );
		const pvs = Mod_LeafPVS( leaf, sv.worldmodel );
		const numBytes = ( sv.worldmodel.numleafs + 7 ) >> 3;
		if ( ! checkpvs || checkpvs.length < numBytes )
			checkpvs = new Uint8Array( numBytes );
		checkpvs.set( pvs.subarray( 0, numBytes ) );

	}

	return i;

}

function PF_checkclient() {

	// find a new check if on a new frame
	if ( sv.time - sv.lastchecktime >= 0.1 ) {

		sv.lastcheck = PF_newcheckclient( sv.lastcheck );
		sv.lastchecktime = sv.time;

	}

	// return check if it might be visible
	const ent = EDICT_NUM( sv.lastcheck );
	if ( ent.free || ent.v.health <= 0 ) {

		RETURN_EDICT( sv.edicts[ 0 ] );
		return;

	}

	// if current entity can't possibly see the check entity, return 0
	if ( sv.worldmodel && checkpvs ) {

		const self = PROG_TO_EDICT( pr_global_struct.self );
		const view = checkclient_view;
		VectorAdd( self.v.origin, self.v.view_ofs, view );
		const leaf = Mod_PointInLeaf( view, sv.worldmodel );
		// get leaf index: leaf._leafIndex is set during BSP load
		const l = ( leaf._leafIndex != null ? leaf._leafIndex : - 1 ) - 1;
		if ( l < 0 || ! ( checkpvs[ l >> 3 ] & ( 1 << ( l & 7 ) ) ) ) {

			RETURN_EDICT( sv.edicts[ 0 ] );
			return;

		}

	}

	// might be able to see it
	RETURN_EDICT( ent );

}

/*
=================
PF_stuffcmd

Sends text over to the client's execution buffer

stuffcmd (clientent, value)
=================
*/
function PF_stuffcmd() {

	const entnum = G_EDICTNUM( OFS_PARM0 );
	if ( entnum < 1 || entnum > ( svs.maxclients || 1 ) )
		PR_RunError( 'Parm 0 not a client' );

	const str = G_STRING( OFS_PARM1 );
	const client = svs.clients[ entnum - 1 ];
	if ( client ) {

		MSG_WriteByte( client.message, svc_stufftext );
		MSG_WriteString( client.message, str );

	}

}

/*
=================
PF_localcmd

Sends text to the server's command buffer

localcmd (string)
=================
*/
function PF_localcmd() {

	const str = G_STRING( OFS_PARM0 );
	Cbuf_AddText( str );

}

/*
=================
PF_cvar

float cvar (string)
=================
*/
function PF_cvar() {

	const str = G_STRING( OFS_PARM0 );
	G_FLOAT_SET( OFS_RETURN, Cvar_VariableValue( str ) );

}

/*
=================
PF_cvar_set

float cvar (string)
=================
*/
function PF_cvar_set() {

	const varName = G_STRING( OFS_PARM0 );
	const val = G_STRING( OFS_PARM1 );
	Cvar_Set( varName, val );

}

/*
=================
PF_findradius

Returns a chain of entities that have origins within a spherical area

findradius (origin, radius)
=================
*/
function PF_findradius() {

	let chain = sv.edicts[ 0 ];

	const org = G_VECTOR( OFS_PARM0 );
	const rad = G_FLOAT( OFS_PARM1 );

	const eorg = findradius_eorg;

	for ( let i = 1; i < sv.num_edicts; i ++ ) {

		const ent = EDICT_NUM( i );
		if ( ent.free )
			continue;
		if ( ent.v.solid === 0 ) // SOLID_NOT
			continue;
		for ( let j = 0; j < 3; j ++ )
			eorg[ j ] = org[ j ] - ( ent.v.origin[ j ] + ( ent.v.mins[ j ] + ent.v.maxs[ j ] ) * 0.5 );
		if ( Length( eorg ) > rad )
			continue;

		ent.v.chain = EDICT_TO_PROG( chain );
		chain = ent;

	}

	RETURN_EDICT( chain );

}

/*
=========
PF_dprint
=========
*/
function PF_dprint() {

	Con_DPrintf( '%s', PF_VarString( 0 ) );

}

// C printf "%5.1f": one decimal, right-aligned in a 5-character field
export function PF_Format5_1f( v ) {

	return v.toFixed( 1 ).padStart( 5, ' ' );

}

// ftos/vtos return a temp string in pr_strings space (PR_SetTempString)
function PF_ftos() {

	const v = G_FLOAT( OFS_PARM0 );
	let str;

	if ( v === ( v | 0 ) )
		str = String( v | 0 ); // %d
	else
		str = PF_Format5_1f( v ); // %5.1f

	// Write into the next pr_string_temp buffer (see PR_SetTempString)
	const ofs = PR_SetTempString( str );
	G_INT_SET( OFS_RETURN, ofs );

}

function PF_fabs() {

	const v = G_FLOAT( OFS_PARM0 );
	G_FLOAT_SET( OFS_RETURN, Math.abs( v ) );

}

function PF_vtos() {

	const v = G_VECTOR( OFS_PARM0 );
	// sprintf( pr_string_temp, "'%5.1f %5.1f %5.1f'", ... )
	const str = '\'' + PF_Format5_1f( v[ 0 ] ) + ' ' + PF_Format5_1f( v[ 1 ] ) + ' ' + PF_Format5_1f( v[ 2 ] ) + '\'';

	// Write into the next pr_string_temp buffer (see PR_SetTempString)
	const ofs = PR_SetTempString( str );
	G_INT_SET( OFS_RETURN, ofs );

}

function PF_Spawn() {

	const ed = ED_Alloc();
	RETURN_EDICT( ed );

}

function PF_Remove() {

	const ed = G_EDICT( OFS_PARM0 );
	ED_Free( ed );

}

// entity (entity start, .string field, string match) find = #5;
function PF_Find() {

	let e = G_EDICTNUM( OFS_PARM0 );
	const f = G_INT( OFS_PARM1 );
	const s = G_STRING( OFS_PARM2 );

	// C tests char pointers here, which are never NULL: an empty string is a
	// valid search that matches entities whose field is empty or unset.
	if ( s == null )
		PR_RunError( 'PF_Find: bad search string' );

	for ( e ++; e < sv.num_edicts; e ++ ) {

		const ed = EDICT_NUM( e );
		if ( ed.free )
			continue;
		const t = E_STRING( ed, f );
		if ( t == null )
			continue;
		if ( t === s ) {

			RETURN_EDICT( ed );
			return;

		}

	}

	RETURN_EDICT( sv.edicts[ 0 ] );

}

function PR_CheckEmptyString( s ) {

	if ( s == null || s.length === 0 || s.charCodeAt( 0 ) <= 32 )
		PR_RunError( 'Bad string' );

}

function PF_precache_file() {

	// precache_file is only used to copy files with qcc, it does nothing
	G_INT_SET( OFS_RETURN, G_INT( OFS_PARM0 ) );

}

function PF_precache_sound() {

	const s = G_STRING( OFS_PARM0 );
	G_INT_SET( OFS_RETURN, G_INT( OFS_PARM0 ) );
	PR_CheckEmptyString( s );

	if ( sv.state !== ss_loading )
		PR_RunError( 'PF_Precache_*: Precache can only be done in spawn functions' );

	if ( sv.sound_precache ) {

		for ( let i = 0; i < MAX_SOUNDS; i ++ ) {

			if ( sv.sound_precache[ i ] == null ) {

				sv.sound_precache[ i ] = s;
				return;

			}

			if ( sv.sound_precache[ i ] === s )
				return;

		}

		PR_RunError( 'PF_precache_sound: overflow' );

	}

}

function PF_precache_model() {

	const s = G_STRING( OFS_PARM0 );
	G_INT_SET( OFS_RETURN, G_INT( OFS_PARM0 ) );
	PR_CheckEmptyString( s );

	if ( sv.state !== ss_loading )
		PR_RunError( 'PF_Precache_*: Precache can only be done in spawn functions' );

	if ( sv.model_precache ) {

		for ( let i = 0; i < MAX_MODELS; i ++ ) {

			if ( sv.model_precache[ i ] == null ) {

				sv.model_precache[ i ] = s;
				sv.models[ i ] = Mod_ForName( s, true );
				return;

			}

			if ( sv.model_precache[ i ] === s )
				return;

		}

		PR_RunError( 'PF_precache_model: overflow' );

	}

}

function PF_coredump() {

	ED_PrintEdicts();

}

function PF_traceon() {

	PR_SetTrace( true );

}

function PF_traceoff() {

	PR_SetTrace( false );

}

function PF_eprint() {

	ED_PrintNum( G_EDICTNUM( OFS_PARM0 ) );

}

/*
===============
PF_walkmove

float(float yaw, float dist) walkmove
===============
*/
function PF_walkmove() {

	const ent = PROG_TO_EDICT( pr_global_struct.self );
	const yaw = G_FLOAT( OFS_PARM0 );
	const dist = G_FLOAT( OFS_PARM1 );

	if ( ! ( ( ent.v.flags | 0 ) & ( FL_ONGROUND | FL_FLY | FL_SWIM ) ) ) {

		G_FLOAT_SET( OFS_RETURN, 0 );
		return;

	}

	const yawRad = yaw * M_PI / 180;
	const move = walkmove_move;
	move[ 0 ] = Math.cos( yawRad ) * dist;
	move[ 1 ] = Math.sin( yawRad ) * dist;
	move[ 2 ] = 0;

	// save program state, because SV_movestep may call other progs
	const oldf = pr_xfunction;
	const oldself = pr_global_struct.self;

	G_FLOAT_SET( OFS_RETURN, SV_movestep( ent, move, true ) ? 1 : 0 );

	// restore program state
	PR_SetXFunction( oldf );
	pr_global_struct.self = oldself;

}

/*
===============
PF_droptofloor

void() droptofloor
===============
*/
function PF_droptofloor() {

	const ent = PROG_TO_EDICT( pr_global_struct.self );

	const end = droptofloor_end;
	VectorCopy( ent.v.origin, end );
	end[ 2 ] -= 256;

	const trace = SV_Move( ent.v.origin, ent.v.mins, ent.v.maxs, end, false, ent );

	if ( trace.fraction === 1 || trace.allsolid ) {

		G_FLOAT_SET( OFS_RETURN, 0 );

	} else {

		VectorCopy( trace.endpos, ent.v.origin );
		SV_LinkEdict( ent, false );
		ent.v.flags = ( ent.v.flags | 0 ) | FL_ONGROUND;
		ent.v.groundentity = EDICT_TO_PROG( trace.ent );
		G_FLOAT_SET( OFS_RETURN, 1 );

	}

}

/*
===============
PF_lightstyle

void(float style, string value) lightstyle
===============
*/
function PF_lightstyle() {

	const style = G_FLOAT( OFS_PARM0 ) | 0;
	const val = G_STRING( OFS_PARM1 );

	// Deliberate deviation from id, taken from Ironwail/QuakeSpasm: bounds
	// check the style, which id used unchecked to index sv.lightstyles and
	// sent to clients (whose CL_ParseServerMessage Sys_Errors on >= 64)
	if ( style < 0 || style >= MAX_LIGHTSTYLES ) {

		Con_DPrintf( 'PF_lightstyle: invalid style ' + style + '\n' );
		return;

	}

	// change the string in sv
	if ( sv.lightstyles ) {

		sv.lightstyles[ style ] = val;

	}

	// send message to all clients on this server
	if ( sv.state !== ss_active )
		return;

	for ( let j = 0; j < svs.maxclients; j ++ ) {

		const client = svs.clients[ j ];
		if ( ! client ) continue;
		if ( client.active || client.spawned ) {

			MSG_WriteChar( client.message, svc_lightstyle );
			MSG_WriteChar( client.message, style );
			MSG_WriteString( client.message, val );

		}

	}

}

function PF_rint() {

	const f = G_FLOAT( OFS_PARM0 );
	if ( f > 0 )
		G_FLOAT_SET( OFS_RETURN, ( f + 0.5 ) | 0 );
	else
		G_FLOAT_SET( OFS_RETURN, ( f - 0.5 ) | 0 );

}

function PF_floor() {

	G_FLOAT_SET( OFS_RETURN, Math.floor( G_FLOAT( OFS_PARM0 ) ) );

}

function PF_ceil() {

	G_FLOAT_SET( OFS_RETURN, Math.ceil( G_FLOAT( OFS_PARM0 ) ) );

}

/*
=============
PF_checkbottom
=============
*/
function PF_checkbottom() {

	const ent = G_EDICT( OFS_PARM0 );
	G_FLOAT_SET( OFS_RETURN, SV_CheckBottom( ent ) ? 1 : 0 );

}

/*
=============
PF_pointcontents
=============
*/
function PF_pointcontents() {

	const v = G_VECTOR( OFS_PARM0 );
	G_FLOAT_SET( OFS_RETURN, SV_PointContents( v ) );

}

/*
=============
PF_nextent

entity nextent(entity)
=============
*/
function PF_nextent() {

	let i = G_EDICTNUM( OFS_PARM0 );

	while ( true ) {

		i ++;
		if ( i === sv.num_edicts ) {

			RETURN_EDICT( sv.edicts[ 0 ] );
			return;

		}

		const ent = EDICT_NUM( i );
		if ( ! ent.free ) {

			RETURN_EDICT( ent );
			return;

		}

	}

}

/*
=============
PF_aim

Pick a vector for the player to shoot along
vector aim(entity, missilespeed)
=============
*/
const DAMAGE_AIM = 2;

function PF_aim() {

	const ent = G_EDICT( OFS_PARM0 );
	const teamplayValue = teamplay.value;
	// speed = G_FLOAT( OFS_PARM1 ); // not used in original C

	const start = aim_start;
	const dir = aim_dir;
	const end = aim_end;
	const bestdir = aim_bestdir;

	VectorCopy( ent.v.origin, start );
	start[ 2 ] += 20;

	// try sending a trace straight
	VectorCopy( pr_global_struct.v_forward, dir );
	VectorMA( start, 2048, dir, end );
	const tr = SV_Move( start, vec3_origin, vec3_origin, end, false, ent );
	if ( tr.ent && tr.ent.v.takedamage === DAMAGE_AIM
		&& ( teamplayValue === 0 || ent.v.team <= 0 || ent.v.team !== tr.ent.v.team ) ) {

		const ret = G_VECTOR( OFS_RETURN );
		VectorCopy( pr_global_struct.v_forward, ret );
		return;

	}

	// try all possible entities
	VectorCopy( dir, bestdir );
	let bestdist = sv_aim.value;
	let bestent = null;

	for ( let i = 1; i < sv.num_edicts; i ++ ) {

		const check = EDICT_NUM( i );
		if ( check.v.takedamage !== DAMAGE_AIM )
			continue;
		if ( check === ent )
			continue;
		if ( teamplayValue !== 0 && ent.v.team > 0 && ent.v.team === check.v.team )
			continue; // don't aim at teammate

		for ( let j = 0; j < 3; j ++ )
			end[ j ] = check.v.origin[ j ] + 0.5 * ( check.v.mins[ j ] + check.v.maxs[ j ] );
		VectorSubtract( end, start, dir );
		VectorNormalize( dir );
		const dist = DotProduct( dir, pr_global_struct.v_forward );
		if ( dist < bestdist )
			continue; // too far to turn
		const tr2 = SV_Move( start, vec3_origin, vec3_origin, end, false, ent );
		if ( tr2.ent === check ) {

			// can shoot at this one
			bestdist = dist;
			bestent = check;

		}

	}

	const ret = G_VECTOR( OFS_RETURN );
	if ( bestent != null ) {

		VectorSubtract( bestent.v.origin, ent.v.origin, dir );
		const dist = DotProduct( dir, pr_global_struct.v_forward );
		VectorScale( pr_global_struct.v_forward, dist, end );
		end[ 2 ] = dir[ 2 ];
		VectorNormalize( end );
		VectorCopy( end, ret );

	} else {

		VectorCopy( bestdir, ret );

	}

}

/*
==============
PF_changeyaw

This was a major timewaster in progs, so it was converted to C
==============
*/
function PF_changeyaw() {

	const ent = PROG_TO_EDICT( pr_global_struct.self );
	const current = anglemod( ent.v.angles[ 1 ] );
	const ideal = ent.v.ideal_yaw;
	const speed = ent.v.yaw_speed;

	if ( current === ideal )
		return;

	let move = ideal - current;
	if ( ideal > current ) {

		if ( move >= 180 )
			move = move - 360;

	} else {

		if ( move <= - 180 )
			move = move + 360;

	}

	if ( move > 0 ) {

		if ( move > speed )
			move = speed;

	} else {

		if ( move < - speed )
			move = - speed;

	}

	ent.v.angles[ 1 ] = anglemod( current + move );

}

//===============================================================================
// MESSAGE WRITING
//===============================================================================

const MSG_BROADCAST = 0; // unreliable to all
const MSG_ONE = 1; // reliable to one (msg_entity)
const MSG_ALL = 2; // reliable to all
const MSG_INIT = 3; // write to the init string

function WriteDest() {

	const dest = G_FLOAT( OFS_PARM0 ) | 0;

	switch ( dest ) {

		case MSG_BROADCAST:
			return sv.datagram;
		case MSG_ONE: {

			const ent = PROG_TO_EDICT( pr_global_struct.msg_entity );
			const entnum = NUM_FOR_EDICT( ent );
			if ( entnum < 1 || entnum > ( svs.maxclients || 1 ) ) {

				PR_RunError( 'WriteDest: not a client' );
				return null;

			}

			const client = svs.clients[ entnum - 1 ];
			return client.message;

		}

		case MSG_ALL:
			return sv.reliable_datagram;
		case MSG_INIT:
			return sv.signon;
		default:
			PR_RunError( 'WriteDest: bad destination' );
			return null;

	}

}

function PF_WriteByte() {

	const dest = WriteDest();
	if ( dest ) MSG_WriteByte( dest, G_FLOAT( OFS_PARM1 ) | 0 );

}

function PF_WriteChar() {

	const dest = WriteDest();
	if ( dest ) MSG_WriteChar( dest, G_FLOAT( OFS_PARM1 ) | 0 );

}

function PF_WriteShort() {

	const dest = WriteDest();
	if ( dest ) MSG_WriteShort( dest, G_FLOAT( OFS_PARM1 ) | 0 );

}

function PF_WriteLong() {

	const dest = WriteDest();
	if ( dest ) MSG_WriteLong( dest, G_FLOAT( OFS_PARM1 ) | 0 );

}

function PF_WriteCoord() {

	const dest = WriteDest();
	if ( dest ) MSG_WriteCoord( dest, G_FLOAT( OFS_PARM1 ) );

}

function PF_WriteAngle() {

	const dest = WriteDest();
	if ( dest ) MSG_WriteAngle( dest, G_FLOAT( OFS_PARM1 ) );

}

function PF_WriteString() {

	const dest = WriteDest();
	if ( dest ) MSG_WriteString( dest, G_STRING( OFS_PARM1 ) );

}

function PF_WriteEntity() {

	const dest = WriteDest();
	if ( dest ) MSG_WriteShort( dest, NUM_FOR_EDICT( G_EDICT( OFS_PARM1 ) ) );

}

//=============================================================================

function PF_makestatic() {

	const ent = G_EDICT( OFS_PARM0 );

	SV_ReserveSignonSpace( 34 ); // Ironwail's size, for its largest svc_spawnstatic2

	MSG_WriteByte( sv.signon, svc_spawnstatic );
	MSG_WriteByte( sv.signon, ent.v.modelindex | 0 );
	MSG_WriteByte( sv.signon, ent.v.frame | 0 );
	MSG_WriteByte( sv.signon, ent.v.colormap | 0 );
	MSG_WriteByte( sv.signon, ent.v.skin | 0 );
	for ( let i = 0; i < 3; i ++ ) {

		MSG_WriteCoord( sv.signon, ent.v.origin[ i ] );
		MSG_WriteAngle( sv.signon, ent.v.angles[ i ] );

	}

	// throw the entity away now
	ED_Free( ent );

}

/*
==============
PF_setspawnparms
==============
*/
function PF_setspawnparms() {

	const ent = G_EDICT( OFS_PARM0 );
	const i = NUM_FOR_EDICT( ent );
	if ( i < 1 || i > svs.maxclients )
		PR_RunError( 'Entity is not a client' );

	// copy spawn parms out of the client_t
	const client = svs.clients[ i - 1 ];
	for ( let j = 0; j < 16; j ++ ) // NUM_SPAWN_PARMS = 16

		pr_global_struct[ 'parm' + ( j + 1 ) ] = client.spawn_parms[ j ];

}

/*
==============
PF_changelevel
==============
*/
function PF_changelevel() {

	// make sure we don't issue two changelevels
	if ( svs.changelevel_issued )
		return;
	svs.changelevel_issued = true;

	const s = G_STRING( OFS_PARM0 );
	Cbuf_AddText( 'changelevel ' + s + '\n' );

}

/*
=================
SV_MoveToGoal
=================
*/
function SV_MoveToGoal() {

	SV_MoveToGoal_Real();

}

/*
===============================================================================

EXTENSION BUILT-INS

Not in id's Quake. Ported from Ironwail's pr_cmds.c, with its builtin
numbers, so that mods written for QuakeSpasm-family engines (Arcane
Dimensions and others) load. Before these, any call past #78 ended the map
with "Bad builtin call number".

===============================================================================
*/

// Ironwail's Con_Warning and Con_DWarning
function PF_Warning( msg ) {

	Con_Printf( '%s', 'Warning: ' + msg );

}

function PF_DWarning( msg ) {

	Con_DPrintf( '%s', 'Warning: ' + msg );

}

// C's atof: like parseFloat, but 0 where nothing parses
function PF_atof( s ) {

	const f = parseFloat( s );
	return Number.isNaN( f ) ? 0 : f;

}

// 2021 re-release: float() finaleFinished = #79
function PF_finalefinished() {

	G_FLOAT_SET( OFS_RETURN, 0 );

}

/*
=================
PF_localsound

Ported from Ironwail's pr_cmds.c (2021 re-release builtin): plays a sound
that only the given client hears.

localsound(clientent, sample)
=================
*/
function PF_localsound() {

	const entnum = G_EDICTNUM( OFS_PARM0 );
	const sample = G_STRING( OFS_PARM1 );

	if ( entnum < 1 || entnum > svs.maxclients ) {

		Con_Printf( 'tried to localsound to a non-client\n' );
		return;

	}

	SV_LocalSound( svs.clients[ entnum - 1 ], sample );

}

/*
=================
PF_checkextension

float(string extname) checkextension = #99

Deviation from Ironwail, which answers true for FTE_QC_CHECKCOMMAND (and
implements checkcommand, #294) so that older Arcane Dimensions builds take
their FTE code path. Neither is ported, so every extension is reported as
missing and mods fall back to their plain-Quake paths.
=================
*/
function PF_checkextension() {

	G_FLOAT_SET( OFS_RETURN, 0 );

}

// maths stuff
function PF_Sin() {

	G_FLOAT_SET( OFS_RETURN, Math.sin( G_FLOAT( OFS_PARM0 ) ) );

}

function PF_Cos() {

	G_FLOAT_SET( OFS_RETURN, Math.cos( G_FLOAT( OFS_PARM0 ) ) );

}

function PF_Sqrt() {

	G_FLOAT_SET( OFS_RETURN, Math.sqrt( G_FLOAT( OFS_PARM0 ) ) );

}

function PF_pow() {

	G_FLOAT_SET( OFS_RETURN, Math.pow( G_FLOAT( OFS_PARM0 ), G_FLOAT( OFS_PARM1 ) ) );

}

function PF_mod() {

	const a = G_FLOAT( OFS_PARM0 );
	const n = G_FLOAT( OFS_PARM1 );

	if ( n === 0 ) {

		PF_DWarning( 'PF_mod: mod by zero\n' );
		G_FLOAT_SET( OFS_RETURN, 0 );

	} else {

		// because QC is inherantly floaty, lets use floats.
		// C: a - ( n * (int)( a / n ) ), all in single precision
		const q = Q_FloatToInt( Math.fround( a / n ) );
		G_FLOAT_SET( OFS_RETURN, Math.fround( a - Math.fround( n * q ) ) );

	}

}

function PF_min() {

	let r = G_FLOAT( OFS_PARM0 );
	for ( let i = 1; i < pr_argc; i ++ ) {

		if ( r > G_FLOAT( OFS_PARM0 + i * 3 ) )
			r = G_FLOAT( OFS_PARM0 + i * 3 );

	}

	G_FLOAT_SET( OFS_RETURN, r );

}

function PF_max() {

	let r = G_FLOAT( OFS_PARM0 );
	for ( let i = 1; i < pr_argc; i ++ ) {

		if ( r < G_FLOAT( OFS_PARM0 + i * 3 ) )
			r = G_FLOAT( OFS_PARM0 + i * 3 );

	}

	G_FLOAT_SET( OFS_RETURN, r );

}

function PF_bound() {

	const minval = G_FLOAT( OFS_PARM0 );
	let curval = G_FLOAT( OFS_PARM1 );
	const maxval = G_FLOAT( OFS_PARM2 );
	if ( curval > maxval )
		curval = maxval;
	if ( curval < minval )
		curval = minval;
	G_FLOAT_SET( OFS_RETURN, curval );

}

// string stuff
function PF_strlen() {

	// FIXME: doesn't try to handle utf-8
	G_FLOAT_SET( OFS_RETURN, G_STRING( OFS_PARM0 ).length );

}

function PF_strcat() {

	let out = '';
	for ( let i = 0; i < pr_argc; i ++ ) {

		out += G_STRING( OFS_PARM0 + i * 3 );
		if ( out.length >= STRINGTEMP_LENGTH ) {

			PF_Warning( 'PF_strcat: overflow (string truncated)\n' );
			break;

		}

	}

	// PR_SetTempString cuts it to STRINGTEMP_LENGTH - 1, as q_strlcat does
	G_INT_SET( OFS_RETURN, PR_SetTempString( out ) );

}

function PF_substring() {

	const s = G_STRING( OFS_PARM0 );
	let start = Q_FloatToInt( G_FLOAT( OFS_PARM1 ) );
	let length = Q_FloatToInt( G_FLOAT( OFS_PARM2 ) );

	let slen = s.length; // utf-8 should use chars, not bytes.

	if ( start < 0 )
		start = slen + start;
	if ( length < 0 )
		length = slen - start + ( length + 1 );
	if ( start < 0 ) {

		// length += start;
		start = 0;

	}

	if ( start >= slen || length <= 0 ) {

		G_INT_SET( OFS_RETURN, PR_SetTempString( '' ) );
		return;

	}

	slen -= start;
	if ( length > slen )
		length = slen;

	if ( length >= STRINGTEMP_LENGTH ) {

		length = STRINGTEMP_LENGTH - 1;
		PF_Warning( 'PF_substring: truncation\n' );

	}

	G_INT_SET( OFS_RETURN, PR_SetTempString( s.substr( start, length ) ) );

}

/*
=================
PF_strzone

Copies its arguments, joined, into a string that lasts until strunzone
(see PR_ZoneString)
=================
*/
function PF_strzone() {

	let s = '';
	for ( let i = 0; i < pr_argc; i ++ )
		s += G_STRING( OFS_PARM0 + i * 3 );

	G_INT_SET( OFS_RETURN, PR_ZoneString( s ) );

}

function PF_strunzone() {

	const ofs = G_INT( OFS_PARM0 );
	if ( ofs === 0 )
		return; // don't bug out if they gave a null string

	if ( ! PR_UnzoneString( ofs ) )
		PF_Warning( 'PF_strunzone: string wasn\'t strzoned\n' );

}

// string tokenizing (gah)
const MAXQCTOKENS = 64;
const qctoken = [];

function PF_ArgC() {

	G_FLOAT_SET( OFS_RETURN, qctoken.length );

}

function tokenizeqc( str ) {

	qctoken.length = 0;
	let pos = 0;
	while ( qctoken.length < MAXQCTOKENS ) {

		// skip whitespace here so the token's start is accurate
		while ( pos < str.length && str.charCodeAt( pos ) <= 32 )
			pos ++;

		if ( pos >= str.length )
			break;

		const rest = COM_Parse( str.slice( pos ) );
		if ( rest === null )
			break;

		qctoken.push( com_token );
		pos = str.length - rest.length;

	}

	return qctoken.length;

}

// KRIMZON_SV_PARSECLIENTCOMMAND added these two - note that for
// compatibility with DP, this tokenize builtin is veeery vauge and doesn't
// match the console
function PF_Tokenize() {

	G_FLOAT_SET( OFS_RETURN, tokenizeqc( G_STRING( OFS_PARM0 ) ) );

}

function PF_ArgV() {

	let idx = Q_FloatToInt( G_FLOAT( OFS_PARM0 ) );

	// negative indexes are relative to the end
	if ( idx < 0 )
		idx += qctoken.length;

	if ( idx < 0 || idx >= qctoken.length )
		G_INT_SET( OFS_RETURN, 0 );
	else
		G_INT_SET( OFS_RETURN, PR_SetTempString( qctoken[ idx ] ) );

}

function PF_sprintf() {

	const out = PF_sprintf_internal( G_STRING( OFS_PARM0 ), 1, STRINGTEMP_LENGTH );
	G_INT_SET( OFS_RETURN, PR_SetTempString( out ) );

}

// conversions (mostly string)
function PF_stof() {

	G_FLOAT_SET( OFS_RETURN, PF_atof( G_STRING( OFS_PARM0 ) ) );

}

function PF_stov() {

	let s = G_STRING( OFS_PARM0 );
	const v = G_VECTOR( OFS_RETURN );
	for ( let i = 0; i < 3; i ++ ) {

		s = COM_Parse( s );
		v[ i ] = PF_atof( com_token );

	}

}

function PF_etos() {

	// yes, this is lame
	G_INT_SET( OFS_RETURN, PR_SetTempString( 'entity ' + G_EDICTNUM( OFS_PARM0 ) ) );

}

function PF_ftoi() {

	G_INT_SET( OFS_RETURN, Q_FloatToInt( G_FLOAT( OFS_PARM0 ) ) );

}

function PF_itof() {

	G_FLOAT_SET( OFS_RETURN, G_INT( OFS_PARM0 ) );

}

function PF_Fixme() {

	PR_RunError( 'unimplemented builtin' );

}

//============================================================================
// Builtin dispatch table
// This matches the C pr_builtin[] array exactly
//============================================================================

const pr_builtin = [
	PF_Fixme,			// #0
	PF_makevectors,		// void(entity e) makevectors = #1;
	PF_setorigin,		// void(entity e, vector o) setorigin = #2;
	PF_setmodel,		// void(entity e, string m) setmodel = #3;
	PF_setsize,			// void(entity e, vector min, vector max) setsize = #4;
	PF_Fixme,			// void(entity e, vector min, vector max) setabssize = #5;
	PF_break,			// void() break = #6;
	PF_random,			// float() random = #7;
	PF_sound,			// void(entity e, float chan, string samp) sound = #8;
	PF_normalize,		// vector(vector v) normalize = #9;
	PF_error,			// void(string e) error = #10;
	PF_objerror,		// void(string e) objerror = #11;
	PF_vlen,			// float(vector v) vlen = #12;
	PF_vectoyaw,		// float(vector v) vectoyaw = #13;
	PF_Spawn,			// entity() spawn = #14;
	PF_Remove,			// void(entity e) remove = #15;
	PF_traceline,		// float(vector v1, vector v2, float tryents) traceline = #16;
	PF_checkclient,		// entity() clientlist = #17;
	PF_Find,			// entity(entity start, .string fld, string match) find = #18;
	PF_precache_sound,	// void(string s) precache_sound = #19;
	PF_precache_model,	// void(string s) precache_model = #20;
	PF_stuffcmd,		// void(entity client, string s) stuffcmd = #21;
	PF_findradius,		// entity(vector org, float rad) findradius = #22;
	PF_bprint,			// void(string s) bprint = #23;
	PF_sprint,			// void(entity client, string s) sprint = #24;
	PF_dprint,			// void(string s) dprint = #25;
	PF_ftos,			// void(string s) ftos = #26;
	PF_vtos,			// void(string s) vtos = #27;
	PF_coredump,		// #28
	PF_traceon,			// #29
	PF_traceoff,		// #30
	PF_eprint,			// void(entity e) debug print an entire entity = #31
	PF_walkmove,		// float(float yaw, float dist) walkmove = #32
	PF_Fixme,			// #33
	PF_droptofloor,		// #34
	PF_lightstyle,		// #35
	PF_rint,			// #36
	PF_floor,			// #37
	PF_ceil,			// #38
	PF_Fixme,			// #39
	PF_checkbottom,		// #40
	PF_pointcontents,	// #41
	PF_Fixme,			// #42
	PF_fabs,			// #43
	PF_aim,				// #44
	PF_cvar,			// #45
	PF_localcmd,		// #46
	PF_nextent,			// #47
	PF_particle,		// #48
	PF_changeyaw,		// #49
	PF_Fixme,			// #50
	PF_vectoangles,		// #51

	PF_WriteByte,		// #52
	PF_WriteChar,		// #53
	PF_WriteShort,		// #54
	PF_WriteLong,		// #55
	PF_WriteCoord,		// #56
	PF_WriteAngle,		// #57
	PF_WriteString,		// #58
	PF_WriteEntity,		// #59

	PF_Fixme,			// #60 (Quake2: sin; set from pr_extbuiltins)
	PF_Fixme,			// #61 (Quake2: cos; set from pr_extbuiltins)
	PF_Fixme,			// #62 (Quake2: sqrt; set from pr_extbuiltins)
	PF_Fixme,			// #63 (Quake2: changepitch)
	PF_Fixme,			// #64 (Quake2: TraceToss)
	PF_Fixme,			// #65 (Quake2: etos; set from pr_extbuiltins)
	PF_Fixme,			// #66 (Quake2: WaterMove)

	SV_MoveToGoal,		// #67
	PF_precache_file,	// #68
	PF_makestatic,		// #69

	PF_changelevel,		// #70
	PF_Fixme,			// #71

	PF_cvar_set,		// #72
	PF_centerprint,		// #73

	PF_ambientsound,	// #74

	PF_precache_model,	// #75 precache_model2
	PF_precache_sound,	// #76 precache_sound2 is different only for qcc
	PF_precache_file,	// #77

	PF_setspawnparms,	// #78
];

// Names of id's builtins, for the name remap in PR_InitProgsBuiltins
// (Ironwail's pr_builtindefs). Index is the builtin number.
const pr_builtin_names = [
	null, 'makevectors', 'setorigin', 'setmodel', 'setsize', null, 'break', 'random',
	'sound', 'normalize', 'error', 'objerror', 'vlen', 'vectoyaw', 'spawn', 'remove',
	'traceline', 'checkclient', 'find', 'precache_sound', 'precache_model', 'stuffcmd',
	'findradius', 'bprint', 'sprint', 'dprint', 'ftos', 'vtos', 'coredump', 'traceon',
	'traceoff', 'eprint', 'walkmove', null, 'droptofloor', 'lightstyle', 'rint', 'floor',
	'ceil', null, 'checkbottom', 'pointcontents', null, 'fabs', 'aim', 'cvar', 'localcmd',
	'nextent', 'particle', 'ChangeYaw', null, 'vectoangles', 'WriteByte', 'WriteChar',
	'WriteShort', 'WriteLong', 'WriteCoord', 'WriteAngle', 'WriteString', 'WriteEntity',
	null, null, null, null, null, null, null, 'movetogoal', 'precache_file', 'makestatic',
	'changelevel', null, 'cvar_set', 'centerprint', 'ambientsound', 'precache_model2',
	'precache_sound2', 'precache_file2', 'setspawnparms',
];

// Extension builtins: Ironwail's pr_builtindefs past id's #1-#78, in its
// order and with its numbers. Number 0 means Ironwail gives it none: QuakeC
// declares it "= #0" and PR_InitProgsBuiltins binds it by name to a slot
// counting down from the top of the table, in this order. Unported ones stay
// PF_Fixme, so calling them is "unimplemented builtin", as in Ironwail.
const pr_extbuiltins = [
	[ 'sin', PF_Sin, 60 ],					// float(float angle)
	[ 'cos', PF_Cos, 61 ],					// float(float angle)
	[ 'sqrt', PF_Sqrt, 62 ],				// float(float value)
	[ 'etos', PF_etos, 65 ],				// string(entity ent)
	[ 'finaleFinished', PF_finalefinished, 79 ],	// float() (2021 re-release)
	[ 'localsound', PF_localsound, 80 ],	// void(entity client, string sample) (2021 re-release)
	[ 'stof', PF_stof, 81 ],				// float(string)
	[ 'ex_centerprint', PF_centerprint, 0 ],	// void(entity client, string s, ...)
	[ 'ex_bprint', PF_bprint, 0 ],			// void(string s, ...)
	[ 'ex_sprint', PF_sprint, 0 ],			// void(entity client, string s, ...)
	[ 'ex_finalefinished', PF_finalefinished, 0 ],	// float()
	[ 'ex_CheckPlayerEXFlags', PF_Fixme, 0 ],	// not ported
	[ 'ex_walkpathtogoal', PF_Fixme, 0 ],	// not ported
	[ 'ex_localsound', PF_localsound, 0 ],	// void(entity client, string sample)
	[ 'min', PF_min, 94 ],					// float(float a, float b, ...)
	[ 'max', PF_max, 95 ],					// float(float a, float b, ...)
	[ 'bound', PF_bound, 96 ],				// float(float minimum, float val, float maximum)
	[ 'pow', PF_pow, 97 ],					// float(float value, float exp)
	[ 'checkextension', PF_checkextension, 99 ],	// float(string extname)
	[ 'strlen', PF_strlen, 114 ],			// float(string s)
	[ 'strcat', PF_strcat, 115 ],			// string(string s1, ...)
	[ 'substring', PF_substring, 116 ],		// string(string s, float start, float length)
	[ 'stov', PF_stov, 117 ],				// vector(string s)
	[ 'strzone', PF_strzone, 118 ],			// string(string s, ...)
	[ 'strunzone', PF_strunzone, 119 ],		// void(string s)
	[ 'str2chr', PF_Fixme, 222 ],			// not ported
	[ 'chr2str', PF_Fixme, 223 ],			// not ported
	[ 'strconv', PF_Fixme, 224 ],			// not ported
	[ 'clientstat', PF_Fixme, 232 ],		// not ported
	[ 'mod', PF_mod, 245 ],					// float(float a, float n)
	[ 'ftoi', PF_ftoi, 0 ],					// int(float)
	[ 'itof', PF_itof, 0 ],					// float(int)
	[ 'checkcommand', PF_Fixme, 294 ],		// not ported
	// #316-#352 are CSQC-only in Ironwail: names bound, server slots PF_Fixme
	[ 'iscachedpic', PF_Fixme, 316 ],
	[ 'precache_pic', PF_Fixme, 317 ],
	[ 'drawgetimagesize', PF_Fixme, 318 ],
	[ 'drawcharacter', PF_Fixme, 320 ],
	[ 'drawrawstring', PF_Fixme, 321 ],
	[ 'drawpic', PF_Fixme, 322 ],
	[ 'drawfill', PF_Fixme, 323 ],
	[ 'drawsetcliparea', PF_Fixme, 324 ],
	[ 'drawresetcliparea', PF_Fixme, 325 ],
	[ 'drawstring', PF_Fixme, 326 ],
	[ 'stringwidth', PF_Fixme, 327 ],
	[ 'drawsubpic', PF_Fixme, 328 ],
	[ 'getstati', PF_Fixme, 330 ],
	[ 'getstatf', PF_Fixme, 331 ],
	[ 'getstats', PF_Fixme, 332 ],
	[ 'getplayerkeyvalue', PF_Fixme, 348 ],
	[ 'getplayerkeyfloat', PF_Fixme, 0 ],
	[ 'registercommand', PF_Fixme, 352 ],
	[ 'vectorvectors', PF_Fixme, 432 ],		// not ported
	[ 'clientcommand', PF_Fixme, 440 ],		// not ported
	[ 'tokenize', PF_Tokenize, 441 ],		// float(string s)
	[ 'argv', PF_ArgV, 442 ],				// string(float n)
	[ 'argc', PF_ArgC, 0 ],					// float()
	[ 'asin', PF_Fixme, 471 ],				// not ported
	[ 'acos', PF_Fixme, 472 ],				// not ported
	[ 'atan', PF_Fixme, 473 ],				// not ported
	[ 'atan2', PF_Fixme, 474 ],				// not ported
	[ 'tan', PF_Fixme, 475 ],				// not ported
	[ 'tokenize_console', PF_Fixme, 514 ],	// not ported
	[ 'sprintf', PF_sprintf, 627 ],			// string(string fmt, ...)
];

// Ironwail's MAX_BUILTINS. Every slot is filled (PF_Fixme where nothing is
// ported), so an unported extension number is "unimplemented builtin" when
// called, not "Bad builtin call number" when reached.
const MAX_BUILTINS = 1280;

// name -> builtin number, for every builtin (id's and the extensions)
const pr_builtin_numbers = new Map();

const pr_builtin_table = ( function () {

	const table = new Array( MAX_BUILTINS ).fill( PF_Fixme );
	for ( let i = 0; i < pr_builtin.length; i ++ ) {

		table[ i ] = pr_builtin[ i ];
		if ( pr_builtin_names[ i ] )
			pr_builtin_numbers.set( pr_builtin_names[ i ], i );

	}

	// as Ironwail, numberless builtins count down from MAX_BUILTINS - 2
	let next = MAX_BUILTINS - 2;
	for ( const [ name, func, number ] of pr_extbuiltins ) {

		const n = number !== 0 ? number : next --;
		table[ n ] = func;
		pr_builtin_numbers.set( name, n );

	}

	return table;

} )();

/*
===============
PR_InitProgsBuiltins

Called by PR_LoadProgs once the functions are parsed. Mirrors the second
half of Ironwail's PR_InitBuiltins: a function declared "= #0" (no
statements, parms or locals) is bound by name to the builtin with that name.
Also resets the string state the extension builtins keep per progs (zoned
strings live in the string table that PR_LoadProgs replaces).
===============
*/
export function PR_InitProgsBuiltins() {

	for ( let i = 0; i < pr_functions.length; i ++ ) {

		const func = pr_functions[ i ];
		if ( func.first_statement !== 0 || func.parm_start !== 0 || func.locals !== 0 )
			continue;

		const number = pr_builtin_numbers.get( PR_GetString( func.s_name ) );
		if ( number !== undefined )
			func.first_statement = - number;

	}

	PR_ClearZoneStrings();
	qctoken.length = 0;

}

/*
===============
PR_InitBuiltins

Registers the builtin function table. Called during PR_Init.
===============
*/
export function PR_InitBuiltins() {

	PR_SetBuiltins( pr_builtin_table, MAX_BUILTINS );

	// Wire up sv_move.js callbacks
	SV_Move_SetCallbacks( {
		PF_changeyaw: PF_changeyaw,
		G_FLOAT: G_FLOAT,
		G_FLOAT_SET: G_FLOAT_SET,
	} );

}
