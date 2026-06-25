import {
	InterpolationSamplingMode,
	InterpolationSamplingType,
	Matrix4,
	Mesh,
	MeshStandardMaterial,
	PlaneGeometry,
	Vector2
} from 'three';

import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, color, float, Fn, If, mix, mx_fractal_noise_float, mx_noise_float, positionWorld, smoothstep, struct, varying, vec3 } from 'three/tsl';

import {
	bakeGroups,
	boxMatrix,
	buildFaces,
	buildFootprint,
	createRandom,
	floorHash,
	interior,
	nonIndexed,
	skyscraperLights,
	_unitBox
} from './buildingShared.js';

// material-zone codes baked per vertex, so one material branches on partId and
// shades every zone of the curtain wall
const PartId = { CORE: 0, MULLION: 1, SPANDREL: 2, GLASS: 3 };
const { CORE, MULLION, SPANDREL, GLASS } = PartId;

// a plain ( un-rotated ) box matrix mapping the shared unit box onto an
// axis-aligned, world-space box — used for the horizontal roof slab and the
// rooftop mechanical penthouse, which don't belong to any vertical face frame
function worldBox( cx, cy, cz, sx, sy, sz ) {

	return new Matrix4().makeScale( sx, sy, sz ).setPosition( cx, cy, cz );

}

/**
 * Generates a modern glass-curtain-wall rectangular skyscraper — the sleek,
 * minimalist counterpart to the Beaux-Arts {@link SkyscraperGenerator}.
 *
 * The mass is a clean rectangular box ( optionally with one chamfered corner for
 * a block-corner lot ), wrapped in a curtain wall: floor-to-floor vision glass
 * over an opaque spandrel band that hides each floor slab, framed by a regular
 * grid of slim aluminium mullions ( verticals every module, a transom and a
 * floor-line rail every storey ). A dark structural core sits behind the glass,
 * and the top is closed by a roof slab, a metal parapet and a small mechanical
 * penthouse. Every piece is instanced and baked — with the same per-vertex
 * `partId` + interior-mapping room attributes the rest of the city uses — into a
 * single non-indexed BufferGeometry, so one {@link createGlassTowerMaterial}
 * material dresses the whole tower in one draw call.
 *
 * The vision glass reuses the shared {@link interior} room raymarch, so its
 * windows light up at night with the same `skyscraperLights` sliders that drive
 * the terracotta towers.
 *
 * ```js
 * const generator = new GlassTowerGenerator( { seed: 7, totalHeight: 180 }, material );
 * scene.add( generator.build() ); // a single Mesh
 * ```
 */
class GlassTowerGenerator {

	constructor( parameters = {}, material = null ) {

		this.parameters = parameters; // caller overrides; defaults fill the rest at build time
		this.material = material; // a single material; the look is driven by the baked `partId` attribute

		this.mesh = null;

	}

	setParameters( parameters ) {

		Object.assign( this.parameters, parameters );

		return this;

	}

