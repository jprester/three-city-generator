import { useEffect, useMemo } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { useControls } from 'leva';

/**
 * Bloom for the City view — the R3F port of the upstream city example's render
 * pipeline (three.js commit 769f5a6, "Add bloom to city generator and tune lit
 * windows"). A soft glow is added to the brightest areas (the lit windows) of the
 * scene's HDR colour before tone mapping folds it back to display range.
 *
 * The original example drives this from its animation loop via
 * `renderPipeline.render()`; here a `useFrame` with priority > 0 takes over R3F's
 * automatic render so the pipeline becomes the sole presenter. The exposure and
 * bloom-strength controls mirror the two GUI sliders the commit added.
 */
export default function CityBloom() {
  const { gl, scene, camera } = useThree();

  const { pipeline, bloomPass } = useMemo(() => {
    const pipeline = new THREE.RenderPipeline(gl);

    const scenePassColor = pass(scene, camera).getTextureNode('output');
    const bloomPass = bloom(scenePassColor, 0.1, 0.0, 0.0);

    pipeline.outputNode = scenePassColor.add(bloomPass);

    return { pipeline, bloomPass };
  }, [gl, scene, camera]);

  // these merge into the existing "City" leva folder (Scene.jsx owns seed / timeOfDay)
  useControls('City', {
    exposure: {
      value: 0.35,
      min: 0.01,
      max: 1,
      step: 0.01,
      onChange: (v) => (gl.toneMappingExposure = v),
    },
    bloom: {
      value: 0.25,
      min: 0,
      max: 2,
      step: 0.01,
      onChange: (v) => (bloomPass.strength.value = v),
    },
  });

  // present through the bloom pipeline instead of the default renderer.render()
  useFrame(() => {
    pipeline.render();
  }, 1);

  useEffect(() => () => pipeline.dispose?.(), [pipeline]);

  return null;
}
