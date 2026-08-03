import { standCardModel, standRose, type PlaceStand } from '@atlas/core';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Text as SvgText } from 'react-native-svg';

import { theme } from './theme';

/** Rendered at 100×100 user units and scaled by the view box, as the web card is. */
const ROSE_PX = 84;

/**
 * The rose, drawn — the Android twin of the web card's, from the same
 * `standRose` geometry so the two clients cannot draw different figures for one
 * saved plan.
 *
 * Colours are CSS strings rather than `theme` tokens on purpose: react-native-svg
 * takes CSS colour props, and a PlatformColor handed to `stroke` resolves to a
 * transparent resource id — a rose that silently disappears in one theme.
 */
function Rose({ stand }: { stand: PlaceStand }) {
  const rose = standRose(stand);
  return (
    <Svg width={ROSE_PX} height={ROSE_PX} viewBox="0 0 100 100">
      <Circle cx={50} cy={50} r={44} fill="none" stroke={theme.icon} strokeOpacity={0.35} />
      <Circle cx={50} cy={50} r={22} fill="none" stroke={theme.icon} strokeOpacity={0.35} />
      {rose.spokes.map((spoke) => (
        <Line
          key={spoke.key}
          x1={50}
          y1={50}
          x2={spoke.x * 100}
          y2={spoke.y * 100}
          stroke={theme.icon}
          strokeWidth={3}
          strokeLinecap="round"
        />
      ))}
      <Line
        x1={50}
        y1={50}
        x2={rose.aim.x * 100}
        y2={rose.aim.y * 100}
        stroke="#f59e0b"
        strokeWidth={3.5}
        strokeLinecap="round"
        strokeDasharray="6,4"
      />
      <Circle cx={50} cy={50} r={3.5} fill={theme.icon} />
      <SvgText x={50} y={9} fill={theme.icon} fontSize={11} textAnchor="middle">
        N
      </SvgText>
    </Svg>
  );
}

/** Tinted verdict strips; explicit text colours, since `theme.text` is a foreground. */
const APPROACH_STYLE: Record<string, { backgroundColor: string; color: string }> = {
  clear: { backgroundColor: 'rgba(46,158,91,0.18)', color: '#2e9e5b' },
  caution: { backgroundColor: 'rgba(208,138,40,0.18)', color: theme.warning },
  high: { backgroundColor: 'rgba(216,79,85,0.18)', color: theme.danger },
};

/**
 * What this pin was saved *as* — the plan the Fish & Hunt shortlist made
 * (ROADMAP § E12), on the card rather than buried in the editor's notes field.
 *
 * A record of a decision, not a live reading, so it dates itself: the surface is
 * re-derived and the approach verdict was true of one route on one day. The
 * card's live facts sit above in their own rows and are not mixed in.
 */
export function StandBlock({ stand }: { stand: PlaceStand }) {
  const model = standCardModel(stand);
  const approachStyle = model.approachRisk ? APPROACH_STYLE[model.approachRisk] : undefined;
  return (
    <View style={styles.card} testID="destination-stand">
      <View style={styles.head}>
        <Text style={styles.title}>{model.title}</Text>
        {model.savedNote ? <Text style={styles.saved}>{model.savedNote}</Text> : null}
      </View>
      <View style={styles.body}>
        <Rose stand={stand} />
        <View style={styles.rows}>
          {model.rows.map((row) => (
            <View key={row.key} style={styles.row}>
              <Text style={styles.rowLabel}>{row.label}</Text>
              <Text style={styles.rowValue}>{row.value}</Text>
            </View>
          ))}
        </View>
      </View>
      {model.approachNote && approachStyle ? (
        <Text
          style={[
            styles.approach,
            { backgroundColor: approachStyle.backgroundColor, color: approachStyle.color },
          ]}
        >
          {model.approachNote}
        </Text>
      ) : null}
      <Text style={styles.warning}>{model.warning}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
    backgroundColor: theme.surfaceMuted,
    gap: 6,
  },
  head: { gap: 1 },
  title: { color: theme.text, fontSize: 14, fontWeight: '800' },
  saved: { color: theme.textMuted, fontSize: 11 },
  body: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  rows: { flex: 1, gap: 4 },
  row: { flexDirection: 'row', gap: 6 },
  rowLabel: { width: 62, color: theme.textMuted, fontSize: 12 },
  rowValue: { flex: 1, color: theme.text, fontSize: 12, lineHeight: 16 },
  approach: {
    fontSize: 11,
    lineHeight: 15,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 6,
  },
  warning: { color: theme.textMuted, fontSize: 11, lineHeight: 15 },
});
