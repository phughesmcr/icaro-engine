#!/usr/bin/env python3
"""Inventory C functions, cvars and console commands against the JS port.

Usage:
  python3 tools/port_inventory.py <WinQuake dir> <repo root> [--platform] > out.tsv

<WinQuake dir> is the WinQuake/ folder of id-Software/Quake. Without
--platform it scans CORE_FILES: the GLQuake build's object list
(Makefile.linuxi386 GLQUAKE_OBJS) minus the platform drivers, plus
cd_audio.c, which src/cd_audio.js cites. With --platform it scans
PLATFORM_FILES (the Win32 GLQuake drivers) for cvars and commands only.

For each C item it reports whether src/, server/ or main.js has a same-named
counterpart. Name matching cannot see partial bodies, switch cases,
COM_CheckParm arguments or the pr_builtin table order.

Output columns (tab-separated):
  kind      function | cvar | command
  name      C function name, cvar name or command name
  c_file, c_line
  cpp       preprocessor conditions around the item (`#if 0`, QUAKE2...)
  c_callers functions only: number of uses in all WinQuake/*.c and *.h,
            excluding definitions and prototypes
  status    see below
  js_where  first JS file where the counterpart was found
  c_symbol  C variable (cvar) or handler function (command)
  note      detail for `differs` and `handler`

status:
  functions: defined | stub (every JS definition has an empty or
             constant-return body) | used (name appears in code but is not
             defined, e.g. an injected callback) | mentioned (comments only)
             | missing
  cvars:     registered | differs (default, archive or server flag differs,
             never passed to Cvar_RegisterVariable, or never read in JS while C
             reads it) | string-only | mentioned | missing
  commands:  registered | handler (registered with a JS handler of a
             different name) | string-only | mentioned | missing
"""
import os
import re
import sys

CORE_FILES = [
	'cl_demo.c', 'cl_input.c', 'cl_main.c', 'cl_parse.c', 'cl_tent.c', 'chase.c', 'cmd.c',
	'common.c', 'console.c', 'crc.c', 'cvar.c',
	'gl_draw.c', 'gl_mesh.c', 'gl_model.c', 'gl_refrag.c', 'gl_rlight.c', 'gl_rmain.c',
	'gl_rmisc.c', 'gl_rsurf.c', 'gl_screen.c', 'gl_warp.c',
	'host.c', 'host_cmd.c', 'keys.c', 'menu.c', 'mathlib.c', 'net_loop.c', 'net_main.c',
	'pr_cmds.c', 'pr_edict.c', 'pr_exec.c', 'r_part.c', 'sbar.c',
	'sv_main.c', 'sv_phys.c', 'sv_move.c', 'sv_user.c', 'zone.c', 'view.c', 'wad.c', 'world.c',
	'snd_dma.c', 'snd_mem.c', 'snd_mix.c', 'cd_audio.c',
]
# Win32 GLQuake platform files (WinQuake.dsp "GL Release"), plus gl_test.c.
PLATFORM_FILES = [
	'cd_win.c', 'conproc.c', 'gl_test.c', 'gl_vidnt.c', 'in_win.c', 'net_dgrm.c', 'net_vcr.c',
	'net_win.c', 'net_wins.c', 'net_wipx.c', 'snd_win.c', 'sys_win.c',
]

C_KEYWORDS = { 'if', 'while', 'for', 'switch', 'return', 'sizeof', 'else', 'do' }

FUNC_RE = re.compile( r'^(?!#)(?!typedef)[A-Za-z_][\w \t\*]*?[\s\*]([A-Za-z_]\w*)\s*\(([^;]*)$' )
CVAR_RE = re.compile( r'^\s*(?:static\s+)?cvar_t\s+(\w+)\s*=\s*\{\s*"([^"]+)"\s*,\s*"([^"]*)"\s*(?:,\s*(\w+))?\s*(?:,\s*(\w+))?' )
CMD_RE = re.compile( r'Cmd_AddCommand\s*\(\s*"([^"]+)"\s*,\s*&?\s*(\w+)' )

