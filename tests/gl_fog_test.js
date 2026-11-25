// Tests for src/gl_fog.js (Ironwail gl_fog.c): worldspawn parsing, the fog
// command's argument forms, fades and the per-frame Three.js fog.

import * as common from '../src/common.js';
import { Cmd_TokenizeString } from '../src/cmd.js';
import { cl } from '../src/client.js';
import {
	Fog_ParseWorldspawn, Sky_ParseSkyfog, Fog_FogCommand_f, Fog_GetState,
	Fog_GetColor, Fog_GetDensity, Fog_SetupFrame, Fog_GetSkyFog, Fog_ScanFloats,
	Fog_NewMap, r_skyfog
} from '../src/gl_fog.js';

function near( a, b, what ) {

	if ( Math.abs( a - b ) > 1e-6 )
		throw new Error( what + ': expected ' + b + ', got ' + a );

}

function worldspawn( keys ) {

	return '{\n"classname" "worldspawn"\n' + keys + '\n}\n{\n"classname" "light"\n"fog" "0.9 1 1 1"\n}\n';

}

function runFog( args ) {

	Cmd_TokenizeString( 'fog ' + args );
	Fog_FogCommand_f();

}

function withTime( t, fn ) {

	const saved = cl.time;
	cl.time = t;
	try {

		fn();

	} finally {

		cl.time = saved;

	}

}

Deno.test( 'Fog_ParseWorldspawn reads the worldspawn fog key and resets to no fog', () => {

	withTime( 0, () => {

		Fog_ParseWorldspawn( worldspawn( '"fog" "0.025 0.576471 0.266667 0.431373"' ) );
		let s = Fog_GetState();
		near( s.density, 0.025, 'density' );
		near( s.red, 0.576471, 'red' );
		near( s.green, 0.266667, 'green' );
		near( s.blue, 0.431373, 'blue' );

		// a map without the key: no fog, grey
		Fog_ParseWorldspawn( worldspawn( '"message" "x"' ) );
		s = Fog_GetState();
		near( s.density, 0, 'no-fog density' );
		near( s.red, 0.3, 'no-fog red' );
		if ( s.fade_time !== 0 || s.fade_done !== 0 ) throw new Error( 'fade not reset' );

		// a leading '_' is stripped, and only the worldspawn is read
		Fog_ParseWorldspawn( worldspawn( '"_fog" "0.05 1 0 0"' ) );
		near( Fog_GetDensity(), 0.05, '_fog density' );
		near( Fog_GetState().red, 1, '_fog red' );

	} );

} );

Deno.test( 'Fog_ParseWorldspawn keeps the defaults for fields sscanf does not fill', () => {

	withTime( 0, () => {

		Fog_ParseWorldspawn( worldspawn( '"fog" "0.05"' ) );
		let s = Fog_GetState();
		near( s.density, 0.05, 'density' );
		near( s.red, 0.3, 'red' );
		near( s.blue, 0.3, 'blue' );

		Fog_ParseWorldspawn( worldspawn( '"fog" "0.05 0.5 x 0.9"' ) );
		s = Fog_GetState();
		near( s.red, 0.5, 'red before the bad field' );
		near( s.green, 0.3, 'green at the bad field' );
		near( s.blue, 0.3, 'blue after the bad field' );

		// mg1/mg3/dopa's fog_* keys are QuakeC fields, not engine keys
		Fog_ParseWorldspawn( worldspawn( '"fog_density" "0.03"\n"fog_color" "60 55 50"' ) );
		near( Fog_GetDensity(), 0, 'fog_* ignored' );

		Fog_ParseWorldspawn( null );
		near( Fog_GetDensity(), 0, 'no entities' );

	} );

} );

Deno.test( 'Fog_ScanFloats matches sscanf %f prefixes', () => {

	const out = [ 9, 9, 9 ];
	if ( Fog_ScanFloats( ' 1.5 -2e1 .25', out ) !== 3 ) throw new Error( 'count' );
	near( out[ 1 ], - 20, 'exponent' );
	near( out[ 2 ], 0.25, 'leading dot' );
	const out2 = [ 9, 9 ];
	if ( Fog_ScanFloats( '3abc 4', out2 ) !== 1 ) throw new Error( 'stops after a partial field' );
	near( out2[ 0 ], 3, 'prefix' );
	near( out2[ 1 ], 9, 'untouched' );

} );

