// svc_achievement (52), which the 2021 re-release QuakeC writes on every
// secret: the client reads and ignores its string, as Ironwail does, instead
// of stopping with "Illegible server message".

// Bootstrap the client renderer graph in its established safe import order.
await import( '../src/gl_rsurf.js' );

const { CL_ParseServerMessage } = await import( '../src/cl_parse.js' );
const { cl } = await import( '../src/client.js' );
const net = await import( '../src/net.js' );
const common = await import( '../src/common.js' );
const { MSG_WriteByte, MSG_WriteLong, MSG_WriteString, SZ_Clear, COM_SetNetMessage } = common;
const { svc_achievement, svc_updatestat } = await import( '../src/protocol.js' );
const { STAT_TOTALSECRETS } = await import( '../src/quakedef.js' );

function assertEqual( actual, expected, message ) {

	if ( actual !== expected )
		throw new Error( `${message}: expected ${expected}, got ${actual}` );

}

Deno.test( 'svc_achievement is read and ignored, and the next message still parses', () => {

	const savedMessage = {
		data: net.net_message.data, maxsize: net.net_message.maxsize, cursize: net.net_message.cursize
	};
	const savedCommonMessage = common.net_message;
	const savedStat = cl.stats[ STAT_TOTALSECRETS ];

	try {

		COM_SetNetMessage( net.net_message ); // Host_Init does this
		net.net_message.data = new Uint8Array( 256 );
		net.net_message.maxsize = 256;
		SZ_Clear( net.net_message );

		// multi_trigger on a secret: the achievement, then a stat update
		assertEqual( svc_achievement, 52, 'svc_achievement number' );
		MSG_WriteByte( net.net_message, svc_achievement );
		MSG_WriteString( net.net_message, 'ACH_FIND_SECRET' );
		MSG_WriteByte( net.net_message, svc_updatestat );
		MSG_WriteByte( net.net_message, STAT_TOTALSECRETS );
		MSG_WriteLong( net.net_message, 7 );
		cl.stats[ STAT_TOTALSECRETS ] = 0;

		CL_ParseServerMessage();

		assertEqual( cl.stats[ STAT_TOTALSECRETS ], 7, 'stat after the achievement' );

	} finally {

		cl.stats[ STAT_TOTALSECRETS ] = savedStat;
		net.net_message.data = savedMessage.data;
		net.net_message.maxsize = savedMessage.maxsize;
		net.net_message.cursize = savedMessage.cursize;
		COM_SetNetMessage( savedCommonMessage );

	}

} );
