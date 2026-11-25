// Ported from: Ironwail Quake/gl_model.c (MD5 models, "for compat with the
// rerelease and NOT doom3": MD5_*, MD5Anim_*, Mod_LoadMD5Skins and
// Mod_LoadMD5MeshModel) and Quake/r_alias.c (drawing them).
//
// Not in WinQuake. The 2021 rerelease ships an .md5mesh and .md5anim beside
// most .mdl files; Ironwail draws those instead when r_enhancedmodels is on.
// gl_model.js Mod_LoadMD5Replacement decides when and calls in here.
//
// Deliberate deviations from Ironwail, all in how the model is drawn rather
// than what is drawn:
// - Ironwail skins on the GPU, blending the two poses' bone matrices. Here
//   each pose is skinned on the CPU once, the first time it is drawn, and
//   cached as a pose template the .mdl path uses (gl_mesh.js
//   GL_DrawAliasFrame), so r_lerpmodels, .lit tint, entity alpha, fog, the
//   colormap and shadows work unchanged. Skinning is linear in the bone
//   matrices, so blending the two skinned poses gives the same vertices as
//   blending the matrices.
// - Ironwail keeps the four strongest weights of each vertex as bytes (n/255);
//   the four are picked and renormalised the same way here, as floats.
// - Ironwail lights an alias vertex from its normal in the shader. This port
//   lights both kinds from the anorm_dots tables (shadedots), so each skinned
//   normal is mapped to the nearest of the 162 Quake normals.
// - One mesh per file: an .md5mesh with more (Ironwail draws each as its own
//   surface) is not used, and the .mdl is drawn. Every rerelease file has one.
// - Skins are looked up as progs/<shader>_<skin>_<frame> like Ironwail, but
//   only as .lmp (what the rerelease ships), not .png, .tga, .jpg or .pcx.

import * as THREE from 'three';
import { Con_Printf } from './common.js';
import { r_avertexnormals } from './anorm_dots.js';
import { COM_FindFile } from './pak.js';
import { vid } from './vid.js';
import { aliashdr_t, maliasframedesc_t, GL_LoadTexture, MAX_SKINS, MF_HOLEY } from './gl_model.js';

// Ironwail iqmvert_t: weight[4], idx[4]
const MD5_MAXINFLUENCES = 4;

/*
=================================================================
Tokenizer

COM_Parse over the file text: the same tokens (whitespace and // and /* *\/
comments skipped, quoted strings, and { } ( ) ' as single characters), but
it walks an index instead of returning the rest of the text, since an
.md5anim is a few hundred kilobytes of numbers.
=================================================================
*/

function MD5_IsSingleChar( c ) {

	return c === 123 || c === 125 || c === 40 || c === 41 || c === 39; // { } ( ) '

}

function MD5_Parser( data, fname ) {

	return { data: data, pos: 0, token: '', fname: fname };

}

// COM_Parse: the next token into p.token; false (and '') at the end
function MD5_Parse( p ) {

	const data = p.data;
	const len = data.length;
	let pos = p.pos;
	p.token = '';

	while ( true ) {

		while ( pos < len && data.charCodeAt( pos ) <= 32 )
			pos ++;
		if ( pos >= len ) {

			p.pos = len;
			return false;

		}

		const c = data.charCodeAt( pos );
		if ( c === 47 && data.charCodeAt( pos + 1 ) === 47 ) { // //

			while ( pos < len && data.charCodeAt( pos ) !== 10 )
				pos ++;
			continue;

		}

		if ( c === 47 && data.charCodeAt( pos + 1 ) === 42 ) { // /*

			pos += 2;
			while ( pos < len && ! ( data.charCodeAt( pos ) === 42 && data.charCodeAt( pos + 1 ) === 47 ) )
				pos ++;
			if ( pos < len )
				pos += 2;
			continue;

		}

		break;

	}

	const c = data.charCodeAt( pos );
	if ( c === 34 ) { // quoted string

		const end = data.indexOf( '"', pos + 1 );
		p.token = end === - 1 ? data.substring( pos + 1 ) : data.substring( pos + 1, end );
		p.pos = end === - 1 ? len : end + 1;
		return true;

	}

	if ( MD5_IsSingleChar( c ) ) {

		p.token = data.charAt( pos );
		p.pos = pos + 1;
		return true;

	}

	const start = pos;
	while ( pos < len && data.charCodeAt( pos ) > 32 && ! MD5_IsSingleChar( data.charCodeAt( pos ) ) )
		pos ++;
	p.token = data.substring( start, pos );
	p.pos = pos;
	return true;

}

// MD5ERROR: Ironwail prints a warning and fails the load; the caller
// catches this and draws the .mdl
function MD5_Error( msg ) {

	throw new Error( msg );

}

// MD5EXPECT
function MD5_Expect( p, s ) {

	if ( p.token !== s )
		MD5_Error( 'Mod_LoadMD5MeshModel(' + p.fname + '): expected "' + s + '", found "' + p.token + '"' );
	MD5_Parse( p );

}

// MD5CHECK
function MD5_Check( p, s ) {

	if ( p.token !== s )
		return false;
	MD5_Parse( p );
	return true;

}

// MD5UINT: strtoull, so a negative number is huge and fails the bounds
// checks; junk is 0
function MD5_UInt( p ) {

	const i = parseInt( p.token, 10 );
	MD5_Parse( p );
	if ( Number.isNaN( i ) ) return 0;
	return i < 0 ? Number.MAX_SAFE_INTEGER : i;

}

