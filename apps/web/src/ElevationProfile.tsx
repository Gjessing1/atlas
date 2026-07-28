import { fmtDuration, fmtKm, type LatLng } from '@atlas/core';
import { buildElevationProfile } from '@atlas/gpx';
import type { TrackData } from '@atlas/gpx';
import { routeSurfaceAt, routeSurfaceBreakdown, type RouteEnrichment } from '@atlas/routing';
import { useEffect, useMemo, useRef, useState } from 'react';

/** A "nice" tick step (1/2/5 × 10^k) giving roughly `target` intervals. */
function niceStep(range: number, target: number): number {
  const raw = range / Math.max(target, 1);
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

interface ElevationProfileProps {
  title: string;
  /** Summary stats to show in the header (subset of @atlas/gpx TrackStats keys). */
  stats: Record<string, number>;
  data: TrackData;
  /** OSM surface ranges for routed paths; imported tracks may not carry them. */
  enrichment?: RouteEnrichment;
  onClose: () => void;
  /** Fired while hovering the chart so the map can mark the position. */
  onHoverPoint: (point: LatLng | null) => void;
}

const HEIGHT = 120;
const MARGIN = { top: 10, right: 12, bottom: 20, left: 44 };

/** Green on easy ground, warming through orange to red as uphill grade rises. */
function gradeColor(grade: number): string {
  const magnitude = Math.abs(grade);
  if (magnitude < 3) return '#3b9b62';
  if (magnitude < 6) return grade < 0 ? '#54a6c7' : '#d4a52d';
  if (magnitude < 12) return grade < 0 ? '#397fba' : '#e47f2c';
  return grade < 0 ? '#315e9f' : '#d84b3e';
}

export function ElevationProfile({
  title,
  stats,
  data,
  enrichment,
  onClose,
  onHoverPoint,
}: ElevationProfileProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(680);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const profile = useMemo(() => buildElevationProfile(data), [data]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Clear the map hover marker when the panel unmounts or the data changes.
  useEffect(() => () => onHoverPoint(null), [data, onHoverPoint]);

  const statParts = [
    stats['distanceM'] !== undefined && fmtKm(stats['distanceM']),
    stats['ascentM'] !== undefined && `↗ ${Math.round(stats['ascentM'])} m`,
    stats['descentM'] !== undefined && `↘ ${Math.round(stats['descentM'])} m`,
    stats['durationMs'] ? fmtDuration(stats['durationMs']) : null,
  ].filter((s): s is string => Boolean(s));

  const innerW = Math.max(width - MARGIN.left - MARGIN.right, 40);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const chart = useMemo(() => {
    if (profile.length < 2) return null;
    const maxDist = profile[profile.length - 1]!.distM;
    let minEle = Infinity;
    let maxEle = -Infinity;
    for (const p of profile) {
      if (p.ele < minEle) minEle = p.ele;
      if (p.ele > maxEle) maxEle = p.ele;
    }
    if (maxEle - minEle < 10) {
      const mid = (minEle + maxEle) / 2;
      minEle = mid - 5;
      maxEle = mid + 5;
    }
    const yStep = niceStep(maxEle - minEle, 3);
    const yMin = Math.floor(minEle / yStep) * yStep;
    const yMax = Math.ceil(maxEle / yStep) * yStep;
    const x = (d: number) => (maxDist > 0 ? (d / maxDist) * innerW : 0);
    const y = (e: number) => innerH - ((e - yMin) / (yMax - yMin)) * innerH;

    const linePath = profile
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.distM).toFixed(1)},${y(p.ele).toFixed(1)}`)
      .join('');
    const areaPath = `${linePath}L${x(maxDist).toFixed(1)},${innerH}L0,${innerH}Z`;
    const segments = profile.slice(1).map((point, index) => {
      const previous = profile[index]!;
      const distanceM = point.distM - previous.distM;
      const grade = distanceM > 0 ? ((point.ele - previous.ele) / distanceM) * 100 : 0;
      return { previous, point, grade };
    });

    const yTicks: number[] = [];
    for (let v = yMin; v <= yMax + 1e-9; v += yStep) yTicks.push(v);
    const xStep = niceStep(maxDist, 5);
    const xTicks: number[] = [];
    for (let v = 0; v <= maxDist + 1e-9; v += xStep) xTicks.push(v);

    return { maxDist, x, y, areaPath, segments, yTicks, xTicks };
  }, [profile, innerW, innerH]);

  const setHover = (index: number | null) => {
    setHoverIndex(index);
    const p = index !== null ? profile[index] : undefined;
    onHoverPoint(p ? { lat: p.lat, lng: p.lng } : null);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!chart) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left - MARGIN.left;
    const targetDist = (px / innerW) * chart.maxDist;
    // Binary search for the nearest profile point by distance.
    let lo = 0;
    let hi = profile.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (profile[mid]!.distM < targetDist) lo = mid + 1;
      else hi = mid;
    }
    const prev = profile[lo - 1];
    if (prev && targetDist - prev.distM < profile[lo]!.distM - targetDist) lo -= 1;
    setHover(lo);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!chart) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const delta = e.key === 'ArrowRight' ? 1 : -1;
      const next = Math.min(Math.max((hoverIndex ?? 0) + delta, 0), profile.length - 1);
      setHover(next);
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  const hovered = hoverIndex !== null ? profile[hoverIndex] : undefined;
  const hoveredPrevious =
    hoverIndex !== null && hoverIndex > 0 ? profile[hoverIndex - 1] : undefined;
  const hoveredGrade =
    hovered && hoveredPrevious && hovered.distM > hoveredPrevious.distM
      ? ((hovered.ele - hoveredPrevious.ele) / (hovered.distM - hoveredPrevious.distM)) * 100
      : null;
  const hoveredSurface = hovered ? routeSurfaceAt(enrichment, hovered.distM) : null;
  const surfaces = useMemo(
    () => routeSurfaceBreakdown(enrichment, profile.at(-1)?.distM ?? 0),
    [enrichment, profile],
  );

  return (
    <div className="elevation-panel" ref={containerRef}>
      <div className="elevation-header">
        <strong>{title}</strong>
        <span className="elevation-stats">{statParts.join(' · ')}</span>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close profile">
          ✕
        </button>
      </div>
      {chart ? (
        <div className="elevation-chart">
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`Elevation profile of ${title}`}
            tabIndex={0}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHover(null)}
            onKeyDown={onKeyDown}
          >
            <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
              {chart.yTicks.map((v) => (
                <g key={v}>
                  <line x1={0} x2={innerW} y1={chart.y(v)} y2={chart.y(v)} className="grid-line" />
                  <text x={-8} y={chart.y(v) + 3} className="axis-label" textAnchor="end">
                    {Math.round(v)} m
                  </text>
                </g>
              ))}
              {chart.xTicks.map((v) => (
                <text
                  key={v}
                  x={chart.x(v)}
                  y={innerH + 14}
                  className="axis-label"
                  textAnchor="middle"
                >
                  {v === 0 ? '0' : fmtKm(v)}
                </text>
              ))}
              <path d={chart.areaPath} className="profile-area" />
              {chart.segments.map(({ previous, point, grade }, index) => (
                <line
                  key={index}
                  x1={chart.x(previous.distM)}
                  y1={chart.y(previous.ele)}
                  x2={chart.x(point.distM)}
                  y2={chart.y(point.ele)}
                  className="profile-segment"
                  stroke={gradeColor(grade)}
                />
              ))}
              {hovered && (
                <g>
                  <line
                    x1={chart.x(hovered.distM)}
                    x2={chart.x(hovered.distM)}
                    y1={0}
                    y2={innerH}
                    className="crosshair"
                  />
                  <circle
                    cx={chart.x(hovered.distM)}
                    cy={chart.y(hovered.ele)}
                    r={4}
                    className="profile-dot"
                  />
                </g>
              )}
            </g>
          </svg>
          {hovered && (
            <div
              className="elevation-tooltip"
              style={{
                left: Math.min(MARGIN.left + chart.x(hovered.distM) + 10, width - 90),
              }}
            >
              <strong>{Math.round(hovered.ele)} m</strong>
              <span>{fmtKm(hovered.distM)}</span>
              {hoveredGrade !== null && <span>{hoveredGrade.toFixed(1)}% grade</span>}
              {hoveredSurface && <span>{hoveredSurface}</span>}
            </div>
          )}
          {surfaces.length > 0 && (
            <div className="surface-breakdown" aria-label="Route surfaces">
              <strong>Surface</strong>
              {surfaces.map((surface) => (
                <span key={surface.label}>
                  {surface.label} {surface.percent}%
                </span>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="elevation-empty">No elevation data in this track.</div>
      )}
    </div>
  );
}
