// Ported from: WinQuake/sv_main.c -- server main program

import { Sys_Error } from './sys.js';
import {
	Con_Printf, Con_DPrintf, SZ_Clear, SZ_Write,
	MSG_WriteByte, MSG_WriteChar, MSG_WriteShort, MSG_WriteLong,
	MSG_WriteFloat, MSG_WriteString, MSG_WriteCoord, MSG_WriteAngle,
	MSG_WriteAngle16,
	standard_quake
} from './common.js';
import { Cmd_ExecuteString, Cbuf_InsertText } from './cmd.js';
import { cvar_t, Cvar_RegisterVariable, Cvar_Set, Cvar_SetValue } from './cvar.js';
import {
	MAX_MODELS, MAX_SOUNDS, MAX_DATAGRAM, MAX_EDICTS, MAX_MSGLEN,
	STAT_PING
} from './quakedef.js';
import {
	PROTOCOL_VERSION,
	GAME_COOP, GAME_DEATHMATCH,
	DEFAULT_SOUND_PACKET_VOLUME, DEFAULT_SOUND_PACKET_ATTENUATION,
	SND_VOLUME, SND_ATTENUATION,
	svc_print, svc_serverinfo, svc_cdtrack, svc_setview, svc_signonnum,
	svc_time, svc_particle, svc_sound, svc_clientdata, svc_updatestat, svc_updatefrags,
	svc_stufftext, svc_nop, svc_spawnbaseline, svc_disconnect,
	svc_updatename, svc_updatecolors,
	SU_VIEWHEIGHT, SU_IDEALPITCH, SU_PUNCH1, SU_VELOCITY1,
	SU_ITEMS, SU_ONGROUND, SU_INWATER, SU_WEAPONFRAME, SU_ARMOR, SU_WEAPON,
	DEFAULT_VIEWHEIGHT, svc_damage, svc_setangle,
	svc_playerinfo, PF_MSEC, PF_COMMAND, PF_VELOCITY1,
	PF_MODEL, PF_SKINNUM, PF_EFFECTS, PF_WEAPONFRAME, PF_DEAD, PF_GIB, PF_FLY, PF_NOCLIP, PF_TELEPORT,
	CM_ANGLE1, CM_ANGLE2, CM_ANGLE3, CM_FORWARD, CM_SIDE, CM_UP, CM_BUTTONS, CM_IMPULSE,
	svc_packetentities, svc_deltapacketentities, svc_serversequence,
	PE_ENT_MASK, PE_ORIGIN1, PE_ORIGIN2, PE_ORIGIN3,
	PE_ANGLE2, PE_REMOVE, PE_MOREBITS,
	PE_FRAME, PE_ANGLE1, PE_ANGLE3, PE_MODEL, PE_COLORMAP, PE_SKIN, PE_EFFECTS, PE_SOLID,
	PS_BSP, PS_BOX, PS_NOLERP,
	MAX_PACKET_ENTITIES, PE_UPDATE_BACKUP, PE_UPDATE_MASK
} from './protocol.js';
import {
	sv, svs, ss_loading, ss_active,
	client_t, NUM_PING_TIMES,
	host_client, set_host_client,
	MOVETYPE_PUSH, MOVETYPE_STEP, MOVETYPE_FLY, MOVETYPE_NOCLIP,
	SOLID_BSP, SOLID_BBOX, SOLID_SLIDEBOX,
	FL_ONGROUND,
	EF_MUZZLEFLASH,
	NUM_SPAWN_PARMS,
	deathmatch, coop, skill
} from './server.js';
import { hostname } from './net_main.js';
import {
	NET_CheckNewConnections, NET_SendMessage, NET_SendUnreliableMessage,
	NET_CanSendMessage, NET_CanSendUnreliableMessage, NET_SendToAll, NET_Close, NET_GetMessage
} from './net_main.js';
import { net_activeconnections, set_net_activeconnections } from './net.js';
import { realtime, Host_ClearMemory, Host_Error, set_host_frametime } from './host.js';
import { COM_LoadFile } from './pak.js';
import { VectorCopy, VectorAdd, DotProduct } from './mathlib.js';
import { Mod_ForName, Mod_LeafPVS } from './gl_model.js';
import { PR_LoadProgs, PR_AllocEdicts, ED_ClearEdict, ED_LoadFromFile, ED_NewString, GetEdictFieldValue, PR_SetCurrentSkill, PR_SetDeathmatch, nomonsters } from './pr_edict.js';
import { MAX_ENT_LEAFS, pr_global_struct, progs, pr_crc, EDICT_NUM, NUM_FOR_EDICT, PR_SetSV, PR_SetSVS, EDICT_TO_PROG, PROG_TO_EDICT, NEXT_EDICT, PR_GetString } from './progs.js';
import { SV_ClearWorld, SV_Move, SV_TestEntityPosition, SV_LinkEdict, SV_PointContents } from './world.js';
import { SV_Physics, SV_SetState, SV_SetCallbacks,
	sv_maxvelocity, sv_gravity, sv_nostep, sv_friction, sv_edgefriction,
	sv_stopspeed, sv_maxspeed, sv_accelerate, sv_idealpitchscale } from './sv_phys.js';
import { PR_ExecuteProgram, PR_SetHostError } from './pr_exec.js';
import { SV_User_SetCallbacks, SV_SetIdealPitch } from './sv_user.js';
import { V_CalcRoll } from './view.js';
import { key_dest } from './keys.js';

//============================================================================
// Module-level state
//============================================================================

const localmodels = new Array( MAX_MODELS );
for ( let i = 0; i < MAX_MODELS; i ++ )
	localmodels[ i ] = '*' + i;

// PVS culling state (from WinQuake/sv_main.c)
// The PVS must include a small area around the client to allow head bobbing
// or other small motion on the client side.
// C sizes fatpvs from a fixed MAX_MAP_LEAFS. Like Ironwail, the port sizes it
// from the world model's leaf count instead (SV_AllocFatPVS at map load), so
// a map with more leafs than any fixed limit still gets a full PVS.
const CONTENTS_SOLID = - 2;
let fatbytes = 0;
let fatpvs = new Uint8Array( 0 );

/*
=============
SV_AllocFatPVS

Not in C. Grows fatpvs to hold the PVS of the given world model; it never
shrinks, so it allocates only when a map has more leafs than any before it.
=============
*/
export function SV_AllocFatPVS( worldmodel ) {

	const bytes = ( worldmodel.numleafs + 31 ) >> 3;
	if ( bytes > fatpvs.length )
		fatpvs = new Uint8Array( bytes );

}

// sv_aim is only used in sv_main.js (not a physics cvar shared with sv_phys/sv_user)
export const sv_aim = new cvar_t( 'sv_aim', '0.93' );

export let current_skill = 0;

/*
===============
SV_Init
===============
*/
export function SV_Init() {

	PR_SetHostError( Host_Error );
	Cvar_RegisterVariable( sv_maxvelocity );
	Cvar_RegisterVariable( sv_gravity );
	Cvar_RegisterVariable( sv_friction );
	Cvar_RegisterVariable( sv_edgefriction );
	Cvar_RegisterVariable( sv_stopspeed );
	Cvar_RegisterVariable( sv_maxspeed );
	Cvar_RegisterVariable( sv_accelerate );
	Cvar_RegisterVariable( sv_idealpitchscale );
	Cvar_RegisterVariable( sv_aim );
	Cvar_RegisterVariable( sv_nostep );
	PR_SetDeathmatch( deathmatch );

	for ( let i = 0; i < MAX_MODELS; i ++ )
		localmodels[ i ] = '*' + i;

	// Wire up sv_user.js callbacks
	SV_User_SetCallbacks( {
		V_CalcRoll,
		SV_DropClient,
		NET_GetMessage,
		Cbuf_InsertText,
		Cmd_ExecuteString,
		set_host_client,
		get_key_dest: () => key_dest,
	} );

}

/*
=============================================================================

EVENT MESSAGES

=============================================================================
*/

