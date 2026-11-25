// Ported from: QuakeSpasm Quake/image.c (Image_LoadTGA) and Ironwail
// Quake/image.c (Image_LoadImage) -- loading external images
//
// Only targa is ported: the skyboxes (gl_sky.js) are its one user, and the
// 2021 rerelease add-ons ship their skyboxes as .tga.

import { Con_Printf } from './common.js';
import { COM_FindFile } from './pak.js';

/*
============
Image_LoadImage

returns { data, width, height }, data being RGBA top to bottom, or null.

Ironwail tries name.png, .tga and .jpg (through stb_image), then .pcx and
.lmp. Only .tga is ported: the browser decodes png and jpg only
asynchronously, and each name tried and missing is a loose-file request
(COM_EnsureFile). The caller makes sure the file has been fetched.
============
*/
export function Image_LoadImage( name ) {

	const loadfilename = name + '.tga';
	const file = COM_FindFile( loadfilename );
	if ( file === null )
		return null;

	return Image_LoadTGA( file.data.subarray( 0, file.size ), loadfilename );

}

/*
=========================================================

  Targa

=========================================================
*/

/*
=============
Image_LoadTGA

Reads an uncompressed paletted (type 1), truecolor (2) or grayscale (3)
targa, or a run-length encoded truecolor one (10), at 24 or 32 bits per
pixel. Returns { data, width, height } with data RGBA, top row first, or
null.

Deliberate deviation: QuakeSpasm calls Sys_Error for an unsupported targa,
which ends the game for a bad skybox face. This warns and returns null, as
Ironwail (stb_image) does. Reads past the end of the file give 0 rather
than C's EOF.
=============
*/
export function Image_LoadTGA( buf, loadfilename = '' ) {

	if ( buf.length < 18 ) {

		Con_Printf( 'Image_LoadTGA: ' + loadfilename + ' is too short\n' );
		return null;

	}

	const id_length = buf[ 0 ];
	const colormap_type = buf[ 1 ];
	const image_type = buf[ 2 ];
	// colormap_index (buf[ 3 ], buf[ 4 ]) is unused, as in QuakeSpasm
	const colormap_length = buf[ 5 ] | ( buf[ 6 ] << 8 );
	const colormap_size = buf[ 7 ];
	// x_origin, y_origin (buf[ 8 ] to buf[ 11 ]) are unused, as in QuakeSpasm
	const width = buf[ 12 ] | ( buf[ 13 ] << 8 );
	const height = buf[ 14 ] | ( buf[ 15 ] << 8 );
	const pixel_size = buf[ 16 ];
	const attributes = buf[ 17 ];

	if ( image_type === 1 ) {

		if ( pixel_size !== 8 || colormap_size !== 24 || colormap_length > 256 ) {

			Con_Printf( 'Image_LoadTGA: ' + loadfilename + ' has an ' + colormap_size + 'bit palette\n' );
			return null;

		}

	} else {

		if ( image_type !== 2 && image_type !== 3 && image_type !== 10 ) {

			Con_Printf( 'Image_LoadTGA: ' + loadfilename + ' is not a type 2, 3, or 10 targa (' + image_type + ')\n' );
			return null;

		}

		if ( image_type === 3 ) {

			if ( colormap_type !== 0 || pixel_size !== 8 ) {

				Con_Printf( 'Image_LoadTGA: ' + loadfilename + ' is not a 8bit grayscale targa\n' );
				return null;

			}

		} else if ( colormap_type !== 0 || ( pixel_size !== 32 && pixel_size !== 24 ) ) {

			Con_Printf( 'Image_LoadTGA: ' + loadfilename + ' is not a 24bit or 32bit targa\n' );
			return null;

		}

	}

	const columns = width;
	const rows = height;
	const upside_down = ( attributes & 0x20 ) === 0; //johnfitz -- fix for upside-down targas

	const targa_rgba = new Uint8Array( columns * rows * 4 );

	let pos = 18 + id_length; // skip TARGA image comment
	const end = buf.length;
	const getc = () => ( pos < end ? buf[ pos ++ ] : 0 );

	if ( image_type === 1 ) { // Uncompressed, paletted images

		const palette = new Uint8Array( 256 * 4 );
		// palette data comes first
		for ( let i = 0; i < colormap_length; i ++ ) {

			// this palette data is bgr.
			palette[ i * 4 + 2 ] = getc();
			palette[ i * 4 + 1 ] = getc();
			palette[ i * 4 + 0 ] = getc();
			palette[ i * 4 + 3 ] = 255;

		}

		for ( let row = rows - 1; row >= 0; row -- ) {

			const realrow = upside_down ? row : rows - 1 - row;
			let pixbuf = realrow * columns * 4;

			for ( let column = 0; column < columns; column ++ ) {

				const i = getc();
				targa_rgba[ pixbuf ++ ] = palette[ i * 4 + 0 ];
				targa_rgba[ pixbuf ++ ] = palette[ i * 4 + 1 ];
				targa_rgba[ pixbuf ++ ] = palette[ i * 4 + 2 ];
				targa_rgba[ pixbuf ++ ] = palette[ i * 4 + 3 ];

			}

		}

	} else if ( image_type === 2 ) { // Uncompressed, RGB images

		for ( let row = rows - 1; row >= 0; row -- ) {

			//johnfitz -- fix for upside-down targas
			const realrow = upside_down ? row : rows - 1 - row;
			let pixbuf = realrow * columns * 4;
			//johnfitz
			for ( let column = 0; column < columns; column ++ ) {

				const blue = getc();
				const green = getc();
				const red = getc();
				const alphabyte = pixel_size === 32 ? getc() : 255;
				targa_rgba[ pixbuf ++ ] = red;
				targa_rgba[ pixbuf ++ ] = green;
				targa_rgba[ pixbuf ++ ] = blue;
				targa_rgba[ pixbuf ++ ] = alphabyte;

			}

		}

	} else if ( image_type === 3 ) { // Uncompressed grayscale images

		for ( let row = rows - 1; row >= 0; row -- ) {

			const realrow = upside_down ? row : rows - 1 - row;
			let pixbuf = realrow * columns * 4;

			for ( let column = 0; column < columns; column ++ ) {

				const gray = getc();
				targa_rgba[ pixbuf ++ ] = gray; // R
				targa_rgba[ pixbuf ++ ] = gray; // G
				targa_rgba[ pixbuf ++ ] = gray; // B
				targa_rgba[ pixbuf ++ ] = 255; // A

			}

		}

	} else { // image_type 10: Runlength encoded RGB images

		let red = 0, green = 0, blue = 0, alphabyte = 0;
		breakOut:
		for ( let row = rows - 1; row >= 0; row -- ) {

			//johnfitz -- fix for upside-down targas
			let realrow = upside_down ? row : rows - 1 - row;
			let pixbuf = realrow * columns * 4;
			//johnfitz
			for ( let column = 0; column < columns; ) {

				const packetHeader = getc();
				const packetSize = 1 + ( packetHeader & 0x7f );
				if ( packetHeader & 0x80 ) { // run-length packet

					blue = getc();
					green = getc();
					red = getc();
					alphabyte = pixel_size === 32 ? getc() : 255;

					for ( let j = 0; j < packetSize; j ++ ) {

						targa_rgba[ pixbuf ++ ] = red;
						targa_rgba[ pixbuf ++ ] = green;
						targa_rgba[ pixbuf ++ ] = blue;
						targa_rgba[ pixbuf ++ ] = alphabyte;
						column ++;
						if ( column === columns ) { // run spans across rows

							column = 0;
							if ( row > 0 )
								row --;
							else
								break breakOut;
							//johnfitz -- fix for upside-down targas
							realrow = upside_down ? row : rows - 1 - row;
							pixbuf = realrow * columns * 4;
							//johnfitz

						}

					}

				} else { // non run-length packet

					for ( let j = 0; j < packetSize; j ++ ) {

						blue = getc();
						green = getc();
						red = getc();
						alphabyte = pixel_size === 32 ? getc() : 255;
						targa_rgba[ pixbuf ++ ] = red;
						targa_rgba[ pixbuf ++ ] = green;
						targa_rgba[ pixbuf ++ ] = blue;
						targa_rgba[ pixbuf ++ ] = alphabyte;
						column ++;
						if ( column === columns ) { // pixel packet run spans across rows

							column = 0;
							if ( row > 0 )
								row --;
							else
								break breakOut;
							//johnfitz -- fix for upside-down targas
							realrow = upside_down ? row : rows - 1 - row;
							pixbuf = realrow * columns * 4;
							//johnfitz

						}

					}

				}

			}

		}

	}

	return { data: targa_rgba, width, height };

}
