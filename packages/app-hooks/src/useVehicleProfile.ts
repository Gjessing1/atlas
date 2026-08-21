import { normalizeVehicle, type VehicleProfile } from '@atlas/routing';
import { useCallback, useEffect, useState } from 'react';

/**
 * The described vehicle, saved per account rather than per device.
 *
 * Deliberately **not** a `local.` key: the height of the van does not change
 * because you opened the planner on a laptop instead of the phone in its
 * windscreen mount. A route planned at the kitchen table has to make the same
 * assumptions the one being driven does, or the plan is worthless.
 */
const VEHICLE_SETTING = 'route.vehicle';

export interface VehicleProfileSettings {
  status: string;
  getSetting: (key: string) => Promise<string | null>;
  setSetting: (key: string, value: string) => void;
}

export interface VehicleProfileController {
  /** The saved vehicle, or null while driving an ordinary car. */
  vehicle: VehicleProfile | null;
  /** Save a vehicle, or clear it back to "an ordinary car" with null. */
  setVehicle: (vehicle: VehicleProfile | null) => void;
  /** False until the stored value has been read, so the UI can wait to render. */
  loaded: boolean;
}

function parseStored(raw: string | null): VehicleProfile | null {
  if (!raw) return null;
  try {
    return normalizeVehicle(JSON.parse(raw) as unknown);
  } catch {
    // A corrupt setting means "an ordinary car", never a guessed clearance.
    return null;
  }
}

/** Loads and persists the described vehicle used for driving routes. */
export function useVehicleProfile(settings: VehicleProfileSettings): VehicleProfileController {
  const { status, getSetting, setSetting } = settings;
  const [vehicle, setVehicleState] = useState<VehicleProfile | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (status !== 'ready') return;
    let cancelled = false;
    void (async () => {
      const raw = await getSetting(VEHICLE_SETTING);
      if (cancelled) return;
      setVehicleState(parseStored(raw));
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [status, getSetting]);

  const setVehicle = useCallback(
    (next: VehicleProfile | null) => {
      // Normalise on the way in as well as out: the editor works in free text,
      // and a clamped value must be what is stored, shown and routed on.
      const clean = next ? normalizeVehicle(next) : null;
      setVehicleState(clean);
      setSetting(VEHICLE_SETTING, clean ? JSON.stringify(clean) : '');
    },
    [setSetting],
  );

  return { vehicle, setVehicle, loaded };
}
