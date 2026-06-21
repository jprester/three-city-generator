import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  color,
  mix,
  select,
  step,
  smoothstep,
  fract,
  floor,
  sin,
  positionWorld,
  cameraPosition,
  dot,
  cross,
  uniform,
} from 'three/tsl';

/**
 * INTERIOR MAPPING — fake 3D rooms behind a flat window, entirely in the shader.
 * =============================================================================
 *
 * This is a standalone, teaching-oriented version of the trick used by the city
 * generator's skyscraper windows. Nothing here is a texture or a 3D model: a
 * single flat plane is shaded so that every window appears to look into a small
 * furnished room with depth, parallax, lighting and soft corner shadows.
 *
 * The idea (a classic by Joost van Dongen, 2008):
 *   1. For each pixel on the glass, build the view ray (camera -> pixel).
 *   2. Pretend there is an axis-aligned BOX room sitting just behind the glass.
 *   3. Intersect the ray with that box and find where it EXITS (the far wall the
 *      eye is actually looking at). That single intersection is cheap — no loop.
 *   4. Colour that exit point procedurally (which wall? floor? ceiling?) and
 *      optionally test a few furniture boxes that might be closer than the wall.
 *
 * Because the box's far face is found analytically, the whole "room" costs about
 * the same as a handful of divides — no raymarching loop, no recursion.
 *
 * This version assumes the window plane lies in the world XY plane facing +Z
 * (the lab builds exactly such a plane), which keeps the frame math readable:
 *   - "across" the window  = world +X
 *   - "up"     the window  = world +Y
 *   - "into"   the wall     = world -Z  (so room depth grows in local +Z)
 * The original generator does the same in each tower face's local frame, so it
 * works on angled walls too — see SkyscraperGenerator.js `interior()`.
 */

// ---------------------------------------------------------------------------
// Tunable parameters, exposed as TSL uniforms so the lab's sliders update the
// look live without recompiling the shader. Defaults give a plausible flat.
// ---------------------------------------------------------------------------
export function createInteriorUniforms() {
  return {
    windowW: uniform(1.5), // window cell width  (world units)
    windowH: uniform(1.75), // window cell height
    frame: uniform(0.12), // stone frame border thickness around the glass
    mullion: uniform(0.04), // central glazing-bar half-thickness (the window cross)
    roomDepth: uniform(1.55), // room depth as a multiple of room height
    litFraction: uniform(0.25), // fraction of rooms with the lights on
    furniture: uniform(1), // 0/1 — show furniture
    curtains: uniform(1), // 0/1 — show curtains
    ao: uniform(1), // 0..1 — strength of the fake corner ambient occlusion
    interiorOn: uniform(1), // 0/1 — blend between flat dark glass and the room
    seed: uniform(0), // global seed offset; re-rolls every room
  };
}

/**
 * Builds a MeshStandardNodeMaterial that draws interior-mapped rooms.
 * Apply it to a plane in the XY world plane facing +Z.
 */
