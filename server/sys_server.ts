// Server-side system interface for Deno
// Replaces browser sys.js for the dedicated server

export function Sys_Init(): void {
	console.log('Icaro Engine Dedicated Server initializing...');
}

export function Sys_Error(error: string): never {
	console.error('Sys_Error:', error);
	Deno.exit(1);
}

const _quietLogAllowPatterns: RegExp[] = [
	/^Connection from /,
	/^Connection closed:/,
	/^Client .*(connected|removed)\b/,
	/^Spawning server for map:/,
	/^SpawnServer:/,
	/^Server initialized!/,
	/^Room .* idle for /,
	/^Host_ServerFrame error:/,
	/^SV_ReadClientMessage:/,
	/^Unhandled promise rejection:/,
	/^WebTransport server listening /,
	/^WebSocket server listening /,
	/^WebTransport server driver initialized/,
	/^NET_Init complete/,
	/^\[Heartbeat\]/,
	/^Host_Error/,
	/^Failed to start WebTransport listener/,
];

function _shouldPrintLine(line: string): boolean {
	const quietLogs = (globalThis as { __ICARO_QUIET_LOGS?: boolean })
		.__ICARO_QUIET_LOGS === true;
	if (!quietLogs) return true;

	const trimmed = line.trim();
	if (trimmed.length === 0) return false;

	for (const pattern of _quietLogAllowPatterns) {
		if (pattern.test(trimmed)) return true;
	}

	return false;
}

export function Sys_Printf(fmt: string, ...args: unknown[]): void {
	let result: string;
	if (args.length > 0) {
		// Simple printf-style formatting
		// Use a replacement function: a string replacement would expand `$&`,
		// `$'` etc. inside user-supplied arguments.
		let index = 0;
		result = fmt.replace(/%[sdif]/g, (spec) => {
			if (index >= args.length) return spec;
			return String(args[index++]);
		});
	} else {
		result = fmt;
	}

	if (_shouldPrintLine(result) === false) {
		return;
	}

	// console.log adds its own newline
	console.log(result.endsWith('\n') ? result.slice(0, -1) : result);
}

export function Sys_Quit(): void {
	console.log('Sys_Quit');
	Deno.exit(0);
}

export function Sys_FloatTime(): number {
	return performance.now() / 1000.0;
}

export function Sys_DoubleTime(): number {
	return performance.now() / 1000.0;
}

// Server-specific: milliseconds for precise timing
export function Sys_Milliseconds(): number {
	return performance.now();
}