// MD5SINT: strtol
function MD5_SInt( p ) {

	const i = parseInt( p.token, 10 );
	MD5_Parse( p );
	return Number.isNaN( i ) ? 0 : i;

}

// MD5FLOAT: strtod
function MD5_Float( p ) {

	const f = parseFloat( p.token );
	MD5_Parse( p );
	return Number.isNaN( f ) ? 0 : f;

}

/*
=================================================================
3x4 row-major matrices (Ironwail bonepose_t.mat), flat with an offset
=================================================================
*/

// GenMatrixPosQuat4Scale, with a scale of 1 (all Ironwail passes for MD5)
function GenMatrixPosQuat4( px, py, pz, qx, qy, qz, qw, out, o ) {

	const x2 = qx + qx;
	const y2 = qy + qy;
	const z2 = qz + qz;

	const xx = qx * x2, xy = qx * y2, xz = qx * z2;
	const yy = qy * y2, yz = qy * z2, zz = qz * z2;
	const xw = qw * x2, yw = qw * y2, zw = qw * z2;

	out[ o + 0 ] = 1.0 - ( yy + zz );
	out[ o + 4 ] = xy + zw;
	out[ o + 8 ] = xz - yw;

	out[ o + 1 ] = xy - zw;
	out[ o + 5 ] = 1.0 - ( xx + zz );
	out[ o + 9 ] = yz + xw;

	out[ o + 2 ] = xz + yw;
	out[ o + 6 ] = yz - xw;
	out[ o + 10 ] = 1.0 - ( xx + yy );

	out[ o + 3 ] = px;
	out[ o + 7 ] = py;
	out[ o + 11 ] = pz;

}

// Matrix3x4_Invert_Simple: rotation and uniform scale only
function Matrix3x4_Invert_Simple( in1, i, out, o ) {

	const scale = 1.0 / ( in1[ i + 0 ] * in1[ i + 0 ] + in1[ i + 1 ] * in1[ i + 1 ] + in1[ i + 2 ] * in1[ i + 2 ] );

	out[ o + 0 ] = in1[ i + 0 ] * scale;
	out[ o + 1 ] = in1[ i + 4 ] * scale;
	out[ o + 2 ] = in1[ i + 8 ] * scale;
	out[ o + 4 ] = in1[ i + 1 ] * scale;
	out[ o + 5 ] = in1[ i + 5 ] * scale;
	out[ o + 6 ] = in1[ i + 9 ] * scale;
	out[ o + 8 ] = in1[ i + 2 ] * scale;
	out[ o + 9 ] = in1[ i + 6 ] * scale;
	out[ o + 10 ] = in1[ i + 10 ] * scale;

	out[ o + 3 ] = - ( in1[ i + 3 ] * out[ o + 0 ] + in1[ i + 7 ] * out[ o + 1 ] + in1[ i + 11 ] * out[ o + 2 ] );
	out[ o + 7 ] = - ( in1[ i + 3 ] * out[ o + 4 ] + in1[ i + 7 ] * out[ o + 5 ] + in1[ i + 11 ] * out[ o + 6 ] );
	out[ o + 11 ] = - ( in1[ i + 3 ] * out[ o + 8 ] + in1[ i + 7 ] * out[ o + 9 ] + in1[ i + 11 ] * out[ o + 10 ] );

}

// R_ConcatTransforms (mathlib.c): out = in1 * in2
function R_ConcatTransforms( a, i, b, j, out, o ) {

	for ( let r = 0; r < 3; r ++ ) {

		const a0 = a[ i + r * 4 ], a1 = a[ i + r * 4 + 1 ], a2 = a[ i + r * 4 + 2 ], a3 = a[ i + r * 4 + 3 ];
		out[ o + r * 4 ] = a0 * b[ j ] + a1 * b[ j + 4 ] + a2 * b[ j + 8 ];
		out[ o + r * 4 + 1 ] = a0 * b[ j + 1 ] + a1 * b[ j + 5 ] + a2 * b[ j + 9 ];
		out[ o + r * 4 + 2 ] = a0 * b[ j + 2 ] + a1 * b[ j + 6 ] + a2 * b[ j + 10 ];
		out[ o + r * 4 + 3 ] = a0 * b[ j + 3 ] + a1 * b[ j + 7 ] + a2 * b[ j + 11 ] + a3;

	}

}

// The w of a unit quaternion stored as x y z: Ironwail's exporter
// convention is a negative w
function MD5_QuatW( qx, qy, qz ) {

	let w = 1 - ( qx * qx + qy * qy + qz * qz );
	if ( w < 0 )
		w = 0; //we have no imagination.
	return - Math.sqrt( w );

}

