import {
  ELEMENT_STALE_DAYS,
  elementAgeDays,
  orbitalPeriodMinutes,
  predictPasses,
  skyGetsDark,
  subpointAt,
  type Observer,
  type SatelliteOmm,
  type SatellitePass,
} from '@atlas/satellites';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BottomSheet } from './BottomSheet';
import { theme } from './theme';

const SEARCH_HOURS = 72;
const COMPASS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const;

const compass = (degrees: number) =>
  COMPASS[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16]!;
const passTime = (pass: SatellitePass) => {
  const start = new Date(pass.start);
  const end = new Date(pass.end);
  return `${start.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}–${end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
};

export function SatellitePassSheet({
  element,
  layerId,
  observer,
  observerSource,
  minElevationDeg,
  onMinElevationChange,
  overhead,
  locating,
  locationError,
  onUseMapCenter,
  onUseMyLocation,
  onClose,
  bottomInset,
}: {
  element: SatelliteOmm | null;
  layerId: string;
  observer: Observer;
  observerSource: 'map' | 'location';
  /**
   * Lifted out of the sheet because the map draws the same floor as a circle:
   * two copies would let the ring and the list disagree about a sighting.
   */
  minElevationDeg: number;
  onMinElevationChange: (deg: number) => void;
  /** Above the observer's horizon this second; null when nothing is selected. */
  overhead: boolean | null;
  locating: boolean;
  locationError: boolean;
  onUseMapCenter: () => void;
  onUseMyLocation: () => void;
  onClose: () => void;
  bottomInset: number;
}) {
  const [visibleOnly, setVisibleOnly] = useState(true);
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const prediction = useMemo(() => {
    if (!element) return { passes: [], hasAnyPass: false, getsDark: true };
    const from = new Date();
    const passes = predictPasses(element, observer, {
      from,
      hours: SEARCH_HOURS,
      minElevationDeg,
      visibleOnly,
      limit: 8,
    });
    const any =
      visibleOnly && passes.length === 0
        ? predictPasses(element, observer, {
            from,
            hours: SEARCH_HOURS,
            minElevationDeg,
            visibleOnly: false,
            limit: 1,
          }).length > 0
        : passes.length > 0;
    return { passes, hasAnyPass: any, getsDark: skyGetsDark(observer, from, SEARCH_HOURS) };
  }, [element, observer.lat, observer.lng, observer.altitudeM, visibleOnly, minElevationDeg]);

  if (!element) return null;
  const fix = subpointAt(element, new Date(nowMs));
  const ageDays = elementAgeDays(element, nowMs);
  const age =
    ageDays < 1 ? `${Math.max(1, Math.round(ageDays * 24))} h` : `${ageDays.toFixed(1)} d`;
  let empty = `This orbit does not climb above ${minElevationDeg}° here in the next 3 days.`;
  if (visibleOnly && prediction.hasAnyPass) {
    empty = prediction.getsDark
      ? 'It passes overhead, but is not sunlit against a dark sky in the next 3 days.'
      : 'The sky does not get dark enough here in the next 3 days.';
  }

  return (
    <BottomSheet
      visible
      mode="map"
      initialSnap="half"
      onClose={onClose}
      bottomInset={bottomInset}
      testID="satellite-pass-sheet"
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.heading}>{element.OBJECT_NAME}</Text>
          <Text style={styles.muted}>
            {element.ATLAS_GROUP === 'stations'
              ? 'Space station'
              : layerId === 'starlink'
                ? 'Starlink satellite'
                : 'Naked-eye catalog'}{' '}
            · NORAD {element.NORAD_CAT_ID}
          </Text>
        </View>
        <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="Close">
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>

      <View style={styles.facts}>
        <Text style={styles.fact}>
          {fix
            ? `${Math.round(fix.altitudeKm)} km · ${Math.round(fix.speedKmS * 3600).toLocaleString()} km/h · ${fix.sunlit ? 'sunlit' : 'in shadow'}`
            : 'Current position unavailable'}
        </Text>
        <Text style={[styles.muted, ageDays >= ELEMENT_STALE_DAYS ? styles.stale : null]}>
          {Math.round(orbitalPeriodMinutes(element))} min orbit · elements {age} old
          {ageDays >= ELEMENT_STALE_DAYS ? ' · predictions may drift' : ''}
        </Text>
      </View>

      <View style={styles.observer}>
        <Text style={styles.observerTitle}>
          Passes over {observerSource === 'location' ? 'my location' : 'map centre'}
        </Text>
        <Text style={styles.muted}>
          {observer.lat.toFixed(4)}, {observer.lng.toFixed(4)}
        </Text>
        {overhead !== null ? (
          <Text style={overhead ? styles.overheadOn : styles.muted}>
            {overhead
              ? `Above your horizon now — over ${minElevationDeg}° up`
              : 'Below your horizon — outside the circle on the map'}
          </Text>
        ) : null}
        <View style={styles.chips}>
          <Chip label="Map centre" on={observerSource === 'map'} onPress={onUseMapCenter} />
          <Chip
            label={locating ? 'Locating…' : 'My location'}
            on={observerSource === 'location'}
            onPress={onUseMyLocation}
            disabled={locating}
          />
        </View>
        {locationError ? (
          <Text style={styles.muted}>Location was unavailable. The forecast is unchanged.</Text>
        ) : null}
      </View>

      <View style={styles.controls}>
        <View style={styles.chips}>
          <Chip label="Visible" on={visibleOnly} onPress={() => setVisibleOnly(true)} />
          <Chip label="All" on={!visibleOnly} onPress={() => setVisibleOnly(false)} />
        </View>
        <View style={styles.chips}>
          {[10, 30].map((value) => (
            <Chip
              key={value}
              label={`${value}°+`}
              on={minElevationDeg === value}
              onPress={() => onMinElevationChange(value)}
            />
          ))}
        </View>
      </View>

      <View style={styles.listHeading}>
        <Text style={styles.listTitle}>{visibleOnly ? 'Visible passes' : 'All passes'}</Text>
        <Text style={styles.muted}>next 3 days</Text>
      </View>
      <ScrollView style={styles.list}>
        {prediction.passes.length ? (
          prediction.passes.map((pass) => (
            <View style={styles.pass} key={`${pass.noradId}/${pass.start}`}>
              <Text style={styles.passTime}>{passTime(pass)}</Text>
              <Text style={styles.fact}>
                {compass(pass.startAzimuth)} → {compass(pass.endAzimuth)} · peaks{' '}
                {Math.round(pass.maxElevationDeg)}° ·{' '}
                {Math.max(1, Math.round(pass.durationSeconds / 60))} min
              </Text>
              <Text style={styles.muted}>
                {pass.magnitude !== undefined ? `${pass.magnitude.toFixed(1)} mag · ` : ''}
                {visibleOnly
                  ? 'sunlit after dark'
                  : `${pass.sunlit ? 'sunlit' : 'in shadow'} · ${pass.darkSky ? 'dark sky' : 'daylight'}`}
              </Text>
            </View>
          ))
        ) : (
          <Text style={styles.empty}>{empty}</Text>
        )}
        <Text style={styles.note}>
          “Visible” means sunlit against a sky darker than civil twilight. Clouds and local
          obstructions are not included.
        </Text>
      </ScrollView>
    </BottomSheet>
  );
}

function Chip({
  label,
  on,
  onPress,
  disabled = false,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      style={[styles.chip, on ? styles.chipOn : null, disabled ? styles.disabled : null]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.chipText, on ? styles.chipTextOn : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  headerText: { flex: 1, paddingRight: 8 },
  heading: { color: theme.text, fontSize: 17, fontWeight: '700' },
  close: { color: theme.textMuted, fontSize: 18, paddingHorizontal: 4 },
  muted: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  facts: { marginTop: 10 },
  fact: { color: theme.text, fontSize: 12 },
  stale: { color: theme.warning, fontWeight: '700' },
  observer: {
    marginTop: 12,
    padding: 10,
    borderRadius: 10,
    backgroundColor: theme.surfaceMuted,
  },
  observerTitle: { color: theme.text, fontSize: 13, fontWeight: '700' },
  // The map's selection blue, not `theme.accent` — accent is reserved for the
  // one control a screen wants tapped, and this is a reading, not a button.
  // Matching the footprint's own colour is also what ties the sentence to the
  // circle it describes. Muted rather than red when false: being outside a
  // footprint is the ordinary state of affairs, not a fault.
  overheadOn: { color: '#38bdf8', fontSize: 12, fontWeight: '700' },
  controls: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  chips: { flexDirection: 'row', gap: 6, marginTop: 7 },
  chip: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 11,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 8,
  },
  chipOn: { borderColor: theme.accent, backgroundColor: theme.accentFaint },
  chipText: { color: theme.text, fontSize: 12 },
  chipTextOn: { color: theme.accent, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  listHeading: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: 12,
  },
  listTitle: { color: theme.text, fontSize: 13, fontWeight: '700' },
  list: { marginTop: 4 },
  pass: { paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.border },
  passTime: { color: theme.text, fontSize: 12, fontWeight: '700' },
  empty: {
    color: theme.textMuted,
    fontSize: 12,
    marginTop: 5,
    padding: 10,
    borderRadius: 8,
    backgroundColor: theme.surfaceMuted,
  },
  note: { color: theme.textMuted, fontSize: 11, lineHeight: 15, marginVertical: 10 },
});
