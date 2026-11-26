// Check that a formatting change left the code's meaning alone.
//
// Usage, from the repository root:
//   deno run --allow-read --allow-run=git tools/fmt_ast_check.js <base-ref> [<file>...]
//
// For each .js and .ts file that differs between <base-ref> and the working
// tree (or each <file> given), it parses both versions with @babel/parser and
// compares the syntax trees, ignoring positions, comments, raw source text
// (quote style, number spelling) and redundant parentheses. It also accepts
// the changes deno fmt makes with this repository's settings
// (docs/style-cleanup-plan.md):
//   - braces added or removed around a single statement (useBraces). The
//     trees are already parsed, so an `else` belongs to the same `if` either
//     way, and a lone declaration can't be a bare body in a module;
//   - empty statements (a stray `;`) dropped from a statement list;
//   - a quoted property key that needs no quotes, unquoted (quoteProps);
//   - the names inside one import { ... } or export { ... } reordered
//     (sortNamedImports, sortNamedExports).
// Anything else is reported, including import declarations that moved: some
// modules are in import cycles where their order matters.
//
// Exit status: 0 when every file matches, 1 when any differs or fails to parse.

// A full specifier, not the import map: server/deno.json repeats that map
// and only tools/ needs this package
import { parse } from 'npm:@babel/parser@8.1.3';

// Keys that hold layout, not meaning
const SKIP = new Set( [ 'start', 'end', 'loc', 'range', 'extra', 'comments',
	'leadingComments', 'trailingComments', 'innerComments', 'tokens', 'errors' ] );

// Statement positions where useBraces can add or remove a block
const BODY_KEYS = {
	IfStatement: [ 'consequent', 'alternate' ],
	ForStatement: [ 'body' ],
	ForInStatement: [ 'body' ],
	ForOfStatement: [ 'body' ],
	WhileStatement: [ 'body' ],
	DoWhileStatement: [ 'body' ],
};

// Statement lists, where an empty statement means nothing
const LIST_KEYS = {
	Program: 'body',
	BlockStatement: 'body',
	StaticBlock: 'body',
	TSModuleBlock: 'body',
	SwitchCase: 'consequent',
};

const IDENTIFIER_NAME = /^[A-Za-z_$][\w$]*$/;

function parseSource( text, path ) {

	return parse( text, {
		sourceType: 'module',
		createParenthesizedExpressions: false,
		plugins: path.endsWith( '.ts' ) ? [ 'typescript' ] : [],
	} );

}

function unwrapBlock( node ) {

	if ( node !== null && node !== undefined && node.type === 'BlockStatement'
		&& node.body.length === 1 && node.directives.length === 0 )
		return node.body[ 0 ];
	return node;

}

function specifierName( n ) {

	return n === null || n === undefined ? '' : ( n.name ?? n.value ?? '' );

}

function sortSpecifiers( list, nodeType ) {

	const named = nodeType === 'ImportDeclaration' ? 'ImportSpecifier' : 'ExportSpecifier';
	const head = list.filter( ( s ) => s.type !== named );
	const rest = list.filter( ( s ) => s.type === named );
	const key = nodeType === 'ImportDeclaration'
		? ( s ) => specifierName( s.imported ) + ' ' + specifierName( s.local )
		: ( s ) => specifierName( s.local ) + ' ' + specifierName( s.exported );
	rest.sort( ( a, b ) => ( key( a ) < key( b ) ? - 1 : key( a ) > key( b ) ? 1 : 0 ) );
	return head.concat( rest );

}

// The value of node[ key ], with deno fmt's accepted changes undone
function child( node, key ) {

	const value = node[ key ];
	const type = node.type;
	if ( BODY_KEYS[ type ] !== undefined && BODY_KEYS[ type ].includes( key ) )
		return unwrapBlock( value );
	if ( LIST_KEYS[ type ] === key && Array.isArray( value ) )
		return value.filter( ( s ) => s.type !== 'EmptyStatement' );
	if ( key === 'key' && node.computed === false && value !== null && value.type === 'StringLiteral'
		&& IDENTIFIER_NAME.test( value.value ) )
		return { type: 'Identifier', name: value.value, loc: value.loc };
	if ( key === 'specifiers' && ( type === 'ImportDeclaration' || type === 'ExportNamedDeclaration' ) )
		return sortSpecifiers( value, type );
	return value;

}

// Compare two trees. Returns null when they match, or a description of the
// first difference with the line of the nearest node on each side.
function compare( a, b, path, lines ) {

	if ( a === b ) return null;
	if ( a === null || b === null || typeof a !== 'object' || typeof b !== 'object' ) {

		if ( ( a === undefined || a === null ) && ( b === undefined || b === null ) ) return null;
		return { path, lines, why: JSON.stringify( a ) + ' vs ' + JSON.stringify( b ) };

	}

	if ( Array.isArray( a ) !== Array.isArray( b ) )
		return { path, lines, why: 'list vs node' };

	if ( Array.isArray( a ) ) {

		if ( a.length !== b.length )
			return { path, lines, why: a.length + ' items vs ' + b.length };
		for ( let i = 0; i < a.length; i ++ ) {

			const d = compare( a[ i ], b[ i ], path + '[' + i + ']', lines );
			if ( d !== null ) return d;

		}

		return null;

	}

	const here = [
		a.loc !== undefined && a.loc !== null ? a.loc.start.line : lines[ 0 ],
		b.loc !== undefined && b.loc !== null ? b.loc.start.line : lines[ 1 ],
	];
	const where = path + ( typeof a.type === 'string' ? '.' + a.type : '' );
	if ( a.type !== b.type )
		return { path: where, lines: here, why: a.type + ' vs ' + b.type };

	const keys = new Set( [ ...Object.keys( a ), ...Object.keys( b ) ] );
	for ( const key of keys ) {

		if ( SKIP.has( key ) ) continue;
		const d = compare( child( a, key ), child( b, key ), where + '.' + key, here );
		if ( d !== null ) return d;

	}

	return null;

}

async function git( args ) {

	const out = await new Deno.Command( 'git', { args, stdout: 'piped', stderr: 'piped' } ).output();
	if ( out.success !== true )
		throw new Error( 'git ' + args.join( ' ' ) + ': ' + new TextDecoder().decode( out.stderr ).trim() );
	return new TextDecoder().decode( out.stdout );

}

async function main( args ) {

	if ( args.length < 1 ) {

		console.error( 'usage: tools/fmt_ast_check.js <base-ref> [<file>...]' );
		return 2;

	}

	const base = args[ 0 ];
	let files = args.slice( 1 );
	if ( files.length === 0 )
		files = ( await git( [ 'diff', '--name-only', '--diff-filter=M', base, '--', '*.js', '*.ts' ] ) )
			.split( '\n' ).filter( ( f ) => f !== '' );

	let bad = 0;
	for ( const file of files ) {

		let before, after;
		try {

			before = parseSource( await git( [ 'show', base + ':' + file ] ), file );
			after = parseSource( await Deno.readTextFile( file ), file );

		} catch ( e ) {

			console.log( file + ': ' + e.message );
			bad ++;
			continue;

		}

		const d = compare( before.program, after.program, 'program', [ 1, 1 ] );
		if ( d !== null ) {

			console.log( file + ':' + d.lines[ 1 ] + ' (was line ' + d.lines[ 0 ] + '): ' + d.path + ': ' + d.why );
			bad ++;

		}

	}

	console.log( ( files.length - bad ) + ' of ' + files.length + ' files match' );
	return bad === 0 ? 0 : 1;

}

Deno.exit( await main( Deno.args ) );
