// Tests for the Ironwail solo scoreboard layout (sbar.js Sbar_SoloScoreboard):
// kills and secrets either side, the skill between them, and the level title
// centred above, scrolling when it is wider than the bar.

await import( '../src/gl_rsurf.js' );
globalThis.window = { devicePixelRatio: 1 }; // gl_draw.js sizes the virtual screen from it

const sbar = await import( '../src/sbar.js' );
const host = await import( '../src/host.js' );
const { Draw_GetVirtualWidth, Draw_GetVirtualHeight } = await import( '../src/gl_draw.js' );
const { STAT_MONSTERS, STAT_TOTALMONSTERS, STAT_SECRETS, STAT_TOTALSECRETS } = await import( '../src/quakedef.js' );

// Characters drawn, keyed by screen y then x
const drawn = [];
const cl = {
	stats: new Int32Array( 32 ), items: 0, gametype: 0, scores: [], time: 0, faceanimtime: 0,
	maxclients: 1, levelname: '', item_gettime: new Float32Array( 32 ), viewentity: 0, worldmodel: null,
};
sbar.Sbar_SetExternals( { cl, Draw_Character: ( x, y, c ) => drawn.push( { x, y, c } ) } );

const XOFS = ( Draw_GetVirtualWidth() - 320 ) >> 1;
const YOFS = Draw_GetVirtualHeight() - 24; // SBAR_HEIGHT

// The text drawn on sbar row y, with the bar-relative x of its first character
function row( y ) {

	const chars = drawn.filter( ( d ) => d.y === YOFS + y ).sort( ( a, b ) => a.x - b.x );
	if ( chars.length === 0 ) return { x: null, text: '' };
	let text = '';
	let next = chars[ 0 ].x;
	for ( const d of chars ) {

		while ( next < d.x ) {

			text += ' ';
			next += 8;

		}

		text += String.fromCharCode( d.c );
		next = d.x + 8;

	}

	return { x: chars[ 0 ].x - XOFS, text };

}

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${JSON.stringify( expected )}, got ${JSON.stringify( actual )}` );

}

Deno.test( 'Sbar_SoloScoreboard draws the Ironwail layout', () => {

	const savedSkill = host.skill.value;
	try {

		host.skill.value = 2;
		cl.stats[ STAT_MONSTERS ] = 5;
		cl.stats[ STAT_TOTALMONSTERS ] = 12;
		cl.stats[ STAT_SECRETS ] = 1;
		cl.stats[ STAT_TOTALSECRETS ] = 3;
		cl.levelname = 'the  Slipgate\nComplex ';
		cl.worldmodel = { name: 'maps/e1m1.bsp' };

		drawn.length = 0;
		sbar.Sbar_SoloScoreboard();

		// "Kills: 5/12" at 8 (ends at 96); "Secrets: 1/3" ends at 312 (starts at 216);
		// "skill 2" centred between them: ( 96 + 216 ) / 2 - 7 * 4 = 128
		const bottom = row( 12 );
		assertEqual( bottom.x, 8, 'kills x' );
		assertEqual( bottom.text, 'Kills: 5/12' + ' '.repeat( 4 ) + 'skill 2' + ' '.repeat( 4 ) + 'Secrets: 1/3', 'bottom row' );

		// Sanitized level name and map name, centred at 160
		const title = 'the Slipgate Complex (e1m1)';
		const top = row( 4 );
		assertEqual( top.text, title, 'title' );
		assertEqual( top.x, 160 - title.length * 4, 'title x' );

		// Rebuilt when the stats change
		cl.stats[ STAT_MONSTERS ] = 6;
		drawn.length = 0;
		sbar.Sbar_SoloScoreboard();
		assertEqual( row( 12 ).text.startsWith( 'Kills: 6/12' ), true, 'kills updated' );

	} finally {

		host.skill.value = savedSkill;

	}

} );

Deno.test( 'Sbar_SoloScoreboard falls back to the map name and scrolls long titles', () => {

	cl.levelname = '';
	cl.worldmodel = { name: 'maps/start.bsp' };
	drawn.length = 0;
	sbar.Sbar_SoloScoreboard();
	assertEqual( row( 4 ).text, 'start', 'map name only' );

	// Over 40 characters: drawn twice with '///' between, offset by realtime
	const name = 'An extremely long level name for scrolling';
	cl.levelname = name;
	drawn.length = 0;
	sbar.Sbar_SoloScoreboard();
	const str = name + ' (start)';
	const len = str.length * 8 + 40;
	const ofs = Math.floor( host.realtime * 30 ) % len;
	const top = row( 4 );
	assertEqual( top.x, - ofs, 'scroll start' );
	assertEqual( top.text, str + ' /// ' + str, 'scrolled text' );

} );
