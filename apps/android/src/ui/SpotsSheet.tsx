import {
  spotWalkLabel,
  spotWindowLabel,
  standWindRisk,
  type BestSpotsState,
} from '@atlas/app-hooks';
import { fmtClock } from '@atlas/core';
import { spotApproachLabel, spotColor, spotPlaceDraft, type PotentialSpot } from '@atlas/potential';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BottomSheet } from './BottomSheet';
import { theme } from './theme';

/**
 * The affordance that opens the shortlist, under the preparation pill.
 *
 * Deliberately not automatic: the list is a real request against the derive
 * service and the router, and a sheet that opened by itself over every prepared
 * cell would take over a map the user may be reading for something else.
 */
export function SpotsButton({
  top,
  left,
  onPress,
  hunting = false,
}: {
  top: number;
  left: number;
  onPress: () => void;
  hunting?: boolean;
}) {
  return (
    <Pressable style={[styles.button, { top, left }]} onPress={onPress} testID="spots-button">
      <Text style={styles.buttonText}>
        {hunting ? 'Plan stands in view' : 'Best spots in view'}
      </Text>
    </Pressable>
  );
}

/**
 * "Best spots in view" on Android — the twin of the web's SpotsPanel, and bound
 * by the same rules (ROADMAP § N5 → E6).
 *
 * Each row answers the three things the heatmap cannot: *why here* (the
 * surface's own strongest factor), *when* (today's conditions window — the
 * other half of D3's structure/conditions split, shown once for the area) and
 * *how far in from the road*, which is what decides whether prime water is
 * tonight's plan.
 *
 * An empty list is a finding and says so in the surface's own words; a list
 * with cells still building says it is provisional rather than presenting
 * itself as the answer.
 */
