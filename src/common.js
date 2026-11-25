// Ported from: WinQuake/common.c -- misc functions used in client and server
// + WinQuake/common.h -- general definitions

import { Sys_Error } from './sys.js';
import { cvar_t, Cvar_RegisterVariable, Cvar_Set } from './cvar.js';
import { COM_LoadFile } from './pak.js';
import { unicode_translit_src } from './unicode_translit.js';

//============================================================================
// common.h types
//============================================================================

export class sizebuf_t {

	constructor() {

		this.allowoverflow = false; // if false, do a Sys_Error
		this.overflowed = false; // set to true if the buffer size failed
		this.data = null; // Uint8Array
		this.maxsize = 0;
		this.cursize = 0;

	}

}

export class link_t {

	constructor() {

		this.prev = this;
		this.next = this;

	}

}

//============================================================================
// Linked list operations
//============================================================================

// ClearLink is used for new headnodes
export function ClearLink( l ) {

	l.prev = l.next = l;

}

export function RemoveLink( l ) {

	l.next.prev = l.prev;
	l.prev.next = l.next;

}

export function InsertLinkBefore( l, before ) {

	l.next = before;
	l.prev = before.prev;
	l.prev.next = l;
	l.next.prev = l;

}

export function InsertLinkAfter( l, after ) {

	l.next = after.next;
	l.prev = after;
	l.prev.next = l;
	l.next.prev = l;

}

//============================================================================
// Q_ato* functions - parse numbers same way as Quake
//============================================================================

// QuakeSpasm/Ironwail: Q_atoi and Q_atof skip leading whitespace (q_isspace),
// so a value such as " 1" reads as 1. id's C reads it as 0.
function Q_SkipSpace( str ) {

	let pos = 0;
	while ( pos < str.length ) {

		const c = str.charCodeAt( pos );
		if ( c !== 32 && ( c < 9 || c > 13 ) )
			break;
		pos ++;

	}

	return pos;

}

export function Q_atoi( str ) {

	let pos = Q_SkipSpace( str );
	let sign = 1;
	let val = 0;

	if ( str.charAt( pos ) === '-' ) {

		sign = - 1;
		pos ++;

	}

	// check for hex
	if ( str.charAt( pos ) === '0' && ( str.charAt( pos + 1 ) === 'x' || str.charAt( pos + 1 ) === 'X' ) ) {

		pos += 2;
		while ( pos < str.length ) {

			const c = str.charAt( pos );
			pos ++;
			if ( c >= '0' && c <= '9' )
				val = ( val << 4 ) + c.charCodeAt( 0 ) - 48;
			else if ( c >= 'a' && c <= 'f' )
				val = ( val << 4 ) + c.charCodeAt( 0 ) - 87;
			else if ( c >= 'A' && c <= 'F' )
				val = ( val << 4 ) + c.charCodeAt( 0 ) - 55;
			else
				return val * sign;

		}

		return val * sign;

	}

	// check for character
	if ( str.charAt( pos ) === '\'' ) {

		return sign * str.charCodeAt( pos + 1 );

	}

	// assume decimal
	while ( pos < str.length ) {

		const c = str.charAt( pos );
		pos ++;
		if ( c < '0' || c > '9' )
			return val * sign;
		val = val * 10 + c.charCodeAt( 0 ) - 48;

	}

	return val * sign;

}

export function Q_atof( str ) {

	let pos = Q_SkipSpace( str );
	let sign = 1;
	let val = 0;

	if ( str.charAt( pos ) === '-' ) {

		sign = - 1;
		pos ++;

	}

	// check for hex
	if ( str.charAt( pos ) === '0' && ( str.charAt( pos + 1 ) === 'x' || str.charAt( pos + 1 ) === 'X' ) ) {

		pos += 2;
		while ( pos < str.length ) {

			const c = str.charAt( pos );
			pos ++;
			if ( c >= '0' && c <= '9' )
				val = ( val * 16 ) + c.charCodeAt( 0 ) - 48;
			else if ( c >= 'a' && c <= 'f' )
				val = ( val * 16 ) + c.charCodeAt( 0 ) - 87;
			else if ( c >= 'A' && c <= 'F' )
				val = ( val * 16 ) + c.charCodeAt( 0 ) - 55;
			else
				return val * sign;

		}

		return val * sign;

	}

	// check for character
	if ( str.charAt( pos ) === '\'' ) {

		return sign * str.charCodeAt( pos + 1 );

	}

	// assume decimal
	let decimal = - 1;
	let total = 0;
	while ( pos < str.length ) {

		const c = str.charAt( pos );
		pos ++;
		if ( c === '.' ) {

			decimal = total;
			continue;

		}

		if ( c < '0' || c > '9' )
			break;
		val = val * 10 + c.charCodeAt( 0 ) - 48;
		total ++;

	}

	if ( decimal === - 1 )
		return val * sign;
	while ( total > decimal ) {

		val /= 10;
		total --;

	}

	return val * sign;

}

//============================================================================
// Byte order functions
// JavaScript is always little-endian for DataView, but we use typed arrays
// which are platform-endian (little-endian on all modern platforms)
//============================================================================

export function LittleShort( l ) { return l; }
export function LittleLong( l ) { return l; }
export function LittleFloat( l ) { return l; }

//============================================================================
// sizebuf operations
//============================================================================

