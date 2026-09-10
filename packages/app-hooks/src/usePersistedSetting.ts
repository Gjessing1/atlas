/**
 * Reading and writing one {@link SettingDefinition} from React.
 *
 * Every persisted preference in Atlas had grown the same twenty lines: a
 * `status !== 'ready'` guard, a `getSetting` whose `.then` had to survive an
 * unmount, a `try`/`catch` around `JSON.parse`, a ref saying whether the stored
 * value had been read yet (without which the first render's default is written
 * straight over it), and a setter that serialized and fired the write into the
 * void. Written out once per feature, in eleven hooks and two apps, with small
 * differences in each — one hook forgets the cancellation, another treats a
 * corrupt row as a fatal error, a third writes before it has loaded.
 *
 * This is that sequence, once. What the feature still owns is everything that
 * is actually about the feature: the key, the scope, the default, and the
 * decoder that says what a usable value looks like — all of it in the
 * definition, next to the code that uses it.
 *
 * The load-before-write discipline is the load-bearing part and the easiest to
 * get wrong: `loaded` starts false, `value` reads as the default meanwhile, and
 * {@link usePersistedSetting} refuses to write until the stored row has come
 * back. A hook that skipped it would erase the user's real value on every cold
 * start, which is a bug that only ever shows up on someone else's device.
 */

import { readSetting, type SettingDefinition } from '@atlas/core';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The storage seam this needs — the settings half of `useUserData`, which is
 * all any preference has ever needed. Both apps already pass exactly this.
 *
 * `setSetting` may return `void` as well as a promise so a caller can hand over
 * a narrower stub, but a real `UserData` answers whether the write landed and
 * this hook passes that answer on.
 */
export interface SettingsAccess {
  status: string;
  getSetting: (key: string) => Promise<string | null | undefined>;
  setSetting: (key: string, value: string) => Promise<boolean> | void;
}

export interface PersistedSetting<T> {
  /** The stored value, or the definition's default until one has been read. */
  value: T;
  /**
   * Save a new value (or derive it from the current one, like `setState`).
   * Resolves `false` when the write did not reach the database — the user has
   * already been told through the write-error channel; this is for a caller
   * that wants to react, and for tests that want to prove it.
   */
  setValue: (next: T | ((current: T) => T)) => Promise<boolean>;
  /**
   * Whether the stored value has been read. Callers that persist *derived*
   * state — a plan that follows the planner, a record that follows a trip —
   * must not write before this is true.
   */
  loaded: boolean;
}

/**
 * Bind one setting definition to React state.
 *
 * Storage that is not ready yet is not an error: the value reads as the
 * default, writes are accepted in memory so the UI stays live (a toggle in a
 * second tab still toggles), and `loaded` stays false so nothing derived
 * overwrites a row it has not seen. An edit made in that window is not lost
 * either — it is kept as a mutation and replayed onto the stored row when the
 * read lands (see `pending`), which is what stops a layer switched on in the
 * first second from switching itself back off. If storage never arrives, that
 * is exactly the "works this session, gone on reload" behaviour the panels
 * already describe.
 */
export function usePersistedSetting<T>(
  access: SettingsAccess,
  definition: SettingDefinition<T>,
): PersistedSetting<T> {
  const { status, getSetting, setSetting } = access;
  const [value, setStateValue] = useState<T>(definition.defaultValue);
  const [loaded, setLoaded] = useState(false);
  // The write path needs the current value to resolve an updater, and must not
  // re-create `setValue` on every change — a changing callback identity is what
  // re-arms effects that persist derived state, one write per keystroke.
  const valueRef = useRef(value);
  valueRef.current = value;
  const definitionRef = useRef(definition);
  definitionRef.current = definition;

  /**
   * The key whose stored value has been read, so it is read *once*.
   *
   * Not a micro-optimisation — it is a correctness latch, and every hook this
   * replaces had its own. The effect re-runs whenever the seam's `getSetting`
   * changes identity, which for a caller that builds its settings object inline
   * is every render; without the latch each of those re-reads the database and
   * overwrites whatever the user has changed since with the row on disk. The
   * symptom is a toggle that flips back on the next unrelated render.
   */
  const loadedKey = useRef<string | null>(null);

  /**
   * Edits made before the stored row was read, kept as the *mutations* they
   * were so they can be replayed onto that row when it arrives.
   *
   * Storage takes a moment to open (OPFS on the web, SQLite on the phone) and
   * the UI is live before it does, so a user can act inside that window. Two
   * obvious answers are both wrong: letting the read win reverts the edit a
   * second after it was made (a layer switched on flips itself back off), and
   * letting the edit win means writing a value derived from the *default* over
   * a row nobody has looked at — for a map-shaped setting like the overlay
   * state that is every other preference in it, gone. Replaying the mutation
   * onto what was stored is the only answer that keeps both.
   */
  const pending = useRef<((current: T) => T)[]>([]);
  const setSettingRef = useRef(setSetting);
  setSettingRef.current = setSetting;

  useEffect(() => {
    if (status !== 'ready' || loadedKey.current === definition.key) return;
    let cancelled = false;
    void Promise.resolve(getSetting(definition.key))
      .then((raw) => {
        if (cancelled) return;
        loadedKey.current = definition.key;
        const stored = readSetting(definition, raw);
        const replayed = pending.current.reduce((current, mutate) => mutate(current), stored);
        pending.current = [];
        valueRef.current = replayed;
        setStateValue(replayed);
        setLoaded(true);
        // An edit that could not be saved when it was made can be saved now.
        if (replayed !== stored) {
          void setSettingRef.current(definition.key, definition.encode(replayed));
        }
      })
      .catch(() => {
        // Reading failed (storage went away mid-load). The default stands and
        // `loaded` stays false, so nothing derived writes over a row that may
        // still be there — the same position as "not read yet", which is true.
        if (!cancelled) setStateValue(definition.defaultValue);
      });
    return () => {
      cancelled = true;
    };
  }, [status, getSetting, definition]);

  const setValue = useCallback(
    async (next: T | ((current: T) => T)) => {
      const def = definitionRef.current;
      const resolved =
        typeof next === 'function' ? (next as (current: T) => T)(valueRef.current) : next;
      valueRef.current = resolved;
      setStateValue(resolved);
      // The stored row has not been read yet — storage is still opening, or its
      // read is in flight. This edit was resolved against the *default*, so
      // writing it now would put a default-shaped value over a row nobody has
      // looked at; for a map-shaped setting like the overlay state that is
      // every other preference in it, gone. Queue the mutation instead and let
      // the read replay it (see `pending`). It reached no database yet, so the
      // honest answer is `false`.
      if (loadedKey.current !== def.key) {
        pending.current.push(typeof next === 'function' ? (next as (c: T) => T) : () => resolved);
        return false;
      }
      return (await setSetting(def.key, def.encode(resolved))) ?? true;
    },
    [setSetting],
  );

  return { value, setValue, loaded };
}
