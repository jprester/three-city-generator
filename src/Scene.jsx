import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { useControls } from 'leva';
import * as THREE from 'three/webgpu';
import {
  color,
  floor,
  fract,
  mix,
  positionWorld,
  sin,
  step,
  varying,
} from 'three/tsl';

import { SkyMesh } from 'three/examples/jsm/objects/SkyMesh.js';
import {
  CityGenerator,
  createRoadMaterial,
} from './generators/CityGenerator.js';
import {
  createSkyscraperMaterial,
  skyscraperLights,
} from './generators/city/SkyscraperGenerator.js';
import { createGlassTowerMaterial } from './generators/city/GlassTowerGenerator.js';

// a per-lot cell hash: maps a world-space fragment to the city-grid lot it sits
// on and returns a stable hash( a, b ) for that lot, so a single shared material
// can pick a per-tower colour without any per-building uniform. `seed` shifts the
// whole pick. Used by both the terracotta and the glass-tower materials.
function lotCellHash(layout, seed) {
  const periodX = layout.blockW + layout.street;
  const periodZ = layout.blockD + layout.street;
  const gx = positionWorld.x.add(layout.cityW / 2);
  const gz = positionWorld.z.add(layout.cityD / 2);
  const blockIX = floor(gx.div(periodX));
  const blockIZ = floor(gz.div(periodZ));
  const cellX = blockIX.mul(layout.lotsX).add(floor(gx.sub(blockIX.mul(periodX)).div(layout.lot)));
  const cellZ = blockIZ.mul(layout.lotsZ).add(floor(gz.sub(blockIZ.mul(periodZ)).div(layout.lot)));
  return (a, b) =>
    fract(sin(cellX.mul(a).add(cellZ.mul(b)).add(seed)).mul(43758.5453));
}

// pick one colour from a palette by a 0..1 hash ( evenly bucketed )
function pickFromPalette(palette, pick) {
  let c = palette[0];
  for (let i = 1; i < palette.length; i++) {
    c = mix(c, palette[i], step(i / palette.length, pick));
  }
  return c;
}

// NYC palette, hashed per lot in the city grid so a single shared material
// dresses the whole skyline — only the picked flat colour differs per tower.
// Ported verbatim from the original webgpu_generator_city example. `seed` is
// baked into the material as a constant (matching the original, where the colour
// pick does not change with the slider — only the layout does).
function buildBuildingMaterial(layout, seed) {
  const palette = [
    color(0xc6c0b2), color(0xc6c0b2), color(0xbdb7a8), color(0xd1ccbe), color(0xb4afa1), // limestone / pale dressed stone
    color(0x9a988f), color(0x8b8983), color(0xa5a39a), // grey granite / concrete
    color(0xb1a484), color(0xbcae8b), // buff / tan brick
    color(0x80705b), color(0x786755), // brownstone
    color(0x946d5b), color(0x885f4e), // weathered brick
    color(0xdbd6cb), // pale glazed
    color(0x7c868d), // steel / glass
    color(0x4c4943), // dark stone (rare)
  ];

  const cellHash = lotCellHash(layout, seed);
  let buildingBase = pickFromPalette(palette, cellHash(127.1, 311.7));
  buildingBase = buildingBase.mul(cellHash(269.5, 183.3).mul(0.12).add(0.94)); // subtle per-building brightness

  // constant across each tower's footprint -> resolve once per vertex (varying)
  return createSkyscraperMaterial(varying(buildingBase));
}

// curtain-wall glass tints — cool blue / teal / green / steel greys, with a rare
// bronze — hashed per lot ( seed shifted so the pick decorrelates from the
// terracotta one ) so the modern towers vary across the skyline.
function buildGlassMaterial(layout, seed) {
  const palette = [
    color(0x3a4e5a), color(0x33454f), color(0x2c3a44), // blue-grey glass
    color(0x35494a), color(0x3d524f), // teal / green-grey
    color(0x44505a), color(0x4c5860), // neutral steel
    color(0x5a4c3a), // bronze (rare)
  ];

  const cellHash = lotCellHash(layout, seed + 97);
  let tint = pickFromPalette(palette, cellHash(127.1, 311.7));
  tint = tint.mul(cellHash(269.5, 183.3).mul(0.16).add(0.92)); // subtle per-building brightness

  return createGlassTowerMaterial(varying(tint));
}

