// gl_draw.c Draw_TextureMode_f: the gl_texturemode console command.

// Bootstrap the renderer's circular module graph in its safe order.
await import( '../src/gl_rsurf.js' );

const gl_draw = await import( '../src/gl_draw.js' );
const glquake = await import( '../src/glquake.js' );
const cmd = await import( '../src/cmd.js' );
const THREE = await import( 'three' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

function makeTexture( mipmap ) {

	return { generateMipmaps: mipmap, needsUpdate: false, minFilter: null, magFilter: null };

}

function run( text ) {

	cmd.Cmd_TokenizeString( text );
	gl_draw.Draw_TextureMode_f();

}

function withRegistry( fn ) {

	const oldRegistry = glquake._allGameTextures.slice();
	const oldMin = glquake.gl_filter_min;
	const oldMax = glquake.gl_filter_max;
	try {

		glquake._allGameTextures.length = 0;
		fn();

	} finally {

		glquake._allGameTextures.splice( 0, glquake._allGameTextures.length, ...oldRegistry );
		glquake.set_gl_filter( oldMin, oldMax );

	}

}

Deno.test( 'gl_texturemode defaults to GL_LINEAR_MIPMAP_NEAREST like gl_draw.c', () => {

	assertEqual( glquake.gl_filter_min, glquake.GL_LINEAR_MIPMAP_NEAREST, 'gl_filter_min' );
	assertEqual( glquake.gl_filter_max, glquake.GL_LINEAR, 'gl_filter_max' );

} );

Deno.test( 'each gl_texturemode name maps to its Three.js filters', () => {

	const table = [
		[ 'GL_NEAREST', THREE.NearestFilter, THREE.NearestFilter ],
		[ 'GL_LINEAR', THREE.LinearFilter, THREE.LinearFilter ],
		[ 'GL_NEAREST_MIPMAP_NEAREST', THREE.NearestMipmapNearestFilter, THREE.NearestFilter ],
		[ 'GL_LINEAR_MIPMAP_NEAREST', THREE.LinearMipmapNearestFilter, THREE.LinearFilter ],
		[ 'GL_NEAREST_MIPMAP_LINEAR', THREE.NearestMipmapLinearFilter, THREE.NearestFilter ],
		[ 'GL_LINEAR_MIPMAP_LINEAR', THREE.LinearMipmapLinearFilter, THREE.LinearFilter ]
	];

	withRegistry( () => {

		for ( const [ name, min, mag ] of table ) {

			const mipmapped = makeTexture( true );
			const flat = makeTexture( false );
			glquake.GL_RegisterTexture( mipmapped );
			glquake.GL_RegisterTexture( flat );

			run( `gl_texturemode ${name.toLowerCase()}` ); // Q_strcasecmp
			assertEqual( mipmapped.minFilter, min, `${name} min` );
			assertEqual( mipmapped.magFilter, mag, `${name} mag` );
			assertEqual( mipmapped.needsUpdate, true, `${name} re-upload` );
			// C only re-filters "existing mipmap texture objects"
			assertEqual( flat.needsUpdate, false, `${name} leaves unmipmapped textures` );
			assertEqual( flat.minFilter, null, `${name} unmipmapped min untouched` );

			// GL_Upload32: new textures take the mode; unmipmapped ones use
			// gl_filter_max both ways
			const loaded = makeTexture( false );
			glquake.GL_SetTextureFilter( loaded, false );
			assertEqual( loaded.minFilter, mag, `${name} unmipmapped load min` );
			assertEqual( loaded.magFilter, mag, `${name} unmipmapped load mag` );

			glquake._allGameTextures.length = 0;

		}

	} );

} );

Deno.test( 'gl_texturemode ignores a bad filter name and the old 0/1 values', () => {

	withRegistry( () => {

		run( 'gl_texturemode GL_NEAREST' );
		const texture = makeTexture( true );
		glquake.GL_RegisterTexture( texture );

		for ( const bad of [ 'GL_BOGUS', '0', '1' ] ) {

			run( `gl_texturemode ${bad}` );
			assertEqual( glquake.gl_filter_min, glquake.GL_NEAREST, `${bad} keeps min` );
			assertEqual( glquake.gl_filter_max, glquake.GL_NEAREST, `${bad} keeps max` );
			assertEqual( texture.needsUpdate, false, `${bad} re-filters nothing` );

		}

		// no argument only prints the current mode
		run( 'gl_texturemode' );
		assertEqual( glquake.gl_filter_min, glquake.GL_NEAREST, 'query keeps the mode' );
		assertEqual( texture.needsUpdate, false, 'query re-filters nothing' );

	} );

} );