export function SZ_Alloc( buf, startsize ) {

	if ( startsize < 256 )
		startsize = 256;
	buf.data = new Uint8Array( startsize );
	buf.maxsize = startsize;
	buf.cursize = 0;

}

export function SZ_Free( buf ) {

	buf.cursize = 0;

}

export function SZ_Clear( buf ) {

	buf.cursize = 0;

}

// Host_Error lives in host.js, which imports this module, so host.js installs
// it here (COM_SetHostError) for SZ_GetSpace. Until then Sys_Error stands in.
let _hostError = null;

export function COM_SetHostError( fn ) {

	_hostError = fn;

}

export function SZ_GetSpace( buf, length ) {

	if ( buf.cursize + length > buf.maxsize ) {

		if ( ! buf.allowoverflow ) {

			// ericw (QuakeSpasm/Ironwail): Host_Error instead of id's Sys_Error,
			// which would wipe the page or end the room process
			if ( _hostError !== null )
				_hostError( 'SZ_GetSpace: overflow without allowoverflow set' );
			Sys_Error( 'SZ_GetSpace: overflow without allowoverflow set' );

		}

		if ( length > buf.maxsize )
			Sys_Error( 'SZ_GetSpace: ' + length + ' is > full buffer size' );

		buf.overflowed = true;
		Con_Printf( 'SZ_GetSpace: overflow\n' );
		SZ_Clear( buf );

	}

	const offset = buf.cursize;
	buf.cursize += length;

	return offset; // return offset into buf.data

}

export function SZ_Write( buf, data, length ) {

	const offset = SZ_GetSpace( buf, length );
	if ( typeof data === 'string' ) {

		for ( let i = 0; i < length; i ++ )
			buf.data[ offset + i ] = data.charCodeAt( i );

	} else {

		for ( let i = 0; i < length; i ++ )
			buf.data[ offset + i ] = data[ i ];

	}

}

export function SZ_Print( buf, data ) {

	const len = data.length + 1;

	if ( buf.cursize > 0 && buf.data[ buf.cursize - 1 ] !== 0 ) {

		// no trailing 0
		const offset = SZ_GetSpace( buf, len );
		for ( let i = 0; i < data.length; i ++ )
			buf.data[ offset + i ] = data.charCodeAt( i );
		buf.data[ offset + data.length ] = 0;

	} else {

		// write over trailing 0
		if ( buf.cursize > 0 ) buf.cursize --;
		const offset = SZ_GetSpace( buf, len );
		for ( let i = 0; i < data.length; i ++ )
			buf.data[ offset + i ] = data.charCodeAt( i );
		buf.data[ offset + data.length ] = 0;

	}

}

//===========================================================================
// MESSAGE IO FUNCTIONS
//
// Handles byte ordering and avoids alignment errors
//===========================================================================

// Cached buffers for float conversion to avoid per-call allocations (Golden Rule #4)
const _floatWriteBuf = new ArrayBuffer( 4 );
const _floatWriteView = new DataView( _floatWriteBuf );
const _floatReadBuf = new ArrayBuffer( 4 );
const _floatReadView = new DataView( _floatReadBuf );

// writing functions

export function MSG_WriteChar( sb, c ) {

	const offset = SZ_GetSpace( sb, 1 );
	sb.data[ offset ] = c & 0xff;

}

export function MSG_WriteByte( sb, c ) {

	const offset = SZ_GetSpace( sb, 1 );
	sb.data[ offset ] = c & 0xff;

}

export function MSG_WriteShort( sb, c ) {

	const offset = SZ_GetSpace( sb, 2 );
	sb.data[ offset ] = c & 0xff;
	sb.data[ offset + 1 ] = ( c >> 8 ) & 0xff;

}

export function MSG_WriteLong( sb, c ) {

	const offset = SZ_GetSpace( sb, 4 );
	sb.data[ offset ] = c & 0xff;
	sb.data[ offset + 1 ] = ( c >> 8 ) & 0xff;
	sb.data[ offset + 2 ] = ( c >> 16 ) & 0xff;
	sb.data[ offset + 3 ] = ( c >> 24 ) & 0xff;

}

export function MSG_WriteFloat( sb, f ) {

	_floatWriteView.setFloat32( 0, f, true ); // little-endian
	const offset = SZ_GetSpace( sb, 4 );
	sb.data[ offset ] = _floatWriteView.getUint8( 0 );
	sb.data[ offset + 1 ] = _floatWriteView.getUint8( 1 );
	sb.data[ offset + 2 ] = _floatWriteView.getUint8( 2 );
	sb.data[ offset + 3 ] = _floatWriteView.getUint8( 3 );

}

export function MSG_WriteString( sb, s ) {

	if ( ! s ) {

		SZ_Write( sb, '\0', 1 );

	} else {

		SZ_Write( sb, s + '\0', s.length + 1 );

	}

}

// Deliberate deviations from WinQuake's MSG_WriteShort( (int)(f*8) ):
// - (int) truncates toward zero, so a coordinate could be sent up to 1/8
//   unit short (and negative ones moved the other way). This rounds to the
//   nearest 1/8 with Q_rint, as Ironwail's MSG_WriteCoord16 does.
// - The server speaks PROTOCOL_ICARO only, so this writes a long, not a
//   short: the 2021 rerelease maps reach past +-4096 (protocol.js). Like
//   Ironwail's PRFL_INT32COORD, but in 1/8 units, not 1/16, so a coordinate
//   inside +-4096 decodes to the same value as the short did.
export function MSG_WriteCoord( sb, f ) {

	const x = f * 8;
	// Q_rint: ((x) > 0 ? (int)((x) + 0.5) : (int)((x) - 0.5))
	MSG_WriteLong( sb, ( x > 0 ? x + 0.5 : x - 0.5 ) | 0 );

}

