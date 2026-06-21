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
import { createSkyscraperMaterial } from './generators/city/SkyscraperGenerator.js';

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

  const periodX = layout.blockW + layout.street;
  const periodZ = layout.blockD + layout.street;
  const gx = positionWorld.x.add(layout.cityW / 2);
  const gz = positionWorld.z.add(layout.cityD / 2);
  const blockIX = floor(gx.div(periodX));
  const blockIZ = floor(gz.div(periodZ));
  const cellX = blockIX.mul(layout.lotsX).add(floor(gx.sub(blockIX.mul(periodX)).div(layout.lot)));
  const cellZ = blockIZ.mul(layout.lotsZ).add(floor(gz.sub(blockIZ.mul(periodZ)).div(layout.lot)));
  const cellHash = (a, b) =>
    fract(sin(cellX.mul(a).add(cellZ.mul(b)).add(seed)).mul(43758.5453));

  const pick = cellHash(127.1, 311.7);
  let buildingBase = palette[0];
  for (let i = 1; i < palette.length; i++) {
    buildingBase = mix(buildingBase, palette[i], step(i / palette.length, pick));
  }
  buildingBase = buildingBase.mul(cellHash(269.5, 183.3).mul(0.12).add(0.94)); // subtle per-building brightness

  // constant across each tower's footprint -> resolve once per vertex (varying)
  return createSkyscraperMaterial(varying(buildingBase));
}

// Position the sun for the given time of day, drive the key light from it, and
// re-bake the sky into the IBL environment. Mirrors updateSun() in the example.
function updateSun(ctx, scene, timeOfDay) {
  const { sky, sun, sunLight, pmrem, envScene } = ctx;

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

  // re-bake the sky (without the sun disc) into the environment map for IBL
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
    timeOfDay: { value: 6.4, min: 6, max: 18, step: 0.1, label: 'time of day' },
  });

  // --- one-time setup: persistent objects (sky, env, ground, key light) ----
  useEffect(() => {
    scene.environmentIntensity = 0.25; // sky as a soft fill; the sun is the key

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
    sunLight.shadow.mapSize.set(4096, 4096);
    sunLight.shadow.bias = -0.0004;
    scene.add(sunLight);

    // one shared building material, built once (seed baked in, as in the example)
    const material = buildBuildingMaterial(city.layout, 1);

    ctx.current = {
      pmrem,
      sky,
      sun,
      envScene,
      city,
      ground,
      sunLight,
      material,
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

  // --- rebuild the city when the seed changes ------------------------------
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;

    if (c.cityGroup) scene.remove(c.cityGroup);
    c.city.parameters.seed = seed;
    c.cityGroup = c.city.build({ building: c.material });
    scene.add(c.cityGroup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  // --- move the sun when the time of day changes ---------------------------
  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    updateSun(c, scene, timeOfDay);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeOfDay]);

  return null;
}
