import type { PotentialExplainResponse } from '@atlas/potential';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { theme } from './theme';

/** Same three ratings the weather card colours its factor dots with. */
const DOT: Record<string, string> = {
  good: '#2e9e5b',
  fair: '#f0b429',
  poor: '#d05a5a',
};

/**
 * Why this point scores what it does, inside the destination card — the Android
 * twin of the web's PotentialExplain, and bound by the same three rules:
 *
 * - the headline is a **rank within the area on screen**, never a fake absolute;
 * - with no standout from the contrast gate, no rank is quoted at all;
 * - missing inputs are named as *unknown*, never folded into the score.
 */
export function PotentialExplainCard({
  data,
  targetLabel,
}: {
  data: PotentialExplainResponse;
  targetLabel?: string;
}) {
  const [showSources, setShowSources] = useState(false);
  const rank = Number.isFinite(data.score) ? Math.round(data.score) : null;
  const headline =
    data.standout && rank !== null && rank >= 60
      ? `${data.bandLabel} · top ${Math.max(1, 100 - rank)} % here`
      : data.bandLabel;

  return (
    <View style={styles.card} testID="potential-explain">
      <View style={styles.head}>
        <Text style={styles.headline}>{headline}</Text>
        <Text style={styles.target}>{targetLabel ?? data.target}</Text>
      </View>
      <Text style={styles.summary}>{data.standout ? data.summary : data.contrast}</Text>
      {data.factors.map((factor) => (
        <View key={factor.key} style={styles.factor}>
          <View style={[styles.dot, { backgroundColor: DOT[factor.rating] ?? theme.textMuted }]} />
          <View style={styles.factorText}>
            <Text style={styles.factorLabel}>
              {factor.label} · {Math.round(factor.weight * 100)} %
            </Text>
            <Text style={styles.factorDetail}>{factor.detail}</Text>
          </View>
        </View>
      ))}
      {data.missing.length > 0 ? (
        <Text style={styles.note}>
          No {data.missing.map((m) => m.toLowerCase()).join(', ')} data here — unknown, not poor.
        </Text>
      ) : null}
      {data.notes.map((note) => (
        <Text key={note} style={styles.note}>
          {note}
        </Text>
      ))}
      <Pressable onPress={() => setShowSources((open) => !open)} hitSlop={6}>
        <Text style={styles.sources}>Built from {data.inputs.length} sources</Text>
      </Pressable>
      {showSources
        ? data.inputs.map((input) => (
            <View key={input.id} style={styles.inputRow}>
              <Text style={[styles.note, !input.ok && styles.inputFailed]}>{input.label}</Text>
              <Text style={styles.note} numberOfLines={1}>
                {input.ok ? input.detail : 'did not answer'}
              </Text>
            </View>
          ))
        : null}
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
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  headline: { flexShrink: 1, color: theme.text, fontSize: 14, fontWeight: '800' },
  target: { color: theme.textMuted, fontSize: 11 },
  summary: { color: theme.text, fontSize: 12, lineHeight: 17 },
  factor: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  dot: { width: 9, height: 9, borderRadius: 5, marginTop: 4 },
  factorText: { flex: 1 },
  factorLabel: { color: theme.text, fontSize: 12, fontWeight: '600' },
  factorDetail: { color: theme.textMuted, fontSize: 12, lineHeight: 16 },
  note: { color: theme.textMuted, fontSize: 11, lineHeight: 15 },
  inputRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  inputFailed: { color: theme.warning },
  sources: { color: theme.accent, fontSize: 11, fontWeight: '700' },
});