export function SpotsSheet({
  visible,
  state,
  targetLabel,
  saveEnabled,
  onPick,
  onSave,
  onClose,
  bottomInset,
}: {
  visible: boolean;
  state: BestSpotsState;
  targetLabel?: string;
  saveEnabled: boolean;
  onPick: (spot: PotentialSpot, index: number) => void;
  onSave: (spot: PotentialSpot, index: number) => void;
  onClose: () => void;
  bottomInset: number;
}) {
  const conditions = state.window;
  return (
    <BottomSheet
      visible={visible}
      mode="map"
      onClose={onClose}
      initialSnap="half"
      bottomInset={bottomInset}
      testID="spots-sheet"
    >
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.heading}>
            {state.mode === 'stands' ? 'Calling stands in view' : 'Best spots in view'}
          </Text>
          {targetLabel ? <Text style={styles.muted}>{targetLabel}</Text> : null}
        </View>
        <Pressable onPress={onClose} hitSlop={10} testID="spots-close">
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>

      {conditions ? (
        <View style={styles.window}>
          <Text style={styles.windowTitle}>
            Best window today {spotWindowLabel(conditions, fmtClock)}
          </Text>
          <Text style={styles.muted}>{conditions.summary}</Text>
        </View>
      ) : state.windowNote ? (
        <Text style={styles.note}>{state.windowNote}</Text>
      ) : null}

      {state.pending > 0 ? (
        <Text style={styles.note}>
          Still reading {state.pending} more area{state.pending === 1 ? '' : 's'} — this list may
          still change.
        </Text>
      ) : null}
      {state.status === 'loading' && state.spots.length === 0 ? (
        <Text style={styles.note}>Looking…</Text>
      ) : null}
      {state.status === 'empty' || state.status === 'error' ? (
        <Text style={styles.note}>{state.note ?? 'Nothing to show here.'}</Text>
      ) : null}
      {state.status === 'ready' && state.note ? (
        <Text style={styles.note}>{state.note}</Text>
      ) : null}

      <ScrollView style={styles.list}>
        {state.spots.map((spot, index) => {
          const walk = spotWalkLabel(spot);
          const wind = standWindRisk(spot, conditions);
          const approach = spotApproachLabel(spot);
          const approachRisk = spot.access?.approach?.risk;
          return (
            <View
              style={[
                styles.row,
                wind === 'blown' && styles.rowBlown,
                approachRisk === 'high' && styles.rowApproachHigh,
              ]}
              key={spot.id}
            >
              <Pressable
                style={styles.rowMain}
                onPress={() => onPick(spot, index)}
                testID={`spot-${index}`}
              >
                <View style={[styles.number, { backgroundColor: spotColor(spot) }]}>
                  <Text style={styles.numberText}>{index + 1}</Text>
                </View>
                <View style={styles.rowText}>
                  <Text style={styles.rowHead} numberOfLines={1}>
                    {spot.bandLabel}
                    {walk ? <Text style={styles.walk}> · {walk}</Text> : null}
                  </Text>
                  <Text style={styles.reason} numberOfLines={2}>
                    {spot.reason}
                  </Text>
                  {spot.stand ? (
                    <Text style={styles.reason} numberOfLines={1}>
                      Vantage {spot.stand.vantageM >= 0 ? '+' : ''}
                      {spot.stand.vantageM} m ·{' '}
                      {wind === 'blown'
                        ? 'wind carries scent toward habitat — avoid'
                        : wind === 'good'
                          ? 'wind carries scent away from habitat'
                          : wind === 'crosswind'
                            ? 'crosswind — check locally'
                            : 'verify wind and backstop on site'}
                    </Text>
                  ) : null}
                  {spot.stand && spot.access ? (
                    <Text
                      style={[
                        styles.reason,
                        approachRisk === 'caution' && styles.approachCaution,
                        approachRisk === 'high' && styles.approachHigh,
                      ]}
                      numberOfLines={2}
                    >
                      {approach ??
                        (spot.access.approximate
                          ? 'Direct off-path approach has too little cover data to assess.'
                          : 'Approach cover could not be assessed.')}
                    </Text>
                  ) : null}
                </View>
              </Pressable>
              <Pressable
                onPress={() => onSave(spot, index)}
                disabled={!saveEnabled}
                hitSlop={8}
                accessibilityLabel={`Save ${spotPlaceDraft(spot, index, { targetLabel }).name}`}
                testID={`spot-save-${index}`}
              >
                <Text style={[styles.save, !saveEnabled && styles.saveDisabled]}>★</Text>
              </Pressable>
            </View>
          );
        })}
      </ScrollView>

      {state.spots.length > 0 && !state.accessAvailable ? (
        <Text style={styles.note}>Walk-in times are unavailable right now.</Text>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  button: {
    position: 'absolute',
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: theme.surfaceOverlay,
    elevation: 3,
  },
  buttonText: { color: theme.text, fontSize: 12, fontWeight: '700' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerText: { flex: 1 },
  heading: { color: theme.text, fontSize: 17, fontWeight: '700' },
  muted: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  close: { color: theme.textMuted, fontSize: 18, paddingHorizontal: 4 },
  window: {
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    borderLeftWidth: 3,
    borderLeftColor: theme.accent,
    backgroundColor: theme.surfaceMuted,
  },
  windowTitle: { color: theme.text, fontSize: 13, fontWeight: '700' },
  note: { color: theme.textMuted, fontSize: 12, marginTop: 12 },
  list: { marginTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  rowBlown: { opacity: 0.48 },
  rowApproachHigh: { borderLeftWidth: 3, borderLeftColor: theme.danger, paddingLeft: 4 },
  rowMain: {
    flex: 1,
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
  },
  number: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  numberText: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
  rowText: { flex: 1 },
  rowHead: { color: theme.text, fontSize: 14, fontWeight: '700' },
  walk: { color: theme.textMuted, fontWeight: '400' },
  reason: { color: theme.textMuted, fontSize: 12, marginTop: 2 },
  approachCaution: { color: theme.warning },
  approachHigh: { color: theme.danger, fontWeight: '700' },
  save: { color: theme.accent, fontSize: 18, paddingHorizontal: 8, paddingVertical: 8 },
  saveDisabled: { color: theme.textMuted, opacity: 0.5 },
});