/*
==================
SV_StartParticle

Make sure the event gets sent to all clients
==================
*/
export function SV_StartParticle( org, dir, color, count ) {

	if ( sv.datagram.cursize > MAX_DATAGRAM - 16 )
		return;
	MSG_WriteByte( sv.datagram, svc_particle );
	MSG_WriteCoord( sv.datagram, org[ 0 ] );
	MSG_WriteCoord( sv.datagram, org[ 1 ] );
	MSG_WriteCoord( sv.datagram, org[ 2 ] );
	for ( let i = 0; i < 3; i ++ ) {

		let v = ( dir[ i ] * 16 ) | 0;
		if ( v > 127 )
			v = 127;
		else if ( v < - 128 )
			v = - 128;
		MSG_WriteChar( sv.datagram, v );

	}

	MSG_WriteByte( sv.datagram, count );
	MSG_WriteByte( sv.datagram, color );

}

/*
==================
SV_StartSound

Each entity can have eight independant sound sources, like voice,
weapon, feet, etc.

Channel 0 is an auto-allocate channel, the others override anything
allready running on that entity/channel pair.

An attenuation of 0 will play full volume everywhere in the level.
Larger attenuations will drop off. (max 4 attenuation)
==================
*/
export function SV_StartSound( entity, channel, sample, volume, attenuation ) {

	// C calls Sys_Error for these. Like Ironwail, Host_Error: a bad QuakeC
	// sound() call ends the map, not the program.

	if ( volume < 0 || volume > 255 )
		Host_Error( 'SV_StartSound: volume = ' + volume );

	if ( attenuation < 0 || attenuation > 4 )
		Host_Error( 'SV_StartSound: attenuation = ' + attenuation );

	if ( channel < 0 || channel > 7 )
		Host_Error( 'SV_StartSound: channel = ' + channel );

	if ( sv.datagram.cursize > MAX_DATAGRAM - 16 )
		return;

	// find precache number for sound
	let sound_num;
	for ( sound_num = 1; sound_num < MAX_SOUNDS && sv.sound_precache[ sound_num ]; sound_num ++ ) {

		if ( sample === sv.sound_precache[ sound_num ] )
			break;

	}

	if ( sound_num === MAX_SOUNDS || sv.sound_precache[ sound_num ] == null ) {

		Con_Printf( 'SV_StartSound: ' + sample + ' not precacheed\n' );
		return;

	}

	// NUM_FOR_EDICT -- entity index in edicts array
	const ent = NUM_FOR_EDICT( entity );

	channel = ( ent << 3 ) | channel;

	let field_mask = 0;
	if ( volume !== DEFAULT_SOUND_PACKET_VOLUME )
		field_mask |= SND_VOLUME;
	if ( attenuation !== DEFAULT_SOUND_PACKET_ATTENUATION )
		field_mask |= SND_ATTENUATION;

	// directed messages go only to the entity they are targeted on
	MSG_WriteByte( sv.datagram, svc_sound );
	MSG_WriteByte( sv.datagram, field_mask );
	if ( field_mask & SND_VOLUME )
		MSG_WriteByte( sv.datagram, volume );
	if ( field_mask & SND_ATTENUATION )
		MSG_WriteByte( sv.datagram, ( attenuation * 64 ) | 0 );
	MSG_WriteShort( sv.datagram, channel );
	MSG_WriteByte( sv.datagram, sound_num );
	for ( let i = 0; i < 3; i ++ )
		MSG_WriteCoord( sv.datagram, entity.v.origin[ i ] + 0.5 * ( entity.v.mins[ i ] + entity.v.maxs[ i ] ) );

}

/*
==============================================================================

CLIENT SPAWNING

==============================================================================
*/

/*
================
SV_SendServerinfo

Sends the first message from the server to a connected client.
This will be sent on the initial connection and upon each server load.
================
*/
export function SV_SendServerinfo( client ) {

	MSG_WriteByte( client.message, svc_print );
	const message = '\x02\nVERSION 1.09 SERVER (' + pr_crc + ' CRC)';
	MSG_WriteString( client.message, message );

	MSG_WriteByte( client.message, svc_serverinfo );
	MSG_WriteLong( client.message, PROTOCOL_VERSION );
	MSG_WriteByte( client.message, svs.maxclients );

	if ( ! coop.value && deathmatch.value )
		MSG_WriteByte( client.message, GAME_DEATHMATCH );
	else
		MSG_WriteByte( client.message, GAME_COOP );

	// world message
	const worldEdict = sv.edicts[ 0 ];
	MSG_WriteString( client.message, worldEdict && worldEdict.v ? PR_GetString( worldEdict.v.message ) : '' );

	// model precache list
	for ( let i = 1; i < MAX_MODELS && sv.model_precache[ i ]; i ++ )
		MSG_WriteString( client.message, sv.model_precache[ i ] );
	MSG_WriteByte( client.message, 0 );

	// sound precache list
	for ( let i = 1; i < MAX_SOUNDS && sv.sound_precache[ i ]; i ++ )
		MSG_WriteString( client.message, sv.sound_precache[ i ] );
	MSG_WriteByte( client.message, 0 );

	// send music
	MSG_WriteByte( client.message, svc_cdtrack );
	MSG_WriteByte( client.message, sv.edicts[ 0 ].v.sounds );
	MSG_WriteByte( client.message, sv.edicts[ 0 ].v.sounds );

	// set view
	MSG_WriteByte( client.message, svc_setview );
	const clientnum = svs.clients.indexOf( client );
	MSG_WriteShort( client.message, clientnum + 1 );

	// send movevars for client-side prediction (matches QW sv_user.c:98-108)
	SV_WriteMovevars( client.message );

	MSG_WriteByte( client.message, svc_signonnum );
	MSG_WriteByte( client.message, 1 );

	client.sendsignon = true;
	client.spawned = false; // need prespawn, spawn, etc

}

/*
================
SV_WriteMovevars

Writes the _movevars stufftext that feeds client-side prediction. Not in
NetQuake: it carries the values QuakeWorld sends in svc_serverdata, then
edgefriction and sv_maxvelocity for pmove.js's NetQuake-physics mode.
================
*/
export function SV_WriteMovevars( msg ) {

	MSG_WriteByte( msg, svc_stufftext );
	MSG_WriteString( msg, '_movevars'
		+ ' ' + sv_gravity.value
		+ ' ' + sv_stopspeed.value
		+ ' ' + sv_maxspeed.value
		+ ' ' + 500 // spectatormaxspeed (no cvar in NQ)
		+ ' ' + sv_accelerate.value
		+ ' ' + 0.7 // airaccelerate (no cvar in NQ)
		+ ' ' + 10 // wateraccelerate (no cvar in NQ)
		+ ' ' + sv_friction.value
		+ ' ' + 1 // waterfriction (no cvar in NQ)
		+ ' ' + 1.0 // entgravity
		+ ' ' + sv_edgefriction.value
		+ ' ' + sv_maxvelocity.value
		+ '\n' );

}

// Movevar cvar values last sent to all clients
const _movevars_sent = new Float64Array( 7 );

function SV_SnapshotMovevars() {

	_movevars_sent[ 0 ] = sv_gravity.value;
	_movevars_sent[ 1 ] = sv_stopspeed.value;
	_movevars_sent[ 2 ] = sv_maxspeed.value;
	_movevars_sent[ 3 ] = sv_accelerate.value;
	_movevars_sent[ 4 ] = sv_friction.value;
	_movevars_sent[ 5 ] = sv_edgefriction.value;
	_movevars_sent[ 6 ] = sv_maxvelocity.value;

}

/*
================
SV_CheckMovevars

Re-sends _movevars on the reliable stream when one of the cvars it carries
changes mid-game, so prediction keeps using the server's values.
================
*/
export function SV_CheckMovevars() {

	if ( _movevars_sent[ 0 ] === sv_gravity.value
		&& _movevars_sent[ 1 ] === sv_stopspeed.value
		&& _movevars_sent[ 2 ] === sv_maxspeed.value
		&& _movevars_sent[ 3 ] === sv_accelerate.value
		&& _movevars_sent[ 4 ] === sv_friction.value
		&& _movevars_sent[ 5 ] === sv_edgefriction.value
		&& _movevars_sent[ 6 ] === sv_maxvelocity.value )
		return;

	SV_SnapshotMovevars();
	SV_WriteMovevars( sv.reliable_datagram );

}