/*
=================
MD5_BakeInfluences

Bind-pose position of each vertex from its weights, and its four strongest
bone influences, renormalised.
=================
*/
function MD5_BakeInfluences( fname, bindposes, mesh, wbone, wpos, numweights ) {

	const numverts = mesh.numverts;
	const xyz = new Float32Array( numverts * 3 );
	const idx = new Uint16Array( numverts * MD5_MAXINFLUENCES );
	const weight = new Float32Array( numverts * MD5_MAXINFLUENCES );
	const weights = new Float32Array( MD5_MAXINFLUENCES );
	let maxinfluences = 0;

	for ( let v = 0; v < numverts; v ++ ) {

		weights.fill( 0 );
		const vi = v * MD5_MAXINFLUENCES;
		const first = mesh.firstweight[ v ];
		const count = mesh.count[ v ];

		if ( first + count > numweights )
			MD5_Error( fname + ': weight index out of bounds' );
		if ( maxinfluences < count )
			maxinfluences = count;

		let x = 0, y = 0, z = 0;
		for ( let i = 0; i < count; i ++ ) {

			const w = first + i;
			const m = wbone[ w ] * 12;
			const wx = wpos[ w * 4 ], wy = wpos[ w * 4 + 1 ], wz = wpos[ w * 4 + 2 ], ww = wpos[ w * 4 + 3 ];
			// Matrix3x4_RM_Transform4: the weight is the w of the offset
			x += bindposes[ m ] * wx + bindposes[ m + 1 ] * wy + bindposes[ m + 2 ] * wz + bindposes[ m + 3 ] * ww;
			y += bindposes[ m + 4 ] * wx + bindposes[ m + 5 ] * wy + bindposes[ m + 6 ] * wz + bindposes[ m + 7 ] * ww;
			z += bindposes[ m + 8 ] * wx + bindposes[ m + 9 ] * wy + bindposes[ m + 10 ] * wz + bindposes[ m + 11 ] * ww;

			if ( i < MD5_MAXINFLUENCES ) {

				weights[ i ] = ww;
				idx[ vi + i ] = wbone[ w ];

			} else {

				//obnoxious code to find the lowest of the current possible bone indexes.
				let lowidx = 0;
				for ( let k = 1; k < MD5_MAXINFLUENCES; k ++ )
					if ( weights[ k ] < weights[ lowidx ] )
						lowidx = k;
				if ( weights[ lowidx ] < ww ) {

					//found a lower/unset weight, replace it.
					weights[ lowidx ] = ww;
					idx[ vi + lowidx ] = wbone[ w ];

				}

			}

		}

		xyz[ v * 3 ] = x;
		xyz[ v * 3 + 1 ] = y;
		xyz[ v * 3 + 2 ] = z;

		//normalize in case we dropped some weights.
		const scale = weights[ 0 ] + weights[ 1 ] + weights[ 2 ] + weights[ 3 ];
		if ( scale > 0 ) {

			for ( let k = 0; k < MD5_MAXINFLUENCES; k ++ )
				weight[ vi + k ] = weights[ k ] / scale;

		} else {

			//something bad...
			weight[ vi ] = 1;

		}

	}

	mesh.xyz = xyz;
	mesh.idx = idx;
	mesh.weight = weight;
	mesh.maxinfluences = maxinfluences;

}

/*
=================
MD5_ComputeNormals

Bind-pose normals, which the format lacks: each triangle's face normal is
added to its corners, with vertices at the same position welded so seams
are smooth.
=================
*/
function MD5_ComputeNormals( mesh ) {

	const numverts = mesh.numverts;
	const xyz = mesh.xyz;
	const indexes = mesh.indexes;
	const weld = new Uint32Array( numverts );
	const normals = new Float32Array( numverts * 3 );
	const seen = new Map();

	for ( let v = 0; v < numverts; v ++ ) {

		const key = xyz[ v * 3 ] + ',' + xyz[ v * 3 + 1 ] + ',' + xyz[ v * 3 + 2 ];
		const t = seen.get( key );
		if ( t === undefined ) {

			seen.set( key, v );
			weld[ v ] = v;

		} else {

			weld[ v ] = weld[ t ];

		}

	}

	for ( let t = 0; t < indexes.length; t += 3 ) {

		const i0 = weld[ indexes[ t ] ], i1 = weld[ indexes[ t + 1 ] ], i2 = weld[ indexes[ t + 2 ] ];
		const d1x = xyz[ i1 * 3 ] - xyz[ i0 * 3 ], d1y = xyz[ i1 * 3 + 1 ] - xyz[ i0 * 3 + 1 ], d1z = xyz[ i1 * 3 + 2 ] - xyz[ i0 * 3 + 2 ];
		const d2x = xyz[ i2 * 3 ] - xyz[ i0 * 3 ], d2y = xyz[ i2 * 3 + 1 ] - xyz[ i0 * 3 + 1 ], d2z = xyz[ i2 * 3 + 2 ] - xyz[ i0 * 3 + 2 ];
		// CrossProduct( d2, d1 )
		const nx = d2y * d1z - d2z * d1y;
		const ny = d2z * d1x - d2x * d1z;
		const nz = d2x * d1y - d2y * d1x;
		normals[ i0 * 3 ] += nx; normals[ i0 * 3 + 1 ] += ny; normals[ i0 * 3 + 2 ] += nz;
		normals[ i1 * 3 ] += nx; normals[ i1 * 3 + 1 ] += ny; normals[ i1 * 3 + 2 ] += nz;
		normals[ i2 * 3 ] += nx; normals[ i2 * 3 + 1 ] += ny; normals[ i2 * 3 + 2 ] += nz;

	}

	for ( let v = 0; v < numverts; v ++ ) {

		const w = weld[ v ];
		if ( v === w ) {

			// VectorNormalize: a zero vector stays zero
			const len = Math.hypot( normals[ v * 3 ], normals[ v * 3 + 1 ], normals[ v * 3 + 2 ] );
			if ( len > 0 ) {

				normals[ v * 3 ] /= len;
				normals[ v * 3 + 1 ] /= len;
				normals[ v * 3 + 2 ] /= len;

			}

		} else {

			normals[ v * 3 ] = normals[ w * 3 ];
			normals[ v * 3 + 1 ] = normals[ w * 3 + 1 ];
			normals[ v * 3 + 2 ] = normals[ w * 3 + 2 ];

		}

	}

	mesh.normals = normals;

}

