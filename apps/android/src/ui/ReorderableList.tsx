import { useRef, useState } from 'react';
import { PanResponder, StyleSheet, Text, View } from 'react-native';

/**
 * Long-lists drag-to-arrange without native gesture libs (keeps the feature
 * OTA-updatable): each row gets a ≡ handle wired to a PanResponder; while a
 * row is held, the rows in between shift out of its way, and releasing calls
 * `onReorder` with the ids in their new order. The enclosing ScrollView must
 * freeze while a drag is live — hence `onDragActive`.
 */
export function ReorderableList<T>({
  items,
  keyOf,
  renderRow,
  onReorder,
  onDragActive,
  onDropAt,
}: {
  items: T[];
  keyOf: (item: T) => string;
  /** Render one row; place `handle` where the drag grip should sit. */
  renderRow: (item: T, handle: React.ReactNode) => React.ReactNode;
  onReorder: (orderedIds: string[]) => void;
  /** Fires on drag start/end — disable the outer ScrollView (and close editors). */
  onDragActive: (active: boolean) => void;
  /**
   * Optional cross-list drop target. Receives the dragged item and absolute
   * screen Y; return true when the parent handled it (for example place →
   * folder), suppressing the ordinary within-list reorder.
   */
  onDropAt?: (item: T, pageY: number) => boolean;
}) {
  // Measured row heights by index (rows include any expanded editor below them).
  const heightsRef = useRef<number[]>([]);
  const [drag, setDrag] = useState<{ from: number; to: number; dy: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  // Latest items/callbacks for the long-lived responders (created once per row key).
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const onDragActiveRef = useRef(onDragActive);
  onDragActiveRef.current = onDragActive;
  const onDropAtRef = useRef(onDropAt);
  onDropAtRef.current = onDropAt;

  /** The slot the dragged row should take: each midpoint its centre crosses is one step. */
  const targetIndex = (from: number, dy: number): number => {
    const heights = heightsRef.current;
    const n = itemsRef.current.length;
    const mids: number[] = [];
    let y = 0;
    for (let i = 0; i < n; i++) {
      mids.push(y + (heights[i] ?? 0) / 2);
      y += heights[i] ?? 0;
    }
    const center = (mids[from] ?? 0) + dy;
    let to = from;
    if (dy > 0) {
      for (let i = from + 1; i < n; i++) if (center > (mids[i] ?? Infinity)) to = i;
    } else {
      for (let i = from - 1; i >= 0; i--) if (center < (mids[i] ?? -Infinity)) to = i;
    }
    return to;
  };

  const respondersRef = useRef(new Map<string, ReturnType<typeof PanResponder.create>>());
  const responderFor = (key: string) => {
    let responder = respondersRef.current.get(key);
    if (!responder) {
      responder = PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          const from = itemsRef.current.findIndex((it) => keyOf(it) === key);
          if (from < 0) return;
          onDragActiveRef.current(true);
          setDrag({ from, to: from, dy: 0 });
        },
        onPanResponderMove: (_e, g) => {
          const cur = dragRef.current;
          if (!cur) return;
          setDrag({ from: cur.from, to: targetIndex(cur.from, g.dy), dy: g.dy });
        },
        onPanResponderRelease: (_event, gesture) => {
          const cur = dragRef.current;
          setDrag(null);
          onDragActiveRef.current(false);
          const item = itemsRef.current.find((candidate) => keyOf(candidate) === key);
          if (item && onDropAtRef.current?.(item, gesture.moveY)) return;
          if (!cur || cur.to === cur.from) return;
          const ids = itemsRef.current.map(keyOf);
          const [moved] = ids.splice(cur.from, 1);
          ids.splice(cur.to, 0, moved!);
          onReorderRef.current(ids);
        },
        onPanResponderTerminate: () => {
          setDrag(null);
          onDragActiveRef.current(false);
        },
      });
      respondersRef.current.set(key, responder);
    }
    return responder;
  };

  const shiftFor = (index: number): number => {
    if (!drag || index === drag.from) return 0;
    const draggedHeight = heightsRef.current[drag.from] ?? 0;
    if (drag.from < index && index <= drag.to) return -draggedHeight;
    if (drag.to <= index && index < drag.from) return draggedHeight;
    return 0;
  };

  return (
    <View>
      {items.map((item, index) => {
        const key = keyOf(item);
        const isDragged = drag?.from === index;
        return (
          <View
            key={key}
            onLayout={(e) => {
              heightsRef.current[index] = e.nativeEvent.layout.height;
            }}
            style={[
              { transform: [{ translateY: isDragged ? drag.dy : shiftFor(index) }] },
              isDragged ? styles.dragged : null,
            ]}
          >
            {renderRow(
              item,
              <View {...responderFor(key).panHandlers} style={styles.handle} testID={`drag-${key}`}>
                <Text style={styles.handleText}>≡</Text>
              </View>,
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  dragged: {
    zIndex: 10,
    elevation: 4,
    backgroundColor: '#fff',
    borderRadius: 8,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  handle: {
    paddingHorizontal: 6,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleText: { fontSize: 18, color: '#a5adba', fontWeight: '700' },
});
