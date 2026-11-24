// Ported from: WinQuake/common.c -- misc functions used in client and server
// + WinQuake/common.h -- general definitions

import { Sys_Error } from './sys.js';
import { cvar_t, Cvar_RegisterVariable, Cvar_Set } from './cvar.js';
import { COM_LoadFile } from './pak.js';

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

export function Q_atoi( str ) {

	let pos = 0;
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

	let pos = 0;
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

export function SZ_GetSpace( buf, length ) {

	if ( buf.cursize + length > buf.maxsize ) {

		if ( ! buf.allowoverflow )
			Sys_Error( 'SZ_GetSpace: overflow without allowoverflow set' );

		if ( length > buf.maxsize )
			Sys_Error( 'SZ_GetSpace: ' + length + ' is > full buffer size' );

		buf.overflowed = true;
		Con_Printf( 'SZ_GetSpace: overflow' );
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

export function MSG_WriteCoord( sb, f ) {

	MSG_WriteShort( sb, ( f * 8 ) | 0 );

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

export function MSG_ReadCoord() {

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

	// skip whitespace
	while ( true ) {

		if ( pos >= data.length )
			return null; // end of file

		const c = data.charCodeAt( pos );
		if ( c > 32 ) break; // 32 = space
		pos ++;

	}

	let c = data.charAt( pos );

	// skip // comments
	if ( c === '/' && data.charAt( pos + 1 ) === '/' ) {

		while ( pos < data.length && data.charAt( pos ) !== '\n' )
			pos ++;
		return COM_Parse( data.substring( pos ) );

	}

	// handle quoted strings specially
	if ( c === '"' ) {

		pos ++;
		let token = '';
		while ( pos < data.length ) {

			c = data.charAt( pos );
			pos ++;
			if ( c === '"' || ! c ) {

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

	// parse a regular word
	let token = '';
	while ( pos < data.length ) {

		c = data.charAt( pos );
		if ( c === '{' || c === '}' || c === ')' || c === '(' || c === '\'' || c === ':' )
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
