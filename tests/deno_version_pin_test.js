// The Deno version is pinned twice: .tool-versions (CI and local tools) and
// the game-room image's base in server/Dockerfile. Dependabot bumps neither,
// so a bump that misses one copy would test on one Deno and ship another.

const root = new URL( '../', import.meta.url );

Deno.test( 'server/Dockerfile uses the Deno version in .tool-versions', () => {

	const tool_versions = Deno.readTextFileSync( new URL( '.tool-versions', root ) );
	const pin = tool_versions.match( /^deno\s+(\S+)\s*$/m );
	if ( pin === null ) throw new Error( '.tool-versions has no deno line' );

	const dockerfile = Deno.readTextFileSync( new URL( 'server/Dockerfile', root ) );
	const from = [ ...dockerfile.matchAll( /^FROM\s+denoland\/deno:(?:[a-z0-9]+-)?([0-9][^@\s]*)/gm ) ];
	if ( from.length === 0 ) throw new Error( 'server/Dockerfile has no denoland/deno FROM line' );

	for ( const m of from ) {

		if ( m[ 1 ] !== pin[ 1 ] )
			throw new Error( `server/Dockerfile uses Deno ${m[ 1 ]}, .tool-versions pins ${pin[ 1 ]}: bump both together` );

	}

} );