/*
================
SV_ConnectClient

Initializes a client_t for a new net connection. This will only be called
once for a player each game, not once for each level change.
================
*/
export function SV_ConnectClient( clientnum ) {

	const client = svs.clients[ clientnum ];

	Con_DPrintf( 'Client ' + client.netconnection.address + ' connected\n' );

	const edictnum = clientnum + 1;

	// set up the client_t
	const netconnection = client.netconnection;

	// save spawn parms if loading a game
	const savedSpawnParms = new Float32Array( NUM_SPAWN_PARMS );
	if ( sv.loadgame ) {

		for ( let i = 0; i < NUM_SPAWN_PARMS; i ++ )
			savedSpawnParms[ i ] = client.spawn_parms[ i ];

	}

	// clear the client
	Object.assign( client, new client_t() );
	client.netconnection = netconnection;

	client.name = 'unconnected';
	client.active = true;
	client.spawned = false;
	client.edict = EDICT_NUM( edictnum );
	client.message.data = client.msgbuf;
	client.message.maxsize = MAX_MSGLEN;
	client.message.allowoverflow = true; // we can catch it

	client.privileged = false;

	if ( sv.loadgame ) {

		for ( let i = 0; i < NUM_SPAWN_PARMS; i ++ )
			client.spawn_parms[ i ] = savedSpawnParms[ i ];

	} else {

		// call the progs to get default spawn parms for the new client
		PR_ExecuteProgram( pr_global_struct.SetNewParms );
		for ( let i = 0; i < NUM_SPAWN_PARMS; i ++ )
			client.spawn_parms[ i ] = pr_global_struct[ 'parm' + ( i + 1 ) ];

	}

	SV_SendServerinfo( client );

}

/*
===================
SV_CheckForNewClients
===================
*/
export function SV_CheckForNewClients() {

	while ( true ) {

		const ret = NET_CheckNewConnections();
		if ( ret == null )
			break;

		// init a new client structure
		let i;
		for ( i = 0; i < svs.maxclients; i ++ ) {

			if ( ! svs.clients[ i ].active )
				break;

		}

		if ( i === svs.maxclients )
			Sys_Error( 'Host_CheckForNewClients: no free clients' );

		svs.clients[ i ].netconnection = ret;
		SV_ConnectClient( i );

		set_net_activeconnections( net_activeconnections + 1 );

	}

}

/*
===============================================================================

FRAME UPDATES

===============================================================================
*/

/*
==================
SV_ClearDatagram
==================
*/
export function SV_ClearDatagram() {

	SZ_Clear( sv.datagram );
	sv.datagram.overflowed = false;

}

/*
=======================
SV_SendClientMessages
=======================
*/
export function SV_SendClientMessages() {

	// update frags, names, etc
	SV_UpdateToReliableMessages();

	// build individual updates
	for ( let i = 0; i < svs.maxclients; i ++ ) {

		const client = svs.clients[ i ];
		set_host_client( client );

		if ( ! client.active )
			continue;

		if ( client.spawned ) {

			if ( ! SV_SendClientDatagram( client ) )
				continue;

		} else {

			// the player isn't totally in the game yet
			// send small keepalive messages if too much time has passed
			// send a full message when the next signon stage has been requested
			if ( ! client.sendsignon ) {

				if ( realtime - client.last_message > 5 )
					SV_SendNop( client );
				continue;

			}

		}

		// check for an overflowed message
		if ( client.message.overflowed ) {

			SV_DropClient( true );
			client.message.overflowed = false;
			continue;

		}

		if ( client.message.cursize || client.dropasap ) {

			if ( ! NET_CanSendMessage( client.netconnection ) )
				continue;

			if ( client.dropasap ) {

				SV_DropClient( false ); // went to another level

			} else {

				if ( NET_SendMessage( client.netconnection, client.message ) === - 1 )
					SV_DropClient( true );
				SZ_Clear( client.message );
				client.last_message = realtime;
				client.sendsignon = false;

			}

		}

	}

	// clear muzzle flashes
	SV_CleanupEnts();

}

/*
=======================
SV_UpdateToReliableMessages
=======================
*/
function SV_UpdateToReliableMessages() {

	SV_CheckMovevars();

	// check for changes to be sent over the reliable streams
	for ( let i = 0; i < svs.maxclients; i ++ ) {

		const hclient = svs.clients[ i ];

		if ( hclient.edict && hclient.old_frags !== hclient.edict.v.frags ) {

			for ( let j = 0; j < svs.maxclients; j ++ ) {

				const client = svs.clients[ j ];
				if ( ! client.active )
					continue;
				MSG_WriteByte( client.message, svc_updatefrags );
				MSG_WriteByte( client.message, i );
				MSG_WriteShort( client.message, hclient.edict.v.frags );

			}

			hclient.old_frags = hclient.edict.v.frags;

		}

	}

	for ( let j = 0; j < svs.maxclients; j ++ ) {

		const client = svs.clients[ j ];
		if ( ! client.active )
			continue;
		SZ_Write( client.message, sv.reliable_datagram.data, sv.reliable_datagram.cursize );

	}

	SZ_Clear( sv.reliable_datagram );
	sv.reliable_datagram.overflowed = false;

}

/*
=============================================================================

The PVS must include a small area around the client to allow head bobbing
or other small motion on the client side. Otherwise, a bob might cause an
entity that should be visible to not show up, especially when the bob
crosses a waterline.

=============================================================================
*/

/*
=============
SV_AddToFatPVS

Recursively accumulates PVS bits from leafs within 8 units of the point.
=============
*/
function SV_AddToFatPVS( org, node ) {

	while ( true ) {

		// if this is a leaf, accumulate the pvs bits
		if ( node.contents < 0 ) {

			if ( node.contents !== CONTENTS_SOLID ) {

				const pvs = Mod_LeafPVS( node, sv.worldmodel );
				for ( let i = 0; i < fatbytes; i ++ )
					fatpvs[ i ] |= pvs[ i ];

			}

			return;

		}

		const plane = node.plane;
		const d = DotProduct( org, plane.normal ) - plane.dist;

		if ( d > 8 )
			node = node.children[ 0 ];
		else if ( d < - 8 )
			node = node.children[ 1 ];
		else {

			// go down both sides
			SV_AddToFatPVS( org, node.children[ 0 ] );
			node = node.children[ 1 ];

		}

	}

}

/*
=============
SV_FatPVS

Calculates a PVS that is the inclusive or of all leafs within 8 pixels of the
given point.
=============
*/
export function SV_FatPVS( org ) {

	SV_AllocFatPVS( sv.worldmodel ); // no-op unless the map is new and bigger
	fatbytes = ( sv.worldmodel.numleafs + 31 ) >> 3;
	fatpvs.fill( 0, 0, fatbytes );
	SV_AddToFatPVS( org, sv.worldmodel.nodes[ 0 ] );
	return fatpvs;

}

/*
==================
SV_WriteDelta

Writes part of a packetentities message.
Can delta from either a baseline or a previous packet_entity.
Ported from: QW/server/sv_ents.c
==================
*/
function SV_WriteDelta( from, to, msg, force ) {

	// send an update
	let bits = 0;

	for ( let i = 0; i < 3; i ++ ) {

		const miss = to.origin[ i ] - from.origin[ i ];
		if ( miss < - 0.1 || miss > 0.1 )
			bits |= PE_ORIGIN1 << i;

	}

	if ( to.angles[ 0 ] !== from.angles[ 0 ] )
		bits |= PE_ANGLE1;

	if ( to.angles[ 1 ] !== from.angles[ 1 ] )
		bits |= PE_ANGLE2;

	if ( to.angles[ 2 ] !== from.angles[ 2 ] )
		bits |= PE_ANGLE3;

	if ( to.colormap !== from.colormap )
		bits |= PE_COLORMAP;

	if ( to.skin !== from.skin )
		bits |= PE_SKIN;

	if ( to.frame !== from.frame )
		bits |= PE_FRAME;

	if ( to.effects !== from.effects )
		bits |= PE_EFFECTS;

	if ( to.modelindex !== from.modelindex )
		bits |= PE_MODEL;

	if ( to.solid !== from.solid || ( ( to.solid & PS_BOX ) && ! SV_SameBox( from, to ) ) )
		bits |= PE_SOLID;

	// Check if morebits byte is needed (any of the lower-byte flags set)
	if ( bits & 0xFF )
		bits |= PE_MOREBITS;

	//
	// write the message
	//
	if ( to.number === 0 )
		Sys_Error( 'SV_WriteDelta: unset entity number' );
	if ( to.number > PE_ENT_MASK )
		Sys_Error( 'SV_WriteDelta: entity number > ' + PE_ENT_MASK );

	if ( bits === 0 && ! force )
		return; // nothing to send!

	const i = to.number | ( bits & ~PE_ENT_MASK );
	if ( i & PE_REMOVE )
		Sys_Error( 'SV_WriteDelta: PE_REMOVE' );
	MSG_WriteShort( msg, i );

	if ( bits & PE_MOREBITS )
		MSG_WriteByte( msg, bits & 0xFF );
	if ( bits & PE_MODEL )
		MSG_WriteByte( msg, to.modelindex );
	if ( bits & PE_FRAME )
		MSG_WriteByte( msg, to.frame );
	if ( bits & PE_COLORMAP )
		MSG_WriteByte( msg, to.colormap );
	if ( bits & PE_SKIN )
		MSG_WriteByte( msg, to.skin );
	if ( bits & PE_EFFECTS )
		MSG_WriteByte( msg, to.effects );
	if ( bits & PE_ORIGIN1 )
		MSG_WriteCoord( msg, to.origin[ 0 ] );
	if ( bits & PE_ANGLE1 )
		MSG_WriteAngle( msg, to.angles[ 0 ] );
	if ( bits & PE_ORIGIN2 )
		MSG_WriteCoord( msg, to.origin[ 1 ] );
	if ( bits & PE_ANGLE2 )
		MSG_WriteAngle( msg, to.angles[ 1 ] );
	if ( bits & PE_ORIGIN3 )
		MSG_WriteCoord( msg, to.origin[ 2 ] );
	if ( bits & PE_ANGLE3 )
		MSG_WriteAngle( msg, to.angles[ 2 ] );
	if ( bits & PE_SOLID ) {

		MSG_WriteByte( msg, to.solid );
		if ( to.solid & PS_BOX ) {

			for ( let i = 0; i < 3; i ++ )
				MSG_WriteCoord( msg, to.mins[ i ] );
			for ( let i = 0; i < 3; i ++ )
				MSG_WriteCoord( msg, to.maxs[ i ] );

		}

	}

}