/*
=================
MD5Anim_Begin

The .md5anim header, up to its frame rate. Its poses are read by
MD5Anim_Load once the mesh's joints are known. A missing file gives no
poses, which fails the load.
=================
*/
function MD5Anim_Begin( fname, text ) {

	const ctx = { parser: null, numposes: 0, numjoints: 0, posedata: null };
	if ( text === null )
		return ctx;

	const p = MD5_Parser( text, fname );
	MD5_Parse( p );
	MD5_Expect( p, 'MD5Version' );
	MD5_Expect( p, '10' );
	if ( MD5_Check( p, 'commandline' ) ) MD5_Parse( p );
	MD5_Expect( p, 'numFrames' ); ctx.numposes = MD5_UInt( p );
	MD5_Expect( p, 'numJoints' ); ctx.numjoints = MD5_UInt( p );
	MD5_Expect( p, 'frameRate' ); /*irrelevant here*/

	if ( ctx.numposes <= 0 )
		MD5_Error( fname + ' has no poses' );

	ctx.parser = p;
	return ctx;

}

/*
=================
MD5Anim_Load

Every frame's bone matrices, each the joint's absolute pose times the
inverse of its bind pose: what moves a bind-pose vertex into that frame.
Like Ironwail, components a joint's flags leave out are 0, not the
baseframe's (the rerelease animates all six of every joint), and a frame
the file leaves out keeps zero matrices.
=================
*/
function MD5Anim_Load( ctx, names, parents, inverse ) {

	const p = ctx.parser;
	const fname = p.fname;
	const numjoints = names.length;

	if ( MD5_Parse( p ) === false )
		MD5_Error( fname + ' ends after its header' );

	MD5_Expect( p, 'numAnimatedComponents' );
	const rawcount = MD5_UInt( p );

	if ( ctx.numjoints !== numjoints )
		MD5_Error( fname + ' has incorrect bone count (expected ' + numjoints + ', found ' + ctx.numjoints + ')' );

	const raw = new Float32Array( rawcount + 6 );
	const flags = new Uint8Array( numjoints );
	const offset = new Uint32Array( numjoints );
	const posedata = new Float32Array( numjoints * ctx.numposes * 12 );
	const frameposes = new Float32Array( numjoints * 12 );
	const local = new Float32Array( 12 );

	MD5_Expect( p, 'hierarchy' );
	MD5_Expect( p, '{' );
	for ( let j = 0; j < numjoints; j ++ ) {

		//validate stuff
		if ( names[ j ] !== p.token )
			MD5_Error( fname + ': bone ' + names[ j ] + ' was renamed' );
		MD5_Parse( p );
		if ( parents[ j ] !== MD5_SInt( p ) )
			MD5_Error( fname + ': bone ' + names[ j ] + ' has wrong parent' );
		//new info
		const f = MD5_UInt( p );
		if ( f > 63 ) // f & ~63
			MD5_Error( fname + ': bone ' + names[ j ] + ' has unsupported flags' );
		flags[ j ] = f;
		const o = MD5_UInt( p );
		if ( o > rawcount + 6 )
			MD5_Error( fname + ': bone ' + names[ j ] + ' has bad offset' );
		offset[ j ] = o;

	}

	MD5_Expect( p, '}' );
	MD5_Expect( p, 'bounds' );
	MD5_Expect( p, '{' );
	while ( MD5_Check( p, '(' ) ) {

		MD5_Parse( p ); MD5_Parse( p ); MD5_Parse( p );
		MD5_Expect( p, ')' );

		MD5_Expect( p, '(' );
		MD5_Parse( p ); MD5_Parse( p ); MD5_Parse( p );
		MD5_Expect( p, ')' );

	}

	MD5_Expect( p, '}' );

	MD5_Expect( p, 'baseframe' );
	MD5_Expect( p, '{' );
	while ( MD5_Check( p, '(' ) ) {

		MD5_Parse( p ); MD5_Parse( p ); MD5_Parse( p );
		MD5_Expect( p, ')' );

		MD5_Expect( p, '(' );
		MD5_Parse( p ); MD5_Parse( p ); MD5_Parse( p );
		MD5_Expect( p, ')' );

	}

	MD5_Expect( p, '}' );

	while ( MD5_Check( p, 'frame' ) ) {

		const idx = MD5_UInt( p );
		if ( idx >= ctx.numposes )
			MD5_Error( fname + ': invalid pose index ' + idx + ' (max=' + ctx.numposes + ')' );
		MD5_Expect( p, '{' );
		for ( let j = 0; j < rawcount; j ++ )
			raw[ j ] = MD5_Float( p );
		MD5_Expect( p, '}' );

		//okay, we have our raw info, unpack the actual bone info.
		for ( let j = 0; j < numjoints; j ++ ) {

			let r = offset[ j ];
			const f = flags[ j ];
			// an offset near the end can run past raw: C reads past the
			// allocation, here it reads 0
			const px = ( f & 1 ) !== 0 ? ( r < raw.length ? raw[ r ++ ] : 0 ) : 0;
			const py = ( f & 2 ) !== 0 ? ( r < raw.length ? raw[ r ++ ] : 0 ) : 0;
			const pz = ( f & 4 ) !== 0 ? ( r < raw.length ? raw[ r ++ ] : 0 ) : 0;
			const qx = ( f & 8 ) !== 0 ? ( r < raw.length ? raw[ r ++ ] : 0 ) : 0;
			const qy = ( f & 16 ) !== 0 ? ( r < raw.length ? raw[ r ++ ] : 0 ) : 0;
			const qz = ( f & 32 ) !== 0 ? ( r < raw.length ? raw[ r ++ ] : 0 ) : 0;

			GenMatrixPosQuat4( px, py, pz, qx, qy, qz, MD5_QuatW( qx, qy, qz ), local, 0 );

			if ( parents[ j ] < 0 )
				frameposes.set( local, j * 12 );
			else
				R_ConcatTransforms( frameposes, parents[ j ] * 12, local, 0, frameposes, j * 12 );

		}

		for ( let j = 0; j < numjoints; j ++ )
			R_ConcatTransforms( frameposes, j * 12, inverse, j * 12, posedata, ( idx * numjoints + j ) * 12 );

	}

	ctx.posedata = posedata;

}

