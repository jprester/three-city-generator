import {
	BoxGeometry,
	ExtrudeGeometry,
	LatheGeometry,
	Matrix4,
	Mesh,
	MeshStandardMaterial,
	Path,
	PlaneGeometry,
	ShapeGeometry,
	Shape,
	Vector2
} from 'three';

import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, color, float, floor, Fn, fract, fwidth, If, mix, mod, mx_fractal_noise_float, mx_noise_float, normalWorldGeometry, positionLocal, positionWorld, select, sin, smoothstep, step, struct, uv, vec3 } from 'three/tsl';

import {
	bakeGroups,
	boxMatrix,
	buildFaces,
	buildFootprint,
	bumpNormal,
	createRandom,
	floorHash,
	interior,
	merge,
	nonIndexed,
	skyscraperLights,
	_identity,
	_unitBox
} from './buildingShared.js';

// material-zone codes baked per vertex into the merged geometry, so one material can
// branch on partId and shade every zone
const PartId = { WALL: 0, PIER: 1, FRAME: 2, ORNAMENT: 3, GLASS: 4, AC: 5 };
const { WALL, PIER, FRAME, ORNAMENT, GLASS, AC } = PartId;

// fraction of a floor's height taken by the glazed opening; the remainder is
// the spandrel band. shared by the window module and the spandrels so they tile.
const WINDOW_HEIGHT_RATIO = 0.62;

// width of the flat window-frame band around the glazing; shared by the frame module
// and the glass pane so the pane always tucks inside the frame
const WINDOW_BORDER = 0.1;

// the masonry course module ( brick height × length ). the generator snaps floor and
// bay dimensions to it, and the material's coursing reads the same values, so the
// procedural brickwork lines up with the geometry
const BRICK = { height: 0.3, length: 0.6 };

// the seed-driven "style" of a tower: footprint proportions, tier split and the
// shaping of piers and base arches. these sit between the fixed defaults and the
// caller's parameters, so any parameter passed in still overrides its seeded value.

function randomStyle( random ) {

	const base = 0.10 + random() * 0.07;
	const crown = 0.08 + random() * 0.08;

	return {
		footprint: { width: 26 + random() * 18, depth: 20 + random() * 14 },
		tierFractions: { base, crown },
		pierWidth: 0.4 + random() * 0.4,
		pierDepth: 0.3 + random() * 0.3,
		windowReveal: 0.12 + random() * 0.1,
		stringCourseHeight: 0.5 + random() * 0.5,
		archBayWidthRatio: Math.round( 1.5 + random() * 1.5 ),
		archRise: 0.4 + random() * 0.5
	};

}

/**
 * Generates intricate, tripartite "Beaux-Arts / Neo-Gothic" terracotta
 * skyscrapers from a small set of parameters.
 *
 * The mass is read as a footprint polygon (a rectangle with one chamfered
 * corner) split into vertical faces, each split into three tiers — a tall
 * arcaded base, a repeating shaft and an ornate crown — then into floors and
 * bays. A handful of authored pieces (a pier, a window, a cornice profile, a
 * gothic arch) are instanced across the whole tower, then baked — together with
 * the bespoke base arcade — into a single non-indexed BufferGeometry tagged with
 * a per-vertex `partId` ({@link PartId}) so one material can shade every zone.
 *
 * The generator is material agnostic — it only produces geometry. Pass a single
 * material (e.g. a TSL node material that branches on `partId`) to dress it.
 *
 * ```js
 * const generator = new SkyscraperGenerator( { seed: 35, totalHeight: 140 }, material );
 * scene.add( generator.build() ); // a single Mesh
 * ```
 */
class SkyscraperGenerator {

	constructor( parameters = {}, material = null ) {

		this.parameters = parameters; // caller overrides; defaults + seed fill the rest at build time
		this.material = material; // a single material; the look is driven by the baked `partId` attribute

		this.mesh = null;

	}

	setParameters( parameters ) {

		Object.assign( this.parameters, parameters );

		return this;

	}