function SV_SameBox( a, b ) {

	return a.mins[ 0 ] === b.mins[ 0 ] && a.mins[ 1 ] === b.mins[ 1 ] && a.mins[ 2 ] === b.mins[ 2 ]
		&& a.maxs[ 0 ] === b.maxs[ 0 ] && a.maxs[ 1 ] === b.maxs[ 1 ] && a.maxs[ 2 ] === b.maxs[ 2 ];

}

/*
=============
SV_SetStateSolid

Fills in the PS_* byte and box that client-side prediction collides with.
Not in QuakeWorld, whose CL_SetSolidEntities guesses from the model (QW
never sets U_SOLID). Uses v.solid, never the model: corpses keep their
model but are SOLID_NOT. Mirrors the filters SV_ClipToLinks applies when
clent moves, so the player doesn't collide with their own missiles or
with point-sized entities (nails, rockets) in prediction either.

SOLID_BBOX and SOLID_SLIDEBOX entities get their v.mins/v.maxs as the box,
sent with the PS_* byte only when it changes: the client has no other way
to learn a monster's size, and setsize boxes don't follow from the model
(misc_explobox is 0..32 x 0..64, Chthon is 256 wide and 280 tall).
=============
*/
export function SV_SetStateSolid( state, ent, clent ) {

	let solid = 0;
	const s = ent.v.solid;
	const clprog = EDICT_TO_PROG( clent );

	if ( ( s === SOLID_BSP || s === SOLID_BBOX || s === SOLID_SLIDEBOX )
		&& ent.v.size[ 0 ] !== 0 // points never interact
		&& ent.v.owner !== clprog // don't clip against own missiles
		&& ! ( clent.v.owner !== 0 && clent.v.owner === EDICT_TO_PROG( ent ) ) ) // or owner
		solid = s === SOLID_BSP ? PS_BSP : PS_BOX;

	if ( solid === PS_BOX ) {

		for ( let i = 0; i < 3; i ++ ) {

			state.mins[ i ] = ent.v.mins[ i ];
			state.maxs[ i ] = ent.v.maxs[ i ];

		}

	} else {

		state.mins.fill( 0 );
		state.maxs.fill( 0 );

	}

	// sv_main.c SV_WriteEntitiesToClient: U_NOLERP, "don't mess up the
	// step animation"
	if ( ent.v.movetype === MOVETYPE_STEP )
		solid |= PS_NOLERP;

	state.solid = solid;

}

// Largest single entry SV_WriteDelta can write: short + morebits byte
// + model, frame, colormap, skin, effects + 3 coords + 3 angles
// + PE_SOLID byte and box (6 coords)
const MAX_PACKETENTITY_BYTES = 2 + 1 + 5 + 3 * 2 + 3 + 1 + 6 * 2;

// Largest svc_playerinfo SV_WritePlayersToClient can write: svc + num + flags
// + origin + frame + msec + usercmd (bits, 3 angle16, 3 moves, buttons,
// impulse) + velocity + model, skin, effects, weaponframe, teleport time
const MAX_PLAYERINFO_BYTES = 1 + 1 + 2 + 3 * 2 + 1 + 1 + ( 1 + 3 * 2 + 3 * 2 + 1 + 1 ) + 3 * 2 + 4 + 1;

// An empty packetentities: svc_deltapacketentities + sequence + terminator
const MIN_PACKETENTITIES_BYTES = 2 + 2;

/*
=============
SV_EmitPacketEntities

Writes a delta update of a packet_entities_t to the message.
Ported from: QW/server/sv_ents.c
=============
*/
export function SV_EmitPacketEntities( client, to, msg ) {

	let from;
	let oldmax;

	// QW SV_EmitPacketEntities: the frame to delta from must still be in the
	// client's backup. clc_delta carries the sequence as one byte, so compare
	// modulo 256 (as CL_ParsePacketEntities does); too old means a full update.
	let useDelta = client.delta_sequence !== - 1;
	if ( useDelta ) {

		const age = ( ( client.outgoing_sequence & 255 ) - ( client.delta_sequence & 255 ) ) & 255;
		if ( age === 0 || age >= PE_UPDATE_BACKUP - 1 ) // 0: the frame being built
			useDelta = false;

	}

	// this is the frame that we are going to delta update from
	if ( useDelta ) {

		const fromframe = client.frames[ client.delta_sequence & PE_UPDATE_MASK ];
		from = fromframe.entities;
		oldmax = from.num_entities;

		MSG_WriteByte( msg, svc_deltapacketentities );
		MSG_WriteByte( msg, client.delta_sequence );

	} else {

		oldmax = 0; // no delta update
		from = null;

		MSG_WriteByte( msg, svc_packetentities );

	}

	// Entities numbered below `cursor` are deferred this frame: the client keeps
	// its copy of them and new ones are left out. A frame that overflows sets
	// the cursor to the first entity it could not send, so the next frame
	// starts there instead of re-sending the low numbers first. A sweep needs
	// ceil(entities / capacity) frames at worst, then the cursor returns to 0.
	const cursor = useDelta ? client.pe_cursor | 0 : 0; // a full update has nothing to defer to
	const newcount = to.num_entities;

	let newindex = 0; // read position in `to`
	let outindex = 0; // write position in `to`: deferred new entities leave gaps
	let oldindex = 0;

	// The last point at which the packet could end: the client would rebuild
	// at most MAX_PACKET_ENTITIES entities from it (see the overflow case below)
	let safesize = msg.cursize;
	let safeout = 0;
	let safeold = 0;
	let safenum = cursor; // an overflow before the first entry keeps the sweep where it was
	let overflow = false;

	while ( newindex < newcount || oldindex < oldmax ) {

		// sv_main.c SV_WriteEntitiesToClient stops with "packet overflow" when
		// the next entity might not fit. Keep 2 bytes for the terminator.
		if ( msg.maxsize - msg.cursize < MAX_PACKETENTITY_BYTES + 2 ) {

			overflow = true;
			break;

		}

		const newnum = newindex >= newcount ? 9999 : to.entities[ newindex ].number;
		const oldnum = oldindex >= oldmax ? 9999 : from.entities[ oldindex ].number;

		if ( newnum === oldnum ) {

			if ( newnum < cursor ) {

				// deferred: the client keeps what it has
				to.state( outindex ++ ).copyFrom( from.entities[ oldindex ] );

			} else {

				// delta update from old position
				SV_WriteDelta( from.entities[ oldindex ], to.entities[ newindex ], msg, false );
				if ( outindex !== newindex )
					to.state( outindex ).copyFrom( to.entities[ newindex ] );
				outindex ++;

			}

			oldindex ++;
			newindex ++;

		} else if ( newnum < oldnum ) {

			// this is a new entity, send it from the baseline
			if ( newnum >= cursor ) {

				const ent = EDICT_NUM( newnum );
				SV_WriteDelta( ent.baseline, to.entities[ newindex ], msg, true );
				if ( outindex !== newindex )
					to.state( outindex ).copyFrom( to.entities[ newindex ] );
				outindex ++;

			}

			newindex ++;

		} else {

			// the old entity isn't present in the new message
			MSG_WriteShort( msg, oldnum | PE_REMOVE );
			oldindex ++;

		}

		if ( outindex + oldmax - oldindex <= MAX_PACKET_ENTITIES ) {

			safesize = msg.cursize;
			safeout = outindex;
			safeold = oldindex;
			safenum = Math.min( newindex >= newcount ? 9999 : to.entities[ newindex ].number,
				oldindex >= oldmax ? 9999 : from.entities[ oldindex ].number );

		}

	}

	if ( overflow ) {

		Con_Printf( 'packet overflow\n' );

		// On the terminator the client keeps what it has read and copies the
		// rest of the old frame unchanged. Rewind to the last point where that
		// stays within MAX_PACKET_ENTITIES, and make this frame's snapshot match
		// what the client will hold, so later deltas from it stay in step. The
		// entities left out are sent on a later frame, starting at safenum.
		msg.cursize = safesize;
		let n = safeout;
		for ( let j = safeold; j < oldmax; j ++, n ++ )
			to.state( n ).copyFrom( from.entities[ j ] );
		to.num_entities = n;
		client.pe_cursor = safenum < 9999 ? safenum : 0;

	} else {

		to.num_entities = outindex;
		client.pe_cursor = 0;

	}

	MSG_WriteShort( msg, 0 ); // end of packetentities

}

