import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Animated,
  BackHandler,
  Keyboard,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from './theme';

export type SheetSnap = 'peek' | 'half' | 'full';

interface SnapHeights {
  peek: number;
  half: number;
  full: number;
}

export interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Modal sheets dim and block the map; map sheets leave it interactive. */
  mode?: 'modal' | 'map';
  initialSnap?: SheetSnap;
  /** Visible content height when the sheet is at its lowest snap. */
  peekHeight?: number;
  /** App-level fallback for Android builds that report a zero bottom inset. */
  bottomInset?: number;
  contentStyle?: StyleProp<ViewStyle>;
  sheetStyle?: StyleProp<ViewStyle>;
  testID?: string;
  onSnapChange?: (snap: SheetSnap) => void;
  /**
   * Hardware Back, for a sheet that is not dismissable. Return false to leave the
   * press to the app — a sheet that lives for as long as its layer is on has no
   * "closed" to go to, and consuming Back anyway traps it on the map.
   */
  onBack?: () => boolean;
}

export interface BottomSheetHandle {
  snapTo: (snap: SheetSnap) => void;
}

const SNAP_ORDER: SheetSnap[] = ['peek', 'half', 'full'];

function closestSnap(height: number, snaps: SnapHeights): SheetSnap {
  return SNAP_ORDER.reduce((best, candidate) =>
    Math.abs(snaps[candidate] - height) < Math.abs(snaps[best] - height) ? candidate : best,
  );
}

/**
 * One interaction model for every bottom surface in the Android app.
 *
 * Drag the handle to move between peek, half and full; tap it to progressively
 * expand (or return from full to half). A downward swipe from peek dismisses.
 * The sheet animates its actual height rather than translating a full-height
 * ScrollView below the viewport, so scrolling remains honest at every snap.
 */