	build() {

		const random = createRandom( this.parameters.seed ?? SkyscraperGenerator.defaults.seed );

		// precedence: fixed defaults < seed-driven style < caller parameters

		const p = Object.assign( {}, SkyscraperGenerator.defaults, randomStyle( random ), this.parameters );

		// snap the masonry-driving dimensions to the brick module so the procedural
		// brickwork ( courses up local Y, columns along each face ) lines up with the
		// geometry: a whole number of courses per floor and bricks per bay
		const vModule = BRICK.height * 2; // a course pair, so floor / window halves still land on a joint
		p.floorHeight = Math.max( vModule * 3, Math.round( p.floorHeight / vModule ) * vModule );
		p.windowHeight = Math.round( p.floorHeight * WINDOW_HEIGHT_RATIO / vModule ) * vModule;
		p.bayWidth = Math.max( BRICK.length * 3, Math.round( p.bayWidth / BRICK.length ) * BRICK.length );
		p.pierWidth = Math.max( BRICK.length, Math.round( p.pierWidth / BRICK.length ) * BRICK.length );

		// vertical layout: base / shaft / crown as whole floor counts, so every floor
		// line sits on a course ( the requested total height is rounded to suit )
		const floors = Math.max( 3, Math.round( p.totalHeight / p.floorHeight ) );
		const baseFloors = Math.max( 1, Math.round( floors * p.tierFractions.base ) );
		const crownFloors = Math.max( 1, Math.round( floors * p.tierFractions.crown ) );
		const shaftFloors = Math.max( 1, floors - baseFloors - crownFloors );

		const baseHeight = baseFloors * p.floorHeight;
		const crownHeight = crownFloors * p.floorHeight;
		const shaftHeight = shaftFloors * p.floorHeight;
		p.totalHeight = baseHeight + shaftHeight + crownHeight;

		const baseTop = baseHeight;
		const shaftTop = baseHeight + shaftHeight;

		// accumulators. the box shell ( walls, spandrels, cornices, parapets, slabs )
		// collects only instance matrices; the repeating field ( piers, windows, glass,
		// finials ) is instanced too. only the base arcade needs real geometry.

		const boxes = []; // matrices for the axis-aligned shell boxes
		const extras = []; // bespoke shell geometry: the base arcade
		const windows = [];
		const glass = [];
		const glassRooms = []; // per-glass interior-mapping room ( centre + size ), aligned with `glass`
		const finials = [];
		const acUnits = []; // window air-conditioner boxes on a random subset of shaft windows
		const piers = new Map(); // pier height -> matrices, so each tier's continuous piers share one geometry

		const addPier = ( frame, u, vBottom, height ) => {

			const key = Math.round( height * 1000 ); // bucket equal pier heights ( a number key, no string )
			if ( piers.has( key ) === false ) piers.set( key, [] );
			piers.get( key ).push( frame.matrix( u, vBottom, 0 ) );

		};

		// footprints: full mass, and the inset crown after the setback

		const footprint = buildFootprint( p.footprint.width, p.footprint.depth, p.chamferWidth, p.chamferCornerX, p.chamferCornerZ );
		const faces = buildFaces( footprint );

		const inset = p.setbackDepth * p.bayWidth;
		const crownFootprint = buildFootprint(
			Math.max( p.bayWidth * 2, p.footprint.width - inset * 2 ),
			Math.max( p.bayWidth * 2, p.footprint.depth - inset * 2 ),
			Math.max( 0, p.chamferWidth - inset ),
			p.chamferCornerX,
			p.chamferCornerZ
		);
		const crownFaces = buildFaces( crownFootprint );

		// --- shell ----------------------------------------------------------

		// the base is an open arcade (added below); above it a thin backing wall
		// closes the volume behind the glass, with the facade grid (piers +
		// spandrel bands) built in front of it

		for ( const frame of faces ) addWall( boxes, frame, baseTop, shaftTop, 0.8, - 0.6 );
		for ( const frame of crownFaces ) addWall( boxes, frame, shaftTop, p.totalHeight, 0.8, - 0.6 );

		// setback ledge: a thin slab capping the shaft footprint where the
		// crown steps in, and a roof cap closing the crown

		extras.push( slab( footprint, shaftTop, 0.6 ) );
		extras.push( slab( crownFootprint, p.totalHeight, 0.6 ) );

		// --- base: a gothic arcade with deep pointed openings ---------------

		for ( const frame of faces ) {

			addArcade( extras, frame, baseHeight, p );
			addCornice( boxes, frame, baseTop - p.stringCourseHeight, p.stringCourseHeight, 0.5 );

		}

		// --- shaft: continuous piers, stacked windows, periodic bands -------

		for ( const frame of faces ) {

			addSpandrelBands( boxes, frame, baseTop, shaftHeight, p );
			addPiers( frame, baseTop, shaftHeight, p, addPier );
			addWindows( frame, windows, glass, glassRooms, acUnits, baseTop, shaftHeight, p );

		}

		if ( p.stringCourseEvery > 0 ) {

			const floors = Math.max( 1, Math.round( shaftHeight / p.floorHeight ) );
			const fh = shaftHeight / floors;

			for ( let f = p.stringCourseEvery; f < floors; f += p.stringCourseEvery ) {

				for ( const frame of faces ) {

					addCornice( boxes, frame, baseTop + f * fh - p.stringCourseHeight * 0.5, p.stringCourseHeight, 0.3 );

				}

			}

		}

		// --- crown: shorter floors, heavy cornice, parapet, finials ---------

		const crownCornice = p.stringCourseHeight * 1.6;

		for ( const frame of crownFaces ) {

			addSpandrelBands( boxes, frame, shaftTop, crownHeight, p );
			addPiers( frame, shaftTop, crownHeight - crownCornice, p, addPier ); // piers terminate at the cornice, not through it
			addWindows( frame, windows, glass, glassRooms, null, shaftTop, crownHeight, p );
			addCornice( boxes, frame, p.totalHeight - crownCornice, crownCornice, 0.9 );
			addParapet( boxes, frame, p.totalHeight, p );
			addFinials( frame, finials, shaftTop, crownHeight, p );

		}

		// --- assemble: bake every part into one geometry -------------------

		const groups = [
			{ geometry: _unitBox, matrices: boxes, partId: WALL }, // walls, spandrels, cornices, parapets, slabs
			{ geometry: buildWindowGeometry( p ), matrices: windows, partId: FRAME, rigid: true },
			{ geometry: nonIndexed( buildGlassGeometry( p ) ), matrices: glass, partId: GLASS, rooms: glassRooms, rigid: true },
			{ geometry: _unitBox, matrices: acUnits, partId: AC },
			{ geometry: nonIndexed( buildFinialGeometry( p ) ), matrices: finials, partId: ORNAMENT, rigid: true }
		];

		for ( const [ key, matrices ] of piers ) {

			groups.push( { geometry: buildPierGeometry( p, key / 1000 ), matrices, partId: PIER, rigid: true } );

		}

		for ( const geometry of extras ) { // the base arcade, already in building-local space

			groups.push( { geometry: nonIndexed( geometry ), matrices: [ _identity ], partId: WALL, rigid: true } );

		}

		const geometry = bakeGroups( groups );

		const mesh = new Mesh( geometry, this.material || new MeshStandardMaterial( { color: 0xddccaa, roughness: 0.9 } ) );
		mesh.name = 'Skyscraper';

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

// fixed baseline. the remaining parameters (footprint, tierFractions, pierWidth,
// pierDepth, windowReveal, stringCourseHeight, archBayWidthRatio, archRise) are
// derived from the seed by randomStyle() unless the caller provides them.
SkyscraperGenerator.defaults = {
	seed: 35,
	totalHeight: 140,
	floorHeight: 4,
	bayWidth: 2.6,
	stringCourseEvery: 6,
	chamferWidth: 4,
	chamferCornerX: 1,
	chamferCornerZ: 1,
	setbackDepth: 1.5,
	acChance: 0.12
};

// --- shell pieces --------------------------------------------------------

function addWall( target, frame, vBottom, vTop, thickness = 0.8, front = 0 ) {

	const h = vTop - vBottom;
	target.push( boxMatrix( frame, frame.length / 2, vBottom + h / 2, front - thickness / 2, frame.length + thickness * 2, h, thickness ) );

}

/**
 * Horizontal terracotta bands at every floor line. Together with the projecting
 * piers they form the facade grid; the gaps between them are the window
 * openings, with glass set behind.
 */
function addSpandrelBands( target, frame, vBottom, height, p ) {

	const floors = Math.max( 1, Math.round( height / p.floorHeight ) );
	const fh = height / floors;
	const bandHeight = p.floorHeight - p.windowHeight; // whole courses: floor minus the glazed opening

	// pull the ends in by the band depth so a band doesn't poke its end-cap
	// into the plane of the perpendicular face at the corners ( overdraw )
	const bandLength = Math.max( 0.2, frame.length - 0.6 );

	for ( let f = 0; f <= floors; f ++ ) {

		// front flush at w = 0, meeting the backing wall behind
		target.push( boxMatrix( frame, frame.length / 2, vBottom + f * fh, - 0.3, bandLength, bandHeight, 0.6 ) );

	}

}

/**
 * A thin horizontal cap over a footprint's bounding box at height `y`. Its
 * sides are pulled in behind the facade plane ( into the backing-wall shell )
 * so they never sit coplanar with the walls, spandrels or piers and z-fight.
 */
function slab( footprint, y, thickness ) {

	// a thin cap following the footprint OUTLINE ( so the chamfered corner is cut, not
	// left overhanging as a rectangular box ), inset a little so its edge tucks just
	// behind the facade and the wall top reads as a lip around it

	const inset = 0.8;
	let cx = 0, cz = 0;
	for ( const p of footprint ) {

		cx += p.x; cz += p.y;

	}

	cx /= footprint.length; cz /= footprint.length;

	// consistent ( CCW ) winding so the extrude caps face up / down correctly
	let area = 0;
	for ( let i = 0; i < footprint.length; i ++ ) {

		const a = footprint[ i ], b = footprint[ ( i + 1 ) % footprint.length ];
		area += a.x * b.y - b.x * a.y;

	}

	const pts = area < 0 ? footprint.slice().reverse() : footprint;

	const shape = new Shape();
	pts.forEach( ( p, i ) => {

		const dx = cx - p.x, dz = cz - p.y;
		const d = Math.hypot( dx, dz ) || 1;
		const x = p.x + dx / d * inset;
		const z = p.y + dz / d * inset;
		if ( i === 0 ) shape.moveTo( x, z ); else shape.lineTo( x, z );

	} );

	// extrude the XZ outline downward by the thickness, the top dropped just below height y:
	// the inset cap would otherwise sit coplanar with the surrounding wall top faces and
	// z-fight, and the parapet / spandrel bands around the edge hide the shallow recess
	const drop = 0.2;
	const geometry = new ExtrudeGeometry( shape, { depth: thickness, bevelEnabled: false } );
	geometry.rotateX( Math.PI / 2 );
	geometry.translate( 0, y - drop, 0 );
	return geometry;

}

/** A two-step projecting cornice / string-course band wrapping a face. */
function addCornice( target, frame, vBottom, height, depth ) {

	target.push( boxMatrix( frame, frame.length / 2, vBottom + height * 0.275, depth / 2, frame.length, height * 0.55, depth ) );
	target.push( boxMatrix( frame, frame.length / 2, vBottom + height * 0.775, depth * 0.85, frame.length, height * 0.45, depth * 1.7 ) );

}

/** A low parapet wall capping the crown. */
function addParapet( target, frame, vTop, p ) {

	const height = 1.4;
	target.push( boxMatrix( frame, frame.length / 2, vTop + height / 2, p.pierDepth * 0.4, frame.length, height, p.pierDepth * 0.8 ) );

}

/**
 * The base storey: a wall pierced by tall pointed-arch openings, extruded with
 * thickness so the openings read as deep recesses.
 */
function addArcade( target, frame, height, p ) {

	const archWidth = p.bayWidth * p.archBayWidthRatio;
	const { count, margin } = frame.bays( archWidth );

	const sill = height * 0.04;
	const spring = height * 0.55;
	const apex = Math.min( height * 0.96, spring + ( archWidth / 2 ) * ( 0.8 + p.archRise ) );

	const shape = new Shape();
	shape.moveTo( 0, 0 );
	shape.lineTo( frame.length, 0 );
	shape.lineTo( frame.length, height );
	shape.lineTo( 0, height );
	shape.lineTo( 0, 0 );

	for ( let i = 0; i < count; i ++ ) {

		const cx = margin + ( i + 0.5 ) * archWidth;
		const hw = archWidth * 0.34;

		const hole = new Path();
		hole.moveTo( cx - hw, sill );
		hole.lineTo( cx - hw, spring );
		hole.quadraticCurveTo( cx - hw, apex, cx, apex );
		hole.quadraticCurveTo( cx + hw, apex, cx + hw, spring );
		hole.lineTo( cx + hw, sill );
		hole.lineTo( cx - hw, sill );
		shape.holes.push( hole );

	}

	const thickness = 1.1;
	const geometry = new ExtrudeGeometry( shape, { depth: thickness, bevelEnabled: false, curveSegments: 8 } );
	geometry.translate( 0, 0, - thickness );
	geometry.applyMatrix4( frame.matrix( 0, 0, 0 ) );

	target.push( geometry );

	// a dark plane set behind the openings so the recesses read

	const back = new PlaneGeometry( frame.length, height );
	back.applyMatrix4( frame.matrix( frame.length / 2, height / 2, - thickness - 0.4 ) );
	target.push( back );

}

// --- repeating field -----------------------------------------------------

function addPiers( frame, vBottom, height, p, addPier ) {

	const { count, margin, width } = frame.bays( p.bayWidth );

	// a pier on every bay edge except the far end: that corner is shared with
	// the next face, which places its own pier there, so emitting both would
	// stack two piers at each corner

	for ( let i = 0; i < count; i ++ ) {

		addPier( frame, margin + i * width, vBottom, height );

	}

}

function addWindows( frame, windows, glass, glassRooms, acUnits, vBottom, height, p ) {

	const { count, margin, width } = frame.bays( p.bayWidth );
	const floors = Math.max( 1, Math.round( height / p.floorHeight ) );
	const fh = height / floors;

	// a window AC unit sitting on the sill, protruding from the facade. about half the window
	// width, capped at a real unit's size ( ~0.66 m ) and kept wider than tall, sticking out
	// about half its width
	const acW = Math.min( ( p.bayWidth - p.pierWidth ) * 0.55, 0.66 );
	const acH = acW * 0.6;
	const acD = acW * 0.5;
	const acV = - p.windowHeight / 2 + acH / 2 + WINDOW_BORDER; // bottom rests on the sill ( the top of the window's bottom frame rail )

	// a real ~0.66 m unit looks lost in a wide opening, so only fit ACs where it still spans a
	// fair share of the window — in practice, the narrower ( older-style ) windows
	const acFits = acW >= ( width - p.pierWidth ) * 0.34;

	for ( let f = 0; f < floors; f ++ ) {

		const cy = vBottom + ( f + 0.5 ) * fh;

		// the interior-mapping room module: one floor tall, a run of two or three bays
		// wide, chosen per floor so neighbouring windows share an interior. the choice
		// is deterministic ( seeded by the floor and the face ) so it is stable, and the
		// run is recorded per window so the material can ray-march the right box.
		const roomBays = floorHash( f, frame, 0 ) > 0.5 ? 3 : 2;
		const roomPhase = Math.floor( floorHash( f, frame, 1 ) * roomBays );

		for ( let b = 0; b < count; b ++ ) {

			const cx = margin + ( b + 0.5 ) * width;

			windows.push( frame.matrix( cx, cy, 0 ) );
			glass.push( frame.matrix( cx, cy, - p.windowReveal ) );

			// the run of bays this window's room spans, clamped at the face ends, recorded
			// as the room's centre on the facade and its width × height in metres
			const room = Math.floor( ( b + roomPhase ) / roomBays );
			const bStart = Math.max( 0, room * roomBays - roomPhase );
			const bEnd = Math.min( count, ( room + 1 ) * roomBays - roomPhase );
			const span = bEnd - bStart;
			glassRooms.push( { center: frame.point( margin + ( bStart + span / 2 ) * width, cy, - p.windowReveal ), size: new Vector2( span * width, fh - 1 ) } ); // centred on the glass plane, so the interior is anchored to the pane it is drawn on

			if ( acUnits && acFits ) {

				// deterministic per-window hash ( varies per face via the frame origin )
				const r = Math.sin( f * 41.3 + b * 12.7 + frame.origin.x * 0.13 + frame.origin.z * 0.31 ) * 43758.5453;
				// the back tucks into the window reveal ( just in front of the glass ) so the unit sits
				// in the opening instead of floating on the facade
				const acW0 = acD / 2 - p.windowReveal + 0.04;
				if ( r - Math.floor( r ) < p.acChance ) acUnits.push( boxMatrix( frame, cx, cy + acV, acW0, acW, acH, acD ) );

			}

		}

	}

}

function addFinials( frame, finials, vBottom, height, p ) {

	const { count, margin, width } = frame.bays( p.bayWidth );
	const top = vBottom + height;

	// skip the far-end bay edge: it is the shared corner the next face also
	// caps, so emitting both would stack two finials at each corner

	for ( let i = 0; i < count; i ++ ) {

		finials.push( new Matrix4().setPosition( frame.point( margin + i * width, top, p.pierDepth * 0.5 ) ) );

	}

}

// --- authored modules ----------------------------------------------------

function buildPierGeometry( p, height ) {

	// a wide pier with a slimmer pilaster raised on its face, giving the
	// continuous vertical rib a stepped, terracotta profile

	const back = new BoxGeometry( p.pierWidth, height, p.pierDepth * 0.6 );
	back.translate( 0, height / 2, p.pierDepth * 0.3 );

	// the pilaster stops just short of the pier top so that where a pier is left
	// exposed ( at a setback ) the cap reads as one clean block rather than the
	// back box and the pilaster stacked into a T
	const pilasterHeight = Math.max( 1, height - 0.6 );
	const front = new BoxGeometry( p.pierWidth * 0.55, pilasterHeight, p.pierDepth * 0.45 );
	front.translate( 0, pilasterHeight / 2, p.pierDepth * 0.6 + p.pierDepth * 0.225 );

	return merge( [ back, front ] );

}

function buildWindowGeometry( p ) {

	// the flat frame face ( a rectangle with the glazing hole ), the four reveal walls
	// of the opening and the glazing bars, merged into one instanced module. a full
	// extrusion would also emit a hidden back cap and outer side walls; windows are by
	// far the heaviest part of a building, so those are skipped.

	const w = p.bayWidth - p.pierWidth;
	const h = p.windowHeight;
	const border = WINDOW_BORDER;
	const depth = p.windowReveal; // reveal walls run all the way back to the glass ( placed at -windowReveal ), so no gap opens between them and the pane
	const iw = w / 2 - border;
	const ih = h / 2 - border;

	const shape = new Shape();
	shape.moveTo( - w / 2, - h / 2 );
	shape.lineTo( w / 2, - h / 2 );
	shape.lineTo( w / 2, h / 2 );
	shape.lineTo( - w / 2, h / 2 );
	shape.lineTo( - w / 2, - h / 2 );

	const hole = new Path();
	hole.moveTo( - iw, - ih );
	hole.lineTo( - iw, ih );
	hole.lineTo( iw, ih );
	hole.lineTo( iw, - ih );
	hole.lineTo( - iw, - ih );
	shape.holes.push( hole );

	const front = new ShapeGeometry( shape ); // visible frame face, flush with the facade

	// the four reveal walls of the opening, set back to the glazing
	const wall = ( x, y, rx, ry, sw, sh ) => {

		const pl = new PlaneGeometry( sw, sh );
		pl.rotateX( rx );
		pl.rotateY( ry );
		pl.translate( x, y, - depth / 2 );
		return pl;

	};

	const left = wall( - iw, 0, 0, Math.PI / 2, depth, ih * 2 );
	const right = wall( iw, 0, 0, - Math.PI / 2, depth, ih * 2 );
	const sill = wall( 0, - ih, - Math.PI / 2, 0, iw * 2, depth );
	const head = wall( 0, ih, Math.PI / 2, 0, iw * 2, depth );

	// a single horizontal glazing bar ( transom ), flat, just in front of the glass —
	// a thin box would triple the window's triangle count for sub-pixel thickness
	const transom = new PlaneGeometry( iw * 2, 0.05 );
	transom.translate( 0, h * 0.04, - depth + 0.02 ); // meeting rail, just above centre

	return merge( [ front, left, right, sill, head, transom ] );

}

function buildGlassGeometry( p ) {

	const w = p.bayWidth - p.pierWidth - WINDOW_BORDER * 2;
	const h = p.windowHeight - WINDOW_BORDER * 2;

	return new PlaneGeometry( w, h );

}

function buildFinialGeometry( p ) {

	// a tapering pinnacle revolved around its axis

	const s = p.pierWidth;
	const profile = [
		new Vector2( 0.0, 0 ),
		new Vector2( s * 0.9, 0 ),
		new Vector2( s * 0.9, s * 0.4 ),
		new Vector2( s * 0.55, s * 1.0 ),
		new Vector2( 0.0, s * 3.2 )
	];

	return new LatheGeometry( profile, 8 ); // round enough to read as a smooth pinnacle, still light

}

// --- material ------------------------------------------------------------

/**
 * The facade material: a single MeshStandardNodeMaterial that reads the baked
 * per-vertex `partId` and reproduces every zone — procedural terracotta brickwork
 * on the walls and piers, smooth dressed stone on the window frames and ornament,
 * dark glazing, and grey AC units — all dressed with world-space
 * weathering. One material covers the whole building ( and a whole city ), which is
 * what makes it compute-rasterizer friendly. `buildingBase` is the tower's flat
 * masonry colour as a TSL node: pass a `uniform( Color )` for a single tower, or a
 * per-fragment palette pick for a city, so the same material dresses both.
 */
function createSkyscraperMaterial( buildingBase = color( 0xc6c0b2 ) ) {

	const soot = color( 0x4a4236 );

	// broad weathering ( a slow tonal drift, a fine clay mottle, and sooty vertical
	// streaks that pool low down ) is driven from world position. It is the heaviest
	// procedural noise on the facade, so — like the interior, glass and AC noise — it
	// is NOT computed here; each is deferred into the per-partId branch that needs it
	// ( see below ), so a glass pixel never pays for brick weathering and a wall pixel
	// never pays for the interior raymarch. Only the cheap, derivative-bearing brick
	// geometry ( joints, relief ) stays in this uniform control flow up front.

	// procedural terracotta brickwork in running bond, keyed off the BUILDING-LOCAL position
	// so the coursing anchors to each tower ( courses from its base, columns at its faces )
	// and lines up with the brick-snapped floor / bay dimensions. courses run up local Y;
	// the across-face axis is world XZ projected onto the face tangent, so brick width stays
	// constant on every face including the 45° chamfer. the geometry ( pre-bump ) normal is
	// used for the bond axis — otherwise colorNode pulls normal computation into its partId
	// branch and glass loses its env reflection.

	const brickH = BRICK.height;
	const brickL = BRICK.length;
	const mortar = 0.025; // joint width, in metres

	const nrm = normalWorldGeometry.abs();
	const across = positionLocal.x.mul( normalWorldGeometry.z ).sub( positionLocal.z.mul( normalWorldGeometry.x ) );
	const rowCoord = positionLocal.y.div( brickH );
	const courseRow = floor( rowCoord );
	const colCoord = across.div( brickL ).add( mod( courseRow, 2 ).mul( 0.5 ) ); // half-brick stagger per row

	// anti-aliased mortar ( the "pristine grid" trick ): the drawn joint never falls below
	// the pixel footprint and its opacity fades to keep energy constant, so lines stay crisp
	// up close and dissolve far away instead of shimmering. the horizontal derivative comes
	// from continuous world X / Z ( weighted by the normal ), not fwidth( across ) which
	// would spike where the normal flips at pier edges.
	const mU = mortar / ( 2 * brickL );
	const mV = mortar / ( 2 * brickH );
	const ddU = nrm.z.mul( fwidth( positionWorld.x ) ).add( nrm.x.mul( fwidth( positionWorld.z ) ) ).div( brickL ).clamp( 1e-6, 0.5 );
	const ddV = fwidth( rowCoord ).clamp( 1e-6, 0.5 );
	const distU = float( 0.5 ).sub( fract( colCoord ).sub( 0.5 ).abs() );
	const distV = float( 0.5 ).sub( fract( rowCoord ).sub( 0.5 ).abs() );
	const drawU = ddU.max( mU );
	const drawV = ddV.max( mV );
	const lineU = smoothstep( drawU.add( ddU ), drawU.sub( ddU ), distU ).mul( float( mU ).div( drawU ).min( 1 ) );
	const lineV = smoothstep( drawV.add( ddV ), drawV.sub( ddV ), distV ).mul( float( mV ).div( drawV ).min( 1 ) );
	const wallFacing = smoothstep( 0.7, 0.45, nrm.y ); // brick only on vertical walls — not roofs, ledges, cornice tops
	const joint = lineU.max( lineV ).mul( wallFacing );

	const brickRnd = fract( sin( courseRow.mul( 78.233 ).add( floor( colCoord ).mul( 12.9898 ) ) ).mul( 43758.5453 ) );
	const brickRnd2 = fract( sin( courseRow.mul( 39.425 ).add( floor( colCoord ).mul( 56.171 ) ) ).mul( 24634.711 ) ); // independent per-brick hash for hue

	// soft brick relief for the bump: each brick is a gently domed mound falling to the
	// recessed mortar over a bevel ( distU / distV are the distance to the nearest column /
	// course line, 0 at the joint, 0.5 at the centre ), so bricks read rounded rather than
	// scratched. the bevel is widened to at least a screen pixel ( from the world-position
	// derivative, our stand-in for a mip LOD ) so the edge never goes sub-pixel and shimmers.
	const bevel = 0.02;
	const texel = fwidth( positionWorld ).length(); // on-screen size of a surface pixel — our hand-rolled LOD
	const lodBevel = texel.mul( 1.5 ).max( bevel );
	const brickFace = smoothstep( 0, lodBevel, distU.mul( brickL ) ).mul( smoothstep( 0, lodBevel, distV.mul( brickH ) ) ).mul( wallFacing );
	const reliefHeight = brickFace.mul( 0.008 );

	// the merged geometry carries a per-vertex partId; this material reads it and
	// branches to reproduce each zone — no per-part materials, compute-raster friendly.
	// partId is constant across each zone's triangles, so the branch is warp-coherent:
	// unlike select() ( which evaluates BOTH sides ), a real If() actually skips the
	// expensive path a pixel doesn't need — the interior raymarch on stone, the brick
	// weathering on glass, the AC noise on everything else. All screen-space derivatives
	// ( joint, reliefHeight, texel ) were taken above in uniform control flow, so the
	// branches only read their results, never call fwidth / dFdx themselves.

	const partId = attribute( 'partId', 'float' );

	// the whole per-zone shade is one Fn returning a struct, so the warp-coherent
	// partId branch is taken once and feeds every material node. ( If / toVar need a
	// builder stack, which exists only inside an Fn — hence the wrapper; the cheap,
	// derivative-bearing brick geometry above stays in the outer uniform control flow
	// and is only *read* inside the branches. )
	const Shaded = struct( { color: 'vec3', roughness: 'float', emissive: 'vec3', height: 'float' } );

	const shade = Fn( () => {

		const isGlass = partId.equal( GLASS );
		const isFrame = partId.equal( FRAME );
		const isOrnament = partId.equal( ORNAMENT );
		const isAC = partId.equal( AC );
		const isPier = partId.equal( PIER );

		const colorOut = vec3( 0 ).toVar();
		const roughOut = float( 0.82 ).toVar();
		const emissiveOut = vec3( 0 ).toVar();
		const heightOut = float( 0 ).toVar(); // bump height; flat ( 0 ) unless a branch sets relief

		If( isGlass, () => {

			// glass: the interior-mapped room is the base colour; the smooth, low-roughness
			// surface still lets a faint sky reflection ride over it, and lit rooms glow.
			const room = interior();

			// grimy glazing: the room shows through, muted by a dusty film and dirt pooled
			// along the bottom of each pane, plus a baseline haze, so the panes read as old
			// glass rather than open holes. the streaks run down the facade ( world Y barely
			// scaled ); the pooled dirt uses the pane's own UV ( y = 0 at the sill ).
			const filmNoise = mx_fractal_noise_float( vec3( positionWorld.x.mul( 1.3 ), positionWorld.y.mul( 0.06 ), positionWorld.z.mul( 1.3 ) ), 2 );
			const dustStreak = smoothstep( - 0.15, 0.5, filmNoise ).mul( 0.45 );
			const pooled = smoothstep( 0.32, 0.0, uv().y ).mul( 0.4 );
			const grime = float( 0.64 ).add( dustStreak ).add( pooled ).clamp( 0, 0.95 ); // baseline haze so the panes read as dirty glass, not open holes
			const dirtyGlass = mix( color( 0x13161a ), color( 0x232b31 ), mx_noise_float( positionWorld.mul( 0.3 ) ).mul( 0.5 ).add( 0.5 ) );

			colorOut.assign( mix( room.xyz.mul( color( 0xb6c6bf ) ), dirtyGlass, grime ) ); // faint green-grey ( soda-lime ) room tint, dirtied toward grimy glass
			roughOut.assign( float( 0.18 ) ); // glass kept smooth for a sky reflection, but soft enough not to alias over the interior
			emissiveOut.assign( room.xyz.mul( room.w ).mul( skyscraperLights.emissiveIntensity ).mul( grime.mul( 0.6 ).oneMinus() ) ); // room.w = emissive weight ( 0 unlit, < 1 behind curtains ), muted further by grime

		} ).ElseIf( isAC, () => {

			// window AC units: a louvered white-plastic box, grimier toward the base where it drips.
			// keyed off the box's own UVs ( acUv.y runs 0 → 1 up each vented side )
			const acUv = uv();
			const acVent = smoothstep( 0.65, 0.4, normalWorldGeometry.y.abs() ); // 1 on the vertical vented sides, 0 on the flat top
			const acDetail = smoothstep( 0.08, 0.015, texel ); // louvers fade out before a slat nears a pixel
			const acLouver = acVent.mul( acDetail );

			// plastic shell: off-white, some units dingier / yellowed than others
			const acDinge = mx_noise_float( positionWorld.mul( 0.4 ) ).mul( 0.5 ).add( 0.5 ); // ~per-unit
			const acPaint = mix( color( 0xf2f1ec ), color( 0xcfccc2 ), acDinge ) // bright white → light dingy grey, both lighter than the wall
				.add( mx_noise_float( positionWorld.mul( 5 ) ).mul( 0.04 ) );

			// a darker recessed grille panel inset into the lighter cabinet, with horizontal louvers
			// inside it ( the front vents ) — the white plastic reads as a thin border frame
			const acGrille = smoothstep( 0.06, 0.14, acUv.x ).mul( smoothstep( 0.94, 0.86, acUv.x ) )
				.mul( smoothstep( 0.12, 0.2, acUv.y ) ).mul( smoothstep( 0.96, 0.88, acUv.y ) ).mul( acLouver );
			const acSlats = fract( acUv.y.mul( 6 ) ); // bold louvers — reads at the unit's small on-screen size
			const acFin = mix( float( 0.82 ), float( 1.04 ), acSlats );
			const acBody = acPaint.mul( mix( float( 1 ), acFin.mul( 0.42 ), acGrille ) ); // cabinet stays light; recessed grille goes dark grey

			// grey-brown condensate grime streaking the lower edge ( plastic doesn't rust ); dirtier units streak more
			const acStreak = mx_fractal_noise_float( vec3( positionWorld.x.mul( 6 ), positionWorld.y.mul( 0.5 ), positionWorld.z.mul( 6 ) ), 3 ).mul( 0.5 ).add( 0.5 );
			const acGrime = smoothstep( 0.4, 0.0, acUv.y ).mul( acStreak ).mul( acDinge.add( 0.3 ) );

			colorOut.assign( mix( acBody, color( 0x6f685a ), acGrime.mul( 0.5 ) ) );
			roughOut.assign( float( 0.52 ).add( acGrille.mul( 0.08 ) ) );
			heightOut.assign( acGrille.mul( acSlats.mul( 0.012 ).sub( 0.01 ) ) ); // recessed grille ( louver fins ) relief

		} ).ElseIf( isFrame, () => {

			// window frames are smooth dressed stone, not brick
			colorOut.assign( buildingBase.mul( 0.55 ) );
			roughOut.assign( mx_noise_float( positionWorld.mul( 0.5 ) ).mul( 0.08 ).add( 0.82 ).add( joint.mul( 0.12 ) ) );

		} ).ElseIf( isOrnament, () => {

			// finials / ornament: smooth dressed stone ( lightened ), not brick
			const tone = mx_fractal_noise_float( positionWorld.mul( 0.03 ), 2 ).mul( 0.18 );
			colorOut.assign( mix( buildingBase, color( 0xffffff ), 0.22 ).mul( float( 1 ).add( tone ) ) );
			roughOut.assign( float( 0.8 ) );

		} ).Else( () => {

			// walls + piers: procedural terracotta brick + weathering on the building's
			// colour, piers lightened a touch. this is where the broad weathering noise
			// ( tonal drift, clay mottle, sooty streaks ) actually runs.
			const tone = mx_fractal_noise_float( positionWorld.mul( 0.03 ), 2 ).mul( 0.18 );
			const mottle = mx_noise_float( positionWorld.mul( 0.7 ) ).mul( 0.06 );
			const streak = mx_fractal_noise_float( vec3( positionWorld.x.mul( 1.5 ), positionWorld.y.mul( 0.04 ), positionWorld.z.mul( 1.5 ) ), 2 );
			const dirt = smoothstep( - 0.1, 0.45, streak ).mul( smoothstep( 210, 0, positionWorld.y ) ).mul( 0.6 );

			const lighten = select( isPier, float( 0.12 ), float( 0 ) );
			const perBrick = float( 1 ).add( tone ).add( mottle ).add( brickRnd.sub( 0.5 ).mul( 0.14 ) );
			// per-brick warm/cool shift ( red up / blue down, or vice-versa ) so individual
			// bricks read as slightly different fired tones, relative to the building's colour
			const warmCool = brickRnd2.sub( 0.5 ).mul( 0.14 );
			const brickShift = vec3( float( 1 ).add( warmCool ), float( 1 ), float( 1 ).sub( warmCool ) );
			const tint = mix( buildingBase, color( 0xffffff ), lighten ).mul( perBrick ).mul( brickShift );
			const masonry = mix( tint, tint.mul( 0.6 ), joint ); // recessed joints read darker

			// roofs / ledges show every blotch ( flat & light ), so horizontal surfaces get a
			// gentler, larger-scale grime instead of the wall's streaky soot — confined to those
			// surfaces by an If ( roofMask > 0 ), so the fractal never runs on the vertical facade
			const roofMask = wallFacing.oneMinus();
			const roofGrime = float( 0 ).toVar();
			If( roofMask.greaterThan( 0 ), () => {

				roofGrime.assign( smoothstep( 0.0, 0.55, mx_fractal_noise_float( positionWorld.mul( 0.025 ), 3 ) ).mul( 0.22 ) );

			} );

			colorOut.assign( mix( masonry, soot, mix( dirt, roofGrime, roofMask ) ) );
			roughOut.assign( mx_noise_float( positionWorld.mul( 0.5 ) ).mul( 0.08 ).add( 0.82 ).add( joint.mul( 0.12 ) ) );
			heightOut.assign( reliefHeight );

		} );

		return Shaded( colorOut, roughOut, emissiveOut, heightOut );

	} )();

	const material = new MeshStandardNodeMaterial();
	material.colorNode = shade.get( 'color' );
	material.roughnessNode = shade.get( 'roughness' );
	material.metalnessNode = float( 0 ); // all dielectric — stone, glass and the plastic AC shells
	material.emissiveNode = shade.get( 'emissive' );
	material.normalNode = bumpNormal( shade.get( 'height' ) ); // glass / frames / ornament stay flat ( height 0 )

	return material;

}

export { SkyscraperGenerator, createSkyscraperMaterial, skyscraperLights };