/*
=============
SV_WriteEntitiesToClient

Encodes the current state of the world as a svc_packetentities message.
Ported from: QW/server/sv_ents.c
=============
*/
export function SV_WriteEntitiesToClient( client, clent, pvs, msg ) {

	// this is the frame we are creating
	const frame = client.frames[ client.outgoing_sequence & PE_UPDATE_MASK ];

	// put visible entities into the packet_entities snapshot
	const pack = frame.entities;
	pack.num_entities = 0;

	// skip player entities (handled by svc_playerinfo), start after maxclients
	for ( let e = svs.maxclients + 1; e < sv.num_edicts; e ++ ) {

		const ent = EDICT_NUM( e );

		// ignore ents without visible models
		if ( ent.v.modelindex === 0 || PR_GetString( ent.v.model ) === '' )
			continue;

		// PVS check - ignore if not touching a PV leaf
		let visible = false;
		for ( let i = 0; i < ent.num_leafs; i ++ ) {

			const leafnum = ent.leafnums[ i ];
			if ( pvs[ leafnum >> 3 ] & ( 1 << ( leafnum & 7 ) ) ) {

				visible = true;
				break;

			}

		}

		// C skips the entity here even when it touches MAX_ENT_LEAFS leafs,
		// where SV_FindTouchedLeafs stopped counting and the visible leaf may
		// be one it never recorded. Like Ironwail (ericw), always send those.
		if ( ! visible && ent.num_leafs < MAX_ENT_LEAFS )
			continue;

		// add to the packetentities
		if ( pack.num_entities >= MAX_PACKET_ENTITIES )
			continue; // all full

		const state = pack.state( pack.num_entities );
		pack.num_entities ++;

		state.number = e;
		state.flags = 0;
		SV_SetStateSolid( state, ent, clent );
		state.origin[ 0 ] = ent.v.origin[ 0 ];
		state.origin[ 1 ] = ent.v.origin[ 1 ];
		state.origin[ 2 ] = ent.v.origin[ 2 ];
		state.angles[ 0 ] = ent.v.angles[ 0 ];
		state.angles[ 1 ] = ent.v.angles[ 1 ];
		state.angles[ 2 ] = ent.v.angles[ 2 ];
		state.modelindex = ent.v.modelindex;
		state.frame = ent.v.frame;
		state.colormap = ent.v.colormap;
		state.skin = ent.v.skin;
		state.effects = ent.v.effects;

	}

	// encode the packet entities as a delta from the
	// last packetentities acknowledged by the client
	SV_EmitPacketEntities( client, pack, msg );

}

/*
==================
SV_WriteClientdataToMessage
==================
*/
export function SV_WriteClientdataToMessage( ent, msg ) {

	//
	// send a damage message
	//
	if ( ent.v.dmg_take || ent.v.dmg_save ) {

		const other = PROG_TO_EDICT( ent.v.dmg_inflictor );
		MSG_WriteByte( msg, svc_damage );
		MSG_WriteByte( msg, ent.v.dmg_save );
		MSG_WriteByte( msg, ent.v.dmg_take );
		for ( let i = 0; i < 3; i ++ )
			MSG_WriteCoord( msg, other.v.origin[ i ] + 0.5 * ( other.v.mins[ i ] + other.v.maxs[ i ] ) );

		ent.v.dmg_take = 0;
		ent.v.dmg_save = 0;

	}

	//
	// send the current viewpos offset from the view entity
	//
	SV_SetIdealPitch();

	// a fixangle might get lost in a dropped packet. Oh well.
	if ( ent.v.fixangle !== 0 ) {

		MSG_WriteByte( msg, svc_setangle );
		for ( let i = 0; i < 3; i ++ )
			MSG_WriteAngle( msg, ent.v.angles[ i ] );
		ent.v.fixangle = 0;

	}

	let bits = 0;

	if ( ent.v.view_ofs[ 2 ] !== DEFAULT_VIEWHEIGHT )
		bits |= SU_VIEWHEIGHT;

	if ( ent.v.idealpitch !== 0 )
		bits |= SU_IDEALPITCH;

	// stuff the sigil bits into the high bits of items for sbar, or else
	// mix in the optional mission-pack items2 field
	const items2 = GetEdictFieldValue( ent, 'items2' );
	let items;
	if ( items2 !== null ) {

		const value = items2.accessor.getFloat( items2.ofs ) | 0;
		items = ( ent.v.items | 0 ) | ( value << 23 );

	} else {

		const serverflags =
			( pr_global_struct !== null ? pr_global_struct.serverflags : 0 ) | 0;
		items = ( ent.v.items | 0 ) | ( serverflags << 28 );

	}

	bits |= SU_ITEMS;

	if ( ( ent.v.flags | 0 ) & FL_ONGROUND )
		bits |= SU_ONGROUND;

	if ( ent.v.waterlevel >= 2 )
		bits |= SU_INWATER;

	for ( let i = 0; i < 3; i ++ ) {

		if ( ent.v.punchangle[ i ] )
			bits |= ( SU_PUNCH1 << i );
		if ( ent.v.velocity[ i ] )
			bits |= ( SU_VELOCITY1 << i );

	}

	if ( ent.v.weaponframe )
		bits |= SU_WEAPONFRAME;

	if ( ent.v.armorvalue )
		bits |= SU_ARMOR;

	// always send weapon
	bits |= SU_WEAPON;

	// send the data
	MSG_WriteByte( msg, svc_clientdata );
	MSG_WriteShort( msg, bits );

	if ( bits & SU_VIEWHEIGHT )
		MSG_WriteChar( msg, ent.v.view_ofs[ 2 ] );

	if ( bits & SU_IDEALPITCH )
		MSG_WriteChar( msg, ent.v.idealpitch );

	for ( let i = 0; i < 3; i ++ ) {

		if ( bits & ( SU_PUNCH1 << i ) )
			MSG_WriteChar( msg, ent.v.punchangle[ i ] );
		if ( bits & ( SU_VELOCITY1 << i ) )
			MSG_WriteChar( msg, ent.v.velocity[ i ] / 16 );

	}

	// [always sent] if (bits & SU_ITEMS)
	MSG_WriteLong( msg, items );

	if ( bits & SU_WEAPONFRAME )
		MSG_WriteByte( msg, ent.v.weaponframe );
	if ( bits & SU_ARMOR )
		MSG_WriteByte( msg, ent.v.armorvalue );
	if ( bits & SU_WEAPON )
		MSG_WriteByte( msg, SV_ModelIndex( PR_GetString( ent.v.weaponmodel ) ) );

	MSG_WriteShort( msg, ent.v.health );
	MSG_WriteByte( msg, ent.v.currentammo );
	MSG_WriteByte( msg, ent.v.ammo_shells );
	MSG_WriteByte( msg, ent.v.ammo_nails );
	MSG_WriteByte( msg, ent.v.ammo_rockets );
	MSG_WriteByte( msg, ent.v.ammo_cells );

	if ( standard_quake ) {

		MSG_WriteByte( msg, ent.v.weapon );

	} else {

		// Mission pack (Rogue/Hipnotic): send weapon as bit index
		for ( let i = 0; i < 32; i ++ ) {

			if ( ( ent.v.weapon | 0 ) & ( 1 << i ) ) {

				MSG_WriteByte( msg, i );
				break;

			}

		}

	}

}