	build() {

		const random = createRandom( this.parameters.seed ?? GlassTowerGenerator.defaults.seed );

		const p = Object.assign( {}, GlassTowerGenerator.defaults, this.parameters );

		// a touch of seed-driven variety so a row of glass towers isn't identical
		p.bayWidth = p.bayWidth ?? ( 1.6 + random() * 0.6 );
		p.spandrelRatio = p.spandrelRatio ?? ( 0.26 + random() * 0.14 );

		// whole floors, so every floor line and the roof land cleanly
		const floors = Math.max( 4, Math.round( p.totalHeight / p.floorHeight ) );
		const fh = p.floorHeight;
		p.totalHeight = floors * fh;
		const H = p.totalHeight;

		const spandrelH = fh * p.spandrelRatio; // opaque band hiding the floor slab
		const visionH = fh - spandrelH; // the glazed opening above it

		const mW = p.mullionWidth;
		const mD = p.mullionDepth;
		const proud = mD / 2; // the mullion's front face stands proud of the facade plane ( n = 0 )
		const glassN = - 0.02; // glass set just behind the facade plane, tucked under the mullions

		const footprint = buildFootprint( p.footprint.width, p.footprint.depth, p.chamferWidth, p.chamferCornerX, p.chamferCornerZ );
		const faces = buildFaces( footprint );

		const cores = []; // backing core walls, roof slab, penthouse
		const mullions = []; // the aluminium grid + parapet
		const spandrels = []; // opaque spandrel panels
		const glass = []; // vision-glass panes
		const glassRooms = []; // per-glass interior-mapping room ( centre + size ), aligned with `glass`

		for ( const frame of faces ) {

			// a dark structural core wall closing the volume behind the curtain wall
			cores.push( boxMatrix( frame, frame.length / 2, H / 2, - 0.9, frame.length, H, 0.8 ) );

			const { count, margin, width } = frame.bays( p.bayWidth );

			// vertical mullions on every module line ( both ends included, so the corners
			// read as framed; the thin members meet at right angles, never coplanar )
			for ( let i = 0; i <= count; i ++ ) {

				mullions.push( boxMatrix( frame, margin + i * width, H / 2, proud, mW, H, mD ) );

			}

			for ( let f = 0; f < floors; f ++ ) {

				const base = f * fh;

				// a floor-line rail and the transom splitting spandrel from vision glass
				mullions.push( boxMatrix( frame, frame.length / 2, base, proud, frame.length, mW, mD ) );
				mullions.push( boxMatrix( frame, frame.length / 2, base + spandrelH, proud, frame.length, mW, mD ) );

				// the interior-mapping room module: one floor tall, a run of two or three
				// bays wide, chosen per floor so neighbouring panes share an interior. the
				// choice is deterministic ( seeded by the floor and the face ) so it is
				// stable, exactly as the terracotta towers do it.
				const roomBays = floorHash( f, frame, 0 ) > 0.5 ? 3 : 2;
				const roomPhase = Math.floor( floorHash( f, frame, 1 ) * roomBays );

				for ( let b = 0; b < count; b ++ ) {

					const cu = margin + ( b + 0.5 ) * width;

					// opaque spandrel panel at the floor base
					spandrels.push( boxMatrix( frame, cu, base + spandrelH / 2, glassN, width - mW, spandrelH - mW, 0.12 ) );

					// the vision-glass pane above it
					const cv = base + spandrelH + visionH / 2;
					glass.push( frame.matrix( cu, cv, glassN ) );

					// the run of bays this pane's room spans, clamped at the face ends,
					// recorded as the room's centre on the facade and its size in metres
					const room = Math.floor( ( b + roomPhase ) / roomBays );
					const bStart = Math.max( 0, room * roomBays - roomPhase );
					const bEnd = Math.min( count, ( room + 1 ) * roomBays - roomPhase );
					const span = bEnd - bStart;
					glassRooms.push( { center: frame.point( margin + ( bStart + span / 2 ) * width, cv, glassN ), size: new Vector2( span * width, visionH - 0.2 ) } );

				}

			}

			// the top rail capping the uppermost floor, then a slim metal parapet above it
			mullions.push( boxMatrix( frame, frame.length / 2, H, proud, frame.length, mW, mD ) );
			mullions.push( boxMatrix( frame, frame.length / 2, H + p.parapetHeight / 2, proud * 0.5, frame.length, p.parapetHeight, mD * 0.8 ) );

		}

		// roof slab closing the top, and a smaller mechanical penthouse standing on it
		const roofTop = H + 0.3;
		cores.push( worldBox( 0, H, 0, p.footprint.width, 0.6, p.footprint.depth ) );

		const phH = fh * 1.4;
		cores.push( worldBox( 0, roofTop + phH / 2, 0, p.footprint.width * 0.45, phH, p.footprint.depth * 0.45 ) );

		// --- assemble: bake every part into one geometry -------------------

		const groups = [
			{ geometry: _unitBox, matrices: cores, partId: CORE },
			{ geometry: _unitBox, matrices: mullions, partId: MULLION },
			{ geometry: _unitBox, matrices: spandrels, partId: SPANDREL },
			{ geometry: nonIndexed( buildGlassGeometry( p, mW, visionH ) ), matrices: glass, partId: GLASS, rooms: glassRooms, rigid: true }
		];

		const geometry = bakeGroups( groups );

		const mesh = new Mesh( geometry, this.material || new MeshStandardMaterial( { color: 0x2a3640, roughness: 0.1, metalness: 0.1 } ) );
		mesh.name = 'GlassTower';

		this.dispose();
		this.mesh = mesh;

		return mesh;

	}

	rebuild() {

		return this.build();

	}

	dispose() {

		if ( this.mesh === null ) return;

		this.mesh.geometry.dispose();
		this.mesh = null;

	}

}

GlassTowerGenerator.defaults = {
	seed: 7,
	totalHeight: 170,
	floorHeight: 3.8,
	bayWidth: null, // seeded ( ~1.6–2.2 m module ) unless the caller sets it
	spandrelRatio: null, // seeded fraction of each floor that is opaque spandrel
	footprint: { width: 34, depth: 28 },
	mullionWidth: 0.12,
	mullionDepth: 0.16,
	parapetHeight: 1.6,
	chamferWidth: 0,
	chamferCornerX: 1,
	chamferCornerZ: 1
};

// one vision-glass pane, sized to the opening between the mullions ( a single
// geometry instanced across every bay and floor )
function buildGlassGeometry( p, mW, visionH ) {

	return new PlaneGeometry( p.bayWidth - mW, visionH - mW );

}

// --- material ------------------------------------------------------------

/**
 * The curtain-wall material: a single MeshStandardNodeMaterial that reads the
 * baked per-vertex `partId` and shades every zone — clean reflective tinted
 * vision glass ( with the shared interior-mapped rooms, lit at night ), darker
 * opaque spandrel panels, brushed-aluminium mullions and a concrete core / roof.
 * One material covers the whole tower ( and every glass tower in the city ).
 * `buildingBase` is the glass tint as a TSL node: pass a `uniform( Color )` for a
 * single tower, or a per-fragment palette pick for a city.
 */
