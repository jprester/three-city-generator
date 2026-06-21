import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// NOTE: no <StrictMode> on purpose. The scene is built imperatively against the
// WebGPU renderer (PMREM env baking, lights, the city group); StrictMode's
// double mount/unmount in dev would build it twice and fight the cleanup.
createRoot(document.getElementById('root')).render(<App />);
