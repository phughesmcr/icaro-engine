// MSG_WriteCoord rounds to the nearest 1/8 unit (Ironwail's
// MSG_WriteCoord16 Q_rint) instead of truncating toward zero.

const common = await import( '../src/common.js' );

function writeCoord( f ) {

	const sb = new common.sizebuf_t();
	common.SZ_Alloc( sb, 256 );
	common.MSG_WriteCoord16( sb, f ); // the NetQuake short form
	const v = sb.data[ 0 ] | ( sb.data[ 1 ] << 8 );
	return ( v > 32767 ? v - 65536 : v ) / 8;

}

Deno.test( 'MSG_WriteCoord rounds to the nearest 1/8 (Q_rint)', () => {

	const cases = [
		[ 10.1, 10.125 ], // id's C sends 10
		[ - 10.1, - 10.125 ], // id's C sends -10
		[ 10.05, 10 ],
		[ 0.0624, 0 ],
		[ 0.0626, 0.125 ],
		[ - 0.0626, - 0.125 ],
		[ 4095.9, 4095.875 ],
		[ - 4096, - 4096 ]
	];

	for ( const [ input, expected ] of cases ) {

		const got = writeCoord( input );
		if ( got !== expected )
			throw new Error( `MSG_WriteCoord( ${input} ): expected ${expected}, got ${got}` );

	}

} );