/*
==================
MSG_WriteDeltaUsercmd

QuakeWorld-style delta compression for usercmd_t
==================
*/
function MSG_WriteDeltaUsercmd( buf, from, cmd ) {

	let bits = 0;

	if ( cmd.angles[ 0 ] !== from.angles[ 0 ] )
		bits |= CM_ANGLE1;
	if ( cmd.angles[ 1 ] !== from.angles[ 1 ] )
		bits |= CM_ANGLE2;
	if ( cmd.angles[ 2 ] !== from.angles[ 2 ] )
		bits |= CM_ANGLE3;
	if ( cmd.forwardmove !== from.forwardmove )
		bits |= CM_FORWARD;
	if ( cmd.sidemove !== from.sidemove )
		bits |= CM_SIDE;
	if ( cmd.upmove !== from.upmove )
		bits |= CM_UP;
	if ( cmd.buttons !== from.buttons )
		bits |= CM_BUTTONS;
	if ( cmd.impulse !== from.impulse )
		bits |= CM_IMPULSE;

	MSG_WriteByte( buf, bits );

	if ( bits & CM_ANGLE1 )
		MSG_WriteAngle16( buf, cmd.angles[ 0 ] );
	if ( bits & CM_ANGLE2 )
		MSG_WriteAngle16( buf, cmd.angles[ 1 ] );
	if ( bits & CM_ANGLE3 )
		MSG_WriteAngle16( buf, cmd.angles[ 2 ] );
	if ( bits & CM_FORWARD )
		MSG_WriteShort( buf, cmd.forwardmove );
	if ( bits & CM_SIDE )
		MSG_WriteShort( buf, cmd.sidemove );
	if ( bits & CM_UP )
		MSG_WriteShort( buf, cmd.upmove );
	if ( bits & CM_BUTTONS )
		MSG_WriteByte( buf, cmd.buttons );
	if ( bits & CM_IMPULSE )
		MSG_WriteByte( buf, cmd.impulse );

}

// null command for delta compression baseline
const nullcmd = {
	msec: 0,
	angles: new Float32Array( 3 ),
	forwardmove: 0,
	sidemove: 0,
	upmove: 0,
	buttons: 0,
	impulse: 0
};

// Cached player command for SV_WritePlayersToClient (avoid per-frame allocations)
const _playerCmd = {
	msec: 0,
	angles: new Float32Array( 3 ),
	forwardmove: 0,
	sidemove: 0,
	upmove: 0,
	buttons: 0,
	impulse: 0
};

// Player model index for checking if model changed
let sv_playermodel = 0;

/*
==================
SV_WritePlayersToClient

QuakeWorld-style player info for client-side prediction
==================
*/
export function SV_WritePlayersToClient( _client, clent, pvs, msg ) {

	// Find player model index if not cached
	if ( sv_playermodel === 0 ) {

		sv_playermodel = SV_ModelIndex( 'progs/player.mdl' );

	}

	for ( let j = 0; j < svs.maxclients; j ++ ) {

		const cl = svs.clients[ j ];
		if ( cl.active === false || cl.spawned === false )
			continue;

		const ent = cl.edict;
		if ( ent == null || ent.v == null )
			continue;

		// Visibility check (skip for self and spectators)
		if ( ent !== clent ) {

			// Check PVS - skip if not visible
			let i;
			for ( i = 0; i < ent.num_leafs; i ++ ) {

				const leafnum = ent.leafnums[ i ];
				if ( pvs[ leafnum >> 3 ] & ( 1 << ( leafnum & 7 ) ) )
					break;

			}

			// Ironwail's MAX_ENT_LEAFS exception, as in SV_WriteEntitiesToClient
			if ( i === ent.num_leafs && ent.num_leafs < MAX_ENT_LEAFS )
				continue; // not visible

		}

		// leave room for this player and an empty packetentities after it;
		// C has no playerinfo, so this mirrors its per-entity overflow check
		if ( msg.maxsize - msg.cursize < MAX_PLAYERINFO_BYTES + MIN_PACKETENTITIES_BYTES ) {

			Con_Printf( 'packet overflow\n' );
			return;

		}

		let pflags = PF_MSEC | PF_COMMAND;

		if ( ent.v.modelindex !== sv_playermodel )
			pflags |= PF_MODEL;
		for ( let i = 0; i < 3; i ++ ) {

			if ( ent.v.velocity[ i ] !== 0 )
				pflags |= ( PF_VELOCITY1 << i );

		}

		if ( ent.v.effects !== 0 )
			pflags |= PF_EFFECTS;
		if ( ent.v.skin !== 0 )
			pflags |= PF_SKINNUM;
		if ( ent.v.health <= 0 )
			pflags |= PF_DEAD;
		if ( ent.v.mins[ 2 ] !== - 24 )
			pflags |= PF_GIB;

		// For self, don't send msec/command (already known), but send weaponframe
		if ( ent === clent ) {

			pflags &= ~( PF_MSEC | PF_COMMAND );
			if ( ent.v.weaponframe !== 0 )
				pflags |= PF_WEAPONFRAME;
			// for prediction (pmove.js PM_NQ_PlayerMove)
			if ( ent.v.movetype === MOVETYPE_NOCLIP )
				pflags |= PF_NOCLIP;
			else if ( ent.v.movetype === MOVETYPE_FLY )
				pflags |= PF_FLY;
			// SV_AirMove's back-move lock after a teleporter, and waterjump
			if ( ent.v.teleport_time > sv.time )
				pflags |= PF_TELEPORT;

		}

		MSG_WriteByte( msg, svc_playerinfo );
		MSG_WriteByte( msg, j );
		MSG_WriteShort( msg, pflags );

		for ( let i = 0; i < 3; i ++ )
			MSG_WriteCoord( msg, ent.v.origin[ i ] );

		MSG_WriteByte( msg, ent.v.frame );

		if ( pflags & PF_MSEC ) {

			let msec = ( 1000 * ( sv.time - ( cl.localtime || 0 ) ) ) | 0;
			if ( msec > 255 )
				msec = 255;
			if ( msec < 0 )
				msec = 0;
			MSG_WriteByte( msg, msec );

		}

		if ( pflags & PF_COMMAND ) {

			// Get the client's last command (reuse cached object)
			_playerCmd.msec = 0;
			_playerCmd.forwardmove = cl.lastcmd != null ? cl.lastcmd.forwardmove : 0;
			_playerCmd.sidemove = cl.lastcmd != null ? cl.lastcmd.sidemove : 0;
			_playerCmd.upmove = cl.lastcmd != null ? cl.lastcmd.upmove : 0;
			_playerCmd.buttons = 0;
			_playerCmd.impulse = 0;
			const cmd = _playerCmd;

			// Copy angles from edict if dead (don't show corpse looking around)
			if ( ent.v.health <= 0 ) {

				cmd.angles[ 0 ] = 0;
				cmd.angles[ 1 ] = ent.v.angles[ 1 ];
				cmd.angles[ 2 ] = 0;

			} else if ( cl.lastcmd ) {

				cmd.angles[ 0 ] = cl.lastcmd.angles ? cl.lastcmd.angles[ 0 ] : 0;
				cmd.angles[ 1 ] = cl.lastcmd.angles ? cl.lastcmd.angles[ 1 ] : 0;
				cmd.angles[ 2 ] = cl.lastcmd.angles ? cl.lastcmd.angles[ 2 ] : 0;

			}

			MSG_WriteDeltaUsercmd( msg, nullcmd, cmd );

		}

		for ( let i = 0; i < 3; i ++ ) {

			if ( pflags & ( PF_VELOCITY1 << i ) )
				MSG_WriteShort( msg, ent.v.velocity[ i ] );

		}

		if ( pflags & PF_MODEL )
			MSG_WriteByte( msg, ent.v.modelindex );

		if ( pflags & PF_SKINNUM )
			MSG_WriteByte( msg, ent.v.skin );

		if ( pflags & PF_EFFECTS )
			MSG_WriteByte( msg, ent.v.effects );

		if ( pflags & PF_WEAPONFRAME )
			MSG_WriteByte( msg, ent.v.weaponframe );

		if ( pflags & PF_TELEPORT )
			MSG_WriteByte( msg, Math.min( 255, Math.ceil( ( ent.v.teleport_time - sv.time ) * 100 ) ) );

	}

}

