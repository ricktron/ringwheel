import { useEffect, useMemo, useRef, useState } from 'react';
import { MERCY_TAXON, RING_KEYS, type RingConfig, type RingKey, type SpinTriple } from '../utils/spin-engine';
import { layoutSlices, nextRotation } from '../utils/wheel-geometry';

/**
 * Concentric three-ring wheel.
 *
 * Adapted from the MultiRingSpinner in the ringwheel-classroom-spinner
 * prototype, with one essential difference: each ring stops with the slice
 * that was actually chosen under the pointer. The engine decides the result
 * first and the animation only presents it.
 *
 * Slice size is proportional to weight, so unequal odds are visible on the wheel.
 */

const SIZE = 600;
const CENTER = SIZE / 2;

interface RingGeometry {
  outer: number;
  inner: number;
  fontSize: number;
  /** Two alternating fills. */
  fills: [string, string];
  text: string;
  title: string;
  /** Spin direction: 1 clockwise, -1 counter-clockwise. */
  direction: 1 | -1;
}

// Taxon sits on the outside because it has the most slices and the longest labels.
const GEOMETRY: Record<RingKey, RingGeometry> = {
  taxon: { outer: 290, inner: 214, fontSize: 16, fills: ['hsl(160 55% 26%)', 'hsl(160 55% 32%)'], text: 'hsl(0 0% 98%)', title: 'Taxon', direction: 1 },
  region: { outer: 210, inner: 140, fontSize: 15, fills: ['hsl(226 60% 42%)', 'hsl(226 60% 50%)'], text: 'hsl(0 0% 98%)', title: 'Region', direction: -1 },
  iucn: { outer: 136, inner: 68, fontSize: 22, fills: ['hsl(38 95% 54%)', 'hsl(25 95% 58%)'], text: 'hsl(220 26% 10%)', title: 'IUCN', direction: 1 },
};

/** Draw order: outermost first so inner rings paint on top. */
const DRAW_ORDER: RingKey[] = ['taxon', 'region', 'iucn'];

/** Point on a circle. Angle 0 is straight up, increasing clockwise. */
function polar(radius: number, angleDeg: number): [number, number] {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [CENTER + radius * Math.cos(rad), CENTER + radius * Math.sin(rad)];
}

function annulusPath(outer: number, inner: number, start: number, sweep: number): string {
  // A single slice covering the full circle cannot be drawn as one arc.
  const end = start + Math.min(sweep, 359.99);
  const large = sweep > 180 ? 1 : 0;
  const [x1, y1] = polar(outer, start);
  const [x2, y2] = polar(outer, end);
  const [x3, y3] = polar(inner, end);
  const [x4, y4] = polar(inner, start);
  return `M ${x1} ${y1} A ${outer} ${outer} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${inner} ${inner} 0 ${large} 0 ${x4} ${y4} Z`;
}

export interface RingWheelProps {
  config: RingConfig;
  /** The outcome the wheel should show. Null before the first spin. */
  result: SpinTriple | null;
  /** Rings that should do a full spin for the current `spinId`. */
  spinningRings: RingKey[];
  /** Changes every time a new spin animation should start. */
  spinId: number;
  durationMs: number;
  /** Ring currently chosen as the veto target. */
  selectedRing: RingKey | null;
  onSelectRing?: (ring: RingKey) => void;
  /** True once the animation has finished and the result may be highlighted. */
  settled: boolean;
}

