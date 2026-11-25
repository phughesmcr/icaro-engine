// QuakeSpasm's per-liquid alpha: r_lavaalpha, r_slimealpha, r_telealpha
// (0 falls back to r_wateralpha) and the worldspawn _wateralpha keys.

// Bootstrap the renderer's existing circular module graph in its safe order.
const gl_rsurf = await import( '../src/gl_rsurf.js' );
const gl_model = await import( '../src/gl_model.js' );
const { cl } = await import( '../src/client.js' );
const { r_wateralpha } = await import( '../src/glquake.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

const water = { flags: gl_model.SURF_DRAWTURB | gl_model.SURF_DRAWWATER };
const lava = { flags: gl_model.SURF_DRAWTURB | gl_model.SURF_DRAWLAVA };
const slime = { flags: gl_model.SURF_DRAWTURB | gl_model.SURF_DRAWSLIME };
const tele = { flags: gl_model.SURF_DRAWTURB | gl_model.SURF_DRAWTELE };

function setCvar( cvar, value ) {

	cvar.value = value;
	cvar.string = String( value );

}

// Runs fn with a fresh world (entities string) and the cvars restored after.
function withWorld( entities, fn ) {

	const cvars = [ r_wateralpha, gl_model.r_lavaalpha, gl_model.r_slimealpha, gl_model.r_telealpha ];
	const saved = cvars.map( ( c ) => c.value );
	const oldWorld = cl.worldmodel;
	try {

		cl.worldmodel = { entities };
		fn();

	} finally {

		cl.worldmodel = oldWorld;
		cvars.forEach( ( c, i ) => setCvar( c, saved[ i ] ) );

	}

}

Deno.test( 'liquid textures get their SURF_DRAW* flag by name', () => {

	assertEqual( gl_model.Mod_LiquidFlagFromName( '*lava1' ), gl_model.SURF_DRAWLAVA, 'lava' );
	assertEqual( gl_model.Mod_LiquidFlagFromName( '*slime0' ), gl_model.SURF_DRAWSLIME, 'slime' );
	assertEqual( gl_model.Mod_LiquidFlagFromName( '*teleport' ), gl_model.SURF_DRAWTELE, 'tele' );
	assertEqual( gl_model.Mod_LiquidFlagFromName( '*water1' ), gl_model.SURF_DRAWWATER, 'water' );
	assertEqual( gl_model.Mod_LiquidFlagFromName( '*04water' ), gl_model.SURF_DRAWWATER, 'other' );
	for ( const name of [ 'r_lavaalpha', 'r_slimealpha', 'r_telealpha' ] )
		assertEqual( gl_model[ name ].string, '0', name + ' defaults to 0' );

} );

Deno.test( 'by default every liquid uses r_wateralpha, as in GLQuake', () => {

	withWorld( '{\n"classname" "worldspawn"\n}', () => {

		setCvar( r_wateralpha, 1 );
		for ( const s of [ water, lava, slime, tele ] )
			assertEqual( gl_rsurf.GL_WaterAlphaForSurface( s ), 1, 'opaque' );

		setCvar( r_wateralpha, 0.5 );
		for ( const s of [ water, lava, slime, tele ] )
			assertEqual( gl_rsurf.GL_WaterAlphaForSurface( s ), 0.5, 'r_wateralpha' );

	} );

} );

Deno.test( 'per-liquid cvars override r_wateralpha', () => {

	withWorld( '{\n"classname" "worldspawn"\n}', () => {

		setCvar( r_wateralpha, 0.5 );
		setCvar( gl_model.r_lavaalpha, 1 );
		setCvar( gl_model.r_telealpha, 0.25 );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( water ), 0.5, 'water' );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( lava ), 1, 'lava' );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( tele ), 0.25, 'tele' );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( slime ), 0.5, 'slime falls back' );

	} );

} );

Deno.test( 'worldspawn keys set the map alpha until a cvar changes', () => {

	setCvar( r_wateralpha, 1 );
	withWorld( '{\n"classname" "worldspawn"\n"_wateralpha" "0.4"\n"lavaalpha" "0.8"\n}\n{\n"wateralpha" "0.1"\n}', () => {

		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( water ), 0.4, '_wateralpha' );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( lava ), 0.8, 'lavaalpha' );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( slime ), 1, 'slime falls back to r_wateralpha' );

		// setting the cvar overrides the map (QS's cvar callback)
		setCvar( r_wateralpha, 0.6 );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( water ), 0.6, 'cvar wins' );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( lava ), 0.8, 'lava keeps the map value' );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( slime ), 0.6, 'fallback follows the cvar' );

	} );

	// a new map reparses its own worldspawn
	withWorld( '{\n"classname" "worldspawn"\n}', () => {

		setCvar( r_wateralpha, 1 );
		assertEqual( gl_rsurf.GL_WaterAlphaForSurface( water ), 1, 'next map' );

	} );

} );
