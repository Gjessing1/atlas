import { useTerrainSlope, type WeatherMapsController } from '@atlas/app-hooks';
import {
  bestWindows,
  buildPlanner,
  compass16,
  forecastTable,
  sunDay,
  symbolEmoji,
  windArrow,
  type ConditionsKind,
  type FactorRating,
  type ForecastPeriodCell,
  type PlannerHour,
  type WeatherMapLayerId,
} from '@atlas/conditions';
import { fmtClock, fmtDayClock, fmtDayLabel, type LatLng } from '@atlas/core';
import { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { UserData } from '../useUserData';
import type { WeatherState } from '../weather/useWeather';
import { BottomSheet } from './BottomSheet';
import { theme } from './theme';

// Sheet prefs are device-local (`local.` keys never sync) — same keys as the web panel.
const MODE_SETTING = 'local.weather.mode';
const SPECIES_SETTING = 'local.weather.species';

type Mode = 'weather' | 'maps' | ConditionsKind;
const MODES: { id: Mode; label: string }[] = [
  { id: 'weather', label: 'Forecast' },
  { id: 'maps', label: 'Maps' },
  { id: 'fishing', label: 'Fishing' },
  { id: 'hunting', label: 'Hunting' },
];
const SPECIES = ['trout', 'perch', 'pike', 'char'] as const;

/** Rating → tick/score colour, shared by the timeline strip and the score box. */
const RATING_COLOR: Record<string, string> = {
  prime: '#2e9e5b',
  good: '#6aab2e',
  fair: '#cf9310',
  slow: '#a9736f',
};
const FACTOR_COLOR: Record<FactorRating, string> = {
  good: '#2e9e5b',
  fair: '#f0b429',
  poor: '#d05a5a',
};

const fmtTime = (ms: number): string => fmtClock(ms);
const fmtStep = (ms: number): string => fmtDayClock(ms);

function frameKind(kind: string): string {
  return kind === 'observation' ? 'Radar observation' : kind === 'nowcast' ? 'Nowcast' : 'Forecast';
}

function WeatherMapControls({ maps }: { maps: WeatherMapsController }): React.JSX.Element {
  const layer = maps.layer;
  const frame = maps.frame;
  return (
    <ScrollView style={styles.mapScroll}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.mapLayerRow}
      >
        {maps.layers.map((candidate) => (
          <Pressable
            key={candidate.id}
            style={[styles.mapLayerChip, layer?.id === candidate.id ? styles.mapLayerActive : null]}
            onPress={() => maps.selectLayer(candidate.id as WeatherMapLayerId)}
            testID={`weather-map-${candidate.id}`}
          >
            <Text
              style={[
                styles.mapLayerText,
                layer?.id === candidate.id ? styles.mapLayerTextActive : null,
              ]}
            >
              {candidate.title}
            </Text>
          </Pressable>
        ))}
        <View style={[styles.mapLayerChip, styles.mapLayerDisabled]}>
          <Text style={styles.mapLayerText}>Lightning</Text>
        </View>
      </ScrollView>

      {maps.status === 'loading' && !layer ? (
        <Text style={styles.muted}>Loading weather maps…</Text>
      ) : null}
      {maps.status === 'error' && !layer ? (
        <Text style={styles.muted}>Weather maps are unavailable right now.</Text>
      ) : null}

      {layer && frame ? (
        <>
          <View style={styles.mapTimeRow}>
            <View>
              <Text style={styles.mapTime}>{fmtStep(Date.parse(frame.time))}</Text>
              <Text style={styles.mapKind}>{frameKind(frame.kind)}</Text>
            </View>
            <Pressable style={styles.playButton} onPress={maps.togglePlaying} testID="weather-play">
              <Text style={styles.playText}>{maps.playing ? 'Pause' : 'Play'}</Text>
            </Pressable>
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.mapTimeline}
            contentContainerStyle={styles.mapTimelineContent}
          >
            {layer.frames.map((candidate, index) => (
              <Pressable
                key={candidate.id}
                onPress={() => maps.selectFrame(index)}
                style={[
                  styles.mapTick,
                  candidate.kind === 'observation'
                    ? styles.mapTickObserved
                    : candidate.kind === 'nowcast'
                      ? styles.mapTickNowcast
                      : styles.mapTickForecast,
                  index === maps.frameIndex ? styles.mapTickSelected : null,
                ]}
                accessibilityLabel={fmtStep(Date.parse(candidate.time))}
              />
            ))}
          </ScrollView>
          <View style={styles.stepButtons}>
            <Pressable
              style={styles.stepButton}
              onPress={maps.previous}
              disabled={maps.frameIndex === 0}
            >
              <Text style={styles.stepButtonText}>◀ Earlier</Text>
            </Pressable>
            <Pressable
              style={styles.stepButton}
              onPress={maps.next}
              disabled={maps.frameIndex === layer.frames.length - 1}
            >
              <Text style={styles.stepButtonText}>Later ▶</Text>
            </Pressable>
          </View>
          <Text style={styles.mapDescription}>{layer.description}</Text>
          <View style={styles.legendBox}>
            <View style={styles.legendHeading}>
              <Text style={styles.legendTitle}>{layer.title}</Text>
              <Text style={styles.legendTitle}>{layer.unit}</Text>
            </View>
            <View style={styles.legendGradient}>
              {layer.legend.map((stop) => (
                <View
                  key={`${stop.label}-${stop.color}`}
                  style={[styles.legendColor, { backgroundColor: stop.color }]}
                />
              ))}
            </View>
            <View style={styles.legendLabels}>
              {layer.legend.map((stop) => (
                <Text key={stop.label} style={styles.legendLabel}>
                  {stop.label}
                </Text>
              ))}
            </View>
          </View>
          <Text style={styles.attribution}>{maps.attribution}</Text>
          {maps.lightningReason ? (
            <Text style={styles.lightningNote}>{maps.lightningReason}</Text>
          ) : null}
        </>
      ) : null}
    </ScrollView>
  );
}

