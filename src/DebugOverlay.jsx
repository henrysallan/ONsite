import React, { useState, useEffect, useRef, useCallback } from 'react';
import { RayDebugLogger } from './RayDebugLogger.js';

const COLORS = RayDebugLogger.CATEGORIES;
const LABELS = RayDebugLogger.LABELS;

function hexToCSS(hex) {
  return '#' + hex.toString(16).padStart(6, '0');
}

/**
 * Full-screen overlay that shows a scrollable log of every raycast.
 * Features:
 *   - Toggle per-category filters
 *   - Pause / resume live feed
 *   - Copy entire log as JSON
 *   - Compact one-line-per-ray format
 */
export function RayDebugOverlay({ logger }) {
  const [visible, setVisible] = useState(false);
  const [entries, setEntries] = useState([]);
  const [paused, setPaused] = useState(false);
  const [filters, setFilters] = useState(() => {
    const f = {};
    for (const k of Object.keys(COLORS)) f[k] = true;
    return f;
  });
  const [statsExpanded, setStatsExpanded] = useState(false);
  const logRef = useRef(null);
  const pausedRef = useRef(false);
  const bufferRef = useRef([]);
  const MAX_DISPLAY = 150;

  // Keep pausedRef in sync
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  // Subscribe to logger
  useEffect(() => {
    if (!logger) return;
    const handler = (entry) => {
      if (pausedRef.current) return;
      bufferRef.current.push(entry);
    };
    logger.onLog(handler);
    // No cleanup needed – logger is a singleton
  }, [logger]);

  // Flush buffer into state at ~4 Hz (avoid re-rendering per ray)
  useEffect(() => {
    const iv = setInterval(() => {
      if (bufferRef.current.length === 0) return;
      const batch = bufferRef.current.splice(0);
      setEntries(prev => {
        const next = [...prev, ...batch];
        return next.length > MAX_DISPLAY ? next.slice(-MAX_DISPLAY) : next;
      });
    }, 250);
    return () => clearInterval(iv);
  }, []);

  // When paused, snapshot the full backing buffer so scroll-back works
  useEffect(() => {
    if (paused && logger) {
      setEntries(logger.getLog());
    }
  }, [paused, logger]);

  // Auto-scroll
  useEffect(() => {
    if (!paused && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [entries, paused]);

  // Sync filter toggles to the logger
  useEffect(() => {
    if (!logger) return;
    for (const k of Object.keys(filters)) logger.filters[k] = filters[k];
  }, [filters, logger]);

  // Keyboard shortcuts:
  //   ` (backtick) — toggle overlay visibility
  //   P            — instant pause/resume (only when overlay is open)
  const visibleRef = useRef(false);
  useEffect(() => { visibleRef.current = visible; }, [visible]);
  useEffect(() => {
    const onKey = (e) => {
      if (e.code === 'Backquote') {
        setVisible(v => !v);
        e.preventDefault();
      }
      if (e.code === 'KeyP' && visibleRef.current && !document.pointerLockElement) {
        setPaused(p => !p);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleFilter = useCallback((key) => {
    setFilters(f => ({ ...f, [key]: !f[key] }));
  }, []);

  const copyLog = useCallback(() => {
    const log = logger ? logger.getLog() : [];
    const text = JSON.stringify(log, null, 2);
    navigator.clipboard.writeText(text).then(() => {
      alert('Log copied to clipboard (' + log.length + ' entries)');
    });
  }, [logger]);

  const clearLog = useCallback(() => {
    if (logger) logger.clearLog();
    setEntries([]);
    bufferRef.current.length = 0;
  }, [logger]);

  // Compute per-category stats
  const stats = {};
  let totalHits = 0, totalMisses = 0;
  for (const e of entries) {
    if (!stats[e.category]) stats[e.category] = { hits: 0, misses: 0 };
    if (e.hit) { stats[e.category].hits++; totalHits++; }
    else { stats[e.category].misses++; totalMisses++; }
  }

  if (!visible) {
    return (
      <div style={{
        position: 'fixed', bottom: 8, left: 8, zIndex: 99999,
        background: 'rgba(0,0,0,0.6)', color: '#0f0', padding: '4px 10px',
        borderRadius: 4, fontSize: 11, fontFamily: 'monospace', pointerEvents: 'auto',
        cursor: 'pointer', userSelect: 'none',
      }} onClick={() => setVisible(true)}>
        Ray Debug [ ` ]
      </div>
    );
  }

  const filtered = entries.filter(e => filters[e.category]);

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 480, zIndex: 99999,
      background: 'rgba(10,10,15,0.92)', color: '#ddd', fontFamily: 'monospace',
      fontSize: 11, display: 'flex', flexDirection: 'column', pointerEvents: 'auto',
      borderLeft: '1px solid #333',
    }}>
      {/* Header */}
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #333', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <strong style={{ color: '#0f0' }}>Ray Debug</strong>
        <button onClick={() => setPaused(!paused)} style={btnStyle}>
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <button onClick={copyLog} style={btnStyle}>📋 Copy JSON</button>
        <button onClick={clearLog} style={btnStyle}>🗑 Clear</button>
        <button onClick={() => setVisible(false)} style={btnStyle}>✕ Close</button>
        <span style={{ color: '#888', marginLeft: 'auto' }}>
          {filtered.length} shown · {totalHits} hits · {totalMisses} misses
        </span>
      </div>

      {/* Filters */}
      <div style={{
        padding: '4px 10px', borderBottom: '1px solid #333', display: 'flex',
        flexWrap: 'wrap', gap: '2px 6px', maxHeight: 80, overflowY: 'auto',
      }}>
        {Object.keys(COLORS).map(k => (
          <label key={k} style={{
            display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer',
            opacity: filters[k] ? 1 : 0.35, fontSize: 10,
          }}>
            <span style={{
              display: 'inline-block', width: 8, height: 8, borderRadius: 2,
              background: hexToCSS(COLORS[k]),
            }} />
            <input type="checkbox" checked={filters[k]} onChange={() => toggleFilter(k)}
              style={{ width: 10, height: 10, margin: 0 }} />
            {LABELS[k] || k}
          </label>
        ))}
      </div>

      {/* Stats */}
      <div style={{ padding: '2px 10px', borderBottom: '1px solid #222', cursor: 'pointer' }}
        onClick={() => setStatsExpanded(!statsExpanded)}>
        <span style={{ color: '#888' }}>{statsExpanded ? '▾' : '▸'} Stats</span>
        {statsExpanded && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', paddingTop: 2 }}>
            {Object.keys(stats).map(k => (
              <span key={k} style={{ color: hexToCSS(COLORS[k] || 0xffffff) }}>
                {LABELS[k]}: {stats[k].hits}✓ {stats[k].misses}✗
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Log entries */}
      <div ref={logRef} style={{ flex: 1, overflowY: 'auto', padding: '2px 6px' }}>
        {filtered.map((e, i) => (
          <div key={i} style={{
            borderBottom: '1px solid #1a1a1a', padding: '1px 0',
            color: hexToCSS(COLORS[e.category] || 0xaaaaaa),
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            <span style={{ color: '#666', marginRight: 4 }}>{e.frame}</span>
            <span style={{ color: hexToCSS(COLORS[e.category] || 0xffffff), fontWeight: 'bold' }}>
              {e.label}
            </span>
            {' '}
            <span style={{ color: '#888' }}>
              ({e.originX},{e.originY},{e.originZ})→({e.dirX},{e.dirY},{e.dirZ}) d={e.maxDist}
            </span>
            {e.hit ? (
              <span style={{ color: '#4f4' }}>
                {' '}HIT {e.hitObject || '?'} @({e.hitX},{e.hitY},{e.hitZ}) d={e.hitDist}
                {' '}n=({e.hitNormX},{e.hitNormY},{e.hitNormZ})
              </span>
            ) : (
              <span style={{ color: '#f44' }}> MISS</span>
            )}
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ color: '#555', padding: 20, textAlign: 'center' }}>
            No rays logged yet. Enable debugging and move around.
          </div>
        )}
      </div>
    </div>
  );
}

const btnStyle = {
  background: '#333', color: '#ccc', border: '1px solid #555', borderRadius: 3,
  padding: '2px 8px', cursor: 'pointer', fontSize: 11, fontFamily: 'monospace',
};
