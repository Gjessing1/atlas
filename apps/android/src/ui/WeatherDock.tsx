import type { SkyLayersController, WeatherMapsController } from '@atlas/app-hooks';
import {
  legendRowSwatches,
  lightningLegendBands,
  timelineDayMarks,
  weatherFrameCaption,
  weatherFrameLabel,
  type WeatherLegendRow,
} from '@atlas/conditions';
import { POI_CATEGORIES, type PoiCategoryId } from '@atlas/core';
import { useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import { useSideInsets } from './insets';
import { theme } from './theme';

/** Segments a legend bar is drawn with: enough to read as a gradient. */
const SWATCHES = 36;
let rememberedLegendOpen = true;

function LegendRow({ row }: { row: WeatherLegendRow }) {
  return (
    <View style={styles.legendRow}>
      {row.label ? <Text style={styles.legendRowLabel}>{row.label}</Text> : null}
      <View style={styles.legendScale}>
        <View style={styles.legendBar}>
          {legendRowSwatches(row, SWATCHES).map((color, index) => (
            <View key={index} style={[styles.legendSwatch, { backgroundColor: color }]} />
          ))}
        </View>
        {row.ticks.length > 0 ? (
          <View style={styles.legendTicks}>
            {row.ticks.map((tick) => (
              <Text
                key={tick.label}
                style={[styles.legendTick, { left: `${tick.at * 100}%` }]}
                numberOfLines={1}
              >
                {tick.label}
              </Text>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function PlayGlyph({ playing }: { playing: boolean }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24">
      {playing ? (
        <>
          <Rect x={6.5} y={5.5} width={4} height={13} rx={1} fill="#fff" />
          <Rect x={13.5} y={5.5} width={4} height={13} rx={1} fill="#fff" />
        </>
      ) : (
        <Path d="M8 5.5v13l10.5-6.5L8 5.5z" fill="#fff" />
      )}
    </Svg>
  );
}

/**
 * The weather layer's scale and timeline, along the bottom of the map while a
 * weather field is on — the web WeatherDock's twin. Which field and how opaque
 * stay in the layer controls, like any overlay.
 *
 * The track is a plain touch strip rather than a native slider (OTA-safe, and a
 * finger dragged along it scrubs frame by frame).
 */
export function WeatherDock({
  maps,
  title,
  bottom,
  onHeight,
  sky,
  lightningOn,
  auroraOn,
  poiOn,
  poiCategories,
  onTogglePoiCategory,
  onShowAllPois,
}: {
  maps: WeatherMapsController;
  title: string;
  /** Already includes the system navigation-bar inset. */
  bottom: number;
  /** The dock's height, so the scale bar and compass can clear it. */
  onHeight: (height: number) => void;
  sky: SkyLayersController;
  lightningOn: boolean;
  auroraOn: boolean;
  poiOn: boolean;
  poiCategories: readonly PoiCategoryId[];
  onTogglePoiCategory: (id: PoiCategoryId) => void;
  onShowAllPois: () => void;
}) {
  const side = useSideInsets();
  const [legendOpen, setLegendOpen] = useState(rememberedLegendOpen);
  const [trackWidth, setTrackWidth] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => () => onHeight(0), [onHeight]);

  const { frames, frame, frameIndex, nowIndex, legend } = maps;
  const forecastMs = sky.aurora.forecast
    ? Date.parse(sky.aurora.forecast.forecastTime)
    : Number.NaN;
  const last = Math.max(1, frames.length - 1);
  const seek = (event: GestureResponderEvent) => {
    if (trackWidth <= 0 || frames.length === 0) return;
    const at = Math.max(0, Math.min(1, event.nativeEvent.locationX / trackWidth));
    const index = Math.round(at * last);
    if (index !== frameIndex) maps.selectFrame(index);
  };

  return (
    <View
      style={[styles.wrap, { bottom, left: side.left + 12, right: side.right + 12 }]}
      pointerEvents="box-none"
      onLayout={(event: LayoutChangeEvent) => onHeight(event.nativeEvent.layout.height)}
      testID="weather-dock"
    >
      {poiOn ? (
        <View style={styles.poiControl} accessibilityLabel="POI categories">
          <Text style={styles.poiTitle}>POIs</Text>
          <ScrollView
            horizontal
            style={styles.poiScroller}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.poiScroll}
          >
            <Pressable
              style={[
                styles.switchButton,
                poiCategories.length === 0 ? styles.switchButtonOn : null,
              ]}
              onPress={onShowAllPois}
              accessibilityRole="button"
              accessibilityState={{ selected: poiCategories.length === 0 }}
              testID="poi-category-all"
            >
              <Text
                style={[styles.switchText, poiCategories.length === 0 ? styles.switchTextOn : null]}
              >
                All
              </Text>
            </Pressable>
            {POI_CATEGORIES.map((category) => {
              const on = poiCategories.includes(category.id);
              return (
                <Pressable
                  key={category.id}
                  style={[styles.switchButton, on ? styles.switchButtonOn : null]}
                  onPress={() => onTogglePoiCategory(category.id)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  testID={`poi-category-${category.id}`}
                >
                  <Text style={[styles.switchText, on ? styles.switchTextOn : null]}>
                    {category.label}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
      {legend || maps.layerId ? (
        <View style={styles.mapControl}>
          {legend ? (
            <View
              style={styles.legend}
              accessibilityLabel={`${title} colour scale in ${legend.unit}`}
            >
              <Pressable
                style={styles.legendHead}
                onPress={() => {
                  const next = !legendOpen;
                  rememberedLegendOpen = next;
                  setLegendOpen(next);
                }}
                accessibilityRole="button"
                accessibilityState={{ expanded: legendOpen }}
                testID="weather-legend-toggle"
              >
                <Text style={styles.legendTitle}>{title}</Text>
                <Text style={styles.legendUnit}>
                  {legend.unit} · Legend {legendOpen ? '⌃' : '⌄'}
                </Text>
              </Pressable>
              {legendOpen
                ? legend.rows.map((row, index) => <LegendRow key={row.label ?? index} row={row} />)
                : null}
            </View>
          ) : null}
          {maps.layerId ? (
            <View style={[styles.timeline, legend ? styles.timelineJoined : null]}>
              {!frame ? (
                <Text style={styles.status}>
                  {maps.status === 'error'
                    ? 'Weather maps are unavailable right now.'
                    : `Loading ${title.toLowerCase()}…`}
                </Text>
              ) : (
                <>
                  <Pressable
                    style={styles.play}
                    onPress={maps.togglePlaying}
                    accessibilityLabel={maps.playing ? 'Pause' : 'Play'}
                    testID="weather-play"
                  >
                    <PlayGlyph playing={maps.playing} />
                  </Pressable>
                  <View style={styles.middle}>
                    {maps.timelineIds.length > 1 ? (
                      <View style={styles.switch}>
                        {maps.timelineIds.map((id) => {
                          const on = maps.timeline?.id === id;
                          return (
                            <Pressable
                              key={id}
                              style={[styles.switchButton, on ? styles.switchButtonOn : null]}
                              onPress={() => maps.setTimeline(id)}
                              testID={`weather-timeline-${id}`}
                            >
                              <Text style={[styles.switchText, on ? styles.switchTextOn : null]}>
                                {id === 'radar' ? 'Radar' : 'Forecast'}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                    ) : null}
                    <View
                      style={styles.track}
                      onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}
                      onStartShouldSetResponder={() => true}
                      onMoveShouldSetResponder={() => true}
                      onResponderGrant={seek}
                      onResponderMove={seek}
                      accessibilityRole="adjustable"
                      accessibilityLabel={`${title} time`}
                      accessibilityValue={{
                        text: weatherFrameLabel(Date.parse(frame.time), nowMs),
                      }}
                      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
                      onAccessibilityAction={(event) =>
                        event.nativeEvent.actionName === 'increment' ? maps.next() : maps.previous()
                      }
                      testID="weather-track"
                    >
                      <View style={styles.rail} pointerEvents="none">
                        <View
                          style={[styles.railFill, { width: `${(frameIndex / last) * 100}%` }]}
                        />
                      </View>
                      {timelineDayMarks(frames, nowMs).map((mark) => (
                        <View
                          key={mark.at}
                          pointerEvents="none"
                          style={[styles.dayMark, { left: `${mark.at * 100}%` }]}
                        />
                      ))}
                      <View
                        pointerEvents="none"
                        style={[styles.nowMark, { left: `${(nowIndex / last) * 100}%` }]}
                      />
                      <View
                        pointerEvents="none"
                        style={[styles.thumb, { left: `${(frameIndex / last) * 100}%` }]}
                      />
                    </View>
                  </View>
                  <Pressable style={styles.time} onPress={maps.goToNow} testID="weather-now">
                    <Text
                      style={[styles.timeLabel, maps.followingNow ? null : styles.timeLabelAway]}
                      numberOfLines={1}
                    >
                      {weatherFrameLabel(Date.parse(frame.time), nowMs)}
                    </Text>
                    <Text style={styles.timeCaption} numberOfLines={1}>
                      {weatherFrameCaption(frame, nowMs)}
                    </Text>
                  </Pressable>
                </>
              )}
            </View>
          ) : null}
        </View>
      ) : null}
      {lightningOn ? (
        <View style={styles.timeline} accessibilityLabel="Lightning time window">
          <Text style={styles.skyTitle}>Lightning</Text>
          <View style={styles.switch}>
            {sky.lightning.windows.map((candidate) => {
              const on = sky.lightning.window === candidate.id;
              return (
                <Pressable
                  key={candidate.id}
                  style={[styles.switchButton, on ? styles.switchButtonOn : null]}
                  onPress={() => sky.lightning.setWindow(candidate.id)}
                  testID={`lightning-window-${candidate.id}`}
                >
                  <Text style={[styles.switchText, on ? styles.switchTextOn : null]}>
                    {candidate.id === '1h' ? 'Last hour' : candidate.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.ageKey} accessibilityLabel="Lightning strike age">
            {lightningLegendBands(sky.lightning.window).map((band, index) => (
              <View key={band.age} style={styles.ageBand}>
                <View
                  style={[
                    styles.ageDot,
                    {
                      backgroundColor: band.color,
                      opacity: Math.max(band.opacity, 0.55),
                      width: Math.max(5, band.radius * 1.6),
                      height: Math.max(5, band.radius * 1.6),
                    },
                  ]}
                />
                <Text style={styles.ageText}>{index === 0 ? `<${band.label}` : band.label}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
      {auroraOn ? (
        <View style={styles.timeline} accessibilityLabel="Aurora forecast time">
          <View style={styles.auroraDot} />
          <View style={styles.skyCopy}>
            <Text style={styles.skyTitle}>Aurora viewing chance</Text>
            <Text style={styles.skyCaption} numberOfLines={1}>
              NOAA intensity · darkness · MET clouds · VIIRS light pollution
            </Text>
          </View>
          <View style={styles.time}>
            <Text style={styles.timeLabel} numberOfLines={1}>
              {Number.isFinite(forecastMs)
                ? weatherFrameLabel(forecastMs, nowMs)
                : sky.aurora.status === 'error'
                  ? 'Unavailable'
                  : 'Loading…'}
            </Text>
            <Text style={styles.timeCaption}>30-minute forecast</Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', gap: 6 },
  poiControl: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 6,
    borderRadius: 24,
    backgroundColor: theme.surface,
    elevation: 4,
  },
  poiTitle: { fontSize: 12, fontWeight: '700', color: theme.text },
  poiScroller: { flex: 1 },
  poiScroll: {
    flexDirection: 'row',
    padding: 2,
    borderRadius: 999,
    backgroundColor: theme.surfaceMuted,
  },
  mapControl: {
    overflow: 'hidden',
    borderRadius: 14,
    backgroundColor: theme.surface,
    elevation: 4,
  },
  legend: {
    alignSelf: 'stretch',
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 2,
  },
  legendHead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 },
  legendTitle: { fontSize: 12, fontWeight: '700', color: theme.text },
  legendUnit: { fontSize: 11, color: theme.textMuted, opacity: 0.7 },
  legendRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 },
  legendRowLabel: { width: 30, fontSize: 9, color: theme.textMuted, opacity: 0.7 },
  legendScale: { flex: 1 },
  legendBar: { flexDirection: 'row', height: 8, borderRadius: 4, overflow: 'hidden' },
  legendSwatch: { flex: 1 },
  legendTicks: { height: 14 },
  legendTick: {
    position: 'absolute',
    top: 1,
    width: 32,
    marginLeft: -16,
    textAlign: 'center',
    fontSize: 9,
    color: theme.textMuted,
    opacity: 0.75,
  },
  timeline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 52,
    paddingLeft: 6,
    paddingRight: 10,
    paddingVertical: 6,
    borderRadius: 26,
    backgroundColor: theme.surface,
    elevation: 4,
  },
  timelineJoined: {
    borderTopWidth: 1,
    borderTopColor: theme.border,
    borderRadius: 0,
    elevation: 0,
  },
  status: { flex: 1, paddingHorizontal: 10, fontSize: 13, color: theme.textMuted },
  skyTitle: { fontSize: 12, fontWeight: '700', color: theme.text },
  skyCopy: { flex: 1, minWidth: 0 },
  skyCaption: { fontSize: 9, color: theme.textMuted, opacity: 0.72 },
  ageKey: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 3 },
  ageBand: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  ageDot: { borderRadius: 5, borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.8)' },
  ageText: { fontSize: 8, color: theme.textMuted, opacity: 0.75 },
  auroraDot: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#54e879',
    opacity: 0.82,
  },
  play: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: theme.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  middle: { flex: 1, gap: 4 },
  switch: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    padding: 2,
    borderRadius: 999,
    backgroundColor: theme.surfaceMuted,
  },
  switchButton: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
  switchButtonOn: { backgroundColor: theme.surface, elevation: 1 },
  switchText: { fontSize: 11, color: theme.textMuted, opacity: 0.75 },
  switchTextOn: { color: theme.text, opacity: 1, fontWeight: '700' },
  // A tall touch strip around a thin rail, so a thumb finds it.
  track: { height: 26, justifyContent: 'center' },
  rail: { height: 4, borderRadius: 2, backgroundColor: theme.surfaceMuted, overflow: 'hidden' },
  railFill: { height: 4, backgroundColor: theme.accent },
  dayMark: {
    position: 'absolute',
    top: 7,
    width: 1,
    height: 12,
    backgroundColor: theme.border,
    opacity: 0.3,
  },
  nowMark: {
    position: 'absolute',
    top: 3,
    width: 2,
    height: 20,
    marginLeft: -1,
    backgroundColor: theme.text,
  },
  thumb: {
    position: 'absolute',
    width: 16,
    height: 16,
    marginLeft: -8,
    borderRadius: 8,
    backgroundColor: theme.accent,
    borderWidth: 2,
    borderColor: '#fff',
    elevation: 2,
  },
  time: { alignItems: 'flex-end', maxWidth: 118 },
  timeLabel: { fontSize: 13, fontWeight: '700', color: theme.text },
  timeLabelAway: { color: theme.accent },
  timeCaption: { fontSize: 10, color: theme.textMuted, opacity: 0.7 },
});