Deno.test( 'fog command argument forms, clamping and usage', () => {

	const printed = [];
	common.Con_SetPrintFunctions( ( msg ) => printed.push( msg ), () => {} );
	try {

		withTime( 10, () => {

			Fog_ParseWorldspawn( worldspawn( '' ) );

			runFog( '0.04' );
			let s = Fog_GetState();
			near( s.density, 0.04, '1 arg density' );
			near( s.red, 0.3, '1 arg keeps colour' );

			runFog( '0.2 0.4 0.6' );
			s = Fog_GetState();
			near( s.density, 0.04, '3 args keep density' );
			near( s.green, 0.4, '3 args green' );

			runFog( '0.1 1 0 0' );
			s = Fog_GetState();
			near( s.density, 0.1, '4 args density' );
			near( s.red, 1, '4 args red' );
			if ( s.fade_time !== 0 ) throw new Error( 'no fade without a time' );

			runFog( '-1 2 -3 0.5' );
			s = Fog_GetState();
			near( s.density, 0, 'density clamped at 0' );
			near( s.red, 1, 'red clamped at 1' );
			near( s.green, 0, 'green clamped at 0' );
			near( s.blue, 0.5, 'blue' );

			runFog( '' );
			const text = printed.join( '' );
			if ( ! text.includes( 'usage:' ) || ! text.includes( '"red"     is "1"' ) || ! text.includes( '"blue"    is "0.5"' ) )
				throw new Error( 'usage text: ' + text );

		} );

	} finally {

		common.Con_SetPrintFunctions( null, null );

	}

} );

Deno.test( 'timed fog commands fade on cl.time, and a new fade starts from the current mix', () => {

	withTime( 100, () => {

		Fog_ParseWorldspawn( worldspawn( '' ) );
		runFog( '0.1 1 0 0' );

		// fog <density> <red> <green> <blue> <time>
		runFog( '0.3 0 1 0 2' );

	} );

	withTime( 101, () => {

		near( Fog_GetDensity(), 0.2, 'halfway density' );
		const c = Fog_GetColor();
		near( c[ 0 ], Math.round( 0.5 * 255 ) / 255, 'halfway red, rounded to 24-bit' );
		near( c[ 1 ], Math.round( 0.5 * 255 ) / 255, 'halfway green' );

		// a new fade from mid-fade starts at the current mix
		runFog( '0 4' ); // fog <density> <time>
		const s = Fog_GetState();
		near( s.old_density, 0.2, 'old density is the current mix' );
		near( s.old_red, 0.5, 'old red is the current mix' );
		near( s.red, 0, 'colour kept by the 2-arg form' );
		near( s.green, 1, 'colour kept by the 2-arg form' );

	} );

	withTime( 103, () => near( Fog_GetDensity(), 0.1, 'second fade halfway' ) );
	withTime( 105, () => near( Fog_GetDensity(), 0, 'fade done' ) );

} );

Deno.test( 'Fog_SetupFrame sets scene.fog only while the fog is on', () => {

	const scene = { fog: null, scale: { x: 1 } };
	const savedSky = r_skyfog.value;
	try {

		withTime( 0, () => {

			Fog_NewMap( { entities: worldspawn( '' ) } );
			Fog_SetupFrame( scene );
			if ( scene.fog !== null ) throw new Error( 'no-fog map got scene.fog' );
			near( Fog_GetSkyFog().w, 0, 'no sky fog without fog' );

			Fog_NewMap( { entities: worldspawn( '"fog" "0.032 1 0.5 0"' ) } );
			Fog_SetupFrame( scene );
			if ( scene.fog === null ) throw new Error( 'fogged map has no scene.fog' );
			near( scene.fog.density, 0.032 / 64, 'FogExp2 density' );
			near( scene.fog.color.r, 1, 'fog colour' );
			near( scene.fog.color.g, 128 / 255, 'fog colour rounded to 24-bit' );
			const fogObject = scene.fog;
			near( Fog_GetSkyFog().w, 0.5, 'r_skyfog default' );
			near( Fog_GetSkyFog().x, 1, 'sky fog colour' );

			Fog_SetupFrame( scene );
			if ( scene.fog !== fogObject ) throw new Error( 'fog object should be reused' );

			runFog( '0' );
			Fog_SetupFrame( scene );
			if ( scene.fog !== null ) throw new Error( 'fog 0 should clear scene.fog' );

		} );

	} finally {

		r_skyfog.value = savedSky;
		r_skyfog.string = String( savedSky );

	}

} );

Deno.test( 'skyfog worldspawn key overrides r_skyfog until the cvar changes', () => {

	const savedValue = r_skyfog.value;
	const savedString = r_skyfog.string;
	const scene = { fog: null, scale: { x: 1 } };
	try {

		withTime( 0, () => {

			const ents = worldspawn( '"fog" "0.05 0.2 0.2 0.2"\n"_skyfog" "0.8"' );
			Sky_ParseSkyfog( ents );
			Fog_ParseWorldspawn( ents );
			Fog_SetupFrame( scene );
			near( Fog_GetSkyFog().w, 0.8, 'map skyfog' );
			near( Fog_GetState().skyfog, 0.8, 'state skyfog' );

			// R_SetSkyfog_f: setting the cvar overrides the map's value
			r_skyfog.value = 0.1;
			Fog_SetupFrame( scene );
			near( Fog_GetSkyFog().w, 0.1, 'cvar skyfog' );

			// clamped to [0, 1] in Fog_SetupFrame
			r_skyfog.value = 3;
			Fog_SetupFrame( scene );
			near( Fog_GetSkyFog().w, 1, 'clamped skyfog' );

		} );

	} finally {

		r_skyfog.value = savedValue;
		r_skyfog.string = savedString;

	}

} );
