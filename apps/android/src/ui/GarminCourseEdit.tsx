import { garminResendDevice, type GarminState } from '@atlas/app-hooks';
import type { RoutePath, RoutingProfile } from '@atlas/routing';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from './theme';

/**
 * Shown in the planner while a Garmin course is being reshaped: the edit replaces the course on
 * Garmin (create the new one, then — after a confirm — delete the old) and goes back to the
 * watch it was last sent to. Same flow as apps/web/src/settings/GarminCourseEdit.tsx.
 */
export function GarminCourseEditBar({
  garmin,
  path,
  profile,
}: {
  garmin: GarminState;
  path: RoutePath | null;
  profile: RoutingProfile;
}) {
  const edit = garmin.courseEdit;
  const [deviceId, setDeviceId] = useState('');
  const resendTo = edit ? garminResendDevice(garmin.deliveries.get(edit.id), garmin.devices) : '';
  useEffect(() => setDeviceId(resendTo), [resendTo, edit?.id]);
  if (!edit) return null;
  const pending = garmin.pendingCourseId === edit.id;
  const disabled = !path || pending || profile === 'car';
  const targets = [{ id: '', name: 'Connect only' }, ...garmin.devices];
  return (
    <View style={styles.box} testID="garmin-course-edit">
      <Text style={styles.text}>
        Editing Garmin course <Text style={styles.strong}>“{edit.name}”</Text>. Reshape it on the
        map, then update it on Garmin.
      </Text>
      {garmin.devices.length > 0 ? (
        <View style={styles.row}>
          {targets.map((item) => (
            <Pressable
              key={item.id || 'none'}
              style={[styles.chip, item.id === deviceId && styles.chipOn]}
              onPress={() => setDeviceId(item.id)}
              accessibilityRole="radio"
              accessibilityState={{ checked: item.id === deviceId }}
            >
              <Text style={styles.chipText}>{item.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.row}>
        <Pressable
          style={[styles.button, disabled && styles.disabled]}
          disabled={disabled}
          onPress={() => path && void garmin.replaceCourse(path, profile, deviceId || undefined)}
          accessibilityRole="button"
          testID="garmin-course-update"
        >
          <Text style={styles.buttonText}>{pending ? 'Updating…' : 'Update on Garmin'}</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.quiet]}
          disabled={pending}
          onPress={garmin.cancelCourseEdit}
          accessibilityRole="button"
          testID="garmin-course-edit-stop"
        >
          <Text style={styles.quietText}>Stop editing</Text>
        </Pressable>
      </View>
      {profile === 'car' ? (
        <Text style={styles.muted}>
          Garmin courses need a walking, running, hiking or cycling plan.
        </Text>
      ) : null}
      {!pending && garmin.courseError ? (
        <Text style={styles.error}>{garmin.courseError}</Text>
      ) : null}
    </View>
  );
}

/** The second half of a replacement: the old course goes only when the user says so. */
export function GarminReplaceConfirm({ garmin }: { garmin: GarminState }) {
  const done = garmin.replacement;
  // Once this asked, its answer (Delete / Keep both) is reported where the question was.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (done) setAsked(true);
  }, [done]);
  if (!done) {
    return asked && garmin.courseNotice ? (
      <Text style={styles.muted}>{garmin.courseNotice}</Text>
    ) : null;
  }
  const pending = garmin.pendingCourseId === done.oldId;
  return (
    <View style={[styles.box, styles.confirm]} testID="garmin-replace-confirm">
      <Text style={styles.text}>
        “{done.name}” is updated on Garmin
        {done.queuedTo ? ` and queued for ${done.queuedTo}` : ''}. Delete the old version from
        Garmin Connect? Your watch may keep its old copy until you remove it there — Atlas has not
        verified what a watch does on its next sync.
      </Text>
      <View style={styles.row}>
        <Pressable
          style={[styles.button, styles.danger, pending && styles.disabled]}
          disabled={pending}
          onPress={() => void garmin.deleteReplacedCourse()}
          accessibilityRole="button"
          testID="garmin-replace-delete"
        >
          <Text style={styles.buttonText}>{pending ? 'Deleting…' : 'Delete old version'}</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.quiet]}
          disabled={pending}
          onPress={garmin.keepReplacedCourse}
          accessibilityRole="button"
          testID="garmin-replace-keep"
        >
          <Text style={styles.quietText}>Keep both</Text>
        </Pressable>
      </View>
      {!pending && garmin.courseError ? (
        <Text style={styles.error}>{garmin.courseError}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    gap: 8,
    padding: 10,
    marginVertical: 6,
    borderRadius: 8,
    backgroundColor: theme.surfaceMuted,
  },
  confirm: { borderWidth: 1, borderColor: theme.danger },
  text: { fontSize: 14, color: theme.text },
  strong: { fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  chip: {
    minHeight: 36,
    justifyContent: 'center',
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: theme.accentFaint,
  },
  chipOn: { backgroundColor: theme.accentFaint, borderColor: theme.accent },
  chipText: { color: theme.text, fontSize: 13 },
  button: {
    minHeight: 48,
    justifyContent: 'center',
    backgroundColor: theme.accent,
    borderRadius: 8,
    paddingHorizontal: 14,
  },
  buttonText: { color: theme.onAccent, fontWeight: '600' },
  quiet: { backgroundColor: theme.surfaceActive },
  quietText: { color: theme.text, fontWeight: '600' },
  danger: { backgroundColor: theme.danger },
  disabled: { opacity: 0.5 },
  muted: { fontSize: 13, color: theme.textMuted, opacity: 0.75 },
  error: { fontSize: 13, color: theme.danger },
});
