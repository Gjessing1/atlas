import { APP_NAME } from '@atlas/core';
import { MapView } from './MapView.js';

export function App() {
  return (
    <div style={{ height: '100%', position: 'relative' }}>
      <MapView />
      <div
        style={{
          position: 'absolute',
          top: 12,
          left: 12,
          padding: '6px 14px',
          borderRadius: 8,
          background: 'rgba(255, 255, 255, 0.9)',
          boxShadow: '0 1px 4px rgba(0, 0, 0, 0.2)',
          fontWeight: 600,
          fontSize: 18,
        }}
      >
        {APP_NAME}
      </div>
    </div>
  );
}