JS_CVAR_RE = re.compile( r"([A-Za-z_$][\w$]*)\s*=\s*new\s+cvar_t\(\s*'([^']+)'\s*,\s*'([^']*)'\s*(?:,\s*(\w+))?\s*(?:,\s*(\w+))?" )
JS_CVAR_OBJ_RE = re.compile( r"([A-Za-z_$][\w$]*)\s*=\s*\{\s*name:\s*'([^']+)'\s*,\s*string:\s*'([^']*)'([^}]*)\}" )
JS_REG_RE = re.compile( r"Cvar_RegisterVariable\(\s*([A-Za-z_$][\w$.]*)\s*\)" )
JS_CMD_RE = re.compile( r"Cmd_AddCommand\(\s*'([^']+)'\s*,\s*([^)]*?)\s*\)" )

DEF_RES = [
	re.compile( r'\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(' ),
	re.compile( r'\b(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)' ),
	re.compile( r'^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{', re.M ),  # method
	re.compile( r'\b([A-Za-z_$][\w$]*)\s*:\s*(?:function|\()' ),
	re.compile( r'\b(?:export\s+)?(?:let|var)\s+[^;]*?\b([A-Za-z_$][\w$]*)\s*[,;=]' ),
]

STUB_BODY = re.compile( r'^\s*(?:return\s*(?:0|null|false|true|undefined|\'\'|-1)?\s*;?\s*)?$' )


def flag( v ):
	return v is not None and v not in ( 'false', '0' )


def strip_c( lines ):
	"""Return lines with comments removed (line count kept)."""
	out = []
	in_comment = False
	for line in lines:
		code = line
		if in_comment:
			if '*/' in code:
				code = code.split( '*/', 1 )[ 1 ]
				in_comment = False
			else:
				out.append( '' )
				continue
		code = re.sub( r'/\*.*?\*/', '', code )
		if '/*' in code:
			code = code.split( '/*', 1 )[ 0 ]
			in_comment = True
		code = code.split( '//', 1 )[ 0 ]
		out.append( code )
	return out


def scan_c( path, fname ):
	items = []
	stack = []
	with open( path, encoding='latin-1' ) as fh:
		lines = fh.read().split( '\n' )
	codes = strip_c( lines )
	depth = 0
	for i, code in enumerate( codes ):
		s = code.strip()
		m = re.match( r'#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)', s )
		if m:
			d, cond = m.group( 1 ), m.group( 2 ).strip()
			if d == 'ifdef':
				stack.append( 'defined(' + cond + ')' )
			elif d == 'ifndef':
				stack.append( '!defined(' + cond + ')' )
			elif d == 'if':
				stack.append( cond )
			elif d in ( 'elif', 'else' ):
				if stack:
					prev = stack.pop()
					stack.append( ( 'else-of ' + prev ) if d == 'else' else ( 'elif ' + cond ) )
			elif d == 'endif' and stack:
				stack.pop()
			continue
		conds = ' && '.join( stack )
		nostr = re.sub( r'"(?:\\.|[^"\\])*"', '""', code )
		nostr = re.sub( r"'(?:\\.|[^'\\])*'", "''", nostr )
		if depth == 0:
			fm = FUNC_RE.match( code )
			if fm and fm.group( 1 ) not in C_KEYWORDS and not code.startswith( ( ' ', '\t' ) ):
				for j in range( i, min( i + 6, len( codes ) ) ):
					t = codes[ j ]
					if j > i and ';' in t and '{' not in t:
						break
					if '{' in t:
						items.append( ( 'function', fm.group( 1 ), fname, i + 1, conds, fm.group( 1 ), None ) )
						break
			cm = CVAR_RE.match( code )
			if cm:
				items.append( ( 'cvar', cm.group( 2 ), fname, i + 1, conds, cm.group( 1 ),
					( cm.group( 3 ), flag( cm.group( 4 ) ), flag( cm.group( 5 ) ) ) ) )
		for cmd in CMD_RE.finditer( code ):
			items.append( ( 'command', cmd.group( 1 ), fname, i + 1, conds, cmd.group( 2 ), None ) )
		depth = max( 0, depth + nostr.count( '{' ) - nostr.count( '}' ) )
	return items


