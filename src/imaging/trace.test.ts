import { describe, expect, it } from 'vitest';
import { DEFAULT_TRACE_SETTINGS, countProfilePoints, traceOutlines } from './trace';
import type { TraceSettings } from './trace';
import { ringArea } from '../physics/contour';
import type { GrayField } from './threshold';

const makeField = (width: number, height: number, fill: number): GrayField => ({
  data: new Float32Array(width * height).fill(fill),
  alpha: new Uint8Array(width * height).fill(255),
  width,
  height,
  hasTransparency: false,
  transparentRatio: 0,
});

const fillRect = (field: GrayField, x0: number, y0: number, x1: number, y1: number, value: number): void => {
  for (let y = Math.max(0, y0); y < Math.min(field.height, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(field.width, x1); x += 1) field.data[y * field.width + x] = value;
  }
};

const settings = (overrides: Partial<TraceSettings> = {}): TraceSettings => ({ ...DEFAULT_TRACE_SETTINGS, ...overrides });

describe('traceOutlines', () => {
  it('recovers a bright rectangle from a dark background', () => {
    const field = makeField(120, 100, 0);
    fillRect(field, 20, 20, 80, 80, 255);
    const trace = traceOutlines(field, settings({ smoothSigma: 0 }));
    expect(trace.polarity).toBe('bright');
    expect(trace.outer).not.toBeNull();
    expect(trace.holes).toHaveLength(0);
    expect(Math.abs(ringArea(trace.outer!))).toBeGreaterThan(3000);
    expect(Math.abs(ringArea(trace.outer!))).toBeLessThan(4200);
    expect(trace.rings.filter((ring) => ring.accepted)).toHaveLength(1);
  });

  it('recovers a dark rectangle from a bright background', () => {
    const field = makeField(120, 100, 255);
    fillRect(field, 20, 20, 80, 80, 0);
    const trace = traceOutlines(field, settings({ smoothSigma: 0 }));
    expect(trace.polarity).toBe('dark');
    expect(trace.outer).not.toBeNull();
    expect(Math.abs(ringArea(trace.outer!))).toBeGreaterThan(3000);
    expect(Math.abs(ringArea(trace.outer!))).toBeLessThan(4200);
  });

  it('splits an inner hole out of the outline', () => {
    const field = makeField(120, 120, 0);
    fillRect(field, 20, 20, 100, 100, 255);
    fillRect(field, 45, 45, 75, 75, 0);
    const trace = traceOutlines(field, settings({ smoothSigma: 0 }));
    expect(trace.outer).not.toBeNull();
    expect(trace.holes).toHaveLength(1);
    expect(Math.abs(ringArea(trace.holes[0]))).toBeGreaterThan(700);
    expect(Math.abs(ringArea(trace.holes[0]))).toBeLessThan(1100);
  });

  it('returns centre candidates near the middle of a symmetric outline', () => {
    const field = makeField(120, 100, 0);
    fillRect(field, 20, 20, 80, 80, 255);
    const trace = traceOutlines(field, settings({ smoothSigma: 0 }));
    expect(trace.centers.map((candidate) => candidate.id)).toEqual(['centroid', 'circle', 'bbox']);
    for (const candidate of trace.centers) {
      // Marching squares runs along pixel borders, so the rectangle spans
      // 19.5 … 79.5 and every centre sits at 49.5.
      expect(Math.abs(candidate.point[0] - 49.5)).toBeLessThan(1);
      expect(Math.abs(candidate.point[1] - 49.5)).toBeLessThan(1);
    }
  });

  it('keeps the winding predictable: outline counter-clockwise, holes clockwise', () => {
    const field = makeField(120, 120, 0);
    fillRect(field, 20, 20, 100, 100, 255);
    fillRect(field, 45, 45, 75, 75, 0);
    const trace = traceOutlines(field, settings({ smoothSigma: 0 }));
    expect(ringArea(trace.outer!)).toBeGreaterThan(0);
    expect(ringArea(trace.holes[0])).toBeLessThan(0);
  });

  it('uses the transparency mask automatically for cut-out art', () => {
    const field = makeField(120, 100, 255);
    field.hasTransparency = true;
    field.alpha.fill(0);
    for (let y = 20; y < 80; y += 1) for (let x = 20; x < 80; x += 1) field.alpha[y * 120 + x] = 255;
    field.transparentRatio = 1 - 3600 / 12000;
    const trace = traceOutlines(field, settings({ smoothSigma: 0 }));
    expect(trace.mode).toBe('alpha');
    expect(trace.outer).not.toBeNull();
    expect(Math.abs(ringArea(trace.outer!))).toBeGreaterThan(3000);
    expect(Math.abs(ringArea(trace.outer!))).toBeLessThan(4200);
  });

  it('never lets transparent pixels become foreground in tone mode', () => {
    const field = makeField(120, 100, 0);
    fillRect(field, 20, 20, 80, 80, 255);
    // A transparent band that is bright enough to look like an object.
    const alpha = field.alpha;
    for (let y = 0; y < 15; y += 1) for (let x = 0; x < 120; x += 1) {
      field.data[y * 120 + x] = 255;
      alpha[y * 120 + x] = 0;
    }
    const trace = traceOutlines(field, settings({ smoothSigma: 0, foreground: 'bright' }));
    expect(trace.mode).toBe('tone');
    expect(trace.outer).not.toBeNull();
    expect(Math.abs(ringArea(trace.outer!))).toBeLessThan(4200);
  });

  it('falls back to tone mode when transparency is negligible', () => {
    const field = makeField(120, 100, 0);
    fillRect(field, 20, 20, 80, 80, 255);
    field.hasTransparency = true;
    field.transparentRatio = 0.001;
    field.alpha[0] = 0;
    const trace = traceOutlines(field, settings({ smoothSigma: 0 }));
    expect(trace.mode).toBe('tone');
    expect(trace.outer).not.toBeNull();
  });

  it('drops holes below the minimum area and says so', () => {
    const field = makeField(120, 120, 0);
    fillRect(field, 20, 20, 100, 100, 255);
    fillRect(field, 55, 55, 60, 60, 0);
    const trace = traceOutlines(field, settings({ smoothSigma: 0, minHoleArea: 500 }));
    expect(trace.holes).toHaveLength(0);
    expect(trace.warnings.join(' ')).toContain('最小孔面积');
  });

  it('keeps only the largest part and warns about the rest', () => {
    const field = makeField(200, 120, 0);
    fillRect(field, 20, 20, 100, 100, 255);
    fillRect(field, 130, 30, 160, 60, 255);
    const trace = traceOutlines(field, settings({ smoothSigma: 0 }));
    expect(trace.outer).not.toBeNull();
    expect(Math.abs(ringArea(trace.outer!))).toBeGreaterThan(5000);
    expect(trace.warnings.join(' ')).toContain('独立区域');
    expect(trace.rings.some((ring) => ring.label.includes('未采用'))).toBe(true);
  });

  it('reports a usable failure when nothing is found', () => {
    const field = makeField(64, 64, 0);
    const trace = traceOutlines(field, settings());
    expect(trace.outer).toBeNull();
    expect(trace.holes).toEqual([]);
    expect(trace.warnings).toHaveLength(1);
  });

  it('honours a manual threshold and foreground override', () => {
    const field = makeField(120, 100, 40);
    fillRect(field, 20, 20, 80, 80, 210);
    const automatic = traceOutlines(field, settings({ smoothSigma: 0 }));
    const manual = traceOutlines(field, settings({ smoothSigma: 0, threshold: 125, foreground: 'bright' }));
    expect(automatic.outer).not.toBeNull();
    expect(manual.outer).not.toBeNull();
    expect(manual.threshold).toBe(125);
  });

  it('shrinks the point count to respect the budget', () => {
    const field = makeField(400, 400, 0);
    // A filled circle sampled coarsely by the field itself; the budget then has
    // to bring the ring down below the limit.
    for (let y = 0; y < 400; y += 1) {
      for (let x = 0; x < 400; x += 1) {
        if (Math.hypot(x - 200, y - 200) < 150) field.data[y * 400 + x] = 255;
      }
    }
    const trace = traceOutlines(field, settings({ smoothSigma: 1, maxPoints: 120 }));
    expect(trace.outer).not.toBeNull();
    expect(countProfilePoints(trace.outer, trace.holes)).toBeLessThanOrEqual(120);
    expect(trace.toleranceUsed).toBeGreaterThan(0);
  });

  it('still finds the outline after smoothing', () => {
    const field = makeField(160, 160, 0);
    fillRect(field, 40, 40, 120, 120, 255);
    const trace = traceOutlines(field, settings({ smoothSigma: 2 }));
    expect(trace.outer).not.toBeNull();
    expect(Math.abs(ringArea(trace.outer!))).toBeGreaterThan(5000);
  });
});