// NetQuake's 16-bit coordinate (Ironwail's MSG_WriteCoord16), for tests and
// tools that build protocol 15 messages
export function MSG_WriteCoord16( sb, f ) {

	const x = f * 8;
	MSG_WriteShort( sb, ( x > 0 ? x + 0.5 : x - 0.5 ) | 0 );

}

// Deliberate deviation from WinQuake's ((int)f*256/360) & 255, which drops
// the fraction of a degree before quantising (up to ~2.4 deg off). This
// rounds to the nearest step with Q_rint, as FitzQuake/QuakeSpasm do
// (johnfitz -- use Q_rint instead of (int)).
export function MSG_WriteAngle( sb, f ) {

	const x = f * 256 / 360;
	// Q_rint: ((x) > 0 ? (int)((x) + 0.5) : (int)((x) - 0.5))
	MSG_WriteByte( sb, ( ( x > 0 ? x + 0.5 : x - 0.5 ) | 0 ) & 255 );

}

// QuakeWorld-style 16-bit angle (more precision)
// Ported from: QW/client/common.c MSG_WriteAngle16
export function MSG_WriteAngle16( sb, f ) {

	MSG_WriteShort( sb, ( ( f * 65536 / 360 ) | 0 ) & 65535 );

}

// reading functions

export let msg_readcount = 0;
export let msg_badread = false;

// net_message: canonical instance lives in net.js; set via COM_SetNetMessage during init
export let net_message = null;
export function COM_SetNetMessage( msg ) { net_message = msg; }

export function MSG_BeginReading() {

	msg_readcount = 0;
	msg_badread = false;

}

// returns -1 and sets msg_badread if no more characters are available
export function MSG_ReadChar() {

	if ( msg_readcount + 1 > net_message.cursize ) {

		msg_badread = true;
		return - 1;

	}

	// signed char
	let c = net_message.data[ msg_readcount ];
	if ( c > 127 ) c -= 256;
	msg_readcount ++;

	return c;

}

export function MSG_ReadByte() {

	if ( msg_readcount + 1 > net_message.cursize ) {

		msg_badread = true;
		return - 1;

	}

	const c = net_message.data[ msg_readcount ];
	msg_readcount ++;

	return c;

}

export function MSG_ReadShort() {

	if ( msg_readcount + 2 > net_message.cursize ) {

		msg_badread = true;
		return - 1;

	}

	let c = net_message.data[ msg_readcount ]
		+ ( net_message.data[ msg_readcount + 1 ] << 8 );

	// sign extend
	if ( c > 32767 ) c -= 65536;

	msg_readcount += 2;

	return c;

}

export function MSG_ReadLong() {

	if ( msg_readcount + 4 > net_message.cursize ) {

		msg_badread = true;
		return - 1;

	}

	const c = net_message.data[ msg_readcount ]
		+ ( net_message.data[ msg_readcount + 1 ] << 8 )
		+ ( net_message.data[ msg_readcount + 2 ] << 16 )
		+ ( net_message.data[ msg_readcount + 3 ] << 24 );

	msg_readcount += 4;

	return c;

}

export function MSG_ReadFloat() {

	if ( msg_readcount + 4 > net_message.cursize ) {

		msg_badread = true;
		return - 1;

	}

	_floatReadView.setUint8( 0, net_message.data[ msg_readcount ] );
	_floatReadView.setUint8( 1, net_message.data[ msg_readcount + 1 ] );
	_floatReadView.setUint8( 2, net_message.data[ msg_readcount + 2 ] );
	_floatReadView.setUint8( 3, net_message.data[ msg_readcount + 3 ] );
	msg_readcount += 4;

	return _floatReadView.getFloat32( 0, true ); // little-endian

}

export function MSG_ReadString() {

	// Use array.join() instead of string concatenation to avoid O(n²) allocations
	const chars = [];

	while ( chars.length < 2047 ) {

		const c = MSG_ReadChar();
		if ( c === - 1 || c === 0 )
			break;
		chars.push( String.fromCharCode( c ) );

	}

	return chars.join( '' );

}

// The coordinate size the client reads: 4 bytes for PROTOCOL_ICARO, 2 for
// protocol 15 (NetQuake demos). CL_ParseServerInfo sets it from the
// server's version. Not in C, where Ironwail passes cl.protocolflags to
// each MSG_ReadCoord; one switch here keeps the dozens of callers
// (cl_tent.js, view.js, render.js) unchanged. The server never reads
// coordinates and always writes 4 bytes (MSG_WriteCoord).
export let msg_coord32 = true;
export function MSG_SetCoord32( on ) { msg_coord32 = on; }

export function MSG_ReadCoord() {

	if ( msg_coord32 )
		return MSG_ReadLong() * ( 1.0 / 8 );
	return MSG_ReadShort() * ( 1.0 / 8 );

}

export function MSG_ReadAngle() {

	return MSG_ReadChar() * ( 360.0 / 256 );

}

// QuakeWorld-style 16-bit angle (more precision)
export function MSG_ReadAngle16() {

	return MSG_ReadShort() * ( 360.0 / 65536 );

}

