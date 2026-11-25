// Web-only addition, no Quake equivalent: the table and value stepping
// behind the Options menu's Advanced pages (menu.js M_Advanced_*). Phone and
// tablet players have no console, so these pages expose the player-facing
// cvars they could otherwise only set there. The cvar names are the engine's
// own console names. This module is pure (no cvar or DOM access) so the
// stepping and clamping can be tested on their own.

/*
Each row names a cvar and how it changes:
- slider: min, max and step. Values snap to the grid from min. `zero`, if
  set, is shown instead of 0 (the liquid alphas fall back to r_wateralpha).
- choice: values (and optional names to show for them), stepped in order
  and wrapping, so a tap on the row reaches every value.
- toggle: neither; 0 and 1.
*/
const SCALES = [ 0, 1, 2, 3, 4, 5, 6 ];
const SCALE_NAMES = [ 'auto', '1', '2', '3', '4', '5', '6' ];
const OFF_ON_SMOOTH = [ 'off', 'on', 'smooth' ];

export const advancedPages = [
	{
		title: 'HUD',
		items: [
			{ label: 'Status bar size', cvar: 'scr_sbarscale', values: SCALES, names: SCALE_NAMES },
			{ label: 'Console size', cvar: 'scr_conscale', values: SCALES, names: SCALE_NAMES },
			{ label: 'Menu size', cvar: 'scr_menuscale', values: SCALES, names: SCALE_NAMES },
			{ label: 'HUD opacity', cvar: 'scr_sbaralpha', min: 0, max: 1, step: 0.1 },
			{ label: 'Show FPS', cvar: 'scr_showfps' },
			{ label: 'Show clock', cvar: 'scr_clock' },
			{ label: 'Log centerprint', cvar: 'con_logcenterprint', values: [ 0, 1, 2 ], names: [ 'off', 'not dm', 'always' ] },
			{ label: 'Field of view', cvar: 'fov', min: 60, max: 130, step: 5 },
			{ label: 'Gun FOV scale', cvar: 'cl_gun_fovscale', min: 0, max: 1, step: 0.1 },
			{ label: 'Max FPS', cvar: 'host_maxfps', values: [ 30, 60, 72, 90, 120, 144, 240 ] }
		]
	},
	{
		title: 'Rendering',
		items: [
			{ label: 'Draw distance', cvar: 'gl_farclip', values: [ 2048, 4096, 8192, 16384 ] },
			{ label: 'Anisotropy', cvar: 'gl_texture_anisotropy', values: [ 1, 2, 4, 8, 16 ] },
			{ label: 'Water opacity', cvar: 'r_wateralpha', min: 0, max: 1, step: 0.1 },
			{ label: 'Lava opacity', cvar: 'r_lavaalpha', min: 0, max: 1, step: 0.1, zero: 'water' },
			{ label: 'Slime opacity', cvar: 'r_slimealpha', min: 0, max: 1, step: 0.1, zero: 'water' },
			{ label: 'Tele opacity', cvar: 'r_telealpha', min: 0, max: 1, step: 0.1, zero: 'water' },
			{ label: 'Underwater warp', cvar: 'r_waterwarp' },
			{ label: 'Dynamic lights', cvar: 'r_dynamic' },
			{ label: 'Flash blend', cvar: 'gl_flashblend' },
			{ label: 'Animation lerp', cvar: 'r_lerpmodels', values: [ 0, 1, 2 ], names: [ 'off', 'on', 'all' ] },
			{ label: 'Movement lerp', cvar: 'r_lerpmove' },
			{ label: 'Double eyes', cvar: 'gl_doubleeys' },
			{ label: 'Shadows', cvar: 'r_shadows' },
			{ label: 'Blend all', cvar: 'gl_cshiftpercent', min: 0, max: 100, step: 10 },
			{ label: 'Blend contents', cvar: 'gl_cshiftpercent_contents', min: 0, max: 100, step: 10 },
			{ label: 'Blend damage', cvar: 'gl_cshiftpercent_damage', min: 0, max: 100, step: 10 },
			{ label: 'Blend bonus', cvar: 'gl_cshiftpercent_bonus', min: 0, max: 100, step: 10 },
			{ label: 'Blend powerup', cvar: 'gl_cshiftpercent_powerup', min: 0, max: 100, step: 10 }
		]
	},
	{
		title: 'View',
		items: [
			{ label: 'Gun kick', cvar: 'v_gunkick', values: [ 0, 1, 2 ], names: OFF_ON_SMOOTH },
			{ label: 'Show gun', cvar: 'r_drawviewmodel' },
			{ label: 'View bob', cvar: 'cl_bob', min: 0, max: 0.05, step: 0.005 },
			{ label: 'View roll', cvar: 'cl_rollangle', min: 0, max: 5, step: 0.5 },
			{ label: 'Look up limit', cvar: 'cl_maxpitch', min: 45, max: 90, step: 5 },
			{ label: 'Look down limit', cvar: 'cl_minpitch', min: - 90, max: - 45, step: 5 }
		]
	},
	{
		title: 'Input',
		items: [
			{ label: 'Mouse filter', cvar: 'm_filter' },
			{ label: 'Raw mouse', cvar: 'in_rawmouse' },
			{ label: 'Menu mouse', cvar: 'ui_mouse' },
			{ label: 'Pad look yaw', cvar: 'gp_look_yaw', min: 0.25, max: 3, step: 0.25 },
			{ label: 'Pad look pitch', cvar: 'gp_look_pitch', min: 0.25, max: 3, step: 0.25 },
			{ label: 'Move deadzone', cvar: 'joy_deadzone_move', min: 0, max: 0.4, step: 0.01 },
			{ label: 'Look deadzone', cvar: 'joy_deadzone_look', min: 0, max: 0.4, step: 0.01 },
			{ label: 'Move outer zone', cvar: 'joy_outer_threshold_move', min: 0, max: 0.3, step: 0.02 },
			{ label: 'Look outer zone', cvar: 'joy_outer_threshold_look', min: 0, max: 0.3, step: 0.02 },
			{ label: 'Move curve', cvar: 'joy_exponent_move', min: 1, max: 4, step: 0.25 },
			{ label: 'Look curve', cvar: 'joy_exponent', min: 1, max: 4, step: 0.25 },
			{ label: 'XR snap turn', cvar: 'xr_snapturn', values: [ 0, 15, 30, 45, 90 ], names: [ 'off', '15', '30', '45', '90' ] },
			{ label: 'XR turn speed', cvar: 'xr_turnspeed', min: 100, max: 400, step: 20 }
		]
	},
	{
		title: 'Sound',
		items: [
			{ label: 'Ambient volume', cvar: 'ambient_level', min: 0, max: 1, step: 0.05 }
		]
	}
];