function createGlassTowerMaterial( buildingBase = color( 0x33414d ) ) {

	const partId = varying( attribute( 'partId', 'float' ) ).setInterpolation( InterpolationSamplingType.FLAT, InterpolationSamplingMode.EITHER ); // flat: a per-face id must not interpolate, or the equal() zone tests below miss on the rounding

	// one Fn returning a struct, so the warp-coherent partId branch is taken once and
	// feeds every material node ( and the interior raymarch only runs on glass )
	const Shaded = struct( { color: 'vec3', roughness: 'float', metalness: 'float', emissive: 'vec3' } );

	const shade = Fn( () => {

		const isGlass = partId.equal( GLASS );
		const isSpandrel = partId.equal( SPANDREL );
		const isMullion = partId.equal( MULLION );

		const colorOut = vec3( 0 ).toVar();
		const roughOut = float( 0.5 ).toVar();
		const metalOut = float( 0 ).toVar();
		const emissiveOut = vec3( 0 ).toVar();

		If( isGlass, () => {

			// reflective coated curtain-wall glass: modelled as a tinted metal so the IBL /
			// sky mirrors strongly across the facade and takes on the tower's blue / teal
			// tint, the way real reflective glazing reads in daylight. ( a true dielectric
			// reflects only ~4% face-on, which all but vanishes against the soft sky fill —
			// the metallic cheat is the standard real-time stand-in for a mirror coating. )
			// lit rooms still glow through at night via the emissive term.
			const room = interior();
			const film = mx_fractal_noise_float( vec3( positionWorld.x.mul( 1.1 ), positionWorld.y.mul( 0.05 ), positionWorld.z.mul( 1.1 ) ), 2 ).mul( 0.5 ).add( 0.5 );

			// for a metal the reflectance IS the base colour, so a dark tint would cut the
			// reflected sky down to a murky navy. lift the tint toward a pale sky-blue: the
			// per-lot hue still drifts the glass warm / cool, but it now reflects the bright
			// sky brightly, the way real reflective curtain wall reads in daylight.
			colorOut.assign( mix( buildingBase, color( 0xdcecf7 ), 0.55 ) );
			roughOut.assign( float( 0.1 ).add( film.mul( 0.06 ) ) ); // near-mirror, with a faint per-region roughness drift so it isn't dead chrome
			metalOut.assign( float( 0.9 ) ); // metallic so the environment reflection dominates and is tinted by the base colour
			emissiveOut.assign( room.xyz.mul( room.w ).mul( skyscraperLights.emissiveIntensity ).mul( 0.85 ) ); // room.w = emissive weight ( 0 unlit ); lit offices glow at night

		} ).ElseIf( isSpandrel, () => {

			// opaque spandrel panels: a darker shade of the glass tint, hiding the floor
			// slab, kept faintly reflective so it reads as part of the glazed skin
			const v = mx_noise_float( positionWorld.mul( 0.25 ) ).mul( 0.5 ).add( 0.5 );
			colorOut.assign( buildingBase.mul( 0.22 ).mul( v.mul( 0.3 ).add( 0.85 ) ) );
			roughOut.assign( float( 0.22 ) );
			metalOut.assign( float( 0.1 ) );

		} ).ElseIf( isMullion, () => {

			// brushed-aluminium mullion grid + parapet
			const grain = mx_noise_float( positionWorld.mul( 2 ) ).mul( 0.06 );
			colorOut.assign( color( 0xb4b9be ).add( grain ) );
			roughOut.assign( float( 0.38 ) );
			metalOut.assign( float( 0.85 ) );

		} ).Else( () => {

			// concrete core / roof slab / mechanical penthouse, with broad grime
			const n = mx_fractal_noise_float( positionWorld.mul( 0.05 ), 2 ).mul( 0.12 );
			const grime = smoothstep( 0, 0.6, mx_fractal_noise_float( positionWorld.mul( 0.03 ), 3 ).mul( 0.5 ).add( 0.5 ) ).mul( 0.18 );
			colorOut.assign( mix( color( 0x8a8d90 ).mul( float( 1 ).add( n ) ), color( 0x55585c ), grime ) );
			roughOut.assign( float( 0.92 ) );

		} );

		return Shaded( colorOut, roughOut, metalOut, emissiveOut );

	} )();

	const material = new MeshStandardNodeMaterial();
	material.colorNode = shade.get( 'color' );
	material.roughnessNode = shade.get( 'roughness' );
	material.metalnessNode = shade.get( 'metalness' );
	material.emissiveNode = shade.get( 'emissive' );

	// the scene dials its environment down to a soft fill ( environmentIntensity ≈ 0.25 ),
	// which is right for the matte masonry but leaves the glass barely reflective. push this
	// material's own env contribution back up so the curtain wall mirrors the sky clearly.
	material.envMapIntensity = 3.5;

	return material;

}

export { GlassTowerGenerator, createGlassTowerMaterial };