/*
=================
MD5_ParseModel

The joints, poses and mesh of an .md5mesh and its .md5anim, in the order
Ironwail's Mod_LoadMD5MeshModel reads them. Throws on a bad file. Not in
the C as a separate step: it has no textures or GPU state, so tests can
call it.
=================
*/
export function MD5_ParseModel( fname, meshText, animText ) {

	const p = MD5_Parser( meshText, fname );
	MD5_Parse( p );

	MD5_Expect( p, 'MD5Version' );
	MD5_Expect( p, '10' );
	if ( MD5_Check( p, 'commandline' ) ) MD5_Parse( p );
	MD5_Expect( p, 'numJoints' ); const numjoints = MD5_UInt( p );
	MD5_Expect( p, 'numMeshes' ); const nummeshes = MD5_UInt( p );

	if ( numjoints <= 0 )
		MD5_Error( fname + ' has no bones' );
	if ( nummeshes <= 0 )
		MD5_Error( fname + ' has no meshes' );
	// not in Ironwail: see the header
	if ( nummeshes > 1 )
		MD5_Error( fname + ' has ' + nummeshes + ' meshes; only one is supported' );

	if ( p.token !== 'joints' ) MD5_Error( 'Mod_LoadMD5MeshModel(' + fname + '): Expected "joints"' );
	const anim = MD5Anim_Begin( COM_StripMD5Extension( fname ) + '.md5anim', animText );
	if ( anim.numposes <= 0 )
		MD5_Error( fname + ' has no poses' );
	MD5_Parse( p );

	const names = [];
	const parents = new Int32Array( numjoints );
	const bindposes = new Float32Array( numjoints * 12 );
	const inverse = new Float32Array( numjoints * 12 );

	MD5_Expect( p, '{' );
	for ( let j = 0; j < numjoints; j ++ ) {

		names[ j ] = p.token; MD5_Parse( p );
		parents[ j ] = MD5_SInt( p );
		if ( parents[ j ] < - 1 || parents[ j ] >= numjoints )
			MD5_Error( fname + ': bone index ' + parents[ j ] + ' out of bounds (max=' + numjoints + ')' );
		MD5_Expect( p, '(' );
		const px = MD5_Float( p );
		const py = MD5_Float( p );
		const pz = MD5_Float( p );
		MD5_Expect( p, ')' );
		MD5_Expect( p, '(' );
		const qx = MD5_Float( p );
		const qy = MD5_Float( p );
		const qz = MD5_Float( p );
		MD5_Expect( p, ')' );

		GenMatrixPosQuat4( px, py, pz, qx, qy, qz, MD5_QuatW( qx, qy, qz ), bindposes, j * 12 );
		Matrix3x4_Invert_Simple( bindposes, j * 12, inverse, j * 12 );	//absolute, so we can just invert now.

	}

	if ( p.token !== '}' ) MD5_Error( 'Mod_LoadMD5MeshModel(' + fname + '): Expected "}"' );
	MD5Anim_Load( anim, names, parents, inverse );
	MD5_Parse( p );

	MD5_Expect( p, 'mesh' );
	MD5_Expect( p, '{' );

	MD5_Expect( p, 'shader' );
	const shader = p.token;
	MD5_Parse( p );

	MD5_Expect( p, 'numverts' );
	const numverts = MD5_UInt( p );
	const mesh = {
		numverts: numverts,
		st: new Float32Array( numverts * 2 ),
		firstweight: new Float64Array( numverts ),
		count: new Float64Array( numverts ),
		indexes: null,
		xyz: null, normals: null, idx: null, weight: null, maxinfluences: 0
	};

	while ( MD5_Check( p, 'vert' ) ) {

		const idx = MD5_UInt( p );
		if ( idx >= numverts )
			MD5_Error( fname + ': vertex index ' + idx + ' out of bounds (max=' + numverts + ')' );
		MD5_Expect( p, '(' );
		mesh.st[ idx * 2 ] = MD5_Float( p );
		mesh.st[ idx * 2 + 1 ] = MD5_Float( p );
		MD5_Expect( p, ')' );
		mesh.firstweight[ idx ] = MD5_UInt( p );
		mesh.count[ idx ] = MD5_UInt( p );

	}

	MD5_Expect( p, 'numtris' );
	const numtris = MD5_UInt( p );
	mesh.indexes = new Uint32Array( numtris * 3 );
	while ( MD5_Check( p, 'tri' ) ) {

		const idx = MD5_UInt( p );
		if ( idx >= numtris )
			MD5_Error( fname + ': triangle index ' + idx + ' out of bounds (max=' + numtris + ')' );
		for ( let j = 0; j < 3; j ++ ) {

			const t = MD5_UInt( p );
			if ( t >= numverts )
				MD5_Error( fname + ': vertex index ' + t + ' out of bounds (max=' + numverts + ')' );
			mesh.indexes[ idx * 3 + j ] = t;

		}

	}

	//md5 is a gpu-unfriendly interchange format. :(
	MD5_Expect( p, 'numweights' );
	const numweights = MD5_UInt( p );
	const wbone = new Uint32Array( numweights );
	const wpos = new Float32Array( numweights * 4 );
	while ( MD5_Check( p, 'weight' ) ) {

		const idx = MD5_UInt( p );
		if ( idx >= numweights )
			MD5_Error( fname + ': weight index ' + idx + ' out of bounds (max=' + numweights + ')' );

		const bone = MD5_UInt( p );
		if ( bone >= numjoints )
			MD5_Error( fname + ': bone index ' + bone + ' out of bounds (max=' + numjoints + ')' );
		wbone[ idx ] = bone;
		const w = MD5_Float( p );
		wpos[ idx * 4 + 3 ] = w;
		MD5_Expect( p, '(' );
		wpos[ idx * 4 ] = MD5_Float( p ) * w;
		wpos[ idx * 4 + 1 ] = MD5_Float( p ) * w;
		wpos[ idx * 4 + 2 ] = MD5_Float( p ) * w;
		MD5_Expect( p, ')' );

	}

	//so make it gpu-friendly.
	MD5_BakeInfluences( fname, bindposes, mesh, wbone, wpos, numweights );
	//and now make up the normals that the format lacks.
	MD5_ComputeNormals( mesh );

	MD5_Expect( p, '}' );

	return {
		numjoints: numjoints,
		names: names,
		parents: parents,
		bindposes: bindposes,
		numposes: anim.numposes,
		posedata: anim.posedata,
		shader: shader,
		numverts: numverts,
		numtris: numtris,
		st: mesh.st,
		xyz: mesh.xyz,
		normals: mesh.normals,
		idx: mesh.idx,
		weight: mesh.weight,
		indexes: mesh.indexes,
		maxinfluences: mesh.maxinfluences
	};

}

