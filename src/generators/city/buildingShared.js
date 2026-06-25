import {
	BoxGeometry,
	BufferAttribute,
	BufferGeometry,
	Matrix3,
	Matrix4,
	Sphere,
	Vector2,
	Vector3
} from 'three';

import { attribute, cameraPosition, color, cross, dot, float, floor, Fn, fract, If, mix, modelWorldMatrixInverse, normalLocal, normalView, positionLocal, positionView, positionWorld, select, sin, smoothstep, step, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';

import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Building-type-agnostic helpers shared by every tower generator: geometry baking,
// the footprint / face frame math, the deterministic PRNG, the derivative-based
// bump and the night-time interior-mapping shader. Both SkyscraperGenerator and
// GlassTowerGenerator are built on these, so the heavy baking pass and the ~200-line
// interior raymarch live in one place.

const _scale = /*@__PURE__*/ new Vector3();
const _point = /*@__PURE__*/ new Vector3();
const _normalMatrix = /*@__PURE__*/ new Matrix3();
const _identity = /*@__PURE__*/ new Matrix4();

// merging requires all-indexed or all-non-indexed inputs; extrusions are
// non-indexed while boxes/planes are indexed, so normalize before merging

function merge( geometries ) {

	return mergeGeometries( geometries.map( ( g ) => g.index ? g.toNonIndexed() : g ) );

}

function nonIndexed( geometry ) {

	return geometry.index ? geometry.toNonIndexed() : geometry;

}

// the unit box is identical for every building's shell boxes — build it once
const _unitBox = /*@__PURE__*/ nonIndexed( new BoxGeometry( 1, 1, 1 ) );

/**
 * Bakes a list of instance groups into one non-indexed BufferGeometry. Each group is a
 * base geometry ( position + normal + uv ), an array of Matrix4 placements and a `partId`
 * written to a per-vertex attribute. Transforming straight into preallocated typed arrays
 * avoids mergeGeometries' per-instance allocations; the result is one geometry, ready for
 * a single draw call and the compute rasterizer.
 */
function bakeGroups( groups ) {

	let total = 0;
	for ( const group of groups ) total += group.geometry.attributes.position.count * group.matrices.length;

	const position = new Float32Array( total * 3 );
	const normal = new Float32Array( total * 3 );
	const uv = new Float32Array( total * 2 );
	const partId = new Float32Array( total );
	// per-window interior-mapping room ( centre + size ) the glass pane looks into; only
	// the glass group writes it, every other vertex stays zero. baked per vertex so the
	// material reads each building's own room sizes without a global uniform.
	const roomCenter = new Float32Array( total * 3 );
	const roomSize = new Float32Array( total * 2 );

	let w = 0;

	// the bounding sphere falls out of the AABB gathered while transforming, sparing a
	// second full pass over the positions ( computeBoundingSphere )
	let minX = Infinity, minY = Infinity, minZ = Infinity;
	let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

	for ( const group of groups ) {

		const geometry = group.geometry;
		const P = geometry.attributes.position.array;
		const N = geometry.attributes.normal.array;
		const U = geometry.attributes.uv.array;
		const count = geometry.attributes.position.count;
		const id = group.partId;
		const rooms = group.rooms; // per-instance { center, size }, glass only
		const rigid = group.rigid === true; // pure rotation ( + translation ): the normal matrix is the rotation itself

		for ( let i = 0; i < group.matrices.length; i ++ ) {

			const room = rooms ? rooms[ i ] : null;

			const matrix = group.matrices[ i ];
			const e = matrix.elements;
			const e0 = e[ 0 ], e1 = e[ 1 ], e2 = e[ 2 ], e4 = e[ 4 ], e5 = e[ 5 ], e6 = e[ 6 ], e8 = e[ 8 ], e9 = e[ 9 ], e10 = e[ 10 ], e12 = e[ 12 ], e13 = e[ 13 ], e14 = e[ 14 ];

			// for a rigid frame the inverse-transpose equals the rotation, so its columns
			// are read straight from the matrix and the per-instance 3×3 inverse is skipped
			let n0, n1, n2, n3, n4, n5, n6, n7, n8;

			if ( rigid ) {

				n0 = e0; n1 = e1; n2 = e2; n3 = e4; n4 = e5; n5 = e6; n6 = e8; n7 = e9; n8 = e10;

			} else {

				const ne = _normalMatrix.getNormalMatrix( matrix ).elements;
				n0 = ne[ 0 ]; n1 = ne[ 1 ]; n2 = ne[ 2 ]; n3 = ne[ 3 ]; n4 = ne[ 4 ]; n5 = ne[ 5 ]; n6 = ne[ 6 ]; n7 = ne[ 7 ]; n8 = ne[ 8 ];

			}

			for ( let v = 0; v < count; v ++ ) {

				const v3 = v * 3, w3 = w * 3;
				const x = P[ v3 ], y = P[ v3 + 1 ], z = P[ v3 + 2 ];
				const wx = e0 * x + e4 * y + e8 * z + e12;
				const wy = e1 * x + e5 * y + e9 * z + e13;
				const wz = e2 * x + e6 * y + e10 * z + e14;
				position[ w3 ] = wx; position[ w3 + 1 ] = wy; position[ w3 + 2 ] = wz;
				if ( wx < minX ) minX = wx; if ( wx > maxX ) maxX = wx;
				if ( wy < minY ) minY = wy; if ( wy > maxY ) maxY = wy;
				if ( wz < minZ ) minZ = wz; if ( wz > maxZ ) maxZ = wz;

				const nx = N[ v3 ], ny = N[ v3 + 1 ], nz = N[ v3 + 2 ];
				const tx = n0 * nx + n3 * ny + n6 * nz, ty = n1 * nx + n4 * ny + n7 * nz, tz = n2 * nx + n5 * ny + n8 * nz;
				const inv = 1 / ( Math.sqrt( tx * tx + ty * ty + tz * tz ) || 1 );
				normal[ w3 ] = tx * inv; normal[ w3 + 1 ] = ty * inv; normal[ w3 + 2 ] = tz * inv;

				uv[ w * 2 ] = U[ v * 2 ]; uv[ w * 2 + 1 ] = U[ v * 2 + 1 ];
				partId[ w ] = id;

				if ( room !== null ) {

					roomCenter[ w3 ] = room.center.x; roomCenter[ w3 + 1 ] = room.center.y; roomCenter[ w3 + 2 ] = room.center.z;
					roomSize[ w * 2 ] = room.size.x; roomSize[ w * 2 + 1 ] = room.size.y;

				}

				w ++;

			}

		}

	}

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new BufferAttribute( position, 3 ) );
	geometry.setAttribute( 'normal', new BufferAttribute( normal, 3 ) );
	geometry.setAttribute( 'uv', new BufferAttribute( uv, 2 ) );
	geometry.setAttribute( 'partId', new BufferAttribute( partId, 1 ) );
	geometry.setAttribute( 'roomCenter', new BufferAttribute( roomCenter, 3 ) );
	geometry.setAttribute( 'roomSize', new BufferAttribute( roomSize, 2 ) );

	geometry.boundingSphere = new Sphere(
		new Vector3( ( minX + maxX ) / 2, ( minY + maxY ) / 2, ( minZ + maxZ ) / 2 ),
		Math.hypot( maxX - minX, maxY - minY, maxZ - minZ ) / 2
	);

	return geometry;

}