//============================================================================
// Path/string utility functions
//============================================================================

export function COM_SkipPath( pathname ) {

	let last = 0;
	for ( let i = 0; i < pathname.length; i ++ ) {

		if ( pathname.charAt( i ) === '/' )
			last = i + 1;

	}

	return pathname.substring( last );

}

export function COM_StripExtension( _in ) {

	const dot = _in.lastIndexOf( '.' );
	if ( dot === - 1 ) return _in;
	return _in.substring( 0, dot );

}

export function COM_FileExtension( _in ) {

	const dot = _in.lastIndexOf( '.' );
	if ( dot === - 1 ) return '';
	return _in.substring( dot + 1 );

}

export function COM_FileBase( _in ) {

	const slash = _in.lastIndexOf( '/' );
	const dot = _in.lastIndexOf( '.' );
	const start = slash >= 0 ? slash + 1 : 0;
	const end = dot > start ? dot : _in.length;
	return _in.substring( start, end );

}

export function COM_DefaultExtension( path, extension ) {

	// if path doesn't have a .EXT, append extension
	// (extension should include the .)
	const slash = path.lastIndexOf( '/' );
	const dot = path.lastIndexOf( '.' );
	if ( dot > slash ) return path; // it has an extension
	return path + extension;

}

/*
==============
COM_Parse

Parse a token out of a string
==============
*/
export let com_token = '';

export function COM_Parse( data ) {

	let pos = 0;
	com_token = '';

	if ( data === null || data === undefined )
		return null;

	const len = data.length;
	let c;

	// skip whitespace and comments
	while ( true ) {

		while ( true ) {

			if ( pos >= len )
				return null; // end of file

			if ( data.charCodeAt( pos ) > 32 ) break; // 32 = space
			pos ++;

		}

		c = data.charAt( pos );

		// skip // comments
		if ( c === '/' && data.charAt( pos + 1 ) === '/' ) {

			while ( pos < len && data.charAt( pos ) !== '\n' )
				pos ++;
			continue;

		}

		// QuakeSpasm: skip /*..*/ comments
		if ( c === '/' && data.charAt( pos + 1 ) === '*' ) {

			pos += 2;
			while ( pos < len && ! ( data.charAt( pos ) === '*' && data.charAt( pos + 1 ) === '/' ) )
				pos ++;
			if ( pos < len )
				pos += 2;
			continue;

		}

		break;

	}

	// handle quoted strings specially
	if ( c === '"' ) {

		pos ++;
		let token = '';
		while ( pos < len ) {

			c = data.charAt( pos );
			pos ++;
			if ( c === '"' ) {

				com_token = token;
				return data.substring( pos );

			}

			token += c;

		}

		com_token = token;
		return data.substring( pos );

	}

	// parse single characters
	if ( c === '{' || c === '}' || c === ')' || c === '(' || c === '\'' || c === ':' ) {

		com_token = c;
		return data.substring( pos + 1 );

	}

	// parse a regular word. QuakeSpasm: ':' only ends a word in id's C, so
	// that is left out here and ip:port (or a wts:// URL) stays one token.
	let token = '';
	while ( pos < len ) {

		c = data.charAt( pos );
		if ( c === '{' || c === '}' || c === ')' || c === '(' || c === '\'' )
			break;
		if ( c.charCodeAt( 0 ) <= 32 )
			break;
		token += c;
		pos ++;

	}

	com_token = token;
	return data.substring( pos );

}

//============================================================================
// Command line args
//============================================================================

export let com_argc = 0;
export let com_argv = [];

// Set by COM_InitArgv from -rogue and -hipnotic (main.js maps ?game= to these)
export let standard_quake = true;
export let rogue = false;
export let hipnotic = false;

//============================================================================
// Registered version check
//============================================================================

// this graphic needs to be in the pak file to use registered features
const pop = new Uint16Array( [
	0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000,
	0x0000, 0x0000, 0x6600, 0x0000, 0x0000, 0x0000, 0x6600, 0x0000,
	0x0000, 0x0066, 0x0000, 0x0000, 0x0000, 0x0000, 0x0067, 0x0000,
	0x0000, 0x6665, 0x0000, 0x0000, 0x0000, 0x0000, 0x0065, 0x6600,
	0x0063, 0x6561, 0x0000, 0x0000, 0x0000, 0x0000, 0x0061, 0x6563,
	0x0064, 0x6561, 0x0000, 0x0000, 0x0000, 0x0000, 0x0061, 0x6564,
	0x0064, 0x6564, 0x0000, 0x6469, 0x6969, 0x6400, 0x0064, 0x6564,
	0x0063, 0x6568, 0x6200, 0x0064, 0x6864, 0x0000, 0x6268, 0x6563,
	0x0000, 0x6567, 0x6963, 0x0064, 0x6764, 0x0063, 0x6967, 0x6500,
	0x0000, 0x6266, 0x6769, 0x6a68, 0x6768, 0x6a69, 0x6766, 0x6200,
	0x0000, 0x0062, 0x6566, 0x6666, 0x6666, 0x6666, 0x6562, 0x0000,
	0x0000, 0x0000, 0x0062, 0x6364, 0x6664, 0x6362, 0x0000, 0x0000,
	0x0000, 0x0000, 0x0000, 0x0062, 0x6662, 0x0000, 0x0000, 0x0000,
	0x0000, 0x0000, 0x0000, 0x0061, 0x6661, 0x0000, 0x0000, 0x0000,
	0x0000, 0x0000, 0x0000, 0x0000, 0x6500, 0x0000, 0x0000, 0x0000,
	0x0000, 0x0000, 0x0000, 0x0000, 0x6400, 0x0000, 0x0000, 0x0000
] );

