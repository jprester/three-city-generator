import { useState } from 'react';

import CityView from './views/CityView.jsx';
import InteriorLab from './views/InteriorLab.jsx';

const VIEWS = {
  city: { label: 'City', Component: CityView },
  interior: { label: 'Interior Window Lab', Component: InteriorLab },
};

export default function App() {
  const [view, setView] = useState('city');
  const Active = VIEWS[view].Component;

  return (
    <>
      <nav className="nav">
        {Object.entries(VIEWS).map(([key, { label }]) => (
          <button
            key={key}
            className={key === view ? 'active' : ''}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {/* key forces a full remount on switch so each WebGPU canvas tears down cleanly */}
      <Active key={view} />
    </>
  );
}
