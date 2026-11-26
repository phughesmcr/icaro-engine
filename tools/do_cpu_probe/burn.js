// CPU work for the probe, shared by worker.js (on Cloudflare) and probe.js
// (to calibrate locally). xorshift32: integer-only work that V8 can't
// optimise away.
export function burn( iters ) {

	let x = 0x9e3779b9 | 0;
	for ( let i = 0; i < iters; i ++ ) {

		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;

	}

	return x >>> 0;

}
