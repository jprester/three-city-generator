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
  createGlassTowerMaterial,
} from './generators/city/SkyscraperGenerator.js';

// A stable per-lot hash from world position: maps a fragment to its city-grid cell
// (same derivation the building material uses for coursing) so a single shared
// material can pick a per-tower colour. `seed` is baked in as a constant.
function cellHashFor(layout, seed) {
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

// picks one palette entry per lot from a hash, with a subtle per-lot brightness jitter
function pickPerLot(palette, cellHash) {
  const pick = cellHash(127.1, 311.7);
  let base = palette[0];
  for (let i = 1; i < palette.length; i++) {
    base = mix(base, palette[i], step(i / palette.length, pick));
  }
  return base.mul(cellHash(269.5, 183.3).mul(0.12).add(0.94));
}

// NYC palette, hashed per lot in the city grid so a single shared material
// dresses the whole skyline — only the picked flat colour differs per tower.
// Ported verbatim from the original webgpu_generator_city example.
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

  const buildingBase = pickPerLot(palette, cellHashFor(layout, seed));

  // constant across each tower's footprint -> resolve once per vertex (varying)
  return createSkyscraperMaterial(varying(buildingBase));
}

// cool, neutral tints for the glass towers' mullions / spandrels, picked per lot so
// the curtain-wall blocks don't all read identically against the warm masonry.
function buildGlassMaterial(layout, seed) {
  const palette = [
    color(0x9aa3a8), color(0x8f9aa0), color(0xa7b0b4), // brushed aluminium / steel
    color(0x7f8c94), color(0xb0b8bc), // cool grey
    color(0x6f8893), color(0x97a6ac), // blue-grey
  ];

  // a different seed offset so a lot's glass tint isn't tied to its masonry pick
  const glassBase = pickPerLot(palette, cellHashFor(layout, seed + 19.7));

  return createGlassTowerMaterial(varying(glassBase));
}

// Position the sun for the given time of day and drive the key light from it.
// Cheap (no GPU work) so it can run live on every slider tick. Mirrors the sun
// half of updateSun() in the example; the IBL re-bake is split out below.
function updateSun(ctx, timeOfDay) {
  const { sky, sun, sunLight } = ctx;

  const u = (timeOfDay - 12) / 6; // -1 sunrise, 0 noon, +1 sunset
  const elevation = Math.max(0, 1 - u * u) * 72; // degrees, peaks at noon
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

  const { seed, timeOfDay, glassMix } = useControls('City', {
    seed: { value: 1, min: 0, max: 100, step: 1 },
    timeOfDay: { value: 6.4, min: 6, max: 18, step: 0.1, label: 'time of day' },
    glassMix: { value: 0.4, min: 0, max: 1, step: 0.05, label: 'glass towers' },
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

    // two shared building materials, built once (seed baked in, as in the example):
    // the terracotta gothic tower and the modern glass curtain-wall tower. Each lot
    // picks one; buildings are separate meshes, so two materials cost no extra batching.
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

  // --- rebuild the city when the seed or glass mix changes -----------------
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;

    if (c.cityGroup) scene.remove(c.cityGroup);
    c.city.parameters.seed = seed;
    c.city.parameters.glassMix = glassMix;
    c.cityGroup = c.city.build({ building: c.material, glass: c.glassMaterial });
    scene.add(c.cityGroup);
    gl.shadowMap.needsUpdate = true; // new geometry -> re-bake the frozen shadow map once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, glassMix]);

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