// Created in COM_Init rather than at module load: cvar.js imports this module,
// so cvar_t may not be initialised yet when common.js is evaluated.
export let registered = null; // cvar_t "registered"
export let cmdline = null; // cvar_t "cmdline"
export let static_registered = 1; // only for startup check, then set

// set true if using non-id files (common.c COM_LoadPackFile, -game, -path;
// this port has no -game or -path, so only a changed pak sets it, such as a
// mission pack's pak0.pak loaded for -rogue or -hipnotic)
export let com_modified = false;

export function COM_SetModified( modified ) {

	com_modified = modified;

}

const CMDLINE_LENGTH = 256;
export let com_cmdline = '';

/*
================
COM_CheckRegistered

Looks for the pop.txt file and verifies it.
Sets the "registered" cvar.
Immediately exits out if an alternate game was attempted to be started without
being registered.
================
*/
export function COM_CheckRegistered() {

	const h = COM_LoadFile( 'gfx/pop.lmp' );
	static_registered = 0;

	if ( h === null ) {

		Con_Printf( 'Playing shareware version.\n' );
		if ( com_modified )
			Sys_Error( 'You must have the registered version to use modified games' );
		return;

	}

	// Sys_FileRead( h, check, sizeof( check ) ): 128 big-endian shorts
	const check = new Uint8Array( h );
	for ( let i = 0; i < 128; i ++ ) {

		const v = 2 * i + 1 < check.length ? ( check[ 2 * i ] << 8 ) | check[ 2 * i + 1 ] : - 1;
		if ( pop[ i ] !== v )
			Sys_Error( 'Corrupted data file.' );

	}

	Cvar_Set( 'cmdline', com_cmdline );
	Cvar_Set( 'registered', '1' );
	static_registered = 1;
	Con_Printf( 'Playing registered version.\n' );

}

/*
================
COM_Init

The registered check from C COM_Init. The pak files are loaded before
Host_Init in this port, so it can run straight away.
================
*/
export function COM_Init() {

	if ( registered === null ) {

		registered = new cvar_t( 'registered', '0' );
		Cvar_RegisterVariable( registered );
		cmdline = new cvar_t( 'cmdline', '0', false, true );
		Cvar_RegisterVariable( cmdline );

	}

	COM_CheckRegistered();

}

export function COM_InitArgv( argv ) {

	com_argc = argv.length;
	com_argv = argv;

	// reconstitute the command line for the cmdline externally visible cvar
	let n = '';
	for ( let j = 0; j < argv.length; j ++ ) {

		n += argv[ j ];
		if ( n.length >= CMDLINE_LENGTH - 1 ) {

			n = n.substring( 0, CMDLINE_LENGTH - 1 );
			break;

		}

		n += ' ';

	}

	com_cmdline = n;

	// common.c COM_InitArgv. Assigned on every call so that a later call
	// without the flag (as the tests make) clears it again.
	rogue = COM_CheckParm( '-rogue' ) !== 0;
	hipnotic = COM_CheckParm( '-hipnotic' ) !== 0;
	standard_quake = rogue === false && hipnotic === false;

}

export function COM_CheckParm( parm ) {

	for ( let i = 1; i < com_argc; i ++ ) {

		if ( ! com_argv[ i ] ) continue;
		if ( com_argv[ i ] === parm ) return i;

	}

	return 0;

}

//============================================================================
// Console print stub (routes to real console when initialized)
//============================================================================

let _realConPrintf = null;
let _realConDPrintf = null;

export function Con_SetPrintFunctions( conPrintf, conDPrintf ) {

	_realConPrintf = conPrintf;
	_realConDPrintf = conDPrintf;

}

export function Con_Printf( fmt, ...args ) {

	if ( _realConPrintf !== null ) {

		_realConPrintf( fmt, ...args );

	} else {

		// Fallback before console is initialized
		console.log( fmt, ...args );

	}

}

export function Con_DPrintf( fmt, ...args ) {

	if ( _realConDPrintf !== null ) {

		_realConDPrintf( fmt, ...args );

	} else {

		// debug printf - only prints when developer cvar is set
		console.debug( fmt, ...args );

	}

}

/*
============================================================================

					LOCALIZATION (2021 rerelease)

Ported from Ironwail Quake/common.c: LOC_* and UTF8_ToQuake. The rerelease
QuakeC prints "$key" strings (for example "$qc_item_health") that these
resolve from localization/loc_<language>.txt in id1's pak0.pak.

Deliberate deviations from Ironwail (docs/port-review.md section 7 names the main ones):
- Only the game's paks are searched. Ironwail also opens QuakeEX.kpf (a zip)
  and the Steam and Epic install folders; the port reads neither.
- The file is decoded with TextDecoder, which turns invalid UTF-8 into U+FFFD
  and so into QCHAR_BOX, as UTF8_ReadCodePoint's UNICODE_UNKNOWN does.
- Entries go in a Map rather than Ironwail's open-addressed FNV-1a table. As
  there, the first of two entries with the same key wins.
- An unquoted value has all trailing whitespace trimmed. Ironwail's trim loop
  keeps one trailing blank and leaves the '\r' of a CRLF line (every value in
  the rerelease files is quoted, so neither case occurs there).
- The port's cvars have no change callbacks, so a change to "language" is
  picked up by the next lookup rather than by LOC_Language_f at once.
- A missing file is reported with Con_DPrintf, not Con_Printf, so the
  shareware game (which has none) boots without a new console line.
- "auto" reads navigator.languages instead of SDL_GetPreferredLocales.
- LOC_Load doesn't retry loc_english.txt when that was the file that failed.
- PF_VarString and LOC_Format have no 1024-byte output buffer, so no
  overflow warnings (the port's PF_VarString never had a limit).
- Not ported: LOC_Init's "Language initialization" banner, the developer 2
  list of entries with unprintable characters, "[skipnotify]" on the
  "Loaded N strings" line, and language completion.

============================================================================
*/

