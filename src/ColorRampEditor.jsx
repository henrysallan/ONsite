/**
 * ColorRampEditor – A Blender-style colour ramp widget.
 *
 * Renders a horizontal gradient bar with draggable stops.
 * Each stop has a position (0-1) and an RGB colour.
 * Supports add (+) and remove (−) buttons.
 * Calls `onChange(stops)` whenever the ramp is modified.
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';

/* ── inline styles (keeps it self-contained) ─────────────────────── */

const RAMP_HEIGHT = 24;
const HANDLE_SIZE = 14;
const TRACK_PAD = 10; // px padding on left/right so handles at 0 & 1 aren't clipped

const styles = {
  wrapper: {
    padding: '6px 8px 10px 8px',
    background: '#1a1a2e',
    borderRadius: 6,
    userSelect: 'none',
    fontFamily: 'Inter, sans-serif',
    fontSize: 11,
    color: '#c8c8d8',
    marginBottom: 4,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  label: {
    fontWeight: 600,
    fontSize: 12,
  },
  btnGroup: {
    display: 'flex',
    gap: 4,
  },
  btn: {
    width: 22,
    height: 22,
    border: '1px solid #555',
    borderRadius: 4,
    background: '#2a2a3e',
    color: '#ddd',
    cursor: 'pointer',
    fontSize: 14,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    lineHeight: 1,
  },
  trackOuter: {
    position: 'relative',
    height: RAMP_HEIGHT + HANDLE_SIZE + 6,
    marginTop: 2,
  },
  rampBar: {
    position: 'absolute',
    top: 0,
    left: TRACK_PAD,
    right: TRACK_PAD,
    height: RAMP_HEIGHT,
    borderRadius: 4,
    border: '1px solid #444',
    overflow: 'hidden',
  },
  handleRow: {
    position: 'absolute',
    top: RAMP_HEIGHT - 2,
    left: TRACK_PAD,
    right: TRACK_PAD,
    height: HANDLE_SIZE + 4,
  },
  handle: (pct, color, selected) => ({
    position: 'absolute',
    left: `calc(${pct * 100}% - ${HANDLE_SIZE / 2}px)`,
    top: 0,
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    borderRadius: 3,
    border: selected ? '2px solid #fff' : '2px solid #888',
    background: color,
    cursor: 'ew-resize',
    boxShadow: selected ? '0 0 4px rgba(255,255,255,0.5)' : 'none',
    zIndex: selected ? 3 : 1,
  }),
  infoRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 4,
    fontSize: 11,
  },
  posInput: {
    width: 54,
    background: '#222',
    border: '1px solid #555',
    borderRadius: 3,
    color: '#ddd',
    padding: '2px 4px',
    fontSize: 11,
  },
  colorInput: {
    width: 28,
    height: 20,
    border: '1px solid #555',
    borderRadius: 3,
    padding: 0,
    background: 'none',
    cursor: 'pointer',
  },
  rgbInput: {
    width: 38,
    background: '#222',
    border: '1px solid #555',
    borderRadius: 3,
    color: '#ddd',
    padding: '2px 4px',
    fontSize: 11,
  },
  rgbRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
    fontSize: 11,
  },
};

/* ── component ───────────────────────────────────────────────────── */

