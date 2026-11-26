// Icaro Engine service worker: offline play and instant repeat launches
// (docs/mobile-roadmap.md, item 9). Web-only addition with no Quake
// equivalent. index.html registers it.
//
// What it caches, and how:
// - static/pak0.pak (the shareware pak) and version-pinned CDN modules
//   (three, nipplejs from cdn.jsdelivr.net/npm/<name>@<version>/): cache
//   first. Their contents never change under the same URL.
// - Everything else on this origin (index.html, main.js, src/, icons,
//   loose maps): network first, so a deploy reaches players on their next
//   online launch and every module of one load comes from the same version.
//   A successful response is copied into the cache; offline, the cached copy
//   is served.
// - Not cached: other paks (registered or rerelease data: big, and lazy paks
//   are read with Range requests, which the Cache API can't answer) and any
//   other request carrying a Range header (music: media elements read with
//   Range, and cache.put rejects a 206). Offline, these get a 404, which the
//   pak loader treats as "no such pak", so an offline launch still starts.
//
// On install it fetches the shell and pak0. The first page load runs before
// this worker controls it, so once the page has loaded it posts the URLs it
// fetched (main.js, src/*.js, three's files) and the worker caches those
// too. No file list is kept here, so new modules need no change to this file.
//
// Bump CACHE_NAME to drop everything cached by an older worker. Bump it
// whenever static/pak0.pak changes: it is cache first under the same URL, so
// players would otherwise keep the old copy.

const CACHE_NAME = 'icaro-v1';
const CACHE_PREFIX = 'icaro-';

const SHELL = [
	'./',
	'index.html',
	'main.js',
	'manifest.webmanifest',
	'static/icon.svg',
	'static/icon.png',
	'static/icon-192.png',
	'static/icon-maskable-512.png',
	'static/apple-touch-icon.png',
	'static/mainmenu.png',
	'static/pak0.pak',
];

const PAK0_PATH = 'static/pak0.pak';
const MEDIA_EXT = /\.(ogg|mp3|wav|flac|opus|m4a)$/i;
const CDN_HOST = 'cdn.jsdelivr.net';
// npm package with an exact version: /npm/three@0.183.0/...
const CDN_PINNED = /^\/npm\/(@[^/]+\/)?[^/@]+@\d+\.\d+\.\d+\//;

function scopeURL() {

	return new URL( self.registration !== undefined ? self.registration.scope : self.location.href );

}

function sameOrigin( url ) {

	return url.origin === self.location.origin;

}

// How to answer a GET: 'pak0', 'immutable', 'network', 'passthrough' or
// null (let the browser handle it). Exported for tests through self.
function SW_Route( request ) {

	if ( request.method !== 'GET' ) return null;

	const url = new URL( request.url );
	if ( url.protocol !== 'http:' && url.protocol !== 'https:' ) return null;

	if ( sameOrigin( url ) ) {

		const scope = scopeURL();
		if ( url.pathname === new URL( PAK0_PATH, scope ).pathname ) return 'pak0';
		if ( /\.pak$/i.test( url.pathname ) ) return 'passthrough';
		if ( request.headers.has( 'range' ) ) return 'passthrough';
		if ( ! url.pathname.startsWith( scope.pathname ) ) return null;
		return 'network';

	}

	if ( url.hostname === CDN_HOST && CDN_PINNED.test( url.pathname ) && ! request.headers.has( 'range' ) )
		return 'immutable';

	return null;

}

// The answer for something we can't fetch and don't have. The engine's
// loaders take a 404 as "not there" and carry on.
function offlineResponse() {

	return new Response( '', { status: 404, statusText: 'Not available offline' } );

}

// Cache key for a request: navigations drop the query (?room=, ?map= and
// the rest all load the same index.html)
function cacheKey( request ) {

	if ( request.mode !== 'navigate' ) return request.url;
	const url = new URL( request.url );
	url.search = '';
	url.hash = '';
	return url.href;

}

async function putIfOk( cache, key, response ) {

	// basic (same origin) or cors (CDN): never cache opaque or partial responses
	if ( response.status !== 200 || ( response.type !== 'basic' && response.type !== 'cors' && response.type !== 'default' ) )
		return;
	await cache.put( key, response );

}

