import { useMemo, useRef } from 'react';
import { OrbitControls } from '@react-three/drei';
import { useControls, button, Leva } from 'leva';
import * as THREE from 'three/webgpu';

import WebGPUCanvas from '../webgpu/WebGPUCanvas.jsx';
import {
  createInteriorUniforms,
  createInteriorWindowMaterial,
} from '../interior/interiorMapping.js';

// The facade is one flat plane in the XY plane (facing +Z), centred so a window
// sits on the origin. Everything you see "inside" is the shader.
const FACADE_W = 12;
const FACADE_H = 14;
const FACADE_CY = 7; // lift it off the ground

function Facade({ uniforms }) {
  // Build the geometry + material once; the sliders drive uniforms, not rebuilds.
  const geometry = useMemo(
    () => new THREE.PlaneGeometry(FACADE_W, FACADE_H),
    []
  );
  const material = useMemo(
    () => createInteriorWindowMaterial(uniforms),
    [uniforms]
  );

  return (
    <mesh geometry={geometry} material={material} position={[0, FACADE_CY, 0]} />
  );
}

export default function InteriorLab() {
  // one stable set of uniform nodes for the lifetime of the view
  const uniforms = useRef(createInteriorUniforms()).current;

  // Leva sliders -> write straight into the uniform .value (live, no recompile)
  useControls('Interior Window Lab', {
    interiorOn: {
      value: true,
      label: 'interior mapping',
      onChange: (v) => (uniforms.interiorOn.value = v ? 1 : 0),
    },
    windowW: {
      value: 1.5,
      min: 0.6,
      max: 3,
      step: 0.05,
      label: 'window width',
      onChange: (v) => (uniforms.windowW.value = v),
    },
    windowH: {
      value: 1.75,
      min: 0.8,
      max: 3.5,
      step: 0.05,
      label: 'window height',
      onChange: (v) => (uniforms.windowH.value = v),
    },
    frame: {
      value: 0.12,
      min: 0,
      max: 0.4,
      step: 0.01,
      label: 'frame width',
      onChange: (v) => (uniforms.frame.value = v),
    },
    mullion: {
      value: 0.04,
      min: 0,
      max: 0.2,
      step: 0.005,
      label: 'glazing bar',
      onChange: (v) => (uniforms.mullion.value = v),
    },
    roomDepth: {
      value: 1.55,
      min: 0.4,
      max: 4,
      step: 0.05,
      label: 'room depth',
      onChange: (v) => (uniforms.roomDepth.value = v),
    },
    litFraction: {
      value: 0.25,
      min: 0,
      max: 1,
      step: 0.05,
      label: 'lit rooms',
      onChange: (v) => (uniforms.litFraction.value = v),
    },
    ao: {
      value: 1,
      min: 0,
      max: 1,
      step: 0.05,
      label: 'corner AO',
      onChange: (v) => (uniforms.ao.value = v),
    },
    furniture: {
      value: true,
      onChange: (v) => (uniforms.furniture.value = v ? 1 : 0),
    },
    curtains: {
      value: true,
      onChange: (v) => (uniforms.curtains.value = v ? 1 : 0),
    },
    reseed: button(() => (uniforms.seed.value += 17.3)),
  });

  return (
    <>
      <Leva collapsed={false} />

      <div id="info">
        <div className="title">
          <span>Interior Window Lab</span>
        </div>
        <small>
          One flat plane. Every &ldquo;room&rdquo; — walls, floor, furniture,
          lit lamps — is raymarched per-pixel in a TSL shader, no geometry or
          textures. Orbit to see the parallax; toggle{' '}
          <em>interior mapping</em> to compare against flat glass.
        </small>
      </div>

      <WebGPUCanvas
        exposure={0.6}
        camera={{ fov: 45, near: 0.1, far: 2000, position: [9, 7, 15] }}
      >
        {/* a dim key light so the stone frame and glass specular read */}
        <hemisphereLight args={[0x99aacc, 0x202028, 1.2]} />
        <directionalLight position={[6, 12, 8]} intensity={1.4} />
        <color attach="background" args={[0x0b0e14]} />

        <Facade uniforms={uniforms} />

        <OrbitControls
          makeDefault
          enableDamping
          target={[0, FACADE_CY, 0]}
          minDistance={3}
          maxDistance={60}
        />
      </WebGPUCanvas>
    </>
  );
}
