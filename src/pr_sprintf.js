// Ported from: Ironwail Quake/pr_cmds.c (PF_sprintf_internal, from
// DarkPlaces' VM_sprintf), plus the C printf conversions it hands to
// q_snprintf. Not in id's Quake: this backs the sprintf (#627) extension
// builtin.

import { Con_Printf } from './common.js';
import { pr_argc, pr_globals_float, pr_globals_int, PR_GetString } from './progs.js';
import { OFS_PARM0 } from './pr_comp.js';

const PRINTF_ALTERNATE = 1;
const PRINTF_ZEROPAD = 2;
const PRINTF_LEFT = 4;
const PRINTF_SPACEPOSITIVE = 8;
const PRINTF_SIGNPOSITIVE = 16;

// Number.prototype.toFixed and toExponential accept at most 100 digits
const MAX_JS_DIGITS = 100;

// C's (int) and (unsigned int) casts of a float. Out-of-range values are
// undefined in C; x86 gives INT_MIN for (int), so we do too.
export function Q_FloatToInt( f ) {

	if ( ! ( f > - 2147483649 && f < 2147483648 ) )
		return - 2147483648;
	return Math.trunc( f ) | 0;

}

function Q_FloatToUint( f ) {

	if ( ! Number.isFinite( f ) )
		return 0;
	return Number( BigInt.asUintN( 32, BigInt( Math.trunc( f ) ) ) );

}

// C formats into a fixed buffer, so a huge width or precision is just cut
// off. A run longer than any output buffer leaves nothing after it visible,
// so cap each run here rather than build a string of that size (or throw
// RangeError past the JS string limit).
const FILL_MAX = 65536;

function fill( ch, n ) {

	return ch.repeat( Math.min( n, FILL_MAX ) );

}

function pad( s, width, flags ) {

	if ( s.length >= width )
		return s;
	if ( flags & PRINTF_LEFT )
		return s + fill( ' ', width - s.length );
	return fill( ' ', width - s.length ) + s;

}

// sign, then zeros up to width, then digits (C's '0' flag)
function padNumber( sign, prefix, digits, width, flags, zeroAllowed ) {

	const len = sign.length + prefix.length + digits.length;
	if ( ( flags & PRINTF_ZEROPAD ) && ! ( flags & PRINTF_LEFT ) && zeroAllowed && len < width )
		return sign + prefix + fill( '0', width - len ) + digits;
	return pad( sign + prefix + digits, width, flags );

}

function signOf( negative, flags ) {

	if ( negative )
		return '-';
	if ( flags & PRINTF_SIGNPOSITIVE )
		return '+';
	if ( flags & PRINTF_SPACEPOSITIVE )
		return ' ';
	return '';

}

// %f body for a non-negative finite value
function fixedDigits( v, prec ) {

	if ( v >= 1e21 ) // toFixed switches to exponent form; doubles this big are integers
		return BigInt( v ).toString() + ( prec > 0 ? '.' + fill( '0', prec ) : '' );
	if ( prec <= MAX_JS_DIGITS )
		return v.toFixed( prec );
	return v.toFixed( MAX_JS_DIGITS ) + fill( '0', prec - MAX_JS_DIGITS );

}

// %e body for a non-negative finite value: mantissa and a two-digit exponent
function expDigits( v, prec, upper ) {

	const p = Math.min( prec, MAX_JS_DIGITS );
	let s = v.toExponential( p );
	const e = s.indexOf( 'e' );
	let mant = s.slice( 0, e );
	if ( prec > p )
		mant += fill( '0', prec - p );
	const exp = parseInt( s.slice( e + 1 ), 10 );
	const expAbs = Math.abs( exp );
	s = mant + ( upper ? 'E' : 'e' ) + ( exp < 0 ? '-' : '+' ) + ( expAbs < 10 ? '0' : '' ) + expAbs;
	return s;

}

function stripZeros( s ) {

	// remove trailing zeros after a decimal point, and the point if bare
	const e = s.search( /[eE]/ );
	let mant = e >= 0 ? s.slice( 0, e ) : s;
	const rest = e >= 0 ? s.slice( e ) : '';
	if ( mant.indexOf( '.' ) >= 0 ) {

		mant = mant.replace( /0+$/, '' );
		if ( mant.endsWith( '.' ) )
			mant = mant.slice( 0, - 1 );

	}

	return mant + rest;

}