const QCHAR_BOX = 11;

// Quake character set to Unicode (Ironwail common.c qchar_to_unicode)
const qchar_to_unicode = new Uint32Array( [
	0x00B7, 0x0000, 0x0000, 0x0000, 0x0000, 0x00B7, 0x0000, 0x0000, 0x0000, 0x0000, 0x000A, 0x25A0, 0x0020, 0x25B6, 0x00B7, 0x00B7, // 0
	0x301A, 0x301B, 0x0030, 0x0031, 0x0032, 0x0033, 0x0034, 0x0035, 0x0036, 0x0037, 0x0038, 0x0039, 0x00B7, 0x002D, 0x002D, 0x002D, // 1
	0x0020, 0x0021, 0x0022, 0x0023, 0x0024, 0x0025, 0x0026, 0x0027, 0x0028, 0x0029, 0x002A, 0x002B, 0x002C, 0x002D, 0x002E, 0x002F, // 2
	0x0030, 0x0031, 0x0032, 0x0033, 0x0034, 0x0035, 0x0036, 0x0037, 0x0038, 0x0039, 0x003A, 0x003B, 0x003C, 0x003D, 0x003E, 0x003F, // 3
	0x0040, 0x0041, 0x0042, 0x0043, 0x0044, 0x0045, 0x0046, 0x0047, 0x0048, 0x0049, 0x004A, 0x004B, 0x004C, 0x004D, 0x004E, 0x004F, // 4
	0x0050, 0x0051, 0x0052, 0x0053, 0x0054, 0x0055, 0x0056, 0x0057, 0x0058, 0x0059, 0x005A, 0x005B, 0x005C, 0x005D, 0x005E, 0x005F, // 5
	0x0060, 0x0061, 0x0062, 0x0063, 0x0064, 0x0065, 0x0066, 0x0067, 0x0068, 0x0069, 0x006A, 0x006B, 0x006C, 0x006D, 0x006E, 0x006F, // 6
	0x0070, 0x0071, 0x0072, 0x0073, 0x0074, 0x0075, 0x0076, 0x0077, 0x0078, 0x0079, 0x007A, 0x007B, 0x007C, 0x007D, 0x007E, 0x2190, // 7
	0x002D, 0x002D, 0x002D, 0x002D, 0x0000, 0x2022, 0x0000, 0x0000, 0x0000, 0x0000, 0x000A, 0x25A0, 0x0020, 0x25B6, 0x2022, 0x2022, // 8
	0x301A, 0x301B, 0x0030, 0x0031, 0x0032, 0x0033, 0x0034, 0x0035, 0x0036, 0x0037, 0x0038, 0x0039, 0x2022, 0x002D, 0x002D, 0x002D, // 9
	0x0020, 0x0021, 0x0022, 0x0023, 0x0024, 0x0025, 0x0026, 0x0027, 0x0028, 0x0029, 0x002A, 0x002B, 0x002C, 0x002D, 0x002E, 0x002F, // 10
	0x0030, 0x0031, 0x0032, 0x0033, 0x0034, 0x0035, 0x0036, 0x0037, 0x0038, 0x0039, 0x003A, 0x003B, 0x003C, 0x003D, 0x003E, 0x003F, // 11
	0x0040, 0x0041, 0x0042, 0x0043, 0x0044, 0x0045, 0x0046, 0x0047, 0x0048, 0x0049, 0x004A, 0x004B, 0x004C, 0x004D, 0x004E, 0x004F, // 12
	0x0050, 0x0051, 0x0052, 0x0053, 0x0054, 0x0055, 0x0056, 0x0057, 0x0058, 0x0059, 0x005A, 0x005B, 0x005C, 0x005D, 0x005E, 0x005F, // 13
	0x0060, 0x0061, 0x0062, 0x0063, 0x0064, 0x0065, 0x0066, 0x0067, 0x0068, 0x0069, 0x006A, 0x006B, 0x006C, 0x006D, 0x006E, 0x006F, // 14
	0x0070, 0x0071, 0x0072, 0x0073, 0x0074, 0x0075, 0x0076, 0x0077, 0x0078, 0x0079, 0x007A, 0x007B, 0x007C, 0x007D, 0x007E, 0x2190, // 15
] );

// unicode_translit[ cp * 2 ], [ cp * 2 + 1 ]: one or two Quake characters per
// code point below 65536 (the second is 0 when unused). Built on first use.
let unicode_translit = null;