// COM_StripExtension for the names above (common.js has one; this keeps
// the parser free of the console)
function COM_StripMD5Extension( name ) {

	const dot = name.lastIndexOf( '.' );
	return dot > name.lastIndexOf( '/' ) ? name.substring( 0, dot ) : name;

}

/*
=================
MD5_SkinPose

One pose's vertices: each bind-pose position and normal moved by its
weighted bone matrices. out and outnormals hold numverts * 3 floats;
lightnormalindices, if given, gets each normal's nearest Quake normal.
=================
*/
// The blended bone matrix is held in twelve locals, rounded to float with
// Math.fround after every add: the same values a Float32Array(12) accumulator
// gives, without its loads and stores.
export function MD5_SkinPose( md5, posenum, out, outnormals, lightnormalindices ) {

	const numjoints = md5.numjoints;
	const posedata = md5.posedata;
	const base = posenum * numjoints * 12;
	const xyz = md5.xyz;
	const normals = md5.normals;
	const idx = md5.idx;
	const weight = md5.weight;
	const fround = Math.fround;

	for ( let v = 0; v < md5.numverts; v ++ ) {

		let m0 = 0, m1 = 0, m2 = 0, m3 = 0, m4 = 0, m5 = 0, m6 = 0, m7 = 0, m8 = 0, m9 = 0, m10 = 0, m11 = 0;
		for ( let k = 0; k < MD5_MAXINFLUENCES; k ++ ) {

			const w = weight[ v * MD5_MAXINFLUENCES + k ];
			if ( w === 0 ) continue;
			const b = base + idx[ v * MD5_MAXINFLUENCES + k ] * 12;
			m0 = fround( m0 + posedata[ b ] * w );
			m1 = fround( m1 + posedata[ b + 1 ] * w );
			m2 = fround( m2 + posedata[ b + 2 ] * w );
			m3 = fround( m3 + posedata[ b + 3 ] * w );
			m4 = fround( m4 + posedata[ b + 4 ] * w );
			m5 = fround( m5 + posedata[ b + 5 ] * w );
			m6 = fround( m6 + posedata[ b + 6 ] * w );
			m7 = fround( m7 + posedata[ b + 7 ] * w );
			m8 = fround( m8 + posedata[ b + 8 ] * w );
			m9 = fround( m9 + posedata[ b + 9 ] * w );
			m10 = fround( m10 + posedata[ b + 10 ] * w );
			m11 = fround( m11 + posedata[ b + 11 ] * w );

		}

		const x = xyz[ v * 3 ], y = xyz[ v * 3 + 1 ], z = xyz[ v * 3 + 2 ];
		out[ v * 3 ] = m0 * x + m1 * y + m2 * z + m3;
		out[ v * 3 + 1 ] = m4 * x + m5 * y + m6 * z + m7;
		out[ v * 3 + 2 ] = m8 * x + m9 * y + m10 * z + m11;

		if ( outnormals === null ) continue;

		const nx = normals[ v * 3 ], ny = normals[ v * 3 + 1 ], nz = normals[ v * 3 + 2 ];
		let tx = m0 * nx + m1 * ny + m2 * nz;
		let ty = m4 * nx + m5 * ny + m6 * nz;
		let tz = m8 * nx + m9 * ny + m10 * nz;
		const len = Math.hypot( tx, ty, tz );
		if ( len > 0 ) {

			tx /= len;
			ty /= len;
			tz /= len;

		}

		outnormals[ v * 3 ] = tx;
		outnormals[ v * 3 + 1 ] = ty;
		outnormals[ v * 3 + 2 ] = tz;

		if ( lightnormalindices !== null )
			lightnormalindices[ v ] = MD5_NearestNormal( tx, ty, tz );

	}

}