/*
=======================
SV_SendClientDatagram
=======================
*/
// Cached buffers for SV_SendClientDatagram (avoid per-frame allocations)
const _scdBuf = new Uint8Array( MAX_DATAGRAM );
const _scdMsg = { allowoverflow: false, overflowed: false, data: _scdBuf, maxsize: MAX_DATAGRAM, cursize: 0 };
const _scdOrg = new Float32Array( 3 );

// Cached buffers for SV_SendNop (avoid per-call allocations)
const _sendNopBuf = new Uint8Array( 4 );
const _sendNopMsg = { allowoverflow: false, overflowed: false, data: _sendNopBuf, maxsize: 4, cursize: 0 };

// Cached buffers for SV_SendReconnect (avoid per-call allocations)
const _sendReconnectBuf = new Uint8Array( 128 );
const _sendReconnectMsg = { allowoverflow: false, overflowed: false, data: _sendReconnectBuf, maxsize: 128, cursize: 0 };

function SV_SendClientDatagram( client ) {

	// QW-style send gating: if transport is choked/backed up, skip building
	// expensive per-frame datagrams and try again next frame.
	if ( ! NET_CanSendUnreliableMessage( client.netconnection ) )
		return true;

	_scdMsg.allowoverflow = false;
	_scdMsg.overflowed = false;
	_scdMsg.cursize = 0;

	MSG_WriteByte( _scdMsg, svc_time );
	MSG_WriteFloat( _scdMsg, sv.time );

	// Write server sequence number for delta compression
	MSG_WriteByte( _scdMsg, svc_serversequence );
	MSG_WriteLong( _scdMsg, client.outgoing_sequence );

	SV_WriteClientdataToMessage( client.edict, _scdMsg );

	// Send ping stat (average of recent ping samples, in milliseconds)
	if ( client.num_pings > 0 ) {

		let totalPing = 0;
		const count = Math.min( client.num_pings, NUM_PING_TIMES );
		for ( let i = 0; i < count; i ++ ) {

			totalPing += client.ping_times[ i ];

		}

		const pingMs = Math.round( ( totalPing / count ) * 1000 );
		if ( pingMs !== client.old_ping ) {

			MSG_WriteByte( _scdMsg, svc_updatestat );
			MSG_WriteByte( _scdMsg, STAT_PING );
			MSG_WriteLong( _scdMsg, pingMs );
			client.old_ping = pingMs;

		}

	}

	// Send player info for other players (QuakeWorld-style prediction)
	VectorAdd( client.edict.v.origin, client.edict.v.view_ofs, _scdOrg );
	const pvs = SV_FatPVS( _scdOrg );
	SV_WritePlayersToClient( client, client.edict, pvs, _scdMsg );

	// QW-style delta-compressed entity updates
	SV_WriteEntitiesToClient( client, client.edict, pvs, _scdMsg );

	// copy the server datagram if there is space
	if ( _scdMsg.cursize + sv.datagram.cursize < _scdMsg.maxsize )
		SZ_Write( _scdMsg, sv.datagram.data, sv.datagram.cursize );

	// Record frame senttime and increment sequence
	client.frames[ client.outgoing_sequence & PE_UPDATE_MASK ].senttime = sv.time;
	client.outgoing_sequence ++;

	// send the datagram
	const sendResult = NET_SendUnreliableMessage( client.netconnection, _scdMsg );
	if ( sendResult === - 1 ) {

		Con_Printf( 'SV_SendClientDatagram: NET_SendUnreliableMessage returned -1, dropping client %s\n', client.name );
		SV_DropClient( true );
		return false;

	}

	return true;

}

/*
=======================
SV_SendNop

Send a nop message without trashing or sending the accumulated client
message buffer
=======================
*/
function SV_SendNop( client ) {

	// Use cached buffer instead of allocating per-call
	_sendNopMsg.cursize = 0;

	MSG_WriteChar( _sendNopMsg, svc_nop );

	if ( NET_SendUnreliableMessage( client.netconnection, _sendNopMsg ) === - 1 )
		SV_DropClient( true );
	client.last_message = realtime;

}

/*
=======================
SV_CleanupEnts
=======================
*/
function SV_CleanupEnts() {

	if ( ! sv.edicts || ! sv.edicts[ 0 ] )
		return;

	// clear muzzle flashes from all edicts
	let ent = NEXT_EDICT( sv.edicts[ 0 ] );
	for ( let e = 1; e < sv.num_edicts; e ++, ent = NEXT_EDICT( ent ) ) {

		ent.v.effects = ( ent.v.effects | 0 ) & ~EF_MUZZLEFLASH;

	}

}

/*
=====================
SV_DropClient

Called when the player is getting totally kicked off the host
if (crash = true), don't bother sending signoffs
=====================
*/
export function SV_DropClient( crash ) {

	const client = host_client;
	if ( client == null )
		return;

	// Get the client index for notifications
	const clientnum = svs.clients.indexOf( client );

	if ( ! crash ) {

		// send any final messages (only if connection didn't crash)
		if ( NET_CanSendMessage( client.netconnection ) ) {

			MSG_WriteByte( client.message, svc_disconnect );
			NET_SendMessage( client.netconnection, client.message );

		}

	}

	// Always call ClientDisconnect to clean up the entity
	// (original Quake skipped this on crash, but that leaves bodies solid/killable)
	if ( client.edict != null && client.spawned ) {

		// call the prog function for removing a client
		// this will set the body to a dead frame, among other things
		const saveSelf = pr_global_struct.self;
		pr_global_struct.self = EDICT_TO_PROG( client.edict );
		PR_ExecuteProgram( pr_global_struct.ClientDisconnect );
		pr_global_struct.self = saveSelf;

	}

	Con_Printf( 'Client ' + client.name + ' removed\n' );

	// break the net connection
	if ( client.netconnection != null ) {

		NET_Close( client.netconnection );
		client.netconnection = null;

	}

	// free the client (the body stays around)
	client.active = false;
	client.name = '';
	client.old_frags = - 999999;
	client.spawned = false;

	set_net_activeconnections( net_activeconnections - 1 );

	// send notification to all clients
	for ( let i = 0; i < svs.maxclients; i ++ ) {

		const other = svs.clients[ i ];
		if ( ! other.active )
			continue;

		MSG_WriteByte( other.message, svc_updatename );
		MSG_WriteByte( other.message, clientnum );
		MSG_WriteString( other.message, '' );

		MSG_WriteByte( other.message, svc_updatefrags );
		MSG_WriteByte( other.message, clientnum );
		MSG_WriteShort( other.message, 0 );

		MSG_WriteByte( other.message, svc_updatecolors );
		MSG_WriteByte( other.message, clientnum );
		MSG_WriteByte( other.message, 0 );

	}

}

/*
================
SV_ModelIndex
================
*/
export function SV_ModelIndex( name ) {

	if ( ! name || name.length === 0 )
		return 0;

	for ( let i = 0; i < MAX_MODELS && sv.model_precache[ i ] != null; i ++ ) {

		if ( sv.model_precache[ i ] === name )
			return i;

	}

	Sys_Error( 'SV_ModelIndex: model ' + name + ' not precached' );
	return 0;

}

/*
================
SV_SendReconnect

Tell all the clients that the server is changing levels
================
*/
function SV_SendReconnect() {

	// Use cached buffer instead of allocating per-call
	_sendReconnectMsg.cursize = 0;

	MSG_WriteChar( _sendReconnectMsg, svc_stufftext );
	MSG_WriteString( _sendReconnectMsg, 'reconnect\n' );
	NET_SendToAll( _sendReconnectMsg, 5 );

	Cbuf_InsertText( 'reconnect\n' );

}

