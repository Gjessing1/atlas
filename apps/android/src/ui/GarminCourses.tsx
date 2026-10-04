import { garminCourseLine, garminCourseSports, type GarminState } from '@atlas/app-hooks';
import {
  GARMIN_COURSE_SPORTS,
  garminSportFolder,
  garminTypeLabel,
  type CollectionRevealTarget,
} from '@atlas/core';
import { useEffect, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { theme } from './theme';

/**
 * The Garmin Connect course library: browse by sport, and per course save a copy into Atlas,
 * send it to a watch, rename it, change its sport or delete it. One course is open at a time so
 * the list stays scannable; every action reports back on the row it came from. Same shape as
 * the web panel (apps/web/src/settings/GarminCourses.tsx).
 */
export function GarminCourses({
  garmin,
  onReveal,
  onShowTrack,
}: {
  garmin: GarminState;
  onReveal: (target: CollectionRevealTarget) => void;
  /** Close Settings and draw the saved copy on the map, framed. */
  onShowTrack: (trackId: string) => void;
}) {
  const [sport, setSport] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { courses, loadCourses, loadDevices } = garmin;

  useEffect(() => {
    if (courses === null) void loadCourses();
  }, [courses, loadCourses]);

  const sports = courses ? garminCourseSports(courses) : [];
  const shown = (courses ?? []).filter(
    (course) => sport === null || garminSportFolder(course.type) === sport,
  );
  const device = deviceId || garmin.devices[0]?.id || '';

  const open = (id: string) => {
    if (openId === id) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setName(courses?.find((course) => course.id === id)?.name ?? '');
    setConfirmDelete(false);
    garmin.clearCourseResult();
    if (garmin.devices.length === 0) void loadDevices();
  };

  return (
    <View testID="garmin-courses">
      <View style={styles.head}>
        <Text style={styles.subheading}>Courses{courses ? ` · ${courses.length}` : ''}</Text>
        <Pressable
          onPress={() => void loadCourses()}
          disabled={garmin.busy}
          hitSlop={12}
          testID="garmin-courses-refresh"
        >
          <Text style={styles.link}>
            {garmin.busy && courses === null ? 'Loading…' : 'Refresh'}
          </Text>
        </Pressable>
      </View>
      {sports.length > 1 ? (
        <View style={styles.chips} accessibilityRole="radiogroup">
          {[{ sport: null as string | null, count: courses!.length }, ...sports].map((item) => {
            const on = sport === item.sport;
            return (
              <Pressable
                key={item.sport ?? 'all'}
                style={[styles.chip, on && styles.chipOn]}
                onPress={() => setSport(item.sport)}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]}>
                  {item.sport ?? 'All'} <Text style={styles.count}>{item.count}</Text>
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {courses && courses.length === 0 ? (
        <Text style={styles.muted}>
          No courses in Garmin Connect yet. Plan a walking, running, hiking or cycling route and
          choose Send to Garmin.
        </Text>
      ) : null}
      <View style={shown.length > 0 ? styles.list : null}>
        {shown.map((course, index) => {
          const expanded = openId === course.id;
          const pending = garmin.pendingCourseId === course.id;
          const savedTrack = garmin.savedCourses.get(course.id);
          return (
            <View key={course.id} style={[index > 0 && styles.divider, expanded && styles.rowOpen]}>
              <Pressable
                style={styles.row}
                onPress={() => open(course.id)}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                testID={`garmin-course-${course.id}`}
              >
                <View style={styles.nameLine}>
                  <Text style={styles.name} numberOfLines={1}>
                    {course.name}
                  </Text>
                  {savedTrack ? <Text style={styles.badge}>In Atlas</Text> : null}
                </View>
                <Text style={styles.line}>{garminCourseLine(course)}</Text>
              </Pressable>
              {expanded ? (
                <View style={styles.actions}>
                  <View style={styles.actionRow}>
                    {/* Seeing the course is the first thing wanted from it: save
                        the copy if there is none yet, then draw and frame it.
                        Opening Collections alone left the line unseen. */}
                    <Pressable
                      style={[styles.button, pending && styles.disabled]}
                      disabled={pending}
                      onPress={() => {
                        if (savedTrack) onShowTrack(savedTrack);
                        else
                          void garmin.saveCourse(course.id).then((id) => {
                            if (id) onShowTrack(id);
                          });
                      }}
                      testID="garmin-course-show"
                    >
                      <Text style={styles.buttonText}>
                        {savedTrack ? 'Show on map' : 'Save & show on map'}
                      </Text>
                    </Pressable>
                    {savedTrack ? (
                      <Pressable
                        style={[styles.button, styles.quiet]}
                        onPress={() => onReveal({ kind: 'track', id: savedTrack })}
                        testID="garmin-course-reveal"
                      >
                        <Text style={styles.quietText}>In Collections</Text>
                      </Pressable>
                    ) : null}
                    {garmin.devices.length > 0 ? (
                      <Pressable
                        style={[styles.button, styles.quiet, pending && styles.disabled]}
                        disabled={pending}
                        onPress={() => void garmin.sendCourse(course.id, device)}
                        testID="garmin-course-send"
                      >
                        <Text style={styles.quietText}>
                          Send to{' '}
                          {garmin.devices.find((item) => item.id === device)?.name ?? 'watch'}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                  {garmin.devices.length > 1 ? (
                    <View style={styles.chips}>
                      {garmin.devices.map((item) => (
                        <Pressable
                          key={item.id}
                          style={[styles.chip, item.id === device && styles.chipOn]}
                          onPress={() => setDeviceId(item.id)}
                          accessibilityRole="radio"
                          accessibilityState={{ checked: item.id === device }}
                        >
                          <Text style={[styles.chipText, item.id === device && styles.chipTextOn]}>
                            {item.name}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                  <Text style={styles.label}>Name</Text>
                  <View style={styles.actionRow}>
                    <TextInput
                      style={styles.input}
                      value={name}
                      maxLength={100}
                      onChangeText={setName}
                      onSubmitEditing={() => void garmin.renameCourse(course.id, name)}
                      testID="garmin-course-name"
                    />
                    <Pressable
                      style={[
                        styles.button,
                        styles.quiet,
                        (pending || !name.trim() || name.trim() === course.name) && styles.disabled,
                      ]}
                      disabled={pending || !name.trim() || name.trim() === course.name}
                      onPress={() => void garmin.renameCourse(course.id, name)}
                      testID="garmin-course-rename"
                    >
                      <Text style={styles.quietText}>Rename</Text>
                    </Pressable>
                  </View>
                  <Text style={styles.label}>Sport</Text>
                  <View style={styles.chips}>
                    {GARMIN_COURSE_SPORTS.map((key) => {
                      const on = course.type === key;
                      return (
                        <Pressable
                          key={key}
                          style={[styles.chip, on && styles.chipOn]}
                          disabled={pending || on}
                          onPress={() => void garmin.setCourseSport(course.id, key)}
                          accessibilityRole="radio"
                          accessibilityState={{ checked: on, disabled: pending }}
                        >
                          <Text style={[styles.chipText, on && styles.chipTextOn]}>
                            {garminTypeLabel(key)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  {confirmDelete ? (
                    <View style={styles.confirm}>
                      <Text style={styles.confirmText}>
                        Delete “{course.name}” from Garmin Connect? This can’t be undone.
                        {savedTrack ? ' Your copy in Atlas stays.' : ''}
                      </Text>
                      <View style={styles.actionRow}>
                        <Pressable
                          style={[styles.button, styles.danger, pending && styles.disabled]}
                          disabled={pending}
                          onPress={() =>
                            void garmin.deleteCourse(course.id).then((deleted) => {
                              if (deleted) {
                                setOpenId(null);
                                setConfirmDelete(false);
                              }
                            })
                          }
                          testID="garmin-course-delete-confirm"
                        >
                          <Text style={styles.buttonText}>{pending ? 'Deleting…' : 'Delete'}</Text>
                        </Pressable>
                        <Pressable
                          style={[styles.button, styles.quiet]}
                          onPress={() => setConfirmDelete(false)}
                        >
                          <Text style={styles.quietText}>Keep</Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : (
                    <View style={[styles.actionRow, styles.foot]}>
                      <Pressable
                        hitSlop={12}
                        onPress={() =>
                          void Linking.openURL(
                            `https://connect.garmin.com/modern/course/${course.id}`,
                          )
                        }
                      >
                        <Text style={styles.link}>Open in Garmin Connect</Text>
                      </Pressable>
                      <Pressable
                        hitSlop={12}
                        disabled={pending}
                        onPress={() => setConfirmDelete(true)}
                        testID="garmin-course-delete"
                      >
                        <Text style={styles.dangerLink}>Delete…</Text>
                      </Pressable>
                    </View>
                  )}
                  {pending && !confirmDelete ? <Text style={styles.muted}>Working…</Text> : null}
                  {!pending && garmin.courseNotice ? (
                    <Text style={styles.muted}>{garmin.courseNotice}</Text>
                  ) : null}
                  {!pending && garmin.courseError ? (
                    <Text style={styles.error}>{garmin.courseError}</Text>
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })}
      </View>
      {/* A deleted course takes its row with it, so its confirmation lands here. */}
      {openId === null && garmin.courseNotice ? (
        <Text style={styles.muted}>{garmin.courseNotice}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  subheading: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.text,
    marginTop: 12,
    marginBottom: 6,
  },
  link: { color: theme.accent, fontWeight: '600', marginTop: 6 },
  dangerLink: { color: theme.danger, fontWeight: '600' },
  muted: { fontSize: 13, color: theme.textMuted, marginTop: 6, opacity: 0.75 },
  error: { fontSize: 13, color: theme.danger, marginTop: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
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
  chipTextOn: { fontWeight: '700' },
  count: { opacity: 0.6, fontWeight: '400' },
  list: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 10,
    overflow: 'hidden',
  },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
  rowOpen: { backgroundColor: theme.surfaceMuted },
  row: { minHeight: 52, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: theme.text },
  badge: {
    paddingHorizontal: 7,
    borderRadius: 9,
    overflow: 'hidden',
    backgroundColor: theme.accentFaint,
    color: theme.accent,
    fontSize: 11,
    fontWeight: '700',
  },
  line: { fontSize: 12, color: theme.textMuted, opacity: 0.75, marginTop: 2 },
  actions: { paddingHorizontal: 12, paddingBottom: 12 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  label: { fontSize: 12, color: theme.textMuted, opacity: 0.75, marginTop: 12, marginBottom: 4 },
  input: {
    flex: 1,
    minWidth: 160,
    minHeight: 48,
    borderWidth: 1,
    borderColor: theme.border,
    color: theme.text,
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 15,
  },
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
  foot: { justifyContent: 'space-between', marginTop: 14 },
  confirm: {
    marginTop: 14,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.danger,
  },
  confirmText: { color: theme.text, fontSize: 14, marginBottom: 8 },
});