def c_blob( wq ):
	parts = []
	for f in sorted( os.listdir( wq ) ):
		if f.endswith( ( '.c', '.h' ) ):
			with open( os.path.join( wq, f ), encoding='latin-1' ) as fh:
				parts.append( '\n'.join( strip_c( fh.read().split( '\n' ) ) ) )
	return '\n'.join( parts )


def c_callers( blob, name ):
	"""Uses (calls or address-of) minus definitions and prototypes."""
	uses = len( re.findall( r'\b%s\b' % re.escape( name ), blob ) )
	decls = len( re.findall( r'^[A-Za-z_][\w \t\*]*\b%s\s*\(' % re.escape( name ), blob, re.M ) )
	return max( 0, uses - decls )


def c_reads( blob, sym ):
	return len( re.findall( r'\b%s\s*\.\s*(?:value|string)\b' % re.escape( sym ), blob ) )


def strip_js_comments( text ):
	text = re.sub( r'/\*.*?\*/', lambda m: '\n' * m.group( 0 ).count( '\n' ), text, flags=re.S )
	return re.sub( r'//[^\n]*', '', text )


def js_function_bodies( code ):
	"""Yield ( name, body ) for `function name( ... ) { body }`."""
	for m in re.finditer( r'\bfunction\s+([A-Za-z_$][\w$]*)\s*\(', code ):
		# skip the parameter list, which may contain default values with parens
		i = m.end()
		depth = 1
		while i < len( code ) and depth > 0:
			depth += { '(': 1, ')': -1 }.get( code[ i ], 0 )
			i += 1
		while i < len( code ) and code[ i ].isspace():
			i += 1
		if i >= len( code ) or code[ i ] != '{':
			continue
		start = i + 1
		i = start
		depth = 1
		while i < len( code ) and depth > 0:
			depth += { '{': 1, '}': -1 }.get( code[ i ], 0 )
			i += 1
		yield m.group( 1 ), code[ start:i - 1 ]


class Js:

	def __init__( self, root ):
		self.defined = {}
		self.code_tokens = {}
		self.all_tokens = {}
		self.strings = {}
		self.cvars = {}
		self.cvar_syms = {}
		self.registered_syms = set()
		self.cmds = {}
		self.bodies = {}  # name -> list of ( file, is_stub )
		code_parts = []
		for sub in ( 'src', 'server', 'main.js' ):
			base = os.path.join( root, sub )
			paths = []
			if os.path.isfile( base ):
				paths = [ base ]
			else:
				for dp, _dn, fn in os.walk( base ):
					for f in fn:
						if f.endswith( ( '.js', '.ts' ) ) and not f.endswith( ( '_test.ts', '_test.js' ) ):
							paths.append( os.path.join( dp, f ) )
			for p in sorted( paths ):
				rel = os.path.relpath( p, root )
				with open( p, encoding='utf-8' ) as fh:
					text = fh.read()
				code = strip_js_comments( text )
				code_parts.append( code )
				for r in DEF_RES:
					for m in r.finditer( code ):
						self.defined.setdefault( m.group( 1 ), rel )
				for name, body in js_function_bodies( code ):
					self.bodies.setdefault( name, [] ).append( ( rel, bool( STUB_BODY.match( body ) ) ) )
				for m in re.finditer( r'[\'"`]([^\'"`\n]+)[\'"`]', code ):
					self.strings.setdefault( m.group( 1 ), rel )
				for m in JS_CVAR_RE.finditer( code ):
					self.cvars.setdefault( m.group( 2 ), ( rel, m.group( 3 ), flag( m.group( 4 ) ), flag( m.group( 5 ) ) ) )
					self.cvar_syms.setdefault( m.group( 2 ), set() ).add( m.group( 1 ) )
				for m in JS_CVAR_OBJ_RE.finditer( code ):
					rest = m.group( 4 )
					self.cvars.setdefault( m.group( 2 ), ( rel, m.group( 3 ), 'archive: true' in rest, 'server: true' in rest ) )
					self.cvar_syms.setdefault( m.group( 2 ), set() ).add( m.group( 1 ) )
				for m in JS_REG_RE.finditer( code ):
					self.registered_syms.add( m.group( 1 ).split( '.' )[ -1 ] )
				for m in JS_CMD_RE.finditer( code ):
					self.cmds.setdefault( m.group( 1 ), ( rel, m.group( 2 ) ) )
				for m in re.finditer( r'[A-Za-z_$][\w$]*', code ):
					self.code_tokens.setdefault( m.group( 0 ), rel )
				for m in re.finditer( r'[A-Za-z_$][\w$]*', text ):
					self.all_tokens.setdefault( m.group( 0 ), rel )
		self.blob = '\n'.join( code_parts )

	def reads( self, name ):
		"""Reads of a cvar: SYM.value / SYM.string (also through `_SYM` aliases)
		or Cvar_Variable*( 'name' )."""
		n = len( re.findall( r"Cvar_Variable(?:Value|String)\(\s*'%s'" % re.escape( name ), self.blob ) )
		for sym in self.cvar_syms.get( name, () ):
			n += len( re.findall( r'\b_?%s\s*\.\s*(?:value|string)\b' % re.escape( sym ), self.blob ) )
		return n

	def stub_where( self, name ):
		defs = self.bodies.get( name )
		if defs and all( stub for _f, stub in defs ):
			return defs[ 0 ][ 0 ]
		return None


