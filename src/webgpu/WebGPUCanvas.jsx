import { useState } from 'react';
import { Canvas, extend } from '@react-three/fiber';
import * as THREE from 'three/webgpu';

// Register every three/webgpu class with R3F's reconciler once, on import.
extend(THREE);

const hasWebGPU =
  typeof navigator !== 'undefined' && navigator.gpu !== undefined;

/**
 * A <Canvas> preconfigured for the three.js WebGPU renderer:
 *  - creates and awaits a WebGPURenderer via the async `gl` factory
 *  - enforces ACES tone mapping + exposure after R3F applies its own defaults
 *  - shows a loading / unsupported overlay
 *
 * Shared by both demo views so the WebGPU plumbing lives in one place.
 */
export default function WebGPUCanvas({
  camera,
  exposure = 0.35,
  shadows = true,
  children,
}) {
  const [ready, setReady] = useState(false);

  if (!hasWebGPU) {
    return (
      <div className="overlay">
        WebGPU is not available in this browser.
        <br />
        Try the latest Chrome, Edge, or Safari Technology Preview.
      </div>
    );
  }

  return (
    <>
      {!ready && <div className="overlay">Initializing WebGPU…</div>}

      <Canvas
        shadows={shadows}
        camera={camera}
        dpr={[1, 1.5]} // cap retina rendering: this scene is fragment-bound, so pixel count dominates cost
        gl={async (props) => {
          const renderer = new THREE.WebGPURenderer({
            ...props,
            antialias: true,
          });
          renderer.shadowMap.enabled = shadows;
          renderer.shadowMap.type = THREE.PCFSoftShadowMap;
          await renderer.init();
          return renderer;
        }}
        onCreated={({ gl }) => {
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = exposure;
          setReady(true);
        }}
      >
        {children}
      </Canvas>
    </>
  );
}
