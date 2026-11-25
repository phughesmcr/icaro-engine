// Ported from: WinQuake/r_part.c -- particle system

import * as THREE from 'three';
import { VectorCopy, VectorSubtract, VectorNormalize } from './mathlib.js';
import { r_avertexnormals } from './anorm_dots.js';
import { d_8to24table } from './vid.js';
import { cl as client_cl } from './client.js';
import { GL_RegisterTexture } from './glquake.js';
import { isXRActive, XR_SCALE } from './webxr.js';
import { Con_Printf, COM_StripExtension } from './common.js';
import { COM_EnsureFile, COM_LoadFileAsString } from './pak.js';

// Deliberate deviation, from Ironwail (r_part.c): id's limit is 2048, and
// one R_ParticleExplosion takes 1024 of them, so two explosions at once used
// up the pool and later effects were dropped. Only the live particles are
// uploaded each frame (see R_DrawParticles), so the bigger pool costs memory
// (about 3 MB) but no per-frame upload.
const MAX_PARTICLES = 16384;

// Precomputed sRGB -> linear lookup table (256 entries)
// Quake palette values are sRGB; Three.js expects vertex colors in linear space.
const srgbToLinear = new Float32Array( 256 );
for ( let i = 0; i < 256; i ++ ) {

	const s = i / 255;
	srgbToLinear[ i ] = s <= 0.04045 ? s / 12.92 : Math.pow( ( s + 0.055 ) / 1.055, 2.4 );

}

const ramp1 = [ 0x6f, 0x6d, 0x6b, 0x69, 0x67, 0x65, 0x63, 0x61 ];
const ramp2 = [ 0x6f, 0x6e, 0x6d, 0x6c, 0x6b, 0x6a, 0x68, 0x66 ];
const ramp3 = [ 0x6d, 0x6b, 6, 5, 4, 3 ];

// particle types
const pt_static = 0;
const pt_grav = 1;
const pt_slowgrav = 2;
const pt_fire = 3;
const pt_explode = 4;
const pt_explode2 = 5;
const pt_blob = 6;
const pt_blob2 = 7;

class particle_t {

	constructor() {

		this.org = new Float32Array( 3 );
		this.vel = new Float32Array( 3 );
		this.color = 0;
		this.ramp = 0;
		this.die = - 1;
		this.type = pt_static;

	}

}

// Particle pool — use array index as linked list via nextIndex
const particles = new Array( MAX_PARTICLES );
const particleNext = new Int32Array( MAX_PARTICLES ); // -1 = end of list

let activeList = - 1; // head index of active list
let freeList = - 1; // head index of free list

// External state
let _scene = null;
let _sv_gravity = { value: 800 }; // cvar-like default; canonical cvar injected by Host_Init

// THREE.js rendering objects
let pointsGeometry = null;
let pointsMaterial = null;
let pointsMesh = null;
let particleTexture = null;

/*
Particle size, from gl_rmisc.c R_DrawParticles:

	scale = (p->org - r_origin) . vpn;
	if (scale < 20) scale = 1; else scale = 1 + scale * 0.004;

Each particle is a triangle with 1.5 * scale legs, textured so the 4x4 dot in
the 8x8 texture covers half of each leg. A point sprite of world size
1.5 * scale shows the same dot. Three.js attenuates point size as
size * scale / depth, which ignores the projection, so the vertex shader is
patched to give the sprite a world size instead.
*/
const PARTICLE_SIZE = 1.5;
// Quake units per scene unit: 1, or XR_SCALE while scene.scale = 1/XR_SCALE
const _particleUnits = { value: 1 };

const _particleSizeChunk = /* glsl */`
	#ifdef USE_SIZEATTENUATION

		bool isPerspective = isPerspectiveMatrix( projectionMatrix );

		if ( isPerspective ) {

			// R_DrawParticles: depth along vpn, in Quake units
			float qdepth = - mvPosition.z * quakeUnits;
			float qscale = qdepth < 20.0 ? 1.0 : 1.0 + qdepth * 0.004;
			gl_PointSize *= qscale * projectionMatrix[ 1 ][ 1 ] * scale / - mvPosition.z;

		}

	#endif
`;