export function RingWheel({
  config,
  result,
  spinningRings,
  spinId,
  durationMs,
  selectedRing,
  onSelectRing,
  settled,
}: RingWheelProps) {
  const slices = useMemo(
    () => ({
      region: layoutSlices(config, 'region', result?.region),
      taxon: layoutSlices(config, 'taxon', result?.taxon),
      iucn: layoutSlices(config, 'iucn', result?.iucn),
    }),
    [config, result?.region, result?.taxon, result?.iucn]
  );

  const [rotations, setRotations] = useState<Record<RingKey, number>>({ region: 0, taxon: 0, iucn: 0 });
  const [animated, setAnimated] = useState<RingKey[]>([]);
  const lastSpinId = useRef(spinId);

  useEffect(() => {
    const isNewSpin = spinId !== lastSpinId.current;
    lastSpinId.current = spinId;
    const spinning = isNewSpin ? spinningRings : [];
    setAnimated(spinning);
    setRotations((prev) => {
      const next = { ...prev };
      for (const ring of RING_KEYS) {
        const slice = result ? slices[ring].find((s) => s.label === result[ring]) : undefined;
        if (!slice) continue;
        next[ring] = nextRotation(prev[ring], slice.center, GEOMETRY[ring].direction, spinning.includes(ring));
      }
      return next;
    });
    // spinningRings is read only when spinId changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spinId, result, slices]);

  const summary = result
    ? `Ring wheel showing Region ${result.region}, Taxon ${result.taxon}, IUCN ${result.iucn}`
    : 'Ring wheel. No spin yet.';

  return (
    <svg
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={summary}
      data-testid="ring-wheel"
      className="w-full h-auto max-w-[min(92vw,74vh)] mx-auto select-none drop-shadow-[0_0_40px_hsl(45_100%_55%/0.25)]"
    >
      <circle cx={CENTER} cy={CENTER} r={296} fill="hsl(220 26% 9%)" stroke="var(--color-sun)" strokeWidth={4} />

      {DRAW_ORDER.map((ring) => {
        const geo = GEOMETRY[ring];
        const mid = (geo.outer + geo.inner) / 2;
        const isSelected = selectedRing === ring;
        return (
          <g
            key={ring}
            className="ring-rotor"
            data-ring={ring}
            data-rotation={rotations[ring]}
            style={{
              transform: `rotate(${rotations[ring]}deg)`,
              transitionDuration: `${animated.includes(ring) ? durationMs : 350}ms`,
              cursor: onSelectRing ? 'pointer' : undefined,
            }}
            onClick={onSelectRing ? () => onSelectRing(ring) : undefined}
          >
            {slices[ring].map((slice, index) => {
              const isResult = settled && result?.[ring] === slice.label;
              const isMercySlice = ring === 'taxon' && slice.label === MERCY_TAXON;
              const arcLength = (slice.sweep / 360) * 2 * Math.PI * mid;
              const estimatedWidth = slice.label.length * geo.fontSize * 0.6;
              const [tx, ty] = polar(mid, slice.center);
              return (
                <g key={slice.label}>
                  <path
                    d={annulusPath(geo.outer, geo.inner, slice.start, slice.sweep)}
                    fill={isMercySlice ? 'hsl(140 45% 20%)' : geo.fills[index % 2]}
                    stroke={isResult ? 'var(--color-sun)' : 'hsl(220 26% 9%)'}
                    strokeWidth={isResult ? 5 : 2}
                    strokeDasharray={isMercySlice && !isResult ? '6 5' : undefined}
                  />
                  <text
                    x={tx}
                    y={ty}
                    fill={isMercySlice ? 'hsl(140 60% 78%)' : geo.text}
                    fontSize={geo.fontSize}
                    fontWeight={700}
                    textAnchor="middle"
                    dominantBaseline="central"
                    transform={`rotate(${slice.center}, ${tx}, ${ty})`}
                    textLength={estimatedWidth > arcLength * 0.86 ? arcLength * 0.86 : undefined}
                    lengthAdjust="spacingAndGlyphs"
                  >
                    {slice.label}
                  </text>
                </g>
              );
            })}
            {isSelected && (
              <circle
                cx={CENTER}
                cy={CENTER}
                r={mid}
                fill="none"
                stroke="var(--color-bad)"
                strokeWidth={geo.outer - geo.inner}
                strokeOpacity={0.28}
                pointerEvents="none"
              />
            )}
          </g>
        );
      })}

      {/* Hub */}
      <circle cx={CENTER} cy={CENTER} r={62} fill="hsl(220 26% 12%)" stroke="var(--color-sun)" strokeWidth={4} />
      <circle cx={CENTER} cy={CENTER} r={12} fill="var(--color-sun)" />

      {/* Pointer: fixed at the top, pointing down at the winning slices. */}
      <path
        d={`M ${CENTER - 18} 0 L ${CENTER + 18} 0 L ${CENTER} 34 Z`}
        fill="var(--color-sun)"
        stroke="hsl(220 26% 9%)"
        strokeWidth={3}
      />
    </svg>
  );
}

/** Small key explaining which ring is which, outermost first. */
export function RingLegend() {
  return (
    <ul className="flex flex-wrap justify-center gap-x-5 gap-y-1 text-sm text-ink-dim" aria-label="Ring key">
      {DRAW_ORDER.map((ring, index) => (
        <li key={ring} className="flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-full" style={{ background: GEOMETRY[ring].fills[1] }} aria-hidden="true" />
          {['Outer', 'Middle', 'Inner'][index]}: {GEOMETRY[ring].title}
        </li>
      ))}
    </ul>
  );
}
