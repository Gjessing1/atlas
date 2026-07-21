import { ROUTING_PROFILES, type RoutingProfile } from '@atlas/routing';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * What the card can be asked for. Transit is not a `RoutingProfile` — it has no
 * costing and no turn-by-turn — but it *is* a travel mode, so it belongs beside
 * the others rather than hidden behind the route planner.
 */
export type TravelChoice = RoutingProfile | 'transit';

export interface DestinationTarget {
  lat: number;
  lng: number;
  /** Label to show (search result name, place name, or coordinates). */
  name: string;
  /** Secondary line, e.g. a tapped POI's category ("cafe · restaurant"). */
  detail?: string;
  /** Search results / long-press points can be saved as a pin; saved places can't. */
  canSave?: boolean;
  /** Set when the target is a saved place — enables the Edit action. */
  placeId?: string;
}

/**
 * Bottom card shown after a destination is picked (search result, long-press,
 * place or favorite) but before navigation starts. Lets the user choose a travel
 * mode (car/bike/foot/hike → routing profile), then Navigate, optionally Save the
 * point as a pin, or Cancel.
 */
export function DestinationCard({
  target,
  mode,
  onModeChange,
  onNavigate,
  transitOffered = false,
  onSave,
  onEdit,
  onShare,
  onWeather,
  onCancel,
  bottomInset = 0,
}: {
  target: DestinationTarget;
  mode: TravelChoice;
  onModeChange: (mode: TravelChoice) => void;
  /** Start guidance — or, for transit, open the journey board. */
  onNavigate: () => void;
  /** Transit can answer here (endpoints in Norway); hides the chip when not. */
  transitOffered?: boolean;
  onSave?: () => void;
  /** Open the saved place's edit panel (only for targets with a placeId). */
  onEdit?: () => void;
  /** Share the point as a web #map= link via the OS share sheet. */
  onShare: () => void;
  /** Open the weather & conditions sheet for this point. */
  onWeather: () => void;
  onCancel: () => void;
  bottomInset?: number;
}) {
  return (
    <View style={[styles.wrap, { paddingBottom: bottomInset + 14 }]}>
      <View style={styles.header}>
        <View style={styles.titles}>
          <Text style={styles.name} numberOfLines={1}>
            {target.name}
          </Text>
          {target.detail ? (
            <Text style={styles.detail} numberOfLines={1}>
              {target.detail}
            </Text>
          ) : null}
        </View>
        <Pressable onPress={onCancel} testID="destination-cancel" hitSlop={10}>
          <Text style={styles.close}>✕</Text>
        </Pressable>
      </View>

      <View style={styles.modes}>
        {ROUTING_PROFILES.map((p) => (
          <Pressable
            key={p.id}
            style={[styles.mode, mode === p.id ? styles.modeActive : null]}
            onPress={() => onModeChange(p.id)}
            testID={`mode-${p.id}`}
          >
            <Text style={styles.modeIcon}>{p.icon}</Text>
            <Text style={[styles.modeLabel, mode === p.id ? styles.modeLabelActive : null]}>
              {p.label}
            </Text>
          </Pressable>
        ))}
        {transitOffered ? (
          <Pressable
            style={[styles.mode, mode === 'transit' ? styles.modeActive : null]}
            onPress={() => onModeChange('transit')}
            testID="mode-transit"
          >
            <Text style={styles.modeIcon}>🚌</Text>
            <Text style={[styles.modeLabel, mode === 'transit' ? styles.modeLabelActive : null]}>
              Transit
            </Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.actions}>
        {/* Transit has no turn-by-turn yet, so the button says what it does:
            it opens the departure board rather than starting guidance. */}
        <Pressable style={styles.navigate} onPress={onNavigate} testID="destination-navigate">
          <Text style={styles.navigateText}>
            {mode === 'transit' ? 'Show journeys' : 'Navigate'}
          </Text>
        </Pressable>
        {target.canSave && onSave ? (
          <Pressable style={styles.save} onPress={onSave} testID="destination-save">
            <Text style={styles.saveText}>Save pin</Text>
          </Pressable>
        ) : null}
        {onEdit ? (
          <Pressable style={styles.save} onPress={onEdit} testID="destination-edit">
            <Text style={styles.saveText}>Edit</Text>
          </Pressable>
        ) : null}
        <Pressable style={styles.save} onPress={onWeather} testID="destination-weather">
          <Text style={styles.saveText}>☀ Weather</Text>
        </Pressable>
        <Pressable style={styles.save} onPress={onShare} testID="destination-share">
          <Text style={styles.saveText}>Share</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingHorizontal: 18,
    paddingTop: 16,
    elevation: 12,
  },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  titles: { flexShrink: 1, paddingRight: 12 },
  name: { fontSize: 17, fontWeight: '700', color: '#111' },
  detail: { fontSize: 13, color: '#778', marginTop: 1 },
  close: { fontSize: 18, color: '#889', paddingHorizontal: 4 },
  modes: { flexDirection: 'row', gap: 8, marginTop: 14 },
  mode: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: '#eef1f6',
  },
  modeActive: { backgroundColor: '#1a73e8' },
  modeIcon: { fontSize: 20 },
  modeLabel: { fontSize: 12, color: '#334', marginTop: 2, fontWeight: '600' },
  modeLabelActive: { color: '#fff' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 16 },
  navigate: {
    flexGrow: 1,
    flexBasis: '100%',
    backgroundColor: '#1a73e8',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  navigateText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  save: {
    backgroundColor: '#eef1f6',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignItems: 'center',
  },
  saveText: { color: '#334', fontWeight: '700', fontSize: 15 },
});