export function R_PatchParticleShader( shader ) {

	shader.uniforms.quakeUnits = _particleUnits;
	shader.vertexShader = shader.vertexShader
		.replace( 'uniform float scale;', 'uniform float scale;\nuniform float quakeUnits;' )
		.replace( /#ifdef USE_SIZEATTENUATION[\s\S]*?#endif/, _particleSizeChunk );

}

const positionArray = new Float32Array( MAX_PARTICLES * 3 );
const colorArray = new Float32Array( MAX_PARTICLES * 3 );

let tracercount = 0;

/*
===============
R_InitParticleTexture

Matches gl_rmisc.c R_InitParticleTexture — 8x8 white dot with alpha diamond
===============
*/
function R_InitParticleTexture() {

	const dottexture = [
		[ 0, 1, 1, 0, 0, 0, 0, 0 ],
		[ 1, 1, 1, 1, 0, 0, 0, 0 ],
		[ 1, 1, 1, 1, 0, 0, 0, 0 ],
		[ 0, 1, 1, 0, 0, 0, 0, 0 ],
		[ 0, 0, 0, 0, 0, 0, 0, 0 ],
		[ 0, 0, 0, 0, 0, 0, 0, 0 ],
		[ 0, 0, 0, 0, 0, 0, 0, 0 ],
		[ 0, 0, 0, 0, 0, 0, 0, 0 ]
	];

	const data = new Uint8Array( 8 * 8 * 4 );
	for ( let x = 0; x < 8; x ++ ) {

		for ( let y = 0; y < 8; y ++ ) {

			const idx = ( y * 8 + x ) * 4;
			data[ idx ] = 255;
			data[ idx + 1 ] = 255;
			data[ idx + 2 ] = 255;
			data[ idx + 3 ] = dottexture[ x ][ y ] * 255;

		}

	}

	particleTexture = new THREE.DataTexture( data, 8, 8, THREE.RGBAFormat );
	// gl_rmisc.c R_InitParticleTexture: always GL_LINEAR, whatever
	// gl_texturemode says
	particleTexture.magFilter = THREE.LinearFilter;
	particleTexture.minFilter = THREE.LinearFilter;
	particleTexture.colorSpace = THREE.SRGBColorSpace;
	particleTexture.needsUpdate = true;

	// Register for filter updates when setting changes
	GL_RegisterTexture( particleTexture );

}

/*
===============
R_InitParticles
===============
*/
export function R_InitParticles() {

	for ( let i = 0; i < MAX_PARTICLES; i ++ ) {

		particles[ i ] = new particle_t();

	}

	R_ClearParticles();
	R_InitParticleTexture();

}

/*
===============
R_SetParticleExternals
===============
*/
export function R_SetParticleExternals( externals ) {

	if ( externals.scene ) _scene = externals.scene;
	if ( externals.sv_gravity != null ) _sv_gravity = externals.sv_gravity;

}

/*
===============
R_ClearParticles
===============
*/
export function R_ClearParticles() {

	activeList = - 1;

	freeList = 0;
	for ( let i = 0; i < MAX_PARTICLES - 1; i ++ ) {

		particleNext[ i ] = i + 1;

	}

	particleNext[ MAX_PARTICLES - 1 ] = - 1;

}

function allocParticle() {

	if ( freeList === - 1 ) return null;

	const idx = freeList;
	freeList = particleNext[ idx ];

	particleNext[ idx ] = activeList;
	activeList = idx;

	const p = particles[ idx ];
	p.org[ 0 ] = 0; p.org[ 1 ] = 0; p.org[ 2 ] = 0;
	p.vel[ 0 ] = 0; p.vel[ 1 ] = 0; p.vel[ 2 ] = 0;
	p.color = 0;
	p.ramp = 0;
	p.die = - 1;
	p.type = pt_static;

	return p;

}

/*
===============
R_ParsePointFile

The fscanf( f, "%f %f %f\n", ... ) loop of R_ReadPointFile_f: read
whitespace-separated triples until one fails to parse. Returns the
coordinates as a flat array, three per point.
===============
*/
export function R_ParsePointFile( text ) {

	const tokens = text.split( /\s+/ ).filter( ( t ) => t.length > 0 );
	const out = [];
	for ( let i = 0; i + 2 < tokens.length; i += 3 ) {

		const x = parseFloat( tokens[ i ] );
		const y = parseFloat( tokens[ i + 1 ] );
		const z = parseFloat( tokens[ i + 2 ] );
		if ( Number.isNaN( x ) || Number.isNaN( y ) || Number.isNaN( z ) )
			break;
		out.push( x, y, z );

	}

	return out;

}

/*
===============
R_LoadPointFile

The particle half of R_ReadPointFile_f: one static particle per point,
coloured ( -c ) & 15, that never dies. Returns the number of points read.
===============
*/
export function R_LoadPointFile( coords ) {

	let c = 0;
	for ( let i = 0; i + 2 < coords.length; i += 3 ) {

		c ++;

		const p = allocParticle();
		if ( p === null ) {

			Con_Printf( 'Not enough free particles\n' );
			break;

		}

		p.die = 99999;
		p.color = ( - c ) & 15;
		p.type = pt_static;
		p.org[ 0 ] = coords[ i ];
		p.org[ 1 ] = coords[ i + 1 ];
		p.org[ 2 ] = coords[ i + 2 ];

	}

	return c;

}

/*
===============
R_ReadPointFile_f

Deviation: C opens maps/<sv.name>.pts, which only exists on the server host.
The port names it after the client's world model ( maps/e1m1.bsp gives
maps/e1m1.pts ), the same file whenever the server is local, and it also
works when connected to a remote server. Loose .pts files (written by qbsp
on a leak) are fetched on demand, so the particles appear once it arrives.
===============
*/
export function R_ReadPointFile_f() {

	if ( client_cl === null || client_cl.worldmodel === null || client_cl.worldmodel === undefined ) {

		Con_Printf( 'pointfile: no map loaded\n' );
		return;

	}

	const name = COM_StripExtension( client_cl.worldmodel.name ) + '.pts';
	const worldmodel = client_cl.worldmodel;

	COM_EnsureFile( name ).then( ( found ) => {

		// the map changed while the file was loading
		if ( client_cl.worldmodel !== worldmodel ) return;

		const text = found === true ? COM_LoadFileAsString( name ) : null;
		if ( text === null ) {

			Con_Printf( 'couldn\'t open ' + name + '\n' );
			return;

		}

		Con_Printf( 'Reading ' + name + '...\n' );
		const c = R_LoadPointFile( R_ParsePointFile( text ) );
		Con_Printf( c + ' points read\n' );

	} );

}

/*
===============
R_ParticleExplosion
===============
*/
export function R_ParticleExplosion( org ) {

	if ( ! client_cl ) return;

	for ( let i = 0; i < 1024; i ++ ) {

		const p = allocParticle();
		if ( ! p ) return;

		p.die = client_cl.time + 5;
		p.color = ramp1[ 0 ];
		p.ramp = Math.random() * 4 | 0;

		if ( i & 1 ) {

			p.type = pt_explode;
			for ( let j = 0; j < 3; j ++ ) {

				p.org[ j ] = org[ j ] + ( ( Math.random() * 32 | 0 ) - 16 );
				p.vel[ j ] = ( Math.random() * 512 | 0 ) - 256;

			}

		} else {

			p.type = pt_explode2;
			for ( let j = 0; j < 3; j ++ ) {

				p.org[ j ] = org[ j ] + ( ( Math.random() * 32 | 0 ) - 16 );
				p.vel[ j ] = ( Math.random() * 512 | 0 ) - 256;

			}

		}

	}

}

/*
===============
R_ParticleExplosion2
===============
*/
export function R_ParticleExplosion2( org, colorStart, colorLength ) {

	if ( ! client_cl ) return;
	let colorMod = 0;

	for ( let i = 0; i < 512; i ++ ) {

		const p = allocParticle();
		if ( ! p ) return;

		p.die = client_cl.time + 0.3;
		p.color = colorStart + ( colorMod % colorLength );
		colorMod ++;
		p.type = pt_blob;

		for ( let j = 0; j < 3; j ++ ) {

			p.org[ j ] = org[ j ] + ( ( Math.random() * 32 | 0 ) - 16 );
			p.vel[ j ] = ( Math.random() * 512 | 0 ) - 256;

		}

	}

}

/*
===============
R_BlobExplosion
===============
*/
export function R_BlobExplosion( org ) {

	if ( ! client_cl ) return;

	for ( let i = 0; i < 1024; i ++ ) {

		const p = allocParticle();
		if ( ! p ) return;

		p.die = client_cl.time + 1 + ( Math.random() * 8 | 0 ) * 0.05;

		if ( i & 1 ) {

			p.type = pt_blob;
			p.color = 66 + ( Math.random() * 6 | 0 );

		} else {

			p.type = pt_blob2;
			p.color = 150 + ( Math.random() * 6 | 0 );

		}

		for ( let j = 0; j < 3; j ++ ) {

			p.org[ j ] = org[ j ] + ( ( Math.random() * 32 | 0 ) - 16 );
			p.vel[ j ] = ( Math.random() * 512 | 0 ) - 256;

		}

	}

}

/*
===============
R_RunParticleEffect
===============
*/
export function R_RunParticleEffect( org, dir, color, count ) {

	if ( ! client_cl ) return;

	for ( let i = 0; i < count; i ++ ) {

		const p = allocParticle();
		if ( ! p ) return;

		if ( count === 1024 ) {

			// rocket explosion
			p.die = client_cl.time + 5;
			p.color = ramp1[ 0 ];
			p.ramp = Math.random() * 4 | 0;

			if ( i & 1 ) {

				p.type = pt_explode;
				for ( let j = 0; j < 3; j ++ ) {

					p.org[ j ] = org[ j ] + ( ( Math.random() * 32 | 0 ) - 16 );
					p.vel[ j ] = ( Math.random() * 512 | 0 ) - 256;

				}

			} else {

				p.type = pt_explode2;
				for ( let j = 0; j < 3; j ++ ) {

					p.org[ j ] = org[ j ] + ( ( Math.random() * 32 | 0 ) - 16 );
					p.vel[ j ] = ( Math.random() * 512 | 0 ) - 256;

				}

			}

		} else {

			p.die = client_cl.time + 0.1 * ( Math.random() * 5 | 0 );
			p.color = ( color & ~ 7 ) + ( Math.random() * 8 | 0 );
			p.type = pt_slowgrav;

			for ( let j = 0; j < 3; j ++ ) {

				p.org[ j ] = org[ j ] + ( ( Math.random() * 16 | 0 ) - 8 );
				p.vel[ j ] = dir[ j ] * 15;

			}

		}

	}

}

/*
===============
R_LavaSplash
===============
*/
export function R_LavaSplash( org ) {

	if ( ! client_cl ) return;
	const dir = new Float32Array( 3 );

	for ( let i = - 16; i < 16; i ++ ) {

		for ( let j = - 16; j < 16; j ++ ) {

			const p = allocParticle();
			if ( ! p ) return;

			p.die = client_cl.time + 2 + ( Math.random() * 32 | 0 ) * 0.02;
			p.color = 224 + ( Math.random() * 8 | 0 );
			p.type = pt_slowgrav;

			dir[ 0 ] = j * 8 + ( Math.random() * 8 | 0 );
			dir[ 1 ] = i * 8 + ( Math.random() * 8 | 0 );
			dir[ 2 ] = 256;

			p.org[ 0 ] = org[ 0 ] + dir[ 0 ];
			p.org[ 1 ] = org[ 1 ] + dir[ 1 ];
			p.org[ 2 ] = org[ 2 ] + ( Math.random() * 64 | 0 );

			VectorNormalize( dir );
			const vel = 50 + ( Math.random() * 64 | 0 );
			p.vel[ 0 ] = dir[ 0 ] * vel;
			p.vel[ 1 ] = dir[ 1 ] * vel;
			p.vel[ 2 ] = dir[ 2 ] * vel;

		}

	}

}

/*
===============
R_TeleportSplash
===============
*/
export function R_TeleportSplash( org ) {

	if ( ! client_cl ) return;
	const dir = new Float32Array( 3 );

	for ( let i = - 16; i < 16; i += 4 ) {

		for ( let j = - 16; j < 16; j += 4 ) {

			for ( let k = - 24; k < 32; k += 4 ) {

				const p = allocParticle();
				if ( ! p ) return;

				p.die = client_cl.time + 0.2 + ( Math.random() * 8 | 0 ) * 0.02;
				p.color = 7 + ( Math.random() * 8 | 0 );
				p.type = pt_slowgrav;

				dir[ 0 ] = j * 8;
				dir[ 1 ] = i * 8;
				dir[ 2 ] = k * 8;

				p.org[ 0 ] = org[ 0 ] + i + ( Math.random() * 4 | 0 );
				p.org[ 1 ] = org[ 1 ] + j + ( Math.random() * 4 | 0 );
				p.org[ 2 ] = org[ 2 ] + k + ( Math.random() * 4 | 0 );

				VectorNormalize( dir );
				const vel = 50 + ( Math.random() * 64 | 0 );
				p.vel[ 0 ] = dir[ 0 ] * vel;
				p.vel[ 1 ] = dir[ 1 ] * vel;
				p.vel[ 2 ] = dir[ 2 ] * vel;

			}

		}

	}

}

/*
===============
R_RocketTrail
===============
*/
export function R_RocketTrail( start, end, type ) {

	if ( ! client_cl ) return;

	const vec = new Float32Array( 3 );
	const s = new Float32Array( 3 );
	VectorCopy( start, s );
	VectorSubtract( end, s, vec );
	let len = VectorNormalize( vec );

	let dec;
	if ( type < 128 ) {

		dec = 3;

	} else {

		dec = 1;
		type -= 128;

	}

	while ( len > 0 ) {

		len -= dec;

		const p = allocParticle();
		if ( ! p ) return;

		p.vel[ 0 ] = 0; p.vel[ 1 ] = 0; p.vel[ 2 ] = 0;
		p.die = client_cl.time + 2;

		switch ( type ) {

			case 0: // rocket trail
				p.ramp = Math.random() * 4 | 0;
				p.color = ramp3[ Math.min( p.ramp | 0, ramp3.length - 1 ) ];
				p.type = pt_fire;
				for ( let j = 0; j < 3; j ++ )
					p.org[ j ] = s[ j ] + ( ( Math.random() * 6 | 0 ) - 3 );
				break;

			case 1: // smoke
				p.ramp = ( Math.random() * 4 | 0 ) + 2;
				p.color = ramp3[ Math.min( p.ramp | 0, ramp3.length - 1 ) ];
				p.type = pt_fire;
				for ( let j = 0; j < 3; j ++ )
					p.org[ j ] = s[ j ] + ( ( Math.random() * 6 | 0 ) - 3 );
				break;

			case 2: // blood
				p.type = pt_grav;
				p.color = 67 + ( Math.random() * 4 | 0 );
				for ( let j = 0; j < 3; j ++ )
					p.org[ j ] = s[ j ] + ( ( Math.random() * 6 | 0 ) - 3 );
				break;

			case 3: // tracer
			case 5:
				p.die = client_cl.time + 0.5;
				p.type = pt_static;
				if ( type === 3 )
					p.color = 52 + ( ( tracercount & 4 ) << 1 );
				else
					p.color = 230 + ( ( tracercount & 4 ) << 1 );
				tracercount ++;
				VectorCopy( s, p.org );
				if ( tracercount & 1 ) {

					p.vel[ 0 ] = 30 * vec[ 1 ];
					p.vel[ 1 ] = 30 * - vec[ 0 ];

				} else {

					p.vel[ 0 ] = 30 * - vec[ 1 ];
					p.vel[ 1 ] = 30 * vec[ 0 ];

				}

				break;

			case 4: // slight blood
				p.type = pt_grav;
				p.color = 67 + ( Math.random() * 4 | 0 );
				for ( let j = 0; j < 3; j ++ )
					p.org[ j ] = s[ j ] + ( ( Math.random() * 6 | 0 ) - 3 );
				len -= 3;
				break;

			case 6: // voor trail
				p.color = 9 * 16 + 8 + ( Math.random() * 4 | 0 );
				p.type = pt_static;
				p.die = client_cl.time + 0.3;
				for ( let j = 0; j < 3; j ++ )
					p.org[ j ] = s[ j ] + ( ( Math.random() * 16 | 0 ) - 8 );
				break;

		}

		s[ 0 ] += vec[ 0 ];
		s[ 1 ] += vec[ 1 ];
		s[ 2 ] += vec[ 2 ];

	}

}

/*
===============
R_EntityParticles

Glowing particle aura around entities with EF_BRIGHTFIELD (e.g. Quad Damage)
===============
*/

const NUMVERTEXNORMALS = 162;
const avelocities = new Array( NUMVERTEXNORMALS );
let _avelocitiesInitialized = false;
const _epForward = new Float32Array( 3 );
const beamlength = 16;

export function R_EntityParticles( ent ) {

	if ( client_cl == null ) return;

	const dist = 64;

	if ( ! _avelocitiesInitialized ) {

		for ( let i = 0; i < NUMVERTEXNORMALS; i ++ ) {

			avelocities[ i ] = new Float32Array( 3 );
			avelocities[ i ][ 0 ] = ( Math.random() * 256 | 0 ) * 0.01;
			avelocities[ i ][ 1 ] = ( Math.random() * 256 | 0 ) * 0.01;
			avelocities[ i ][ 2 ] = ( Math.random() * 256 | 0 ) * 0.01;

		}

		_avelocitiesInitialized = true;

	}

	for ( let i = 0; i < NUMVERTEXNORMALS; i ++ ) {

		let angle = client_cl.time * avelocities[ i ][ 0 ];
		const sy = Math.sin( angle );
		const cy = Math.cos( angle );
		angle = client_cl.time * avelocities[ i ][ 1 ];
		const sp = Math.sin( angle );
		const cp = Math.cos( angle );
		angle = client_cl.time * avelocities[ i ][ 2 ];

		_epForward[ 0 ] = cp * cy;
		_epForward[ 1 ] = cp * sy;
		_epForward[ 2 ] = - sp;

		const p = allocParticle();
		if ( p == null ) return;

		p.die = client_cl.time + 0.01;
		p.color = 0x6f;
		p.type = pt_explode;

		p.org[ 0 ] = ent.origin[ 0 ] + r_avertexnormals[ i ][ 0 ] * dist + _epForward[ 0 ] * beamlength;
		p.org[ 1 ] = ent.origin[ 1 ] + r_avertexnormals[ i ][ 1 ] * dist + _epForward[ 1 ] * beamlength;
		p.org[ 2 ] = ent.origin[ 2 ] + r_avertexnormals[ i ][ 2 ] * dist + _epForward[ 2 ] * beamlength;

	}

}

/*
===============
R_MarkParticleUpload

Not in C. Three.js uploads a whole buffer attribute when needsUpdate is set;
limit the upload to the first count particles, which are the live ones.
(The server's Three.js shim has no update ranges, hence the check.)
===============
*/
export function R_MarkParticleUpload( attribute, count ) {

	if ( attribute.clearUpdateRanges !== undefined ) {

		attribute.clearUpdateRanges();
		attribute.addUpdateRange( 0, count * attribute.itemSize );

	}

	attribute.needsUpdate = true;

}

/*
===============
R_DrawParticles
===============
*/
export function R_DrawParticles() {

	if ( ! client_cl || ! _scene ) return;

	// cl.time can be modified by CL_LerpPoint, but an exact zero delta means
	// the client is paused and particle physics must remain frozen.
	let frametime = client_cl.time - client_cl.oldtime;
	if ( frametime < 0 || frametime > 0.5 ) {

		// Fallback to a reasonable frametime for particle physics
		// but still process dead particle removal
		frametime = 0.016; // ~60fps default

	}

	const time3 = frametime * 15;
	const time2 = frametime * 10;
	const time1 = frametime * 5;
	const grav = frametime * _sv_gravity.value * 0.05;
	const dvel = 4 * frametime;

	// Remove dead particles from front of active list
	while ( activeList !== - 1 && particles[ activeList ].die < client_cl.time ) {

		const killIdx = activeList;
		activeList = particleNext[ killIdx ];
		particleNext[ killIdx ] = freeList;
		freeList = killIdx;

	}

	// Walk active list, remove dead and update physics
	let count = 0;
	let prevIdx = - 1;
	let idx = activeList;

	while ( idx !== - 1 ) {

		const nextIdx = particleNext[ idx ];

		// Remove dead particles in the middle of the list
		if ( particles[ idx ].die < client_cl.time ) {

			if ( prevIdx !== - 1 ) {

				particleNext[ prevIdx ] = nextIdx;

			} else {

				activeList = nextIdx;

			}

			particleNext[ idx ] = freeList;
			freeList = idx;
			idx = nextIdx;
			continue;

		}

		const p = particles[ idx ];

		// Store position for rendering (raw Quake coordinates — camera uses them too)
		positionArray[ count * 3 ] = p.org[ 0 ];
		positionArray[ count * 3 + 1 ] = p.org[ 1 ];
		positionArray[ count * 3 + 2 ] = p.org[ 2 ];

		// Convert palette color to linear RGB (palette is sRGB, Three.js expects linear)
		const rgba = d_8to24table[ p.color & 0xff ];
		colorArray[ count * 3 ] = srgbToLinear[ rgba & 0xff ];
		colorArray[ count * 3 + 1 ] = srgbToLinear[ ( rgba >> 8 ) & 0xff ];
		colorArray[ count * 3 + 2 ] = srgbToLinear[ ( rgba >> 16 ) & 0xff ];

		count ++;

		// Update physics
		p.org[ 0 ] += p.vel[ 0 ] * frametime;
		p.org[ 1 ] += p.vel[ 1 ] * frametime;
		p.org[ 2 ] += p.vel[ 2 ] * frametime;

		switch ( p.type ) {

			case pt_static:
				break;

			case pt_fire:
				p.ramp += time1;
				if ( p.ramp >= 6 )
					p.die = - 1;
				else
					p.color = ramp3[ Math.min( p.ramp | 0, ramp3.length - 1 ) ];
				p.vel[ 2 ] += grav;
				break;

			case pt_explode:
				p.ramp += time2;
				if ( p.ramp >= 8 )
					p.die = - 1;
				else
					p.color = ramp1[ Math.min( p.ramp | 0, ramp1.length - 1 ) ];
				for ( let i = 0; i < 3; i ++ )
					p.vel[ i ] += p.vel[ i ] * dvel;
				p.vel[ 2 ] -= grav;
				break;

			case pt_explode2:
				p.ramp += time3;
				if ( p.ramp >= 8 )
					p.die = - 1;
				else
					p.color = ramp2[ Math.min( p.ramp | 0, ramp2.length - 1 ) ];
				for ( let i = 0; i < 3; i ++ )
					p.vel[ i ] -= p.vel[ i ] * frametime;
				p.vel[ 2 ] -= grav;
				break;

			case pt_blob:
				for ( let i = 0; i < 3; i ++ )
					p.vel[ i ] += p.vel[ i ] * dvel;
				p.vel[ 2 ] -= grav;
				break;

			case pt_blob2:
				for ( let i = 0; i < 2; i ++ )
					p.vel[ i ] -= p.vel[ i ] * dvel;
				p.vel[ 2 ] -= grav;
				break;

			case pt_grav:
				p.vel[ 2 ] -= grav;
				break;

			case pt_slowgrav:
				p.vel[ 2 ] -= grav;
				break;

		}

		prevIdx = idx;
		idx = nextIdx;

	}

	// Render particles as THREE.Points
	if ( count === 0 ) {

		if ( pointsMesh && pointsMesh.parent ) {

			_scene.remove( pointsMesh );

		}

		return;

	}

	if ( ! pointsGeometry ) {

		pointsGeometry = new THREE.BufferGeometry();
		const positionAttribute = new THREE.BufferAttribute( positionArray, 3 );
		const colorAttribute = new THREE.BufferAttribute( colorArray, 3 );
		if ( positionAttribute.setUsage !== undefined ) {

			positionAttribute.setUsage( THREE.DynamicDrawUsage );
			colorAttribute.setUsage( THREE.DynamicDrawUsage );

		}

		pointsGeometry.setAttribute( 'position', positionAttribute );
		pointsGeometry.setAttribute( 'color', colorAttribute );

		pointsMaterial = new THREE.PointsMaterial( {
			size: PARTICLE_SIZE,
			sizeAttenuation: true,
			vertexColors: true,
			depthWrite: false,
			transparent: true,
			map: particleTexture
		} );
		pointsMaterial.onBeforeCompile = R_PatchParticleShader;
		pointsMaterial.customProgramCacheKey = () => 'quake-particles';

		pointsMesh = new THREE.Points( pointsGeometry, pointsMaterial );
		pointsMesh.frustumCulled = false;

	}

	// In XR mode, scene.scale = 1/XR_SCALE but PointsMaterial.size is not
	// affected by parent scale. Divide size to match meter-space distances,
	// and tell the shader how to get depth back in Quake units.
	if ( isXRActive() ) {

		pointsMaterial.size = PARTICLE_SIZE / XR_SCALE;
		_particleUnits.value = XR_SCALE;

	} else {

		pointsMaterial.size = PARTICLE_SIZE;
		_particleUnits.value = 1;

	}

	R_MarkParticleUpload( pointsGeometry.attributes.position, count );
	R_MarkParticleUpload( pointsGeometry.attributes.color, count );
	pointsGeometry.setDrawRange( 0, count );

	if ( ! pointsMesh.parent ) {

		_scene.add( pointsMesh );

	}

}
