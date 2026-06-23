import { OrbitControls } from '@react-three/drei';
import { Leva } from 'leva';

import WebGPUCanvas from '../webgpu/WebGPUCanvas.jsx';
import Scene from '../Scene.jsx';
import CityBloom from '../webgpu/CityBloom.jsx';

export default function CityView() {
  return (
    <>
      <Leva collapsed={false} />

      <div id="info">
        <div className="title">
          <a href="https://threejs.org/" target="_blank" rel="noopener">
            three.js
          </a>
          <span> — City Generator</span>
        </div>
        <small>
          Procedurally generated blocks of Neo-Gothic terracotta skyscrapers at
          sunset. Geometry and every surface are generated in code — no external
          assets.
        </small>
      </div>

      <WebGPUCanvas
        exposure={0.35}
        camera={{ fov: 55, near: 1, far: 20000, position: [-55, 60, -100] }}
      >
        <Scene />
        <CityBloom />

        <OrbitControls
          makeDefault
          enableDamping
          target={[25, 60, 0]}
          maxPolarAngle={Math.PI * 0.5}
          minDistance={20}
          maxDistance={1200}
        />
      </WebGPUCanvas>
    </>
  );
}