/*
================
SV_SaveSpawnparms

Grabs the current state of each client for saving across the
transition to another level
================
*/
export function SV_SaveSpawnparms() {

	svs.serverflags = pr_global_struct.serverflags;

	for ( let i = 0; i < svs.maxclients; i ++ ) {

		const client = svs.clients[ i ];
		if ( ! client.active )
			continue;

		// call the progs to get default spawn parms for the new client
		pr_global_struct.self = EDICT_TO_PROG( client.edict );
		PR_ExecuteProgram( pr_global_struct.SetChangeParms );
		for ( let j = 0; j < NUM_SPAWN_PARMS; j ++ )
			client.spawn_parms[ j ] = pr_global_struct[ 'parm' + ( j + 1 ) ];

	}

}

/*
================
SV_CreateBaseline
================
*/
function SV_CreateBaseline() {

	for ( let entnum = 0; entnum < sv.num_edicts; entnum ++ ) {

		const svent = EDICT_NUM( entnum );
		if ( ! svent || svent.free )
			continue;
		if ( entnum > svs.maxclients && ( ! svent.v || ! svent.v.modelindex ) )
			continue;

		//
		// create entity baseline
		//
		if ( svent.v ) {

			VectorCopy( svent.v.origin, svent.baseline.origin );
			VectorCopy( svent.v.angles, svent.baseline.angles );
			svent.baseline.frame = svent.v.frame;
			svent.baseline.skin = svent.v.skin;

			if ( entnum > 0 && entnum <= svs.maxclients ) {

				svent.baseline.colormap = entnum;
				svent.baseline.modelindex = SV_ModelIndex( 'progs/player.mdl' );

			} else {

				svent.baseline.colormap = 0;
				svent.baseline.modelindex = SV_ModelIndex( PR_GetString( svent.v.model ) );

			}

		}

		//
		// add to the message
		//
		MSG_WriteByte( sv.signon, svc_spawnbaseline );
		MSG_WriteShort( sv.signon, entnum );

		MSG_WriteByte( sv.signon, svent.baseline.modelindex );
		MSG_WriteByte( sv.signon, svent.baseline.frame );
		MSG_WriteByte( sv.signon, svent.baseline.colormap );
		MSG_WriteByte( sv.signon, svent.baseline.skin );
		for ( let i = 0; i < 3; i ++ ) {

			MSG_WriteCoord( sv.signon, svent.baseline.origin[ i ] );
			MSG_WriteAngle( sv.signon, svent.baseline.angles[ i ] );

		}

	}

}

/*
================
SV_SpawnServer

This is called at the start of each level
================
*/
export function SV_SpawnServer( server ) {

	// let's not have any servers with no name
	if ( hostname.string.length === 0 )
		Cvar_Set( 'hostname', 'UNNAMED' );

	Con_DPrintf( 'SpawnServer: ' + server + '\n' );
	svs.changelevel_issued = false; // now safe to issue another

	// Reset cached player model index so it's re-looked-up for the new map
	sv_playermodel = 0;

	//
	// tell all connected clients that we are going to a new level
	//
	if ( sv.active ) {

		SV_SendReconnect();

	}

	//
	// make cvars consistant
	//
	if ( coop.value )
		Cvar_SetValue( 'deathmatch', 0 );
	current_skill = ( skill.value + 0.5 ) | 0;
	if ( current_skill < 0 )
		current_skill = 0;
	if ( current_skill > 3 )
		current_skill = 3;

	Cvar_SetValue( 'skill', current_skill );
	PR_SetCurrentSkill( current_skill );

	//
	// set up the new server
	//
	Host_ClearMemory();

	// clear the server struct
	Object.assign( sv, new ( sv.constructor )() );

	// Ensure progs.js has references to the canonical server objects
	PR_SetSV( sv );
	PR_SetSVS( svs );

	sv.name = server;
	sv.modelname = 'maps/' + server + '.bsp';

	// load progs to get entity field count
	const progsData = COM_LoadFile( 'progs.dat' );
	PR_LoadProgs( progsData );

	// Wire up sv_phys.js with server state and cross-module callbacks
	// (must be after PR_LoadProgs so pr_global_struct is valid)
	SV_SetState( sv, svs, pr_global_struct );
	SV_SetCallbacks( {
		SV_Move,
		SV_TestEntityPosition,
		SV_LinkEdict,
		SV_PointContents,
		SV_StartSound,
		PR_ExecuteProgram,
		EDICT_TO_PROG,
		PROG_TO_EDICT,
		NEXT_EDICT,
		GetEdictFieldValue,
	} );

	// allocate server memory
	sv.max_edicts = MAX_EDICTS;

	// Allocate edicts array using entityfields from loaded progs
	const entityfields = progs ? progs.entityfields : 105; // 105 is default for standard Quake
	sv.edicts = PR_AllocEdicts( sv.max_edicts, entityfields );

	// set up sizebuf data pointers
	sv.datagram.maxsize = MAX_DATAGRAM;
	sv.datagram.cursize = 0;
	sv.datagram.data = sv.datagram_buf;
	sv.datagram.allowoverflow = true; // unreliable messages can be dropped

	sv.reliable_datagram.maxsize = MAX_DATAGRAM;
	sv.reliable_datagram.cursize = 0;
	sv.reliable_datagram.data = sv.reliable_datagram_buf;
	sv.reliable_datagram.allowoverflow = true; // will be copied to client reliables

	sv.signon.maxsize = 8192;
	sv.signon.cursize = 0;
	sv.signon.data = sv.signon_buf;

	// leave slots at start for clients only
	sv.num_edicts = svs.maxclients + 1;
	for ( let i = 0; i < svs.maxclients; i ++ ) {

		const ent = EDICT_NUM( i + 1 );
		svs.clients[ i ].edict = ent;

	}

	sv.state = ss_loading;
	sv.paused = false;
	sv.nomonsters = nomonsters.value !== 0; // Ironwail: latched for the whole map
	sv.time = 1.0;

	sv.name = server;
	sv.modelname = 'maps/' + server + '.bsp';

	sv.worldmodel = Mod_ForName( sv.modelname, false );
	if ( ! sv.worldmodel ) {

		Con_Printf( 'Couldn\'t spawn server ' + sv.modelname + '\n' );
		sv.active = false;
		return;

	}

	sv.models[ 1 ] = sv.worldmodel;
	SV_AllocFatPVS( sv.worldmodel );

	//
	// clear world interaction links
	//
	SV_ClearWorld();

	sv.sound_precache[ 0 ] = '';
	sv.model_precache[ 0 ] = '';
	sv.model_precache[ 1 ] = sv.modelname;

	for ( let i = 1; i < sv.worldmodel.numsubmodels; i ++ ) {

		sv.model_precache[ 1 + i ] = localmodels[ i ];
		sv.models[ i + 1 ] = Mod_ForName( localmodels[ i ], false );

	}

	//
	// load the rest of the entities
	//
	const ent = EDICT_NUM( 0 );
	ED_ClearEdict( ent );
	ent.free = false;

	if ( ent.v ) {

		ent.v.model = ED_NewString( sv.worldmodel.name );
		ent.v.modelindex = 1; // world model
		ent.v.solid = SOLID_BSP;
		ent.v.movetype = MOVETYPE_PUSH;

		if ( coop.value )
			pr_global_struct.coop = coop.value;
		else
			pr_global_struct.deathmatch = deathmatch.value;

		pr_global_struct.mapname = ED_NewString( sv.name );

	}

	// serverflags are for cross level information (sigils)
	if ( pr_global_struct )
		pr_global_struct.serverflags = svs.serverflags;

	if ( sv.worldmodel && sv.worldmodel.entities ) {

		ED_LoadFromFile( sv.worldmodel.entities );

	}

	sv.active = true;

	// all setup is completed, any further precache statements are errors
	sv.state = ss_active;

	// clients get the current movevars in serverinfo
	SV_SnapshotMovevars();

	// run two frames to allow everything to settle
	set_host_frametime( 0.1 );
	SV_Physics();
	SV_Physics();

	// create a baseline for more efficient communications
	SV_CreateBaseline();

	// send serverinfo to all connected clients
	for ( let i = 0; i < svs.maxclients; i ++ ) {

		set_host_client( svs.clients[ i ] );
		if ( host_client.active )
			SV_SendServerinfo( host_client );

	}

	Con_DPrintf( 'Server spawned.\n' );

}