// The index of the Quake vertex normal (anorms.h) closest to a unit vector
export function MD5_NearestNormal( x, y, z ) {

	let best = 0;
	let bestdot = - Infinity;
	for ( let i = 0; i < r_avertexnormals.length; i ++ ) {

		const n = r_avertexnormals[ i ];
		const d = n[ 0 ] * x + n[ 1 ] * y + n[ 2 ] * z;
		if ( d > bestdot ) {

			bestdot = d;
			best = i;

		}

	}

	return best;

}

/*
=================
MD5_CullSphere

GL_AliasCullSphere (gl_mesh.js) for an MD5: one model-space sphere around
every vertex of every pose.
=================
*/
function MD5_CullSphere( hdr ) {

	const md5 = hdr.md5;
	const stride = md5.numverts * 3;
	// every pose's skinned positions, so the radius pass does not skin again
	const all = new Float32Array( md5.numposes * stride );
	let minx = Infinity, miny = Infinity, minz = Infinity;
	let maxx = - Infinity, maxy = - Infinity, maxz = - Infinity;

	for ( let p = 0; p < md5.numposes; p ++ ) {

		const pos = all.subarray( p * stride, ( p + 1 ) * stride );
		MD5_SkinPose( md5, p, pos, null, null );
		for ( let i = 0; i < stride; i += 3 ) {

			if ( pos[ i ] < minx ) minx = pos[ i ];
			if ( pos[ i ] > maxx ) maxx = pos[ i ];
			if ( pos[ i + 1 ] < miny ) miny = pos[ i + 1 ];
			if ( pos[ i + 1 ] > maxy ) maxy = pos[ i + 1 ];
			if ( pos[ i + 2 ] < minz ) minz = pos[ i + 2 ];
			if ( pos[ i + 2 ] > maxz ) maxz = pos[ i + 2 ];

		}

	}

	if ( minx > maxx ) {

		hdr._cullCenter = [ 0, 0, 0 ];
		hdr._cullRadius = 0;
		return;

	}

	const cx = ( minx + maxx ) * 0.5, cy = ( miny + maxy ) * 0.5, cz = ( minz + maxz ) * 0.5;
	let radiusSq = 0;
	for ( let i = 0; i < all.length; i += 3 ) {

		const dx = all[ i ] - cx, dy = all[ i + 1 ] - cy, dz = all[ i + 2 ] - cz;
		const d = dx * dx + dy * dy + dz * dz;
		if ( d > radiusSq ) radiusSq = d;

	}

	hdr._cullCenter = [ cx, cy, cz ];
	hdr._cullRadius = Math.sqrt( radiusSq );

}

/*
=================
Mod_LoadMD5Skins

progs/<shader>_<skin>_<frame>: up to MAX_SKINS skins of up to four frames
each, until a skin has no frame 0. "MD5 violation: the skin is a single
material. adding prefixes/postfixes here is the wrong thing to do. but we
do so anyway, because rerelease compat." The textures are made as
Mod_LoadAllSkins makes an .mdl's, so fullbrights, MF_HOLEY and the player
colormap (texels) work the same.
=================
*/
function Mod_LoadMD5Skins( mod, hdr, shader ) {

	// no palette (the Deno server never runs VID_Init): no masks to make
	const splitFullbright = vid.fullbright > 0;
	const holey = ( mod.flags & MF_HOLEY ) !== 0;

	for ( hdr.numskins = 0; hdr.numskins < MAX_SKINS; hdr.numskins ++ ) {

		const s = hdr.numskins;
		const slots = hdr.gl_texturenum[ s ];
		let f;
		for ( f = 0; f < 4; f ++ ) {

			const texname = 'progs/' + shader + '_' + String( s ).padStart( 2, '0' ) + '_' + String( f ).padStart( 2, '0' );
			const pic = MD5_LoadLMP( texname + '.lmp' );
			if ( pic === null )
				break;

			if ( f === 0 ) {

				// Save 8 bit texels for player model remapping
				hdr.texels[ s ] = pic.data;
				if ( s === 0 ) {

					hdr.skinwidth = pic.width;
					hdr.skinheight = pic.height;

				}

			}

			slots[ f ] = GL_LoadTexture( texname, pic.width, pic.height, pic.data, true, holey, splitFullbright, true );

		}

		if ( f === 0 )
			break;	//no images loaded...

		//this stuff is hideous.
		if ( f < 2 )
			slots[ 1 ] = slots[ 0 ];
		if ( f === 3 )
			Con_Printf( 'Warning: progs/%s_%s_##: 3 skinframes found...\n', shader, String( s ).padStart( 2, '0' ) );
		if ( f < 4 ) {

			slots[ 3 ] = slots[ 1 ];
			slots[ 2 ] = slots[ 0 ];

		}

	}

	if ( hdr.numskins === 0 ) {

		hdr.skinwidth = 1;
		hdr.skinheight = 1;

	}

}

