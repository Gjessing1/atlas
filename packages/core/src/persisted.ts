/**
 * The typed boundary over persisted preferences.
 *
 * Settings stopped being incidental booleans a long time ago: the commute
 * configuration, the open route plan, the trip to resume, vehicle dimensions,
 * every overlay's visibility and opacity and every activity profile's layer
 * preset all live in the same one-column `settings` table, reached through a
 * `getSetting(key)` / `setSetting(key, value)` pair that knows nothing about
 * any of them. Twenty-six non-test files each owned their own raw key, their
 * own `JSON.parse` in a `try`, their own defaults, their own idea of what a
 * corrupt row means and, often, their own migration — and each new preference
 * settled all of that again from scratch.
 *
 * Three things were actually wrong, and this module fixes exactly those:
 *
 *  1. **Scope was a spelling convention.** Whether a value syncs is decided by
 *     the `local.` prefix on its key (see `LOCAL_SETTING_PREFIX` and the outbox
 *     rules in `@atlas/storage`). A definition states its scope in words and
 *     {@link defineSetting} refuses to build one whose key disagrees, so a
 *     dropped prefix is a loud failure at import rather than a laptop quietly
 *     publishing the bus it is not on.
 *  2. **A corrupt row meant whatever each caller decided.** One decoder per
 *     value, owned by the feature, is the only path from stored text to a
 *     usable value — which is also the only place an older shape can be
 *     migrated, because there is nowhere else left to do it.
 *  3. **Writes could fail invisibly.** That half is `useUserData`'s: this
 *     module gives it a typed value to write, and it reports what the storage
 *     promise said instead of dropping it.
 *
 * Deliberately *not* a settings god object. A definition is a small value
 * exported by the feature that owns it, next to the code that reads it; this
 * module only says what one is and how to build one safely. Nothing here knows
 * the app's list of settings, and nothing here touches storage.
 */

/**
 * Where a value lives. `local` never leaves the device (the sync outbox skips
 * it, pulls refuse to apply it, and a dump refuses to import it); `synced`
 * travels between a user's devices under last-write-wins.
 */
export type SettingScope = 'local' | 'synced';

/**
 * The prefix that makes a key device-private, and the storage layer's actual
 * rule — it is enforced there on write, on pull and on import, all three by
 * `startsWith`. This lives in core so a definition can be checked against the
 * same constant the database uses rather than a copy of it.
 */
export const LOCAL_SETTING_PREFIX = 'local.';

/** Whether a raw key is device-private. The one rule, in one place. */
export function isLocalSettingKey(key: string): boolean {
  return key.startsWith(LOCAL_SETTING_PREFIX);
}

/** The scope a raw key implies — what storage acts on, for callers that hold no definition. */
export function settingScopeOf(key: string): SettingScope {
  return isLocalSettingKey(key) ? 'local' : 'synced';
}

/**
 * One persisted value: its key, its scope, what it means when absent, and the
 * two functions that convert it to and from the stored text.
 */
export interface SettingDefinition<T> {
  readonly key: string;
  readonly scope: SettingScope;
  /** What the value is before anyone has ever set it, and after an unreadable row. */
  readonly defaultValue: T;
  /**
   * Stored text → value. Returning `undefined` means *this row cannot be used*
   * and the default stands; it is the single place a feature decides what
   * counts as corrupt, and the single place an older shape is migrated.
   *
   * Must not throw: every caller treats a decoder as total, because a thrown
   * error at read time would take down whichever screen happened to mount
   * first. {@link jsonSetting} is the reason most decoders can't.
   */
  readonly decode: (raw: string) => T | undefined;
  /** Value → stored text. */
  readonly encode: (value: T) => string;
}

/**
 * Every key defined in this process, so two features cannot quietly claim one.
 *
 * A duplicate key is not a merge conflict anybody would notice: both features
 * keep working in isolation and each overwrites the other at runtime, on a
 * schedule set by which screen the user opened last. Definitions are built at
 * module load, so the collision surfaces on import — in the first test that
 * touches either feature, long before a device.
 */
const defined = new Map<string, SettingScope>();

/** Every key defined so far, with its scope — for tests and diagnostics. */
export function definedSettingKeys(): ReadonlyMap<string, SettingScope> {
  return new Map(defined);
}

/**
 * Build a definition, refusing the two mistakes that are invisible at runtime:
 * a scope its key contradicts, and a key someone else already owns.
 *
 * The scope check runs in both directions on purpose. A `synced` value whose
 * key starts with `local.` silently stops syncing — the failure the review
 * called out — but a `local` value *without* the prefix is worse: the sync
 * cursor, the device id or "the journey I am on right now" would be pushed to
 * the server and pulled onto every other device the account owns.
 */
