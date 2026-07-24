import { describe, expect, it } from 'vitest';

import { osmCameraFromTags, parseOsmCameraDirection } from './osmCameras.js';

describe('parseOsmCameraDirection', () => {
  it('parses numeric degrees', () => {
    expect(parseOsmCameraDirection('0')).toBe(0);
    expect(parseOsmCameraDirection('90')).toBe(90);
    expect(parseOsmCameraDirection('215.5')).toBe(215.5);
  });

  it('normalises out-of-range degrees into [0,360)', () => {
    expect(parseOsmCameraDirection('360')).toBe(0);
    expect(parseOsmCameraDirection('-90')).toBe(270);
    expect(parseOsmCameraDirection('450')).toBe(90);
  });

  it('parses 16-point compass abbreviations case-insensitively', () => {
    expect(parseOsmCameraDirection('N')).toBe(0);
    expect(parseOsmCameraDirection('e')).toBe(90);
    expect(parseOsmCameraDirection('SSW')).toBe(202.5);
    expect(parseOsmCameraDirection('nw')).toBe(315);
  });

  it('returns null for relative, empty or unknown values', () => {
    expect(parseOsmCameraDirection('forward')).toBeNull();
    expect(parseOsmCameraDirection('backward')).toBeNull();
    expect(parseOsmCameraDirection('')).toBeNull();
    expect(parseOsmCameraDirection('  ')).toBeNull();
    expect(parseOsmCameraDirection('sideways')).toBeNull();
    expect(parseOsmCameraDirection(undefined)).toBeNull();
  });
});

describe('osmCameraFromTags', () => {
  it('reads a highway=speed_camera node with a numeric direction and name', () => {
    const cam = osmCameraFromTags(
      { highway: 'speed_camera', direction: '180', name: 'E6 Klemetsrud' },
      59.8,
      10.8,
    );
    expect(cam).toEqual({ lat: 59.8, lng: 10.8, bearingDeg: 180, name: 'E6 Klemetsrud' });
  });

  it('falls back to camera:direction when direction is absent', () => {
    const cam = osmCameraFromTags({ highway: 'speed_camera', 'camera:direction': 'W' }, 59, 10);
    expect(cam?.bearingDeg).toBe(270);
  });

  it('yields a null bearing (warn both ways) when no absolute direction is given', () => {
    const cam = osmCameraFromTags({ highway: 'speed_camera', direction: 'forward' }, 59, 10);
    expect(cam).toEqual({ lat: 59, lng: 10, bearingDeg: null, name: null });
  });

  it('accepts an enforcement=maxspeed device=camera node', () => {
    const cam = osmCameraFromTags({ enforcement: 'maxspeed', device: 'camera' }, 48.1, 11.5);
    expect(cam).not.toBeNull();
    expect(cam?.bearingDeg).toBeNull();
  });

  it('prefers name, then ref, then operator for the label', () => {
    expect(osmCameraFromTags({ highway: 'speed_camera', ref: 'CAM-12' }, 1, 1)?.name).toBe(
      'CAM-12',
    );
    expect(osmCameraFromTags({ highway: 'speed_camera', operator: 'Politiet' }, 1, 1)?.name).toBe(
      'Politiet',
    );
    expect(osmCameraFromTags({ highway: 'speed_camera', name: '  ' }, 1, 1)?.name).toBeNull();
  });

  it('returns null for non-camera features and bad coordinates', () => {
    expect(osmCameraFromTags({ highway: 'traffic_signals' }, 1, 1)).toBeNull();
    expect(osmCameraFromTags({ enforcement: 'maxspeed' }, 1, 1)).toBeNull();
    expect(osmCameraFromTags({ highway: 'speed_camera' }, Number.NaN, 1)).toBeNull();
  });
});