/*
============
Q_FormatFloat

C printf %e %E %f %F %g %G of one double. JS rounds exact decimal ties away
from zero where glibc rounds them to even (printf( "%.0f", 2.5 ) gives "2"
in C and "3" here); other values match.
============
*/
export function Q_FormatFloat( conv, flags, width, precision, v ) {

	const upper = conv === 'E' || conv === 'F' || conv === 'G';
	const negative = v < 0 || Object.is( v, - 0 );
	const sign = signOf( negative, flags );

	if ( ! Number.isFinite( v ) ) {

		let s = Number.isNaN( v ) ? 'nan' : 'inf';
		if ( upper )
			s = s.toUpperCase();
		return pad( ( Number.isNaN( v ) ? signOf( false, flags ) : sign ) + s, width, flags );

	}

	const a = Math.abs( v );
	const prec = precision < 0 ? 6 : precision;
	let body;

	switch ( conv ) {

		case 'f':
		case 'F':
			body = fixedDigits( a, prec );
			if ( prec === 0 && ( flags & PRINTF_ALTERNATE ) )
				body += '.';
			break;

		case 'e':
		case 'E':
			body = expDigits( a, prec, upper );
			if ( prec === 0 && ( flags & PRINTF_ALTERNATE ) )
				body = body.replace( /[eE]/, '.$&' );
			break;

		default: { // g, G

			const P = prec === 0 ? 1 : prec;
			let X = 0;
			if ( a !== 0 ) {

				const s = a.toExponential( Math.min( P - 1, MAX_JS_DIGITS ) );
				X = parseInt( s.slice( s.indexOf( 'e' ) + 1 ), 10 );

			}

			if ( P > X && X >= - 4 )
				body = fixedDigits( a, P - 1 - X );
			else
				body = expDigits( a, P - 1, upper );

			if ( flags & PRINTF_ALTERNATE ) {

				if ( body.indexOf( '.' ) < 0 )
					body = body.replace( /([eE]|$)/, '.$1' );

			} else {

				body = stripZeros( body );

			}

			break;

		}

	}

	return padNumber( sign, '', body, width, flags, true );

}

/*
============
Q_FormatInt

C printf %d %i (signed) and %o %u %x %X (unsigned) of one 32-bit integer
============
*/
export function Q_FormatInt( conv, flags, width, precision, v ) {

	let negative = false;
	let digits;
	let prefix = '';

	switch ( conv ) {

		case 'd':
		case 'i':
			negative = v < 0;
			digits = Math.abs( v ).toString();
			break;
		case 'o':
			digits = v.toString( 8 );
			break;
		case 'u':
			digits = v.toString();
			break;
		case 'x':
			digits = v.toString( 16 );
			break;
		default: // X
			digits = v.toString( 16 ).toUpperCase();
			break;

	}

	if ( precision === 0 && v === 0 )
		digits = '';
	if ( precision > digits.length )
		digits = fill( '0', precision - digits.length ) + digits;

	if ( flags & PRINTF_ALTERNATE ) {

		if ( conv === 'o' && digits[ 0 ] !== '0' )
			digits = '0' + digits;
		else if ( conv === 'x' && v !== 0 )
			prefix = '0x';
		else if ( conv === 'X' && v !== 0 )
			prefix = '0X';

	}

	const sign = conv === 'd' || conv === 'i' ? signOf( negative, flags ) : '';
	return padNumber( sign, prefix, digits, width, flags, precision < 0 );

}

function Con_Warning( msg ) {

	Con_Printf( '%s', 'Warning: ' + msg );

}

