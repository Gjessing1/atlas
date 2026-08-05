// @vitest-environment jsdom

import type { NavController } from '@atlas/app-hooks';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  supported: true,
  blocked: false,
  inPip: false,
  armed: false,
  pipListener: null as ((value: boolean) => void) | null,
  actionListener: null as ((action: 'toggleMute' | 'endTrip') => void) | null,
  appStateListener: null as ((state: string) => void) | null,
  setActive: vi.fn((value: boolean) => {
    native.armed = value;
    return value;
  }),
  setMuted: vi.fn(),
  setSourceRect: vi.fn(),
  openSettings: vi.fn(() => true),
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: vi.fn((_event: string, listener: (state: string) => void) => {
      native.appStateListener = listener;
      return { remove: vi.fn() };
    }),
  },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

vi.mock('../../modules/pip', () => ({
  addPipActionListener: (listener: (action: 'toggleMute' | 'endTrip') => void) => {
    native.actionListener = listener;
    return { remove: vi.fn() };
  },
  addPipListener: (listener: (value: boolean) => void) => {
    native.pipListener = listener;
    return { remove: vi.fn() };
  },
  inPictureInPicture: () => native.inPip,
  pipArmed: () => native.armed,
  pipBlockedByUser: () => native.blocked,
  pipSupported: () => native.supported,
  openPipSettings: native.openSettings,
  setPipActive: native.setActive,
  setPipMuted: native.setMuted,
  setPipSourceRect: native.setSourceRect,
}));

import { useNavigationPip } from './useNavigationPip';

const nav = (phase: NavController['phase']) =>
  ({ phase, muted: false, toggleMute: vi.fn(), stop: vi.fn() }) as unknown as NavController;
const settings = {
  status: 'ready',
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(),
};

describe('useNavigationPip', () => {
  beforeEach(() => {
    native.supported = true;
    native.blocked = false;
    native.inPip = false;
    native.armed = false;
    native.pipListener = null;
    native.actionListener = null;
    native.appStateListener = null;
    native.setActive.mockClear();
    native.setSourceRect.mockClear();
    native.setMuted.mockClear();
    native.openSettings.mockClear();
  });

  it('arms for guidance, stays armed in PiP, and disarms when the trip ends', () => {
    const view = renderHook(({ phase }) => useNavigationPip(nav(phase), settings), {
      initialProps: { phase: 'idle' as NavController['phase'] },
    });

    view.rerender({ phase: 'navigating' });
    expect(native.setActive).toHaveBeenLastCalledWith(true);
    native.setActive.mockClear();

    act(() => {
      native.inPip = true;
      native.pipListener?.(true);
    });
    expect(view.result.current.inPictureInPicture).toBe(true);
    expect(native.setActive).not.toHaveBeenCalledWith(false);

    view.rerender({ phase: 'arrived' });
    expect(native.setActive).toHaveBeenLastCalledWith(false);
  });

  it('arms while a requested route is still starting', () => {
    renderHook(() => useNavigationPip(nav('starting'), settings));
    expect(native.setActive).toHaveBeenLastCalledWith(true);
  });

  it('routes native mute and end actions through the navigation controller', () => {
    const controller = nav('navigating');
    renderHook(() => useNavigationPip(controller, settings));

    act(() => native.actionListener?.('toggleMute'));
    expect(controller.toggleMute).toHaveBeenCalledOnce();
    act(() => native.actionListener?.('endTrip'));
    expect(controller.stop).toHaveBeenCalledOnce();
  });

  it('rechecks permission and heals native arming when the activity resumes', () => {
    const view = renderHook(() => useNavigationPip(nav('navigating'), settings));
    expect(view.result.current.available).toBe(true);

    native.armed = false;
    native.setActive.mockClear();
    act(() => native.appStateListener?.('active'));
    expect(native.setActive).toHaveBeenLastCalledWith(true);

    native.blocked = true;
    act(() => native.appStateListener?.('active'));
    expect(view.result.current.available).toBe(false);
    expect(native.setActive).toHaveBeenLastCalledWith(false);
  });

  it('uses the measured map viewport without changing arming state', () => {
    const { result } = renderHook(() => useNavigationPip(nav('navigating'), settings));
    native.setActive.mockClear();

    act(() => result.current.setMapRect({ x: 2, y: 4, width: 380, height: 800 }));

    expect(native.setSourceRect).toHaveBeenCalledWith({ x: 2, y: 4, width: 380, height: 800 });
    expect(native.setActive).not.toHaveBeenCalledWith(false);
  });
});