/**
 * Weather & conditions sheet — the Android twin of the web WeatherPanel. A
 * tappable hour strip over the proxied met.no forecast with sunrise/sunset,
 * plain weather first, and an optional transparent fishing/hunting conditions
 * layer (score + why + best windows). All scoring is the shared @atlas/conditions
 * engine, so the two platforms read identically. JS-only (no native slider) —
 * OTA-friendly, like the Layers sheet.
 */
export function WeatherSheet({
  origin,
  visible,
  onClose,
  target,
  weather,
  maps,
  data,
  bottomInset = 0,
}: {
  origin: string;
  visible: boolean;
  onClose: () => void;
  target: LatLng | null;
  weather: WeatherState;
  maps: WeatherMapsController;
  data: UserData;
  bottomInset?: number;
}) {
  const [mode, setMode] = useState<Mode>('weather');
  const [species, setSpecies] = useState<string>('trout');
  const [selected, setSelected] = useState(0);
  const terrain = useTerrainSlope(origin, target, visible && mode === 'hunting');
  const { status: settingsStatus, getSetting, setSetting } = data;

  // Restore persisted mode/species once storage is ready.
  useEffect(() => {
    if (settingsStatus !== 'ready') return;
    void getSetting(MODE_SETTING).then((raw) => {
      if (raw === 'weather' || raw === 'maps' || raw === 'fishing' || raw === 'hunting')
        setMode(raw);
    });
    void getSetting(SPECIES_SETTING).then((raw) => {
      if (raw && (SPECIES as readonly string[]).includes(raw)) setSpecies(raw);
    });
  }, [settingsStatus, getSetting]);

  const pickMode = (m: Mode): void => {
    setMode(m);
    setSetting(MODE_SETTING, m);
  };
  const pickSpecies = (s: string): void => {
    setSpecies(s);
    setSetting(SPECIES_SETTING, s);
  };

  useEffect(() => {
    maps.setVisible(visible && mode === 'maps');
    return () => maps.setVisible(false);
  }, [visible, mode, maps.setVisible]);

  const rows = useMemo(
    () =>
      weather.forecast
        ? buildPlanner(weather.forecast, {
            kind: mode === 'fishing' || mode === 'hunting' ? mode : null,
            species,
            slopeDeg: mode === 'hunting' ? terrain.fit?.slopeDeg : undefined,
            aspectDeg: mode === 'hunting' ? terrain.fit?.aspectDeg : undefined,
          })
        : [],
    [weather.forecast, mode, species, terrain.fit],
  );
  const windows = useMemo(
    () => (mode === 'fishing' || mode === 'hunting' ? bestWindows(rows) : []),
    [rows, mode],
  );

  const idx = Math.min(selected, Math.max(0, rows.length - 1));
  const row = rows[idx];
  const sun = useMemo(
    () => (row && target ? sunDay(new Date(row.timeMs), target.lat, target.lng) : null),
    [row, target],
  );

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      initialSnap="half"
      bottomInset={bottomInset}
      testID="weather-sheet"
    >
      <View style={styles.headerRow}>
        <Text style={styles.heading}>Weather</Text>
        {target ? (
          <Text style={styles.coords}>
            {target.lat.toFixed(3)}, {target.lng.toFixed(3)}
          </Text>
        ) : null}
        <Pressable onPress={onClose} hitSlop={10} testID="weather-close">
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>

      <View style={styles.modes}>
        {MODES.map((m) => (
          <Pressable
            key={m.id}
            style={[styles.mode, mode === m.id ? styles.modeActive : null]}
            onPress={() => pickMode(m.id)}
            testID={`weather-mode-${m.id}`}
          >
            <Text style={[styles.modeLabel, mode === m.id ? styles.modeLabelActive : null]}>
              {m.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {mode === 'fishing' ? (
        <View style={styles.speciesRow}>
          {SPECIES.map((s) => (
            <Pressable
              key={s}
              style={[styles.chip, species === s ? styles.chipActive : null]}
              onPress={() => pickSpecies(s)}
            >
              <Text style={[styles.chipText, species === s ? styles.chipTextActive : null]}>
                {s}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {mode === 'maps' ? <WeatherMapControls maps={maps} /> : null}

      {mode !== 'maps' && weather.status === 'error' ? (
        <Text style={styles.muted}>Forecast unavailable right now — try again in a bit.</Text>
      ) : null}
      {mode !== 'maps' && weather.status === 'loading' && rows.length === 0 ? (
        <Text style={styles.muted}>Loading forecast…</Text>
      ) : null}

      {mode !== 'maps' && row ? (
        <ScrollView style={styles.scroll}>
          <View style={styles.timeRow}>
            <Text style={styles.stepLabel}>{fmtStep(row.timeMs)}</Text>
            {sun ? (
              <Text style={styles.sun}>
                {sun.sunrise && sun.sunset
                  ? `☀ ${fmtTime(sun.sunrise.getTime())}–${fmtTime(sun.sunset.getTime())}`
                  : sun.noonAltitude > 0
                    ? '☀ midnight sun'
                    : '☀ polar night'}
              </Text>
            ) : null}
          </View>

          {/* Tappable hour strip — the scrubber. Coloured by rating when scoring. */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.strip}
            contentContainerStyle={styles.stripContent}
          >
            {rows.map((r, i) => {
              const color =
                mode === 'weather'
                  ? '#d7dae0'
                  : (RATING_COLOR[r.assessment?.rating ?? ''] ?? '#d7dae0');
              return (
                <Pressable
                  key={r.point.time}
                  onPress={() => setSelected(i)}
                  style={[
                    styles.tick,
                    { backgroundColor: color },
                    i === idx ? styles.tickSelected : null,
                  ]}
                />
              );
            })}
          </ScrollView>

          <View style={styles.stepButtons}>
            <Pressable
              style={styles.stepButton}
              onPress={() => setSelected(Math.max(0, idx - 1))}
              disabled={idx <= 0}
            >
              <Text style={styles.stepButtonText}>◀ Earlier</Text>
            </Pressable>
            <Pressable
              style={styles.stepButton}
              onPress={() => setSelected(Math.min(rows.length - 1, idx + 1))}
              disabled={idx >= rows.length - 1}
            >
              <Text style={styles.stepButtonText}>Later ▶</Text>
            </Pressable>
          </View>

          <WeatherFacts row={row} />

          {mode !== 'weather' && row.assessment ? (
            <View style={styles.assessment}>
              <View style={styles.scoreRow}>
                <View
                  style={[
                    styles.scoreBox,
                    { backgroundColor: RATING_COLOR[row.assessment.rating] ?? '#888' },
                  ]}
                >
                  <Text style={styles.scoreText}>{row.assessment.score}</Text>
                </View>
                <Text style={styles.summary}>{row.assessment.summary}</Text>
              </View>

              {windows.length > 0 ? (
                <View style={styles.windowsRow}>
                  <Text style={styles.muted}>Best windows:</Text>
                  {windows.map((w) => (
                    <Pressable
                      key={w.startIdx}
                      style={styles.windowChip}
                      onPress={() => setSelected(w.peakIdx)}
                    >
                      <Text style={styles.windowChipText}>
                        {fmtStep(rows[w.startIdx]!.timeMs)}–
                        {fmtTime(rows[w.endIdx]!.timeMs + 3600_000)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}

              {row.assessment.factors.map((f) => (
                <View key={f.key} style={styles.factor}>
                  <View style={[styles.factorDot, { backgroundColor: FACTOR_COLOR[f.rating] }]} />
                  <View style={styles.factorBody}>
                    <Text style={styles.factorLabel}>{f.label}</Text>
                    <Text style={styles.factorDetail}>{f.detail}</Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          <WeatherTable rows={rows} selected={idx} onSelect={setSelected} />

          {weather.forecast ? (
            <Text
              style={styles.attribution}
              onPress={() => void Linking.openURL('https://www.met.no/en')}
            >
              Forecast: MET Norway (met.no), updated{' '}
              {fmtTime(new Date(weather.forecast.updatedAt).getTime())}
            </Text>
          ) : null}
        </ScrollView>
      ) : null}
    </BottomSheet>
  );
}

/** One block of forecast facts for the selected step (mirrors the web WeatherFacts). */
function WeatherFacts({ row }: { row: PlannerHour }): React.JSX.Element {
  const p = row.point;
  const gust = p.windGust != null ? ` (${Math.round(p.windGust)})` : '';
  const precipAmount =
    p.precipMin != null && p.precipMax != null && Math.abs(p.precipMax - p.precipMin) >= 0.1
      ? `${p.precipMin.toFixed(1)}–${p.precipMax.toFixed(1)} mm`
      : p.precip != null
        ? `${p.precip.toFixed(1)} mm`
        : null;
  const precip =
    p.precip != null && p.precip > 0
      ? `${precipAmount}${p.precipProb != null ? ` · ${Math.round(p.precipProb)}%` : ''}`
      : 'dry';
  const trend =
    row.pressureTrendHpa != null
      ? ` ${row.pressureTrendHpa > 0 ? '↗' : row.pressureTrendHpa < 0 ? '↘' : '→'}`
      : '';
  return (
    <View style={styles.facts}>
      <View style={styles.headline}>
        <Text style={styles.emoji}>{symbolEmoji(p.symbol)}</Text>
        <Text style={styles.temp}>{Math.round(p.temp)}°</Text>
        <Text style={styles.wind}>
          {Math.round(p.windSpeed)}
          {gust} m/s from {compass16(p.windFromDir)}
        </Text>
      </View>
      <View style={styles.detailsRow}>
        <Text style={styles.detailItem}>☁ {Math.round(p.cloud)}%</Text>
        <Text style={styles.detailItem}>Humidity {Math.round(p.humidity)}%</Text>
        <Text style={styles.detailItem}>🌧 {precip}</Text>
        {p.apparentTemp != null && Math.abs(p.apparentTemp - p.temp) >= 1 ? (
          <Text style={styles.detailItem}>Feels {Math.round(p.apparentTemp)}°</Text>
        ) : null}
        {p.dewPoint != null ? (
          <Text style={styles.detailItem}>Dew {Math.round(p.dewPoint)}°</Text>
        ) : null}
        {p.uvIndex != null && p.uvIndex >= 1 ? (
          <Text style={styles.detailItem}>UV {p.uvIndex.toFixed(1)}</Text>
        ) : null}
        {p.thunderProb != null && p.thunderProb >= 10 ? (
          <Text style={styles.detailItem}>⚡ {Math.round(p.thunderProb)}%</Text>
        ) : null}
        {p.fog != null && p.fog >= 10 ? (
          <Text style={styles.detailItem}>Fog {Math.round(p.fog)}%</Text>
        ) : null}
        {p.pressure != null ? (
          <Text style={styles.detailItem}>
            {Math.round(p.pressure)} hPa{trend}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Precipitation cell text — millimetres when wet, an em-dash when dry/unknown. */
function precipText(mm: number | null): string {
  return mm != null && mm > 0 ? `${mm.toFixed(mm < 1 ? 1 : 0)}` : '–';
}

/** The wind cell: arrow (blowing direction) + sustained speed, gust muted. */
function WindCell({
  fromDir,
  speed,
  gust,
}: {
  fromDir: number;
  speed: number;
  gust: number | null;
}): React.JSX.Element {
  return (
    <View style={styles.wxWind}>
      <Text style={styles.wxArrow}>{windArrow(fromDir)}</Text>
      <Text style={styles.wxWindSpeed}>{Math.round(speed)}</Text>
      {gust != null ? <Text style={styles.wxGust}>({Math.round(gust)})</Text> : null}
    </View>
  );
}

/** One period row plus, when expanded, its hourly breakdown (Android twin). */
function PeriodRow({
  cell,
  expanded,
  selectedMs,
  onToggle,
  onPickHour,
}: {
  cell: ForecastPeriodCell;
  expanded: boolean;
  selectedMs: number;
  onToggle: () => void;
  onPickHour: (row: PlannerHour) => void;
}): React.JSX.Element {
  const first = cell.hours[0]!.timeMs;
  const last = cell.hours[cell.hours.length - 1]!.timeMs;
  const active = selectedMs >= first && selectedMs <= last;
  const tempSpan = Math.round(cell.tempMin) !== Math.round(cell.tempMax);
  return (
    <>
      <Pressable style={[styles.wxRow, active ? styles.wxRowActive : null]} onPress={onToggle}>
        <View style={styles.wxWhen}>
          <Text style={styles.wxPeriodName}>{cell.label}</Text>
          <Text style={styles.wxHours}>{cell.hoursLabel}</Text>
        </View>
        <Text style={styles.wxSym}>{symbolEmoji(cell.symbol)}</Text>
        <Text style={styles.wxTemp}>
          {Math.round(cell.tempMax)}°
          {tempSpan ? <Text style={styles.wxTempLo}> {Math.round(cell.tempMin)}°</Text> : null}
        </Text>
        <Text style={[styles.wxPrecip, cell.precipMm && cell.precipMm > 0 ? styles.wxWet : null]}>
          {precipText(cell.precipMm)}
        </Text>
        <WindCell fromDir={cell.windFromDir} speed={cell.windMax} gust={cell.gustMax} />
        <Text style={styles.wxChevron}>{expanded ? '⌄' : '›'}</Text>
      </Pressable>
      {expanded
        ? cell.hours.map((h) => {
            const p = h.point;
            return (
              <Pressable
                key={p.time}
                style={[styles.wxRow, h.timeMs === selectedMs ? styles.wxRowActive : null]}
                onPress={() => onPickHour(h)}
              >
                <Text style={[styles.wxWhen, styles.wxHourTime]}>{fmtTime(h.timeMs)}</Text>
                <Text style={styles.wxSym}>{symbolEmoji(p.symbol)}</Text>
                <Text style={styles.wxTemp}>{Math.round(p.temp)}°</Text>
                <Text style={[styles.wxPrecip, p.precip && p.precip > 0 ? styles.wxWet : null]}>
                  {precipText(p.precip)}
                </Text>
                <WindCell fromDir={p.windFromDir} speed={p.windSpeed} gust={p.windGust} />
                <Text style={styles.wxChevron} />
              </Pressable>
            );
          })
        : null}
    </>
  );
}

/**
 * The browsable forecast: a yr.no-style table where a whole day reads at a
 * glance — a row per Night/Morning/Afternoon/Evening with symbol, temperature,
 * precipitation and wind, expandable to the hours behind it. Selecting any row
 * drives the same hour selection the scrubber/conditions layer follows.
 */
function WeatherTable({
  rows,
  selected,
  onSelect,
}: {
  rows: PlannerHour[];
  selected: number;
  onSelect: (idx: number) => void;
}): React.JSX.Element {
  const days = useMemo(() => forecastTable(rows), [rows]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const selectedMs = rows[selected]?.timeMs ?? -1;
  const pickHour = (row: PlannerHour): void => {
    const i = rows.indexOf(row);
    if (i >= 0) onSelect(i);
  };
  return (
    <View style={styles.wxTable}>
      {days.map((day) => (
        <View key={day.dateMs} style={styles.wxDay}>
          <Text style={styles.wxDayLabel}>{fmtDayLabel(day.dateMs)}</Text>
          {day.periods.map((cell) => {
            const key = `${day.dateMs}-${cell.period}`;
            return (
              <PeriodRow
                key={key}
                cell={cell}
                expanded={expanded.has(key)}
                selectedMs={selectedMs}
                onToggle={() => {
                  onSelect(cell.selectIndex);
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  });
                }}
                onPickHour={pickHour}
              />
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  heading: { fontSize: 15, fontWeight: '700', color: theme.text },
  coords: { flex: 1, fontSize: 12, color: theme.textMuted, fontVariant: ['tabular-nums'] },
  close: { fontSize: 18, color: theme.textMuted, paddingHorizontal: 4 },

  modes: { flexDirection: 'row', gap: 6, marginTop: 12 },
  mode: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: theme.surfaceMuted,
  },
  modeActive: { backgroundColor: theme.accent },
  modeLabel: { fontSize: 13, color: theme.text, fontWeight: '600' },
  modeLabelActive: { color: theme.onAccent },

  speciesRow: { flexDirection: 'row', gap: 6, marginTop: 8 },
  chip: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: theme.surfaceMuted,
  },
  chipActive: { backgroundColor: theme.surfaceActive },
  chipText: { fontSize: 12, color: theme.text, textTransform: 'capitalize' },
  chipTextActive: { color: theme.accent, fontWeight: '700' },

  muted: { fontSize: 13, color: theme.textMuted, marginTop: 8 },

  timeRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: 12,
    gap: 8,
  },
  stepLabel: { fontSize: 14, fontWeight: '700', color: theme.text },
  sun: { fontSize: 12, color: theme.textMuted },

  strip: { marginTop: 10, maxHeight: 24 },
  stripContent: { gap: 2, alignItems: 'center' },
  tick: { width: 6, height: 20, borderRadius: 2 },
  tickSelected: { borderWidth: 2, borderColor: theme.text },

  stepButtons: { flexDirection: 'row', gap: 8, marginTop: 10 },
  stepButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: theme.surfaceMuted,
  },
  stepButtonText: { fontSize: 13, color: theme.text, fontWeight: '600' },

  facts: {
    marginTop: 14,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: theme.border,
    gap: 6,
  },
  headline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  emoji: { fontSize: 22 },
  temp: { fontSize: 20, fontWeight: '800', color: theme.text },
  wind: { fontSize: 13, color: theme.text, flexShrink: 1 },
  detailsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  detailItem: { fontSize: 13, color: theme.textMuted, fontVariant: ['tabular-nums'] },

  mapScroll: { marginTop: 10 },
  mapLayerRow: { gap: 7, paddingVertical: 2 },
  mapLayerChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: theme.surfaceMuted,
    borderWidth: 1,
    borderColor: theme.border,
  },
  mapLayerActive: { backgroundColor: theme.surfaceActive, borderColor: theme.accent },
  mapLayerDisabled: { opacity: 0.42 },
  mapLayerText: { fontSize: 12, color: theme.text },
  mapLayerTextActive: { color: theme.accent, fontWeight: '700' },
  mapTimeRow: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  mapTime: { fontSize: 16, fontWeight: '700', color: theme.text },
  mapKind: { marginTop: 1, fontSize: 12, color: theme.textMuted },
  playButton: {
    minWidth: 72,
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: theme.accent,
  },
  playText: { color: theme.onAccent, fontSize: 13, fontWeight: '700' },
  mapTimeline: { marginTop: 14, maxHeight: 28 },
  mapTimelineContent: { alignItems: 'center', gap: 2, paddingHorizontal: 2 },
  mapTick: { width: 7, height: 22, borderRadius: 3 },
  mapTickObserved: { backgroundColor: '#4aa8ed' },
  mapTickNowcast: { backgroundColor: '#7b57ed' },
  mapTickForecast: { backgroundColor: '#b4bec8' },
  mapTickSelected: { borderWidth: 2, borderColor: theme.text },
  mapDescription: { marginTop: 10, fontSize: 12, color: theme.textMuted, textAlign: 'center' },
  legendBox: {
    marginTop: 12,
    padding: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceMuted,
  },
  legendHeading: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  legendTitle: { fontSize: 12, fontWeight: '700', color: theme.text },
  legendGradient: { flexDirection: 'row', height: 14, borderRadius: 5, overflow: 'hidden' },
  legendColor: { flex: 1 },
  legendLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  legendLabel: { fontSize: 9, color: theme.textMuted, fontVariant: ['tabular-nums'] },
  lightningNote: { marginTop: 8, fontSize: 11, lineHeight: 15, color: theme.textMuted },

  assessment: { marginTop: 14, gap: 12 },
  scoreRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  scoreBox: {
    width: 46,
    height: 46,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreText: { color: theme.onAccent, fontWeight: '800', fontSize: 18 },
  summary: { flex: 1, fontSize: 13, lineHeight: 18, color: theme.text },

  windowsRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  windowChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#f1f7e6',
    borderWidth: 1,
    borderColor: '#cbdca9',
  },
  windowChipText: { fontSize: 12, color: '#3c5220' },

  factor: { flexDirection: 'row', gap: 10 },
  factorDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  factorBody: { flex: 1 },
  factorLabel: { fontSize: 13, fontWeight: '700', color: theme.text },
  factorDetail: { fontSize: 13, lineHeight: 18, color: theme.textMuted, marginTop: 1 },

  attribution: { fontSize: 11, color: theme.textMuted, marginTop: 14 },

  // Browsable forecast table (yr.no-style day/period reading surface).
  wxTable: { marginTop: 14, gap: 10 },
  wxDay: { gap: 1 },
  wxDayLabel: { fontSize: 13, fontWeight: '700', color: theme.text, marginBottom: 3 },
  wxRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5,
    paddingHorizontal: 4,
    borderRadius: 8,
  },
  wxRowActive: { backgroundColor: theme.surfaceActive },
  wxWhen: { flex: 1, flexDirection: 'row', alignItems: 'baseline', gap: 6 },
  wxHourTime: { paddingLeft: 10, fontSize: 12, color: theme.textMuted },
  wxPeriodName: { fontSize: 13, fontWeight: '600', color: theme.text },
  wxHours: { fontSize: 10, color: theme.textMuted, fontVariant: ['tabular-nums'] },
  wxSym: { width: 22, textAlign: 'center', fontSize: 15 },
  wxTemp: {
    width: 52,
    textAlign: 'right',
    fontSize: 13,
    fontWeight: '600',
    color: theme.text,
    fontVariant: ['tabular-nums'],
  },
  wxTempLo: { fontSize: 10, fontWeight: '400', color: theme.textMuted },
  wxPrecip: {
    width: 30,
    textAlign: 'right',
    fontSize: 12,
    color: theme.textMuted,
    fontVariant: ['tabular-nums'],
  },
  wxWet: { color: theme.accent, fontWeight: '700' },
  wxWind: {
    width: 58,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'flex-end',
    gap: 2,
  },
  wxArrow: { fontSize: 13, color: theme.accent },
  wxWindSpeed: { fontSize: 12, color: theme.text, fontVariant: ['tabular-nums'] },
  wxGust: { fontSize: 10, color: theme.textMuted, fontVariant: ['tabular-nums'] },
  wxChevron: { width: 12, textAlign: 'center', fontSize: 11, color: theme.textMuted },
});
