import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// We do NOT alias "three" -> "three/webgpu". The WebGPU build does not export
// WebGLRenderer, which R3F and drei (three-stdlib) import from "three", so a
// global alias breaks them. Instead the bare "three" specifier resolves to the
// standard build, while the WebGPU renderer, node materials and TSL are imported
// explicitly from "three/webgpu" and "three/tsl". three's scene graph is
// duck-typed (.isMesh / .isObject3D, not instanceof), so geometry and objects
// created from "three" render fine under the WebGPURenderer.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // only scan our real entry; otherwise Vite also crawls the original example
    // HTML kept under _ref/ (which uses three.js importmap "three/addons/..." paths)
    entries: ['index.html'],
    // prebundle the heavy WebGPU/TSL graph so the dev server starts cleanly
    include: ['three', 'three/webgpu', 'three/tsl'],
  },
});