/*
==================
UTF8_ToQuake

Transliterates a string to Quake encoding. Ironwail decodes UTF-8 here; the
port takes the string TextDecoder already decoded, and returns one character
(code 0-255) per Quake byte, as PR_GetString builds them.
==================
*/
export function UTF8_ToQuake( src ) {

	if ( unicode_translit === null ) {

		unicode_translit = new Uint8Array( 65536 * 2 );

		// precomputed single-character/two-character transliterations
		for ( let i = 0; i < unicode_translit_src.length; i ++ ) {

			const code = unicode_translit_src[ i ][ 0 ];
			const remap = unicode_translit_src[ i ][ 1 ];
			unicode_translit[ code * 2 ] = remap.charCodeAt( 0 );
			unicode_translit[ code * 2 + 1 ] = remap.length > 1 ? remap.charCodeAt( 1 ) : 0;

		}

		// Quake-specific characters: we process the list in reverse order
		// so that codepoints used for both colored and non-colored qchars
		// end up being remapped to the non-colored versions
		// Note: 0 is not included
		for ( let i = qchar_to_unicode.length - 1; i > 0; i -- ) {

			const cp = qchar_to_unicode[ i ];
			if ( cp >= 128 && cp < 65536 ) {

				unicode_translit[ cp * 2 ] = i;
				unicode_translit[ cp * 2 + 1 ] = 0;

			}

		}

		// map ASCII characters to themselves
		for ( let i = 0; i < 128; i ++ ) {

			unicode_translit[ i * 2 ] = i;
			unicode_translit[ i * 2 + 1 ] = 0;

		}

		// Map all other characters to QCHAR_BOX (unknown character)
		for ( let i = 0; i < 65536; i ++ ) {

			if ( unicode_translit[ i * 2 ] === 0 ) {

				unicode_translit[ i * 2 ] = QCHAR_BOX;
				unicode_translit[ i * 2 + 1 ] = 0;

			}

		}

	}

	let dst = '';
	for ( const ch of src ) {

		const cp = ch.codePointAt( 0 );
		if ( cp < 65536 ) {

			dst += String.fromCharCode( unicode_translit[ cp * 2 ] );
			const c1 = unicode_translit[ cp * 2 + 1 ];
			if ( c1 !== 0 ) dst += String.fromCharCode( c1 );

		} else {

			dst += String.fromCharCode( QCHAR_BOX );

		}

	}

	return dst;

}

export let language = null; // cvar_t "language", registered by LOC_Init

const knownlangs = [
	[ '', 'auto' ],
	[ 'en', 'english' ],
	[ 'fr', 'french' ],
	[ 'de', 'german' ],
	[ 'it', 'italian' ],
	[ 'es', 'spanish' ],
];

// Different from language cvar if language is "auto"
let userlang = 'english';

const loc_entries = new Map(); // key (without '$') -> value in Quake encoding
let loc_initialized = false;
let loc_cvarstring = null; // language.string when the strings were last loaded
let loc_argend = 0; // LOC_ParseArg's advanced position
const loc_decoder = new TextDecoder( 'utf-8' ); // strips a leading BOM

function q_isblank( c ) {

	return c === 0x20 || c === 0x09;

}

function q_isspace( c ) {

	return c === 0x20 || ( c >= 0x09 && c <= 0x0D );

}

/*
================
LOC_LoadFile
================
*/
export function LOC_LoadFile( file ) {

	// clear existing data
	loc_entries.clear();

	if ( file === null || file === '' )
		return false;

	const buf = COM_LoadFile( file );
	if ( buf === null ) {

		Con_DPrintf( 'Couldn\'t load \'%s\'\n', file );
		return false;

	}

	const text = loc_decoder.decode( buf );
	const len = text.length;
	let numentries = 0;
	let lineno = 0;
	let cursor = 0;

	while ( cursor < len ) {

		lineno ++;

		// skip leading whitespace
		while ( cursor < len && q_isblank( text.charCodeAt( cursor ) ) )
			cursor ++;

		const line = cursor;
		let equals = - 1;
		// find line end and first equals sign, if any
		while ( cursor < len && text.charCodeAt( cursor ) !== 0x0A ) {

			if ( text.charCodeAt( cursor ) === 0x3D && equals < 0 )
				equals = cursor;
			cursor ++;

		}

		if ( text.charCodeAt( line ) === 0x2F ) {

			if ( text.charCodeAt( line + 1 ) !== 0x2F )
				Con_DPrintf( 'LOC_LoadFile: malformed comment on line %d\n', lineno );

		} else if ( equals >= 0 ) {

			// trim whitespace before equals sign
			let key_end = equals;
			while ( key_end !== line && q_isspace( text.charCodeAt( key_end - 1 ) ) )
				key_end --;
			const key = text.substring( line, key_end );

			let value = equals + 1;
			// skip whitespace after equals sign
			while ( value !== cursor && q_isspace( text.charCodeAt( value ) ) )
				value ++;

			const leading_quote = value !== cursor && text.charCodeAt( value ) === 0x22;
			let trailing_quote = false;
			if ( leading_quote ) value ++;

			// transform escape sequences
			let out = '';
			let src = value;
			while ( src !== cursor ) {

				const c = text[ src ];
				if ( c === '\\' && src + 1 !== cursor ) {

					const e = text[ src + 1 ];
					src += 2;
					switch ( e ) {

						case 'n': out += '\n'; break;
						case 't': out += '\t'; break;
						case 'v': out += '\v'; break;
						case 'b': out += '\b'; break;
						case 'f': out += '\f'; break;

						case '"':
						case '\'':
							out += e;
							break;

						default:
							Con_Printf( 'LOC_LoadFile: unrecognized escape sequence \\%s on line %d\n', e, lineno );
							out += e;
							break;

					}

					continue;

				}

				if ( c === '"' ) {

					trailing_quote = true;
					break;

				}

				out += c;
				src ++;

			}

			// if not a quoted string, trim trailing whitespace
			if ( ! trailing_quote ) {

				let end = out.length;
				while ( end > 0 && q_isspace( out.charCodeAt( end - 1 ) ) )
					end --;
				out = out.substring( 0, end );

			}

			numentries ++;
			if ( ! loc_entries.has( key ) )
				loc_entries.set( key, UTF8_ToQuake( out ) );

		}

		cursor ++; // past the '\n'

	}

	if ( numentries === 0 ) {

		Con_Printf( 'No localized strings in file \'%s\'\n', file );
		return false;

	}

	Con_Printf( 'Loaded %d strings from \'%s\'\n', numentries, file );

	return true;

}