// Position the sun for the given time of day and drive the key light from it.
// Cheap (no GPU work) so it can run live on every slider tick. Mirrors the sun
// half of updateSun() in the example; the IBL re-bake is split out below.
function updateSun(ctx, timeOfDay) {
  const { sky, sun, sunLight, moonLight, moonDir, nightAmbient } = ctx;
  ctx.timeOfDay = timeOfDay; // remembered so the night-fill slider can re-apply live

  // sine arc over a full 24h clock: the sun rises at 6, peaks at noon, sets at 18 and
  // drops BELOW the horizon through the night (negative elevation), so the sky darkens
  // to a real night instead of holding at the horizon. Mirrors dayNight.js's model.
  const s = Math.sin(((timeOfDay - 6) / 12) * Math.PI); // -1 midnight .. +1 noon
  const elevation = s * 72; // degrees; negative when the sun is below the horizon
  const u = (timeOfDay - 12) / 6;
  const azimuth = 90 - u * 55; // sun swings east -> west

  sun.setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - elevation),
    THREE.MathUtils.degToRad(azimuth)
  );
  sky.sunPosition.value.copy(sun);

  const sinElevation = Math.sin(THREE.MathUtils.degToRad(elevation));
  const transmittance = Math.sqrt(Math.max(sinElevation, 0)); // 0 horizon -> 1 zenith
  sunLight.color.set(0xffb072).lerp(new THREE.Color(0xfff4e8), transmittance);
  sunLight.intensity = 6 * transmittance;
  sunLight.position.copy(sun).multiplyScalar(600);

  // night lighting: a layered rig that fades in through dusk (from when the sun nears
  // the horizon to full dark) and is fully off in daylight, when the bright sky env does
  // the fill. `night` ramps 0 -> 1 across dusk; `nightFill` is the user's slider.
  //  - moonLight  : hemisphere — cool moon from above, warm city/ground glow from below
  //  - moonDir    : a soft cool key from high up, for form/highlights on the facades
  //  - nightAmbient: a low floor so shadowed masses never read as pure black
  const night = 1 - THREE.MathUtils.smoothstep(s, -0.1, 0.35); // 0 day .. 1 night
  const fill = night * (ctx.nightFill ?? 1);
  if (moonLight) moonLight.intensity = fill * 0.55;
  if (moonDir) moonDir.intensity = fill * 0.5;
  if (nightAmbient) nightAmbient.intensity = fill * 0.18;
}

// Re-bake the sky (without the sun disc) into the IBL environment map. This is a
// full cubemap render + PMREM convolution, so it is debounced rather than run on
// every slider tick.
function bakeEnvironment(ctx, scene) {
  const { sky, pmrem, envScene } = ctx;

  sky.showSunDisc.value = false;
  envScene.add(sky);
  const env = pmrem.fromScene(envScene).texture;
  if (scene.environment) scene.environment.dispose();
  scene.environment = env;
  sky.showSunDisc.value = true;
  scene.add(sky);
}