/*
============
PF_sprintf_internal

Formats the QuakeC arguments from firstarg on with the format s, and
returns the result cut to outbuflen - 1 characters.
============
*/
export function PF_sprintf_internal( s, firstarg, outbuflen ) {

	let o = '';
	let argpos = firstarg;
	let i = 0;
	const max = outbuflen - 1;

	const GETARG_FLOAT = ( a ) => ( a >= firstarg && a < pr_argc ) ? pr_globals_float[ OFS_PARM0 + 3 * a ] : 0;
	const GETARG_INT = ( a ) => ( a >= firstarg && a < pr_argc ) ? pr_globals_int[ OFS_PARM0 + 3 * a ] : 0;
	const GETARG_STRING = ( a ) => ( a >= firstarg && a < pr_argc ) ? PR_GetString( pr_globals_int[ OFS_PARM0 + 3 * a ] ) : '';
	const GETARG_VECTOR = ( a, j ) => ( a >= firstarg && a < pr_argc ) ? pr_globals_float[ OFS_PARM0 + 3 * a + j ] : 0;
	const GETARG_INTVECTOR = ( a, j ) => ( a >= firstarg && a < pr_argc ) ? pr_globals_int[ OFS_PARM0 + 3 * a + j ] : 0;

	// strtol at i: [ value, index after the digits ]
	const strtol = () => {

		let j = i;
		while ( j < s.length && s[ j ] >= '0' && s[ j ] <= '9' )
			j ++;
		return [ parseInt( s.slice( i, j ), 10 ), j ];

	};

	const emit = ( str ) => {

		if ( o.length < max )
			o += str.slice( 0, max - o.length );

	};

	finished:
	while ( i < s.length ) {

		const s0 = i;
		if ( s[ i ] !== '%' ) {

			emit( s[ i ] );
			i ++;
			continue;

		}

		i ++;
		if ( s[ i ] === '%' ) {

			emit( '%' );
			i ++;
			continue;

		}

		// complete directive format:
		// %3$*1$.*2$ld

		let width = - 1;
		let precision = - 1;
		let thisarg = - 1;
		let flags = 0;
		let isfloat = - 1;

		// is number following?
		if ( s[ i ] >= '0' && s[ i ] <= '9' ) {

			const [ value, err ] = strtol();
			width = value;
			if ( s[ err ] === '$' ) {

				thisarg = width + ( firstarg - 1 );
				width = - 1;
				i = err + 1;

			} else {

				if ( s[ i ] === '0' ) {

					flags |= PRINTF_ZEROPAD;
					if ( width === 0 )
						width = - 1; // it was just a flag

				}

				i = err;

			}

		}

		if ( width < 0 ) {

			flagloop:
			for ( ;; ) {

				switch ( s[ i ] ) {

					case '#': flags |= PRINTF_ALTERNATE; break;
					case '0': flags |= PRINTF_ZEROPAD; break;
					case '-': flags |= PRINTF_LEFT; break;
					case ' ': flags |= PRINTF_SPACEPOSITIVE; break;
					case '+': flags |= PRINTF_SIGNPOSITIVE; break;
					default:
						break flagloop;

				}

				i ++;

			}

			if ( s[ i ] === '*' ) {

				i ++;
				if ( s[ i ] >= '0' && s[ i ] <= '9' ) {

					const [ value, err ] = strtol();
					if ( s[ err ] !== '$' ) {

						Con_Warning( 'PF_sprintf: invalid format string: ' + s.slice( s0 ) + '\n' );
						break finished;

					}

					width = value;
					i = err + 1;

				} else {

					width = argpos ++;

				}

				width = Q_FloatToInt( GETARG_FLOAT( width ) );
				if ( width < 0 ) {

					flags |= PRINTF_LEFT;
					width = - width;

				}

			} else if ( s[ i ] >= '0' && s[ i ] <= '9' ) {

				const [ value, err ] = strtol();
				width = value;
				i = err;

			}
			// otherwise width stays -1

		}

		if ( s[ i ] === '.' ) {

			i ++;
			if ( s[ i ] === '*' ) {

				i ++;
				if ( s[ i ] >= '0' && s[ i ] <= '9' ) {

					const [ value, err ] = strtol();
					if ( s[ err ] !== '$' ) {

						Con_Warning( 'PF_sprintf: invalid format string: ' + s.slice( s0 ) + '\n' );
						break finished;

					}

					precision = value;
					i = err + 1;

				} else {

					precision = argpos ++;

				}

				precision = Q_FloatToInt( GETARG_FLOAT( precision ) );

			} else if ( s[ i ] >= '0' && s[ i ] <= '9' ) {

				const [ value, err ] = strtol();
				precision = value;
				i = err;

			} else {

				Con_Warning( 'PF_sprintf: invalid format string: ' + s.slice( s0 ) + '\n' );
				break finished;

			}

		}

		lengthloop:
		for ( ;; ) {

			switch ( s[ i ] ) {

				case 'h': isfloat = 1; break;
				case 'l': isfloat = 0; break;
				case 'L': isfloat = 0; break;
				case 'j': break;
				case 'z': break;
				case 't': break;
				default:
					break lengthloop;

			}

			i ++;

		}

		// now s[ i ] is the final directive char and is no longer changed
		let conv = s[ i ];
		if ( conv === 'p' || conv === 'P' ) {

			// %p is slightly different from %x.
			// always 8-bytes wide with 0 padding, always ints.
			flags |= PRINTF_ZEROPAD;
			if ( width < 0 ) width = 8;
			if ( isfloat < 0 ) isfloat = 0;

		} else if ( conv === 'i' ) {

			// %i defaults to ints, not floats.
			if ( isfloat < 0 ) isfloat = 0;

		}

		// assume floats, not ints.
		if ( isfloat < 0 )
			isfloat = 1;

		if ( thisarg < 0 )
			thisarg = argpos ++;

		if ( width < 0 ) // not set
			width = 0;

		if ( conv === 'p' )
			conv = 'x';
		else if ( conv === 'P' )
			conv = 'X';

		switch ( conv ) {

			case 'd': case 'i':
				emit( Q_FormatInt( conv, flags, width, precision,
					isfloat ? Q_FloatToInt( GETARG_FLOAT( thisarg ) ) : GETARG_INT( thisarg ) ) );
				break;

			case 'o': case 'u': case 'x': case 'X':
				emit( Q_FormatInt( conv, flags, width, precision,
					isfloat ? Q_FloatToUint( GETARG_FLOAT( thisarg ) ) : GETARG_INT( thisarg ) >>> 0 ) );
				break;

			case 'e': case 'E': case 'f': case 'F': case 'g': case 'G':
				emit( Q_FormatFloat( conv, flags, width, precision,
					isfloat ? GETARG_FLOAT( thisarg ) : GETARG_INT( thisarg ) ) );
				break;

			case 'v': case 'V': {

				const g = conv === 'v' ? 'g' : 'G';
				const parts = [];
				for ( let j = 0; j < 3; j ++ )
					parts.push( Q_FormatFloat( g, flags, width, precision,
						isfloat ? GETARG_VECTOR( thisarg, j ) : GETARG_INTVECTOR( thisarg, j ) ) );
				emit( parts.join( ' ' ) );
				break;

			}

			case 'c': {

				const c = isfloat ? Q_FloatToUint( GETARG_FLOAT( thisarg ) ) : GETARG_INT( thisarg ) >>> 0;
				emit( pad( String.fromCharCode( c & 0xff ), width, flags ) );
				break;

			}

			case 'S': {

				// tokenizable string
				let quotedarg = GETARG_STRING( thisarg );
				if ( /["\n\r]/.test( quotedarg ) || quotedarg.length + 3 >= 65536 ) {

					// our escapes suck...
					// Deliberate deviation: Ironwail points quotedarg at "" here
					// but still copies the original length from it, reading
					// past the literal (undefined behaviour); the port quotes
					// an empty string instead
					Con_Warning( 'PF_sprintf: unable to safely escape arg: ' + s.slice( s0 ) + '\n' );
					quotedarg = '';

				}

				quotedarg = '"' + quotedarg + '"';
				if ( precision >= 0 )
					quotedarg = quotedarg.slice( 0, precision );
				emit( pad( quotedarg, width, flags ) );
				break;

			}

			case 's': {

				let str = GETARG_STRING( thisarg );
				if ( precision >= 0 )
					str = str.slice( 0, precision );
				emit( pad( str, width, flags ) );
				break;

			}

			default:
				Con_Warning( 'PF_sprintf: invalid format string: ' + s.slice( s0 ) + '\n' );
				break finished;

		}

		i ++;

	}

	return o;

}