/*
================
LOC_Load
================
*/
export function LOC_Load() {

	// Ironwail retries loc_english.txt even when that was the file that failed
	if ( ! LOC_LoadFile( 'localization/loc_' + userlang + '.txt' ) && userlang !== 'english' )
		LOC_LoadFile( 'localization/loc_english.txt' );

}

/*
================
LOC_GetSystemLanguage
================
*/
export function LOC_GetSystemLanguage() {

	if ( typeof navigator === 'undefined' || ! Array.isArray( navigator.languages ) )
		return 'english';

	for ( const pref of navigator.languages ) {

		// BCP 47 tags ("fr-FR"); SDL_Locale.language is the part before '-'
		const lang = String( pref ).split( '-' )[ 0 ].toLowerCase();
		for ( let j = 1; j < knownlangs.length; j ++ ) { // start at 1, skipping "auto"

			if ( lang === knownlangs[ j ][ 0 ] )
				return knownlangs[ j ][ 1 ];

		}

	}

	return 'english';

}

/*
================
LOC_Language_f

Called when language changes
================
*/
export function LOC_Language_f() {

	loc_cvarstring = language.string;
	if ( language.string.toLowerCase() === 'auto' )
		userlang = LOC_GetSystemLanguage();
	else
		userlang = language.string;
	LOC_Load();

}

// Reloads the strings when "language" changed since they were loaded (the
// port's stand-in for Ironwail's cvar callback)
function LOC_CheckLanguage() {

	if ( loc_initialized && language.string !== loc_cvarstring )
		LOC_Language_f();

}

/*
================
LOC_Init
================
*/
export function LOC_Init() {

	if ( language === null ) {

		language = new cvar_t( 'language', 'auto', true ); // for 2021 rerelease text
		Cvar_RegisterVariable( language );

	}

	loc_initialized = true;
	LOC_Language_f();

}

/*
================
LOC_Shutdown
================
*/
export function LOC_Shutdown() {

	loc_entries.clear();
	loc_initialized = false;
	loc_cvarstring = null;

}

/*
================
LOC_GetRawString

Returns localized string if available, or null otherwise
================
*/
export function LOC_GetRawString( key ) {

	LOC_CheckLanguage();

	if ( loc_entries.size === 0 || key === null || key.length === 0 || key.charCodeAt( 0 ) !== 0x24 )
		return null;

	const value = loc_entries.get( key.substring( 1 ) );
	return value !== undefined ? value : null;

}

/*
================
LOC_GetString

Returns localized string if available, or input string otherwise
================
*/
export function LOC_GetString( key ) {

	const value = LOC_GetRawString( key );
	return value !== null ? value : key;

}

/*
================
LOC_ParseArg

Returns argument index (>= 0) and sets loc_argend past the placeholder if str
has one ({} or {N}) at pos, otherwise returns a negative value
================
*/
function LOC_ParseArg( str, pos ) {

	// opening brace
	if ( str.charCodeAt( pos ) !== 0x7B )
		return - 1;
	let p = pos + 1;

	// optional index, defaulting to 0
	let arg = 0;
	let c = str.charCodeAt( p );
	while ( c >= 0x30 && c <= 0x39 ) {

		arg = arg * 10 + c - 0x30;
		c = str.charCodeAt( ++ p );

	}

	// closing brace
	if ( c !== 0x7D )
		return - 1;
	loc_argend = p + 1;

	return arg;

}

/*
================
LOC_HasPlaceholders
================
*/
export function LOC_HasPlaceholders( str ) {

	LOC_CheckLanguage();

	if ( loc_entries.size === 0 )
		return false;
	for ( let i = 0; i < str.length; i ++ ) {

		if ( LOC_ParseArg( str, i ) >= 0 )
			return true;

	}

	return false;

}

/*
================
LOC_Format

Replaces placeholders (of the form {} or {N}) with the corresponding arguments.
Ironwail writes into a fixed buffer; the port's strings have no length limit.
================
*/
export function LOC_Format( format, getarg_fn, userdata ) {

	let out = '';
	let run = 0; // start of the literal text not yet copied
	let i = 0;

	while ( i < format.length ) {

		const argindex = LOC_ParseArg( format, i );
		if ( argindex < 0 ) {

			i ++;
			continue;

		}

		out += format.substring( run, i ) + getarg_fn( argindex, userdata );
		i = loc_argend;
		run = i;

	}

	return out + format.substring( run );

}