export function ColorRampEditor({ stops: initialStops, onChange }) {
  const [stops, setStops] = useState(initialStops);
  const [selected, setSelected] = useState(0);
  const trackRef = useRef(null);
  const dragging = useRef(null);

  // Sync external changes
  useEffect(() => {
    setStops(initialStops);
  }, [initialStops]);

  /* helpers */
  const sorted = [...stops].sort((a, b) => a.position - b.position);

  const emit = useCallback(
    (next) => {
      setStops(next);
      onChange?.(next);
    },
    [onChange]
  );

  const colorToHex = (c) => {
    const r = Math.round(c[0] * 255).toString(16).padStart(2, '0');
    const g = Math.round(c[1] * 255).toString(16).padStart(2, '0');
    const b = Math.round(c[2] * 255).toString(16).padStart(2, '0');
    return `#${r}${g}${b}`;
  };

  const hexToColor = (hex) => {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return [r, g, b];
  };

  /* gradient CSS string */
  const gradient = sorted
    .map((s) => `${colorToHex(s.color)} ${s.position * 100}%`)
    .join(', ');

  /* --- drag handling --- */
  const startDrag = (idx, e) => {
    e.preventDefault();
    setSelected(idx);
    dragging.current = idx;
    const onMove = (ev) => handleDrag(ev);
    const onUp = () => {
      dragging.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const handleDrag = (e) => {
    if (dragging.current === null) return;
    const rect = trackRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const clamped = Math.max(0, Math.min(1, x));
    const next = stops.map((s, i) =>
      i === dragging.current ? { ...s, position: Math.round(clamped * 1000) / 1000 } : s
    );
    emit(next);
  };

  /* --- add / remove --- */
  const addStop = () => {
    // Insert a midpoint between the selected stop and the next one
    const sel = stops[selected];
    const sortedIdx = sorted.findIndex((s) => s === sel);
    const nextStop = sorted[Math.min(sortedIdx + 1, sorted.length - 1)];
    const pos = (sel.position + nextStop.position) / 2;
    const newColor = [
      (sel.color[0] + nextStop.color[0]) / 2,
      (sel.color[1] + nextStop.color[1]) / 2,
      (sel.color[2] + nextStop.color[2]) / 2,
    ];
    const next = [...stops, { position: pos, color: newColor }];
    emit(next);
    setSelected(next.length - 1);
  };

  const removeStop = () => {
    if (stops.length <= 2) return;
    const next = stops.filter((_, i) => i !== selected);
    emit(next);
    setSelected(Math.min(selected, next.length - 1));
  };

  /* --- selected stop info --- */
  const sel = stops[selected] || stops[0];
  const selIdx = selected;

  return (
    <div style={styles.wrapper}>
      <div style={styles.header}>
        <span style={styles.label}>Color Ramp</span>
        <div style={styles.btnGroup}>
          <button style={styles.btn} onClick={addStop} title="Add stop">
            +
          </button>
          <button
            style={{ ...styles.btn, opacity: stops.length <= 2 ? 0.4 : 1 }}
            onClick={removeStop}
            title="Remove stop"
            disabled={stops.length <= 2}
          >
            −
          </button>
        </div>
      </div>

      {/* gradient bar + handles */}
      <div style={styles.trackOuter}>
        <div
          style={{
            ...styles.rampBar,
            background: `linear-gradient(to right, ${gradient})`,
          }}
        />
        <div ref={trackRef} style={styles.handleRow}>
          {stops.map((stop, i) => (
            <div
              key={i}
              style={styles.handle(stop.position, colorToHex(stop.color), i === selected)}
              onPointerDown={(e) => startDrag(i, e)}
            />
          ))}
        </div>
      </div>

      {/* selected stop details */}
      <div style={styles.infoRow}>
        <span>Stop {selIdx}</span>
        <label>
          Pos{' '}
          <input
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={sel.position}
            style={styles.posInput}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v)) {
                const next = stops.map((s, i) =>
                  i === selIdx ? { ...s, position: Math.max(0, Math.min(1, v)) } : s
                );
                emit(next);
              }
            }}
          />
        </label>
        <label>
          Color{' '}
          <input
            type="color"
            value={colorToHex(sel.color)}
            style={styles.colorInput}
            onChange={(e) => {
              const next = stops.map((s, i) =>
                i === selIdx ? { ...s, color: hexToColor(e.target.value) } : s
              );
              emit(next);
            }}
          />
        </label>
      </div>

      {/* RGB values */}
      <div style={styles.rgbRow}>
        {['R', 'G', 'B'].map((ch, ci) => (
          <label key={ch} style={{ color: ch === 'R' ? '#f77' : ch === 'G' ? '#7f7' : '#77f' }}>
            {ch}{' '}
            <input
              type="number"
              min={0}
              max={1}
              step={0.01}
              value={Math.round(sel.color[ci] * 100) / 100}
              style={styles.rgbInput}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!isNaN(v)) {
                  const newColor = [...sel.color];
                  newColor[ci] = Math.max(0, Math.min(1, v));
                  const next = stops.map((s, i) =>
                    i === selIdx ? { ...s, color: newColor } : s
                  );
                  emit(next);
                }
              }}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