// deterministic PRNG (mulberry32) so a given seed always yields the same tower

function createRandom( seed ) {

	let s = ( seed >>> 0 ) || 1;

	return function () {

		s = ( s + 0x6D2B79F5 ) | 0;
		let t = Math.imul( s ^ ( s >>> 15 ), 1 | s );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

// a stable per-floor hash ( from the floor index and the face origin ) used to pick the
// interior-mapping room module per floor without allocating a closure each floor
function floorHash( f, frame, k ) {

	const s = Math.sin( f * 12.9898 + frame.origin.x * 0.07 + frame.origin.z * 0.131 + k ) * 43758.5453;
	return s - Math.floor( s );

}

// --- footprint & faces ---------------------------------------------------

/**
 * A rectangle (centred at the origin in the XZ plane) with one corner cut at
 * 45 degrees, returned as an ordered list of `Vector2( x, z )`. `cornerX` /
 * `cornerZ` ( each ±1 ) pick which corner is cut, so the chamfer can be aimed
 * outward to a block corner.
 */
function buildFootprint( width, depth, chamfer, cornerX = 1, cornerZ = 1 ) {

	const hw = width / 2;
	const hd = depth / 2;
	const c = Math.min( chamfer, hw, hd );

	// the four corners, counter-clockwise
	const corners = [
		new Vector2( hw, hd ),
		new Vector2( - hw, hd ),
		new Vector2( - hw, - hd ),
		new Vector2( hw, - hd )
	];

	const points = [];

	for ( let i = 0; i < corners.length; i ++ ) {

		const corner = corners[ i ];

		// cut the requested corner: replace it with two points pulled back along
		// each adjacent edge, leaving a 45° face that points out to that corner
		if ( c > 0 && Math.sign( corner.x ) === cornerX && Math.sign( corner.y ) === cornerZ ) {

			const prev = corners[ ( i + 3 ) % 4 ];
			const next = corners[ ( i + 1 ) % 4 ];
			points.push( corner.clone().lerp( prev, c / corner.distanceTo( prev ) ) );
			points.push( corner.clone().lerp( next, c / corner.distanceTo( next ) ) );

		} else {

			points.push( corner.clone() );

		}

	}

	return points;

}

/**
 * Builds a face frame per footprint edge. Each frame is an orthonormal basis
 * ( u along the edge, v up, n outward ) plus an origin and length, so all
 * facade layout can happen in flat ( u, v ) space and bake to world with one
 * matrix — the same authored piece then instances onto every face, including
 * the diagonal chamfer.
 */
function buildFaces( points ) {

	const faces = [];
	const up = new Vector3( 0, 1, 0 );

	for ( let i = 0; i < points.length; i ++ ) {

		const a = points[ i ];
		const b = points[ ( i + 1 ) % points.length ];

		// outward normal: perpendicular to the edge, pointing away from the
		// origin (the footprint is centred there)

		const n = new Vector3( b.y - a.y, 0, - ( b.x - a.x ) ).normalize();
		const mid = new Vector3( ( a.x + b.x ) / 2, 0, ( a.y + b.y ) / 2 );
		if ( n.dot( mid ) < 0 ) n.negate();

		// right-handed basis: u = v × n, so makeBasis( u, v, n ) is a pure rotation

		const u = new Vector3().crossVectors( up, n ).normalize();

		const pa = new Vector3( a.x, 0, a.y );
		const pb = new Vector3( b.x, 0, b.y );
		const length = pa.distanceTo( pb );

		// the edge end that u points away from becomes the origin

		const origin = pb.clone().sub( pa ).dot( u ) > 0 ? pa : pb;

		faces.push( new FaceFrame( origin, u, up.clone(), n, length ) );

	}

	return faces;

}

/** A face's local ( u along edge, v up, n outward ) frame in world space. */
class FaceFrame {

	constructor( origin, u, v, n, length ) {

		this.origin = origin;
		this.u = u;
		this.v = v;
		this.n = n;
		this.length = length;

	}

	point( u, v, w, target = new Vector3() ) {

		return target
			.copy( this.origin )
			.addScaledVector( this.u, u )
			.addScaledVector( this.v, v )
			.addScaledVector( this.n, w );

	}

	/** Places a piece authored in the canonical local frame ( x across, y up, z outward ). */
	matrix( u, v, w ) {

		return new Matrix4()
			.makeBasis( this.u, this.v, this.n )
			.setPosition( this.point( u, v, w, _point ) );

	}

	/** How many bays of `bayWidth` fit, with the remainder split into end margins. */
	bays( bayWidth ) {

		const count = Math.max( 1, Math.floor( this.length / bayWidth ) );
		const margin = ( this.length - count * bayWidth ) / 2;

		return { count, margin, width: bayWidth };

	}

}

// a Matrix4 mapping the shared unit box ( 1×1×1, centred ) onto a face-aligned
// box of the given size, centred at the given face-local point. these matrices
// are what the shell InstancedMesh is built from.
function boxMatrix( frame, u, v, w, sizeU, sizeV, sizeN ) {

	return new Matrix4()
		.makeBasis( frame.u, frame.v, frame.n )
		.scale( _scale.set( sizeU, sizeV, sizeN ) )
		.setPosition( frame.point( u, v, w, _point ) );

}

// --- material helpers ----------------------------------------------------

// derivative-based bump for a procedural, world-space height field. the built-in bumpMap
// offsets the UV to read its height, so it returns a zero gradient for a height keyed off
// world position; this feeds the hardware screen-space derivatives of the height into
// Mikkelsen's surface-gradient method so the relief actually perturbs the normal.
function bumpNormal( height ) {

	const dpdx = positionView.dFdx();
	const dpdy = positionView.dFdy();
	const r1 = dpdy.cross( normalView );
	const r2 = normalView.cross( dpdx );
	const det = dpdx.dot( r1 );
	const grad = det.sign().mul( height.dFdx().mul( r1 ).add( height.dFdy().mul( r2 ) ) );

	return det.abs().mul( normalView ).sub( grad ).normalize();

}

// interior mapping: fakes a furnished room behind each glass pane in the fragment
// shader — no geometry, no texture. every pane carries the room it looks into ( centre +
// size, baked per window by the generator ), so neighbouring panes share one interior. the
// view ray is cast into that box and the walls, floor, ceiling and a few furniture pieces
// it meets are shaded procedurally, keyed off a per-room hash. returns vec4( colour, lit ).
// Live, tunable lighting for the lit rooms — module-level uniforms shared by every
// tower's material (the whole city uses one material per type), so a view can dial the
// night glow live without rebuilding any geometry. Set `.value` from a slider:
//   litFraction      — fraction of rooms with the lights on ( 0.2 ≈ the original ~20% )
//   emissiveIntensity — how hard a lit window glows ( pairs with the bloom pass )
const skyscraperLights = {
	litFraction: /*@__PURE__*/ uniform( 0.3 ),
	emissiveIntensity: /*@__PURE__*/ uniform( 5 )
};

const interior = /*@__PURE__*/ Fn( () => {

	const roomCenter = attribute( 'roomCenter', 'vec3' );
	const roomSize = attribute( 'roomSize', 'vec2' );

	// a per-face frame from the geometry normal ( holds on every facade, including the
	// 45° chamfer ): u runs across the face, v is up, n points outward
	const n = normalLocal;
	const up = vec3( 0, 1, 0 );
	const uAxis = cross( up, n ).normalize();

	// this pixel and the view ray, in the room's ( across, up, depth ) frame; depth
	// runs into the wall, so the ray's depth component is positive
	const d = positionLocal.sub( roomCenter );
	const camLocal = modelWorldMatrixInverse.mul( vec4( cameraPosition, 1 ) ).xyz;
	const rayLocal = positionLocal.sub( camLocal ).normalize();
	const origin = vec3( dot( d, uAxis ), d.y, 0 );
	const dir = vec3( dot( rayLocal, uAxis ), rayLocal.y, dot( rayLocal, n ).negate() );

	// the room box: the pane-wide × ceiling-height front rectangle ( centred on the pane ),
	// set back behind the glass and run a little deeper than it is tall. shade the far
	// side the ray exits ( slab method: nearest of the three far-plane crossings;
	// dividing by a near-zero direction gives ±inf, which min() harmlessly drops ).
	const setback = float( 0.1 ); // the room starts just behind the glass, so it sits flush in the frame opening
	const boxMax = vec3( roomSize.x.mul( 0.5 ), roomSize.y.mul( 0.5 ), setback.add( roomSize.y.mul( 1.55 ) ) );
	const boxMin = vec3( boxMax.x.negate(), boxMax.y.negate(), setback );
	const tFar = boxMin.sub( origin ).div( dir ).max( boxMax.sub( origin ).div( dir ) );
	const t = tFar.x.min( tFar.y ).min( tFar.z );
	const hit = origin.add( dir.mul( t ) );
	const q = hit.sub( boxMin ).div( boxMax.sub( boxMin ) ); // 0..1 inside the room

	const onBack = q.z.greaterThan( 0.998 );
	const onCeil = q.y.greaterThan( 0.998 );
	const onFloor = q.y.lessThan( 0.002 );

	// a per-ROOM hash from the baked centre — bit-identical for every pixel of every
	// pane in the room, so it can never speckle and all of a room's windows match
	const cell = floor( roomCenter.mul( 2.0 ) );
	const hash = ( kx, ky, kz ) => fract( sin( cell.x.mul( kx ).add( cell.y.mul( ky ) ).add( cell.z.mul( kz ) ) ).mul( 43758.5453 ) );
	const seed = hash( 12.9898, 78.233, 37.719 );
	const seed2 = hash( 39.346, 11.135, 83.155 );
	const lit = step( skyscraperLights.litFraction.oneMinus(), hash( 63.21, 9.17, 51.43 ) ); // lights on where the room hash clears the ( slider-driven ) threshold

	// each room's bulb colour. most run warm, drifting from a dim amber ( ~2400K ) up to a
	// warm white ( ~3200K ); a minority run cool, from a fluorescent / LED daylight to a TV's
	// bluer glow — so a lit facade reads as a spread of bulb temperatures, not one flat tint
	const warmLight = mix( color( 0xffb845 ), color( 0xffe49c ), hash( 27.1, 4.9, 61.7 ) );
	const coolLight = mix( color( 0xdfe8ff ), color( 0x9fb6ff ), hash( 8.3, 51.2, 17.6 ) );
	const lightCol = select( hash( 44.7, 19.3, 6.1 ).greaterThan( 0.88 ), coolLight, warmLight ); // ~12% of lit rooms run cool

	// depth falloff ( darker toward the back ), and a panel mask on a face given its
	// two 0..1 coordinates — used for the flat fittings below
	const depth = roomSize.y.mul( 1.55 );
	const falloffAt = ( z ) => mix( float( 1.0 ), float( 0.42 ), z.sub( setback ).div( depth ).clamp( 0, 1 ) );
	const rect = ( ax, ay, cx, cy, hw, hh ) => smoothstep( hw + 0.006, hw - 0.006, ax.sub( cx ).abs() ).mul( smoothstep( hh + 0.006, hh - 0.006, ay.sub( cy ).abs() ) );

	// --- the room shell: walls, floor, ceiling, back wall, with flat fittings ----

	// muted plaster, picked per room, with a darker skirting board along the wall foot
	let wall = mix( color( 0x9a8b73 ), color( 0x6f7a82 ), seed );
	wall = mix( wall, color( 0xb9ad97 ), seed2.mul( 0.6 ) );
	const wallCol = mix( wall, wall.mul( 0.5 ), smoothstep( 0.05, 0.04, q.y ) );

	// floorboards with a thin seam every few, and a centred rug
	const seam = step( 0.94, fract( q.x.mul( 6 ) ) );
	const boards = mix( color( 0x4a3320 ), color( 0x6a4c30 ), seed ).mul( seam.mul( 0.3 ).oneMinus() );
	const rug = mix( color( 0x7a3b32 ), color( 0x3a5760 ), seed2 );
	const floorCol = mix( boards, rug, rect( q.x, q.z, 0.5, 0.62, 0.3, 0.26 ).mul( 0.9 ) );

	// ceiling, lighter than the walls, with a round overhead light in the middle; in a
	// lit room the fixture reads bright and glows ( the material's emissive = colour × lit )
	const lamp = smoothstep( 0.16, 0.13, vec2( q.x.sub( 0.5 ), q.z.sub( 0.5 ) ).length() );
	const ceilCol = mix( mix( wall, color( 0xffffff ), 0.5 ), lightCol.mul( mix( float( 1.0 ), float( 4.5 ), lit ) ), lamp );

	// back wall: a panelled door to one side, and a framed picture kept on the
	// opposite half of the wall so it never lands on the door
	const doorX = mix( float( 0.22 ), float( 0.78 ), seed );
	const door = mix( color( 0x5a4631 ), color( 0x39383c ), step( 0.5, seed2 ) );
	const picX = select( doorX.lessThan( 0.5 ), mix( float( 0.68 ), float( 0.82 ), seed2 ), mix( float( 0.18 ), float( 0.32 ), seed2 ) );
	const picCol = mix( color( 0x2c3a4a ), color( 0x7a5a3a ), hash( 5.1, 9.2, 3.3 ) );
	let backCol = mix( wallCol, door, rect( q.x, q.y, doorX, 0.33, 0.085, 0.35 ) );
	backCol = mix( backCol, color( 0x141210 ), rect( q.x, q.y, picX, 0.56, 0.075, 0.085 ) ); // dark frame
	backCol = mix( backCol, picCol, rect( q.x, q.y, picX, 0.56, 0.055, 0.065 ) ); // the picture

	const shellCol = select( onBack, backCol, select( onCeil, ceilCol, select( onFloor, floorCol, wallCol ) ) );

	// fake ambient occlusion: darken the hit toward the room's edges ( where two surfaces
	// meet ), so the box reads with soft corner shading instead of flat-lit walls. the two
	// in-plane axes depend on which face the ray exits through ( q is 0..1 inside the room ).
	const aoBand = 0.15;
	const aoEdge = ( a ) => smoothstep( 0, aoBand, a ).mul( smoothstep( 0, aoBand, a.oneMinus() ) );
	const edgeAO = select( onBack, aoEdge( q.x ).mul( aoEdge( q.y ) ), select( onFloor.or( onCeil ), aoEdge( q.x ).mul( aoEdge( q.z ) ), aoEdge( q.y ).mul( aoEdge( q.z ) ) ) );
	const shellAO = mix( float( 0.72 ), float( 1.0 ), edgeAO );

	// --- nearest surface: the shell, then any furniture block that lies closer ----
	// each block is a solid axis-aligned box in room space; boxHit returns its near
	// face. consider() keeps whichever surface the ray meets first.
	const bestT = t.toVar();
	const bestCol = shellCol.mul( shellAO ).mul( falloffAt( hit.z ) ).toVar();
	const bestEmit = float( 1 ).toVar(); // per-hit emissive weight: shell and fittings emit fully, curtains far less

	const boxHit = ( bMin, bMax ) => {

		const ta = bMin.sub( origin ).div( dir );
		const tb = bMax.sub( origin ).div( dir );
		const lo = ta.min( tb ), hi = ta.max( tb );
		const tN = lo.x.max( lo.y ).max( lo.z );
		const p = origin.add( dir.mul( tN ) );
		return { tN, p, hit: hi.x.min( hi.y ).min( hi.z ).greaterThan( tN ).and( tN.greaterThan( 0 ) ), qb: p.sub( bMin ).div( bMax.sub( bMin ) ) };

	};

	const consider = ( h, tN, c, emit = 1 ) => {

		const isNear = h.and( tN.lessThan( bestT ) );
		bestCol.assign( select( isNear, c, bestCol ) );
		bestEmit.assign( select( isNear, float( emit ), bestEmit ) );
		bestT.assign( select( isNear, tN, bestT ) );

	};

	// the furniture ( six ray/box intersections per pixel ) only resolves when the camera
	// is close enough for it to be more than sub-pixel. Distant windows — the great
	// majority on screen — keep just the room shell, skipping the whole block. Mirrors the
	// road material's distance LOD; the threshold is generous so the cutoff falls where the
	// windows are already tiny and the furniture is invisible anyway.
	If( positionWorld.distance( cameraPosition ).lessThan( 200 ), () => {

		const halfU = boxMax.x, floorY = boxMin.y, ceilY = boxMax.y, backZ = boxMax.z;
		const midZ = setback.add( depth.mul( 0.5 ) ); // room centre, in depth

		// a low table near the middle of the room ( its top catches the light )
		const tCx = mix( float( - 0.6 ), float( 0.6 ), seed );
		const tCz = midZ.add( mix( float( - 0.4 ), float( 0.5 ), seed2 ) );
		const tbl = boxHit( vec3( tCx.sub( 0.6 ), floorY, tCz.sub( 0.35 ) ), vec3( tCx.add( 0.6 ), floorY.add( 0.42 ), tCz.add( 0.35 ) ) );
		const tblCol = mix( color( 0x4a3526 ), color( 0x6b4a30 ), seed2 ).mul( select( tbl.qb.y.greaterThan( 0.94 ), float( 1.25 ), float( 0.8 ) ) );
		consider( tbl.hit, tbl.tN, tblCol.mul( falloffAt( tbl.p.z ) ) );

		// a wide low sofa against the back wall, facing the window
		const sofaCx = mix( halfU.mul( - 0.3 ), halfU.mul( 0.3 ), seed2 );
		const sofa = boxHit( vec3( sofaCx.sub( 1.1 ), floorY, backZ.sub( 0.95 ) ), vec3( sofaCx.add( 1.1 ), floorY.add( mix( float( 0.8 ), float( 0.9 ), seed ) ), backZ.sub( 0.1 ) ) );
		const sofaCol = mix( color( 0x5a4a3a ), color( 0x42566a ), seed ).mul( select( sofa.qb.y.greaterThan( 0.9 ), float( 1.12 ), float( 0.85 ) ) );
		consider( sofa.hit, sofa.tN, sofaCol.mul( falloffAt( sofa.p.z ) ) );

		// tall wardrobes in the back corners — each side stands in some rooms
		const wardrobe = ( cx, gate, h ) => {

			const w = boxHit( vec3( cx.sub( 0.5 ), floorY, backZ.sub( 0.7 ) ), vec3( cx.add( 0.5 ), floorY.add( h ), backZ.sub( 0.1 ) ) );
			const c = mix( color( 0x3a2c22 ), color( 0x55473a ), seed ).mul( select( w.qb.y.greaterThan( 0.94 ), float( 1.2 ), float( 0.82 ) ) );
			consider( w.hit.and( gate ), w.tN, c.mul( falloffAt( w.p.z ) ) );

		};

		wardrobe( halfU.mul( - 0.82 ), hash( 7.3, 2.1, 9.9 ).greaterThan( 0.4 ), mix( float( 1.7 ), float( 2.3 ), seed ) );
		wardrobe( halfU.mul( 0.82 ), hash( 3.7, 8.4, 1.5 ).greaterThan( 0.4 ), mix( float( 1.7 ), float( 2.3 ), seed2 ) );

		// curtains hung just inside the glass: drapes drawn part-way in from each side,
		// so some windows read open and others half-covered

		// curtain fabric colour, picked per room from a muted domestic palette — creams and
		// taupes through warm grey, dusty blue, sage and faded terracotta — with a small
		// in-family drift so drawn drapes vary window to window instead of all reading beige
		const swatch = ( a, b ) => mix( color( a ), color( b ), seed2 );
		const pick = hash( 22.4, 6.7, 91.2 ).mul( 6 ); // 0..6, one bucket per family
		let fabric = swatch( 0xcabfa6, 0xd8cdb8 ); // cream
		fabric = select( pick.greaterThan( 1 ), swatch( 0x8a7a64, 0x9b8c72 ), fabric ); // beige / taupe
		fabric = select( pick.greaterThan( 2 ), swatch( 0x706a64, 0x837d76 ), fabric ); // warm grey
		fabric = select( pick.greaterThan( 3 ), swatch( 0x5f7079, 0x6f818b ), fabric ); // dusty blue
		fabric = select( pick.greaterThan( 4 ), swatch( 0x6c7558, 0x79835f ), fabric ); // sage green
		fabric = select( pick.greaterThan( 5 ), swatch( 0x8c5a44, 0x9a6a52 ), fabric ); // faded terracotta
		const drape = ( bMin, bMax, gate ) => {

			const h = boxHit( bMin, bMax );
			const pleat = fabric.mul( mix( float( 0.78 ), float( 1.12 ), fract( h.p.x.mul( 2.5 ) ) ) ); // soft vertical pleats
			consider( h.hit.and( gate ), h.tN, pleat.mul( falloffAt( h.p.z ) ), 0.2 ); // a drape only transmits a little of the room's glow, never out-glowing the interior

		};

		const cz0 = setback, cz1 = setback.add( 0.12 );
		// drape widths, biased narrow ( squared ) and each capped at half the room width, so
		// the two sides only meet — fully curtaining the window — in the rare room where both
		// are nearly closed; most rooms read partly open
		const sL = smoothstep( 0.3, 1.0, seed ), sR = smoothstep( 0.3, 1.0, seed2 );
		const lw = halfU.mul( sL.mul( sL ) ); // left drape width ( 0 below seed 0.3 )
		const rw = halfU.mul( sR.mul( sR ) ); // right drape width
		drape( vec3( halfU.negate(), floorY, cz0 ), vec3( halfU.negate().add( lw ), ceilY, cz1 ), lw.greaterThan( 0.05 ) );
		drape( vec3( halfU.sub( rw ), floorY, cz0 ), vec3( halfU, ceilY, cz1 ), rw.greaterThan( 0.05 ) );

	} );

	// lit rooms read brighter and take on their bulb's colour ( the lights are on )
	const warmth = mix( vec3( 1.0, 1.0, 1.0 ), lightCol, lit.mul( 0.85 ) );
	return vec4( bestCol.mul( warmth ).mul( mix( float( 1.0 ), float( 1.3 ), lit ) ), lit.mul( bestEmit ) );

} );

export {
	_unitBox,
	_identity,
	merge,
	nonIndexed,
	bakeGroups,
	createRandom,
	floorHash,
	buildFootprint,
	buildFaces,
	FaceFrame,
	boxMatrix,
	bumpNormal,
	skyscraperLights,
	interior
};
