import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { color, mix, positionLocal, smoothstep, uniform } from 'three/tsl';

/**
 * A fully procedural sky — no HDRI, no textures. A large inverted sphere with a
 * vertical TSL gradient serves as both the visible backdrop AND the image-based
 * lighting: it is baked into an environment map via PMREMGenerator so the scene's
 * glass and stone pick up real, matching reflections.
 *
 * Colours are uniforms, so the day/night slider can recolour the sky live; the
 * env map is re-baked whenever the colours change.
 */
export default function ProceduralSky({
  top = 0x244a8c,
  horizon = 0xa6c6ef,
  bottom = 0x8fa6bd,
  radius = 500,
}) {
  const { gl, scene } = useThree();

  // gradient material + geometry, built once; colours live in uniforms
  const { mesh, geometry, material, u } = useMemo(() => {
    const u = {
      top: uniform(new THREE.Color()),
      horizon: uniform(new THREE.Color()),
      bottom: uniform(new THREE.Color()),
    };

    const material = new THREE.MeshBasicNodeMaterial();
    material.side = THREE.BackSide;

    // height factor from the surface direction: 0 straight down .. 1 straight up
    const t = positionLocal.normalize().y.mul(0.5).add(0.5);
    const lower = mix(u.bottom, u.horizon, smoothstep(0.0, 0.5, t));
    material.colorNode = mix(lower, u.top, smoothstep(0.5, 1.0, t));

    const geometry = new THREE.SphereGeometry(1, 32, 16);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.setScalar(radius);

    return { mesh, geometry, material, u };
  }, [radius]);

  // (re)apply colours + (re)bake the environment whenever the palette changes
  useEffect(() => {
    u.top.value.set(top);
    u.horizon.value.set(horizon);
    u.bottom.value.set(bottom);

    scene.add(mesh); // visible backdrop

    // bake the same gradient (in its own scene) into an env map for reflections
    const envScene = new THREE.Scene();
    const envMesh = new THREE.Mesh(geometry, material);
    envMesh.scale.setScalar(radius);
    envScene.add(envMesh);

    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(envScene).texture;
    if (scene.environment) scene.environment.dispose();
    scene.environment = env;

    return () => {
      scene.remove(mesh);
      if (scene.environment) {
        scene.environment.dispose();
        scene.environment = null;
      }
      pmrem.dispose();
    };
  }, [top, horizon, bottom, radius, gl, scene, mesh, geometry, material, u]);

  return null;
}