export function defineSetting<T>(spec: SettingDefinition<T>): SettingDefinition<T> {
  const { key, scope } = spec;
  if (!key) throw new Error('setting definition needs a key');
  if (scope === 'local' && !isLocalSettingKey(key)) {
    throw new Error(
      `setting "${key}" is local but is missing the "${LOCAL_SETTING_PREFIX}" prefix`,
    );
  }
  if (scope === 'synced' && isLocalSettingKey(key)) {
    throw new Error(`setting "${key}" is synced but carries the "${LOCAL_SETTING_PREFIX}" prefix`);
  }
  const existing = defined.get(key);
  if (existing !== undefined) throw new Error(`setting "${key}" is already defined`);
  defined.set(key, scope);
  return Object.freeze({ ...spec });
}

/**
 * Read a stored row through its definition. Total by construction: an absent
 * row, an empty row and an unusable one all resolve to the default, which is
 * what every call site did by hand and roughly half of them got subtly
 * different.
 *
 * Empty text counts as absent because that is how the app deletes: no platform
 * seam has a `removeSetting`, so clearing a value writes `''` (see the resume
 * record and the route plan), and both must read back as "nothing stored".
 */
export function readSetting<T>(def: SettingDefinition<T>, raw: string | null | undefined): T {
  if (raw === null || raw === undefined || raw === '') return def.defaultValue;
  const value = def.decode(raw);
  return value === undefined ? def.defaultValue : value;
}

/** Encode a value for storage. */
export function writeSetting<T>(def: SettingDefinition<T>, value: T): string {
  return def.encode(value);
}

/**
 * A JSON-encoded setting whose decoder works on the parsed value.
 *
 * This is the shape almost every non-scalar setting wants, and the reason
 * `decode` can promise not to throw: the `JSON.parse` and its `try` live here,
 * once, and the feature is left writing the part only it can write — the
 * validator that says whether this particular object is a usable commute, plan
 * or overlay map, and what to do with the version before the current one.
 */
export function jsonSetting<T>(spec: {
  key: string;
  scope: SettingScope;
  defaultValue: T;
  /**
   * Parsed JSON → value, or `undefined` to fall back to the default. Receives
   * `unknown` rather than a cast, because the row may have been written by an
   * older build, a hand edit, or a half-finished write.
   */
  parse: (value: unknown) => T | undefined;
  /** Defaults to `JSON.stringify`; override to control the written shape. */
  toJSON?: (value: T) => unknown;
}): SettingDefinition<T> {
  const { toJSON } = spec;
  return defineSetting<T>({
    key: spec.key,
    scope: spec.scope,
    defaultValue: spec.defaultValue,
    decode: (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return undefined;
      }
      return spec.parse(parsed);
    },
    encode: (value) => JSON.stringify(toJSON ? toJSON(value) : value),
  });
}

/** A setting whose value is one of a fixed set of strings. */
export function enumSetting<T extends string>(spec: {
  key: string;
  scope: SettingScope;
  defaultValue: T;
  values: readonly T[];
}): SettingDefinition<T> {
  const allowed = new Set<string>(spec.values);
  return defineSetting<T>({
    key: spec.key,
    scope: spec.scope,
    defaultValue: spec.defaultValue,
    decode: (raw) => (allowed.has(raw) ? (raw as T) : undefined),
    encode: (value) => value,
  });
}

/** A free-text setting, optionally length-capped. */
export function stringSetting(spec: {
  key: string;
  scope: SettingScope;
  defaultValue: string;
  maxLength?: number;
}): SettingDefinition<string> {
  const { maxLength } = spec;
  return defineSetting<string>({
    key: spec.key,
    scope: spec.scope,
    defaultValue: spec.defaultValue,
    decode: (raw) => (maxLength !== undefined && raw.length > maxLength ? undefined : raw),
    encode: (value) => value,
  });
}

/**
 * A boolean stored as `'1'` / `'0'`.
 *
 * Reads `'true'` as well, because settings written before this module used
 * `String(flag)` about as often as they used `'1'`, and a preference that
 * silently resets itself once is a bug report nobody can reproduce.
 */
export function booleanSetting(spec: {
  key: string;
  scope: SettingScope;
  defaultValue: boolean;
}): SettingDefinition<boolean> {
  return defineSetting<boolean>({
    key: spec.key,
    scope: spec.scope,
    defaultValue: spec.defaultValue,
    decode: (raw) =>
      raw === '1' || raw === 'true' ? true : raw === '0' || raw === 'false' ? false : undefined,
    encode: (value) => (value ? '1' : '0'),
  });
}

/** A finite number, rejecting anything that would put `NaN` into a UI. */
export function numberSetting(spec: {
  key: string;
  scope: SettingScope;
  defaultValue: number;
  min?: number;
  max?: number;
}): SettingDefinition<number> {
  const { min, max } = spec;
  return defineSetting<number>({
    key: spec.key,
    scope: spec.scope,
    defaultValue: spec.defaultValue,
    decode: (raw) => {
      const value = Number(raw);
      if (!Number.isFinite(value)) return undefined;
      if (min !== undefined && value < min) return undefined;
      if (max !== undefined && value > max) return undefined;
      return value;
    },
    encode: (value) => String(value),
  });
}