export default function Scene() {
  const { gl, scene } = useThree();
  const ctx = useRef(null);

  const { seed, timeOfDay } = useControls('City', {
    seed: { value: 1, min: 0, max: 100, step: 1 },
    timeOfDay: { value: 20, min: 0, max: 24, step: 0.1, label: 'time of day' },
    litRooms: {
      value: 0.3,
      min: 0,
      max: 1,
      step: 0.01,
      label: 'lit rooms',
      onChange: (v) => (skyscraperLights.litFraction.value = v),
    },
    windowGlow: {
      value: 5,
      min: 0,
      max: 12,
      step: 0.1,
      label: 'window glow',
      onChange: (v) => (skyscraperLights.emissiveIntensity.value = v),
    },
    nightFill: {
      value: 0.6,
      min: 0,
      max: 2,
      step: 0.05,
      label: 'night fill',
      onChange: (v) => {
        const c = ctx.current;
        if (!c) return;
        c.nightFill = v;
        updateSun(c, c.timeOfDay); // re-apply the moon / ground glow / ambient at the current time
      },
    },
  });

  // --- one-time setup: persistent objects (sky, env, ground, key light) ----
  useEffect(() => {
    scene.environmentIntensity = 0.25; // sky as a soft fill; the sun is the key

    // the city is static while orbiting — only `seed` changes its geometry and only
    // `timeOfDay` moves the light — so the shadow map does NOT need re-rendering every
    // frame. Freeze it and re-bake on demand (in the seed / timeOfDay effects); this
    // drops a full re-raster of all 24 buildings from every single frame.
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;

    const pmrem = new THREE.PMREMGenerator(gl);

    const sky = new SkyMesh();
    sky.scale.setScalar(10000);
    sky.turbidity.value = 8;
    sky.rayleigh.value = 3;
    sky.mieCoefficient.value = 0.008;
    sky.mieDirectionalG.value = 0.88;

    const sun = new THREE.Vector3();
    const envScene = new THREE.Scene();

    const city = new CityGenerator({ seed: 1 });

    // road: sized to the city footprint plus one street of margin all round
    const floorW = city.layout.cityW + 2 * city.layout.street;
    const floorD = city.layout.cityD + 2 * city.layout.street;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(floorW, floorD).rotateX(-Math.PI / 2),
      createRoadMaterial(city.layout)
    );
    ground.receiveShadow = true;
    scene.add(ground);

    // a single directional key aligned with the sky's sun
    const sunLight = new THREE.DirectionalLight();
    sunLight.castShadow = true;
    sunLight.shadow.camera.left = -280;
    sunLight.shadow.camera.right = 280;
    sunLight.shadow.camera.top = 360;
    sunLight.shadow.camera.bottom = -40;
    sunLight.shadow.camera.far = 2400;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.bias = -0.0004;
    scene.add(sunLight);

    // night light rig — all faded in by updateSun() through dusk and off in daylight.
    // a hemisphere doing double duty: cool moonlight from the sky, warm sodium / neon
    // city-glow bouncing up from the streets below.
    const moonLight = new THREE.HemisphereLight(0x4a5a78, 0x5a3a1e, 0);
    scene.add(moonLight);

    // a soft cool directional "moon" from high up, for some form on the facades
    const moonDir = new THREE.DirectionalLight(0xb4c4dc, 0);
    moonDir.position.set(-200, 320, 160);
    scene.add(moonDir);

    // a low ambient floor so deep-shadow masses never go fully black at night
    const nightAmbient = new THREE.AmbientLight(0x222a3a, 0);
    scene.add(nightAmbient);

    // one shared material per building type, built once (seed baked in, as in the example)
    const material = buildBuildingMaterial(city.layout, 1);
    const glassMaterial = buildGlassMaterial(city.layout, 1);

    ctx.current = {
      pmrem,
      sky,
      sun,
      envScene,
      city,
      ground,
      sunLight,
      moonLight,
      moonDir,
      nightAmbient,
      nightFill: 0.6,
      timeOfDay: 20,
      material,
      glassMaterial,
      cityGroup: null,
    };

    // the seed / timeOfDay effects below run on mount too and do the first
    // city.build() and updateSun(), so nothing else is needed here.

    return () => {
      const c = ctx.current;
      if (!c) return;
      if (c.cityGroup) scene.remove(c.cityGroup);
      c.city.dispose();
      scene.remove(c.ground);
      c.ground.geometry.dispose();
      c.ground.material.dispose();
      scene.remove(c.sunLight);
      scene.remove(c.moonLight);
      scene.remove(c.moonDir);
      scene.remove(c.nightAmbient);
      scene.remove(c.sky);
      if (scene.environment) {
        scene.environment.dispose();
        scene.environment = null;
      }
      c.pmrem.dispose();
      ctx.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- rebuild the city when the seed changes ------------------------------
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;

    if (c.cityGroup) scene.remove(c.cityGroup);
    c.city.parameters.seed = seed;
    c.cityGroup = c.city.build({ building: c.material, glassTower: c.glassMaterial });
    scene.add(c.cityGroup);
    gl.shadowMap.needsUpdate = true; // new geometry -> re-bake the frozen shadow map once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  // --- move the sun when the time of day changes ---------------------------
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;

    // the sun + key light update live (cheap); the env re-bake (a cubemap render
    // + PMREM convolution) is debounced so dragging the slider doesn't fire one
    // bake per 0.1 step
    updateSun(c, timeOfDay);
    gl.shadowMap.needsUpdate = true; // the key light moved -> re-bake the frozen shadow map once
    clearTimeout(c.envBakeTimer);
    c.envBakeTimer = setTimeout(() => bakeEnvironment(c, scene), 120);

    return () => clearTimeout(c.envBakeTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeOfDay]);

  return null;
}