export function M_CvarItem_IsSlider( item ) {

	return item.min !== undefined;

}

export function M_CvarItem_IsChoice( item ) {

	return item.values !== undefined;

}

// Drops float noise from step arithmetic (0.1 * 3 = 0.30000000000000004)
function M_CvarRound( v ) {

	return Math.round( v * 1e6 ) / 1e6;

}

/*
================
M_CvarItem_Snap

A slider value clamped to the range and snapped to the step grid from min,
so console values off the grid or out of range land on a reachable step.
================
*/
export function M_CvarItem_Snap( item, v ) {

	if ( ! ( v >= item.min ) ) // also catches NaN
		return item.min;
	if ( v >= item.max )
		return item.max;

	const n = Math.round( ( v - item.min ) / item.step );
	return Math.min( M_CvarRound( item.min + n * item.step ), item.max );

}

// Index of the choice nearest v (the first, on a tie)
function M_CvarItem_ChoiceIndex( item, v ) {

	let best = 0;
	for ( let i = 1; i < item.values.length; i ++ ) {

		if ( Math.abs( item.values[ i ] - v ) < Math.abs( item.values[ best ] - v ) )
			best = i;

	}

	return best;

}

/*
================
M_CvarItem_Step

The value one step from v in direction dir (1 or -1). Sliders stop at their
ends; choices and toggles wrap, so a tap (which only steps up) reaches every
value.
================
*/
export function M_CvarItem_Step( item, v, dir ) {

	if ( M_CvarItem_IsSlider( item ) )
		return M_CvarItem_Snap( item, v + dir * item.step );

	if ( M_CvarItem_IsChoice( item ) ) {

		const count = item.values.length;
		const i = M_CvarItem_ChoiceIndex( item, v );
		return item.values[ ( i + dir + count ) % count ];

	}

	return v !== 0 ? 0 : 1;

}

// Slider position of v, 0 to 1
export function M_CvarItem_Fraction( item, v ) {

	return ( M_CvarItem_Snap( item, v ) - item.min ) / ( item.max - item.min );

}

// Slider value at fraction r of the track, snapped to a step
export function M_CvarItem_FromFraction( item, r ) {

	r = r < 0 ? 0 : ( r > 1 ? 1 : r );
	return M_CvarItem_Snap( item, item.min + r * ( item.max - item.min ) );

}

/*
================
M_CvarItem_Format

The text shown for value v: on/off for toggles, the choice's name, or the
number (to 4 decimals, so cl_bob's 0.005 steps show).
================
*/
export function M_CvarItem_Format( item, v ) {

	if ( M_CvarItem_IsChoice( item ) ) {

		const i = M_CvarItem_ChoiceIndex( item, v );
		if ( item.values[ i ] === v && item.names !== undefined )
			return item.names[ i ];
		return String( M_CvarRound( v ) );

	}

	if ( ! M_CvarItem_IsSlider( item ) )
		return v !== 0 ? 'on' : 'off';

	if ( v === 0 && item.zero !== undefined )
		return item.zero;

	return String( Math.round( v * 1e4 ) / 1e4 );

}