// pak0: the cached whole pak answers every request, including the loader's
// Range: bytes=0-11 probe. pak.js takes a 200 to mean the server ignored the
// Range and reads the whole pak from it.
async function SW_Pak0( _request ) {

	const cache = await caches.open( CACHE_NAME );
	const key = new URL( PAK0_PATH, scopeURL() ).href;
	const cached = await cache.match( key );
	if ( cached !== undefined ) return cached;

	let response;
	try {

		response = await fetch( key );

	} catch {

		return offlineResponse();

	}

	if ( response.status === 200 ) await cache.put( key, response.clone() );
	return response;

}

async function SW_Immutable( request ) {

	const cache = await caches.open( CACHE_NAME );
	const cached = await cache.match( request.url );
	if ( cached !== undefined ) return cached;

	const response = await fetch( request );
	await putIfOk( cache, request.url, response.clone() );
	return response;

}

// Slow (not failed) network: after this long, a cached copy is served and
// the fetch finishes in the background to refresh the cache. On a link that
// hangs rather than fails, waiting for the browser's own timeout would hold
// up every module. A load that crosses a deploy at that moment can mix
// versions; the next launch is consistent again.
let networkTimeoutMs = 5000;

async function SW_Network( request ) {

	const cache = await caches.open( CACHE_NAME );
	const key = cacheKey( request );

	const network = fetch( request ).then( async ( response ) => {

		await putIfOk( cache, key, response.clone() );
		return response;

	} );

	let timer;
	const timeout = new Promise( ( resolve ) => {

		timer = setTimeout( () => resolve( null ), networkTimeoutMs );

	} );

	try {

		const first = await Promise.race( [ network, timeout ] );
		if ( first !== null ) return first;

		const cached = await cache.match( key );
		if ( cached !== undefined ) {

			network.catch( () => {} );
			return cached;

		}

		return await network;

	} catch {

		const cached = await cache.match( key );
		if ( cached !== undefined ) return cached;
		if ( request.mode === 'navigate' ) {

			const shell = await cache.match( new URL( './', scopeURL() ).href );
			if ( shell !== undefined ) return shell;

		}

		return offlineResponse();

	} finally {

		clearTimeout( timer );

	}

}

async function SW_Passthrough( request ) {

	try {

		return await fetch( request );

	} catch {

		return offlineResponse();

	}

}

const handlers = {
	pak0: SW_Pak0,
	immutable: SW_Immutable,
	network: SW_Network,
	passthrough: SW_Passthrough,
};

// Cache the URLs a page reports it loaded (see the header). Each URL is
// fetched on its own, so one failure doesn't drop the rest.
async function SW_CacheURLs( urls ) {

	const cache = await caches.open( CACHE_NAME );
	for ( const raw of urls ) {

		if ( typeof raw !== 'string' ) continue;
		let request;
		try {

			request = new Request( raw );

		} catch {

			continue;

		}

		const route = SW_Route( request );
		if ( route !== 'network' && route !== 'immutable' ) continue;
		// music the page streamed: media is read with Range and isn't cached
		if ( MEDIA_EXT.test( new URL( request.url ).pathname ) ) continue;
		if ( await cache.match( request.url ) !== undefined ) continue;

		try {

			await putIfOk( cache, request.url, await fetch( request ) );

		} catch {

			// offline or blocked: it will be cached when next fetched

		}

	}

}

self.addEventListener( 'install', ( event ) => {

	event.waitUntil( ( async () => {

		const cache = await caches.open( CACHE_NAME );
		const scope = scopeURL();
		for ( const path of SHELL ) {

			const url = new URL( path, scope ).href;
			try {

				await putIfOk( cache, url, await fetch( url ) );

			} catch {

				// a missing icon must not block offline play

			}

		}

		await self.skipWaiting();

	} )() );

} );

self.addEventListener( 'activate', ( event ) => {

	event.waitUntil( ( async () => {

		for ( const name of await caches.keys() ) {

			if ( name.startsWith( CACHE_PREFIX ) && name !== CACHE_NAME ) await caches.delete( name );

		}

		await self.clients.claim();

	} )() );

} );

self.addEventListener( 'fetch', ( event ) => {

	const route = SW_Route( event.request );
	if ( route === null ) return;
	event.respondWith( handlers[ route ]( event.request ) );

} );

self.addEventListener( 'message', ( event ) => {

	const data = event.data;
	if ( data === null || typeof data !== 'object' || data.type !== 'cache-urls' || ! Array.isArray( data.urls ) )
		return;
	event.waitUntil( SW_CacheURLs( data.urls ) );

} );

// For tests (tests/sw_test.js)
self.SW_Route = SW_Route;
self.SW_CACHE_NAME = CACHE_NAME;
self.SW_SetNetworkTimeout = ( ms ) => {

	networkTimeoutMs = ms;

};