// Image_LoadLMP: a qpic (int width, int height, then 8-bit pixels), or null
function MD5_LoadLMP( name ) {

	const file = COM_FindFile( name );
	if ( file === null || file.size < 8 )
		return null;

	const data = file.data;
	const view = new DataView( data.buffer, data.byteOffset, data.byteLength );
	const width = view.getInt32( 0, true );
	const height = view.getInt32( 4, true );
	if ( width <= 0 || height <= 0 || 8 + width * height > file.size ) {

		Con_Printf( 'Warning: %s is not a valid lmp\n', name );
		return null;

	}

	return { width: width, height: height, data: data.slice( 8, 8 + width * height ) };

}

/*
=================
Mod_LoadMD5MeshModel

The alias header an .md5mesh draws with, or null (and a warning) when the
files are bad. As in Ironwail, each pose is one frame: Quake frame n is
pose n of the .md5anim, so QuakeC's frame numbers pick the same animation
as the .mdl's. Nothing else of the .mdl's is changed: the model keeps its
flags (trails, rotation), synctype, frame count, bounds and the .mdl
header the server and the rest of the client read. Ironwail recomputes the
bounds from the MD5 (Mod_CalcAliasBounds); the port's alias bounds are
WinQuake's fixed 16-unit box, which the server's setmodel uses.

The caller (gl_model.js Mod_LoadMD5Replacement) sets loadmodel, so the
skins belong to mod.
=================
*/
export function Mod_LoadMD5MeshModel( mod, meshText, animText ) {

	let md5;
	try {

		md5 = MD5_ParseModel( mod.name.substring( 0, mod.name.lastIndexOf( '.' ) ) + '.md5mesh', meshText, animText );

	} catch ( e ) {

		Con_Printf( 'Warning: %s\n', e.message );
		return null;

	}

	const hdr = new aliashdr_t();
	hdr.md5 = md5;
	hdr.scale[ 0 ] = hdr.scale[ 1 ] = hdr.scale[ 2 ] = 1;
	hdr.numverts = md5.numverts;
	hdr.numtris = md5.numtris;
	hdr.numposes = md5.numposes;
	hdr.numframes = md5.numposes;
	hdr.frames = [];
	for ( let j = 0; j < md5.numposes; j ++ ) {

		const frame = new maliasframedesc_t();
		frame.firstpose = j;
		frame.numposes = 1;
		frame.interval = 0.1;
		hdr.frames[ j ] = frame;

	}

	MD5_CullSphere( hdr );
	Mod_LoadMD5Skins( mod, hdr, md5.shader );
	if ( md5.maxinfluences > MD5_MAXINFLUENCES )
		Con_Printf( '%s uses up to %d influences per vertex\n', mod.name, md5.maxinfluences );

	return hdr;

}

/*
=================
GL_DrawMD5Frame

GL_DrawAliasFrame (gl_mesh.js) for an MD5: the template of one pose, made
the first time the pose is drawn and cached, so drawing allocates nothing.
Every pose shares the uvs and the index.
=================
*/
export function GL_DrawMD5Frame( hdr, posenum ) {

	const md5 = hdr.md5;
	if ( posenum < 0 || posenum >= md5.numposes ) return null;

	if ( hdr._geoCache == null ) hdr._geoCache = new Map();
	let cached = hdr._geoCache.get( posenum );
	if ( cached !== undefined ) return cached;

	if ( hdr._indexAttr == null ) {

		// gl_mesh.js turns the .mdl's triangles round for Three's
		// counter-clockwise front faces; the MD5's wind as the .mdl's
		const indexes = md5.indexes;
		const turned = md5.numverts > 65535 ? new Uint32Array( indexes.length ) : new Uint16Array( indexes.length );
		for ( let t = 0; t < indexes.length; t += 3 ) {

			turned[ t ] = indexes[ t ];
			turned[ t + 1 ] = indexes[ t + 2 ];
			turned[ t + 2 ] = indexes[ t + 1 ];

		}

		hdr._indexAttr = new THREE.BufferAttribute( turned, 1 );
		hdr._uvAttr = new THREE.BufferAttribute( md5.st, 2 );

	}

	const positions = new Float32Array( md5.numverts * 3 );
	const normals = new Float32Array( md5.numverts * 3 );
	const lightnormalindices = new Uint8Array( md5.numverts );
	MD5_SkinPose( md5, posenum, positions, normals, lightnormalindices );

	cached = {
		posAttr: new THREE.BufferAttribute( positions, 3 ),
		normalAttr: new THREE.BufferAttribute( normals, 3 ),
		uvAttr: hdr._uvAttr,
		indexAttr: hdr._indexAttr,
		lightnormalindices: lightnormalindices,
		vertexCount: md5.numverts
	};
	hdr._geoCache.set( posenum, cached );
	return cached;

}