export function createInteriorWindowMaterial(u = createInteriorUniforms()) {
  // ---- the room shader, evaluated per fragment, returns vec4( rgb, lit ) -----
  const interior = Fn(() => {
    const halfW = u.windowW.mul(0.5);
    const halfH = u.windowH.mul(0.5);

    // Which window cell does this pixel fall in? Cells are centred on multiples
    // of the window size, so there's a window centred on the world origin.
    const cellIx = floor(positionWorld.x.div(u.windowW).add(0.5));
    const cellIy = floor(positionWorld.y.div(u.windowH).add(0.5));
    const centerX = cellIx.mul(u.windowW);
    const centerY = cellIy.mul(u.windowH);

    // The fragment's position WITHIN its window, centred on the window
    // (range ~[-halfW, halfW] x [-halfH, halfH]).
    const localX = positionWorld.x.sub(centerX);
    const localY = positionWorld.y.sub(centerY);

    // The glazed opening (the actual glass) is the cell minus the stone frame.
    const roomHalfW = halfW.sub(u.frame);
    const roomHalfH = halfH.sub(u.frame);

    // Is this pixel on the stone frame, or on a glazing bar (the window cross)?
    const onBorder = localX
      .abs()
      .greaterThan(roomHalfW)
      .or(localY.abs().greaterThan(roomHalfH));
    const onMullion = localX
      .abs()
      .lessThan(u.mullion)
      .or(localY.abs().lessThan(u.mullion));
    const isFrame = onBorder.or(onMullion);

    // ---- build the view ray in the room's local (across, up, depth) frame ----
    // The plane faces +Z, so the world axes ARE the room axes; depth runs into
    // the wall, hence the negated z. (The generator does this with dot products
    // against the face's own basis so it also works on rotated walls.)
    const ray = positionWorld.sub(cameraPosition).normalize();
    const dir = vec3(ray.x, ray.y, ray.z.negate());
    const origin = vec3(localX, localY, float(0));

    // ---- the box room, sitting just behind the glass -------------------------
    const setback = float(0.05); // room starts just behind the pane
    const roomH = roomHalfH.mul(2);
    const depth = roomH.mul(u.roomDepth); // deeper than it is tall reads well
    const boxMax = vec3(roomHalfW, roomHalfH, setback.add(depth));
    const boxMin = vec3(roomHalfW.negate(), roomHalfH.negate(), setback);

    // SLAB METHOD, far side only: for each axis the ray crosses the box's near
    // and far planes; the FAR exit is the nearest of the three far crossings.
    // Dividing by a near-zero direction yields +/-inf, which min() drops safely.
    const tFar = boxMin.sub(origin).div(dir).max(boxMax.sub(origin).div(dir));
    const t = tFar.x.min(tFar.y).min(tFar.z);
    const hit = origin.add(dir.mul(t)); // the wall point the eye sees
    const size = boxMax.sub(boxMin);
    const q = hit.sub(boxMin).div(size); // 0..1 coordinates inside the room

    // Which surface did the ray exit through?
    const onBack = q.z.greaterThan(0.998);
    const onCeil = q.y.greaterThan(0.998);
    const onFloor = q.y.lessThan(0.002);

    // ---- a per-ROOM hash: identical for every pixel of a given window --------
    // so a room never speckles and reads as one coherent space.
    const hash = (kx, ky) =>
      fract(
        sin(cellIx.mul(kx).add(cellIy.mul(ky)).add(u.seed)).mul(43758.5453)
      );
    const seed = hash(127.1, 311.7);
    const seed2 = hash(269.5, 183.3);
    const lit = step(u.litFraction.oneMinus(), hash(63.21, 9.17));

    // depth dimming (darker toward the back) + a rectangle mask helper
    const falloffAt = (z) =>
      mix(float(1.0), float(0.42), z.sub(setback).div(depth).clamp(0, 1));
    const rect = (ax, ay, cx, cy, hw, hh) =>
      smoothstep(hw + 0.006, hw - 0.006, ax.sub(cx).abs()).mul(
        smoothstep(hh + 0.006, hh - 0.006, ay.sub(cy).abs())
      );

    // ---- the room shell: walls / floor / ceiling / back wall -----------------
    let wall = mix(color(0x9a8b73), color(0x6f7a82), seed);
    wall = mix(wall, color(0xb9ad97), seed2.mul(0.6));
    const wallCol = mix(wall, wall.mul(0.5), smoothstep(0.05, 0.04, q.y)); // skirting

    const seam = step(0.94, fract(q.x.mul(6))); // floorboard seams
    const boards = mix(color(0x4a3320), color(0x6a4c30), seed).mul(
      seam.mul(0.3).oneMinus()
    );
    const rug = mix(color(0x7a3b32), color(0x3a5760), seed2);
    const floorCol = mix(boards, rug, rect(q.x, q.z, 0.5, 0.62, 0.3, 0.26).mul(0.9));

    const lamp = smoothstep(0.16, 0.13, vec2(q.x.sub(0.5), q.z.sub(0.5)).length());
    const ceilCol = mix(
      mix(wall, color(0xffffff), 0.5),
      color(0xfff0cf).mul(mix(float(1.0), float(4.5), lit)),
      lamp
    );

    const doorX = mix(float(0.22), float(0.78), seed);
    const door = mix(color(0x5a4631), color(0x39383c), step(0.5, seed2));
    const picX = select(
      doorX.lessThan(0.5),
      mix(float(0.68), float(0.82), seed2),
      mix(float(0.18), float(0.32), seed2)
    );
    const picCol = mix(color(0x2c3a4a), color(0x7a5a3a), hash(5.1, 9.2));
    let backCol = mix(wallCol, door, rect(q.x, q.y, doorX, 0.33, 0.085, 0.35));
    backCol = mix(backCol, color(0x141210), rect(q.x, q.y, picX, 0.56, 0.075, 0.085));
    backCol = mix(backCol, picCol, rect(q.x, q.y, picX, 0.56, 0.055, 0.065));

    const shellCol = select(
      onBack,
      backCol,
      select(onCeil, ceilCol, select(onFloor, floorCol, wallCol))
    );

    // ---- fake ambient occlusion: darken where two surfaces meet --------------
    const aoBand = 0.15;
    const aoEdge = (a) =>
      smoothstep(0, aoBand, a).mul(smoothstep(0, aoBand, a.oneMinus()));
    const edgeAO = select(
      onBack,
      aoEdge(q.x).mul(aoEdge(q.y)),
      select(
        onFloor.or(onCeil),
        aoEdge(q.x).mul(aoEdge(q.z)),
        aoEdge(q.y).mul(aoEdge(q.z))
      )
    );
    const shellAO = mix(float(1.0), mix(float(0.72), float(1.0), edgeAO), u.ao);

    // ---- nearest surface so far: the shell. Furniture may sit closer. --------
    const best = {
      t,
      col: shellCol.mul(shellAO).mul(falloffAt(hit.z)),
    };

    // ray vs an axis-aligned box; returns its NEAR face hit + 0..1 box coords
    const boxHit = (bMin, bMax) => {
      const ta = bMin.sub(origin).div(dir);
      const tb = bMax.sub(origin).div(dir);
      const lo = ta.min(tb);
      const hi = ta.max(tb);
      const tN = lo.x.max(lo.y).max(lo.z);
      const p = origin.add(dir.mul(tN));
      return {
        tN,
        p,
        hit: hi.x.min(hi.y).min(hi.z).greaterThan(tN).and(tN.greaterThan(0)),
        qb: p.sub(bMin).div(bMax.sub(bMin)),
      };
    };
    // keep this surface if it's hit, gated on, and nearer than the current best
    const consider = (h, tN, c, gate) => {
      const near = h.and(tN.lessThan(best.t)).and(gate);
      best.col = select(near, c, best.col);
      best.t = select(near, tN, best.t);
    };

    const furn = u.furniture.greaterThan(0.5);
    const halfU = boxMax.x;
    const floorY = boxMin.y;
    const ceilY = boxMax.y;
    const backZ = boxMax.z;
    const midZ = setback.add(depth.mul(0.5));

    // a low table near the middle (its top catches the light)
    const tCx = mix(halfU.mul(-0.4), halfU.mul(0.4), seed);
    const tCz = midZ.add(mix(depth.mul(-0.15), depth.mul(0.2), seed2));
    const tHx = halfU.mul(0.45);
    const tHz = depth.mul(0.12);
    const tbl = boxHit(
      vec3(tCx.sub(tHx), floorY, tCz.sub(tHz)),
      vec3(tCx.add(tHx), floorY.add(roomH.mul(0.22)), tCz.add(tHz))
    );
    const tblCol = mix(color(0x4a3526), color(0x6b4a30), seed2).mul(
      select(tbl.qb.y.greaterThan(0.94), float(1.25), float(0.8))
    );
    consider(tbl.hit, tbl.tN, tblCol.mul(falloffAt(tbl.p.z)), furn);

    // a wide low sofa against the back wall, facing the window
    const sofaCx = mix(halfU.mul(-0.3), halfU.mul(0.3), seed2);
    const sofa = boxHit(
      vec3(sofaCx.sub(halfU.mul(0.7)), floorY, backZ.sub(depth.mul(0.33))),
      vec3(
        sofaCx.add(halfU.mul(0.7)),
        floorY.add(roomH.mul(mix(float(0.32), float(0.4), seed))),
        backZ.sub(depth.mul(0.05))
      )
    );
    const sofaCol = mix(color(0x5a4a3a), color(0x42566a), seed).mul(
      select(sofa.qb.y.greaterThan(0.9), float(1.12), float(0.85))
    );
    consider(sofa.hit, sofa.tN, sofaCol.mul(falloffAt(sofa.p.z)), furn);

    // tall wardrobes in the back corners — each side stands only in some rooms
    const wardrobe = (cx, gate, h) => {
      const w = boxHit(
        vec3(cx.sub(halfU.mul(0.18)), floorY, backZ.sub(depth.mul(0.18))),
        vec3(cx.add(halfU.mul(0.18)), floorY.add(h), backZ.sub(depth.mul(0.05)))
      );
      const c = mix(color(0x3a2c22), color(0x55473a), seed).mul(
        select(w.qb.y.greaterThan(0.94), float(1.2), float(0.82))
      );
      consider(w.hit, w.tN, c.mul(falloffAt(w.p.z)), gate.and(furn));
    };
    wardrobe(
      halfU.mul(-0.78),
      hash(7.3, 2.1).greaterThan(0.4),
      roomH.mul(mix(float(0.72), float(0.95), seed))
    );
    wardrobe(
      halfU.mul(0.78),
      hash(3.7, 8.4).greaterThan(0.4),
      roomH.mul(mix(float(0.72), float(0.95), seed2))
    );

    // curtains hung just inside the glass, drawn part-way in from each side
    const curt = u.curtains.greaterThan(0.5);
    const fabric = mix(color(0x8a7a64), color(0x70605a), seed2);
    const drape = (bMin, bMax, gate) => {
      const h = boxHit(bMin, bMax);
      const pleat = fabric.mul(mix(float(0.78), float(1.12), fract(h.p.x.mul(2.5))));
      consider(h.hit, h.tN, pleat.mul(falloffAt(h.p.z)), gate.and(curt));
    };
    const cz0 = setback;
    const cz1 = setback.add(depth.mul(0.06));
    const sL = smoothstep(0.3, 1.0, seed);
    const sR = smoothstep(0.3, 1.0, seed2);
    const lw = halfU.mul(sL.mul(sL)); // bias narrow, so most rooms read partly open
    const rw = halfU.mul(sR.mul(sR));
    drape(
      vec3(halfU.negate(), floorY, cz0),
      vec3(halfU.negate().add(lw), ceilY, cz1),
      lw.greaterThan(0.05)
    );
    drape(
      vec3(halfU.sub(rw), floorY, cz0),
      vec3(halfU, ceilY, cz1),
      rw.greaterThan(0.05)
    );

    // lit rooms read brighter and warmer (lights on)
    const warmth = mix(vec3(1, 1, 1), color(0xffc081), lit.mul(0.85));
    const roomRGB = best.col.mul(warmth).mul(mix(float(1.0), float(1.3), lit));

    return vec4(roomRGB, lit);
  });

  // ---- assemble the material -------------------------------------------------
  const room = interior(); // vec4( room rgb, lit )

  // The frame mask is recomputed here (cheap cell math) rather than threaded out
  // of the Fn, so the material can paint stone frame vs. glazing.
  const halfW = u.windowW.mul(0.5);
  const halfH = u.windowH.mul(0.5);
  const cellIx = floor(positionWorld.x.div(u.windowW).add(0.5));
  const cellIy = floor(positionWorld.y.div(u.windowH).add(0.5));
  const localX = positionWorld.x.sub(cellIx.mul(u.windowW));
  const localY = positionWorld.y.sub(cellIy.mul(u.windowH));
  const roomHalfW = halfW.sub(u.frame);
  const roomHalfH = halfH.sub(u.frame);
  const onBorder = localX
    .abs()
    .greaterThan(roomHalfW)
    .or(localY.abs().greaterThan(roomHalfH));
  const onMullion = localX
    .abs()
    .lessThan(u.mullion)
    .or(localY.abs().lessThan(u.mullion));
  const isFrame = onBorder.or(onMullion);

  // frame: pale dressed stone with a touch of per-cell tone variation
  const frameTone = fract(
    sin(cellIx.mul(91.7).add(cellIy.mul(47.3)).add(u.seed)).mul(7919.1)
  );
  const frameStone = mix(color(0x9a948a), color(0xb4afa3), frameTone);

  // flat "off" look so the interiorOn slider shows the before/after
  const flatGlass = mix(color(0x10141a), color(0x223040), localY.add(halfH).div(u.windowH));
  const glassColor = mix(flatGlass, room.xyz, u.interiorOn);

  const material = new MeshStandardNodeMaterial();
  material.colorNode = select(isFrame, frameStone, glassColor);
  // lit rooms (room.w == 1) glow; scaled down by interiorOn so "off" is dark glass
  material.emissiveNode = select(
    isFrame,
    color(0x000000),
    room.xyz.mul(room.w).mul(2.2).mul(u.interiorOn)
  );
  material.roughnessNode = select(isFrame, float(0.85), float(0.2)); // glass smoother
  material.metalnessNode = float(0);

  return material;
}