export const BottomSheet = forwardRef<BottomSheetHandle, BottomSheetProps>(function BottomSheet(
  {
    visible,
    onClose,
    children,
    mode = 'modal',
    initialSnap = 'half',
    peekHeight = 168,
    bottomInset = 0,
    contentStyle,
    sheetStyle,
    testID,
    onSnapChange,
    onBack,
  },
  ref,
) {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const safeBottom = Math.max(insets.bottom, bottomInset);
  // Edge-to-edge Android activities do not consistently resize the React
  // root even with adjustResize. Track the IME explicitly so inputs and their
  // results stay above it in search, route, settings and editor sheets.
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', (event) => {
      setKeyboardHeight(Math.max(0, event.endCoordinates.height));
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);
  // Keep the entire sheet physically above three-button/gesture navigation.
  // Padding alone was not sufficient on devices whose translucent nav window
  // clips the composited modal after React Native has laid its children out.
  const sheetBottom = keyboardHeight > 0 ? keyboardHeight : safeBottom;
  const availableHeight = Math.max(240, window.height - sheetBottom);
  const snaps = useMemo<SnapHeights>(() => {
    // Leave a narrow strip above a fully-expanded sheet so it still reads as a
    // sheet, not a replacement screen. The top inset keeps it below cut-outs.
    const full = Math.max(240, availableHeight - Math.max(insets.top, 24) - 12);
    const peek = Math.min(full, Math.max(112, peekHeight));
    const half = Math.min(full, Math.max(peek, Math.round(availableHeight * 0.56)));
    return { peek, half, full };
  }, [availableHeight, insets.top, peekHeight]);

  const animatedHeight = useRef(new Animated.Value(snaps[initialSnap])).current;
  const currentHeight = useRef(snaps[initialSnap]);
  const currentSnap = useRef<SheetSnap>(initialSnap);
  const dragStart = useRef(snaps[initialSnap]);
  const snapsRef = useRef(snaps);
  const visibleRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const onSnapChangeRef = useRef(onSnapChange);
  const onBackRef = useRef(onBack);
  snapsRef.current = snaps;
  onCloseRef.current = onClose;
  onSnapChangeRef.current = onSnapChange;
  onBackRef.current = onBack;

  // Map-mode sheets are intentionally not React Native Modals, so Android
  // does not send them through Modal.onRequestClose. Consume Back here before
  // the activity is backgrounded; every bottom surface then has the same
  // close behavior without each owner growing its own BackHandler effect.
  useEffect(() => {
    if (!visible || mode !== 'map') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      const back = onBackRef.current;
      if (back) return back();
      onCloseRef.current();
      return true;
    });
    return () => subscription.remove();
  }, [mode, visible]);

  const animateTo = (snap: SheetSnap) => {
    const target = snapsRef.current[snap];
    currentSnap.current = snap;
    onSnapChangeRef.current?.(snap);
    Animated.spring(animatedHeight, {
      toValue: target,
      damping: 24,
      stiffness: 240,
      mass: 0.8,
      useNativeDriver: false,
    }).start(() => {
      currentHeight.current = target;
    });
  };
  useImperativeHandle(ref, () => ({ snapTo: animateTo }));

  // Every fresh open starts at the surface's intentional disclosure level.
  // Dimension/safe-area changes keep an already-open sheet at the same snap.
  useEffect(() => {
    if (visible && !visibleRef.current) {
      currentSnap.current = initialSnap;
      currentHeight.current = snaps[initialSnap];
      animatedHeight.setValue(snaps[initialSnap]);
    } else if (visible) {
      animateTo(currentSnap.current);
    }
    visibleRef.current = visible;
    // `animateTo` deliberately reads refs so this effect only tracks geometry.
  }, [animatedHeight, initialSnap, snaps, visible]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dy) > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderGrant: () => {
          animatedHeight.stopAnimation((value) => {
            dragStart.current = value;
            currentHeight.current = value;
          });
        },
        onPanResponderMove: (_event, gesture) => {
          const available = snapsRef.current;
          const next = Math.max(
            Math.round(available.peek * 0.55),
            Math.min(available.full, dragStart.current - gesture.dy),
          );
          currentHeight.current = next;
          animatedHeight.setValue(next);
        },
        onPanResponderRelease: (_event, gesture) => {
          const available = snapsRef.current;
          const projected = currentHeight.current - gesture.vy * 72;
          if (
            currentSnap.current === 'peek' &&
            (gesture.dy > 64 || projected < available.peek * 0.78)
          ) {
            onCloseRef.current();
            return;
          }

          const from = closestSnap(currentHeight.current, available);
          const fromIndex = SNAP_ORDER.indexOf(from);
          const velocityIndex =
            gesture.vy < -0.55
              ? Math.min(SNAP_ORDER.length - 1, fromIndex + 1)
              : gesture.vy > 0.55
                ? Math.max(0, fromIndex - 1)
                : -1;
          animateTo(
            velocityIndex >= 0 ? SNAP_ORDER[velocityIndex]! : closestSnap(projected, available),
          );
        },
        onPanResponderTerminate: () =>
          animateTo(closestSnap(currentHeight.current, snapsRef.current)),
        onPanResponderTerminationRequest: () => false,
      }),
    // The responder is stable; callbacks and geometry are read through refs.
    [animatedHeight],
  );

  if (!visible) return null;

  const cycleSnap = () => {
    const index = SNAP_ORDER.indexOf(currentSnap.current);
    animateTo(currentSnap.current === 'full' ? 'half' : (SNAP_ORDER[index + 1] ?? 'full'));
  };

  const surface = (
    <Animated.View
      style={[styles.sheet, { bottom: sheetBottom, height: animatedHeight }, sheetStyle]}
      testID={testID}
    >
      <View style={styles.handleTouch} {...panResponder.panHandlers}>
        <Pressable
          style={styles.handleButton}
          onPress={cycleSnap}
          accessibilityRole="button"
          accessibilityLabel="Resize sheet"
          accessibilityHint="Tap to expand; swipe down from the lowest position to close"
          testID={testID ? `${testID}-handle` : undefined}
        >
          <View style={styles.handle} />
        </Pressable>
      </View>
      {/* Landscape puts the system navigation bar on a side of the screen, and
          the sheet spans the full width; indent the content past it so buttons
          at the sheet's edges stay visible and tappable (0 in portrait). */}
      <View
        style={[
          styles.content,
          { paddingBottom: 12, paddingLeft: 20 + insets.left, paddingRight: 20 + insets.right },
          contentStyle,
        ]}
      >
        {children}
      </View>
    </Animated.View>
  );

  if (mode === 'map') {
    return (
      <View style={styles.mapLayer} pointerEvents="box-none">
        {surface}
      </View>
    );
  }

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close sheet"
        />
        {surface}
      </View>
    </Modal>
  );
});

const styles = StyleSheet.create({
  mapLayer: { position: 'absolute', inset: 0 },
  backdrop: {
    flex: 1,
    backgroundColor: theme.backdrop,
    justifyContent: 'flex-end',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
    backgroundColor: theme.surface,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    elevation: 16,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -3 },
  },
  handleTouch: { height: 28, alignItems: 'center', justifyContent: 'center' },
  handleButton: {
    width: 64,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handle: { width: 36, height: 5, borderRadius: 3, backgroundColor: theme.handle },
  content: {
    flex: 1,
    overflow: 'hidden',
    paddingHorizontal: 20,
  },
});