def status( kind, name, sym, cinfo, js, cblob ):
	note = ''
	if kind == 'function':
		if name in js.defined:
			sw = js.stub_where( name )
			st, where = ( 'stub', sw ) if sw is not None else ( 'defined', js.defined[ name ] )
		elif name in js.code_tokens:
			st, where = 'used', js.code_tokens[ name ]
		elif name in js.all_tokens:
			st, where = 'mentioned', js.all_tokens[ name ]
		else:
			st, where = 'missing', ''
	elif kind == 'cvar':
		if name in js.cvars:
			where, jdef, jarch, jserv = js.cvars[ name ]
			st = 'registered'
			cdef, carch, cserv = cinfo
			diffs = []
			if cdef != jdef:
				diffs.append( 'default C=%r JS=%r' % ( cdef, jdef ) )
			if carch != jarch:
				diffs.append( 'archive C=%s JS=%s' % ( carch, jarch ) )
			if cserv != jserv:
				diffs.append( 'server C=%s JS=%s' % ( cserv, jserv ) )
			if not ( js.cvar_syms.get( name, set() ) & js.registered_syms ):
				diffs.append( 'never passed to Cvar_RegisterVariable' )
			if c_reads( cblob, sym ) > 0 and js.reads( name ) == 0:
				diffs.append( 'C reads it, JS never does' )
			if diffs:
				st, note = 'differs', '; '.join( diffs )
		elif name in js.strings:
			st, where = 'string-only', js.strings[ name ]
		elif name in js.all_tokens or sym in js.all_tokens:
			st, where = 'mentioned', js.all_tokens.get( name ) or js.all_tokens.get( sym )
		else:
			st, where = 'missing', ''
	else:
		if name in js.cmds:
			where, handler = js.cmds[ name ]
			st = 'registered'
			if handler != sym:
				st, note = 'handler', 'C=%s JS=%s' % ( sym, handler )
		elif name in js.strings:
			st, where = 'string-only', js.strings[ name ]
		elif name in js.all_tokens:
			st, where = 'mentioned', js.all_tokens[ name ]
		else:
			st, where = 'missing', ''
	return st, where, note


def main():
	wq, root = sys.argv[ 1 ], sys.argv[ 2 ]
	platform = '--platform' in sys.argv[ 3: ]
	js = Js( root )
	cblob = c_blob( wq )
	print( '\t'.join( ( 'kind', 'name', 'c_file', 'c_line', 'cpp', 'c_callers', 'status', 'js_where', 'c_symbol', 'note' ) ) )
	for f in ( PLATFORM_FILES if platform else CORE_FILES ):
		for kind, name, fname, line, conds, sym, cinfo in scan_c( os.path.join( wq, f ), f ):
			if platform and kind == 'function':
				continue
			st, where, note = status( kind, name, sym, cinfo, js, cblob )
			callers = str( c_callers( cblob, name ) ) if kind == 'function' else ''
			print( '\t'.join( ( kind, name, fname, str( line ), conds, callers, st, where, sym, note ) ) )


if __name__ == '__main__':
	main()
