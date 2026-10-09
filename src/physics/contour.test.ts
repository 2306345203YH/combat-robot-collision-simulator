import { describe, expect, it } from 'vitest';
import {
  boundsOf,
  centerCandidates,
  classifyRings,
  dedupeRing,
  minimumEnclosingCircle,
  pointInRing,
  ringArea,
  ringCentroid,
  ringContains,
  selectPrimaryRings,
  simplifyRing,
} from './contour';
import type { Vec2 } from '../types';

const square = (min: number, max: number, offset: Vec2 = [0, 0], clockwise = false): Vec2[] => {
  const ring: Vec2[] = [
    [min, min],
    [max, min],
    [max, max],
    [min, max],
  ].map(([x, y]) => [x + offset[0], y + offset[1]]);
  return clockwise ? ring.reverse() : ring;
};

const circleRing = (radius: number, count: number): Vec2[] =>
  Array.from({ length: count }, (_, index): Vec2 => {
    const angle = (index / count) * Math.PI * 2;
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  });

describe('ring primitives', () => {
  it('signs the shoelace area by winding direction', () => {
    expect(ringArea(square(0, 10))).toBeCloseTo(100, 9);
    expect(ringArea(square(0, 10, [0, 0], true))).toBeCloseTo(-100, 9);
  });

  it('returns the area centroid of an offset square', () => {
    const centroid = ringCentroid(square(0, 10, [101, 250]));
    expect(centroid[0]).toBeCloseTo(106, 9);
    expect(centroid[1]).toBeCloseTo(255, 9);
  });

  it('falls back to the vertex average for degenerate rings', () => {
    const centroid = ringCentroid([[0, 0], [4, 0], [0, 0], [4, 0]]);
    expect(centroid[0]).toBeCloseTo(2, 9);
    expect(centroid[1]).toBeCloseTo(0, 9);
  });

  it('reports bounds and centre of a point set', () => {
    const bounds = boundsOf([[3, -2], [11, 9], [-1, 4]]);
    expect(bounds.min).toEqual([-1, -2]);
    expect(bounds.max).toEqual([11, 9]);
    expect(bounds.center).toEqual([5, 3.5]);
    expect(bounds.width).toBe(12);
    expect(bounds.height).toBe(11);
  });

  it('classifies points against a ring', () => {
    const ring = square(0, 10);
    expect(pointInRing([5, 5], ring)).toBe(true);
    expect(pointInRing([15, 5], ring)).toBe(false);
  });

  it('detects containment independently of winding', () => {
    expect(ringContains(square(0, 100), square(40, 60))).toBe(true);
    expect(ringContains(square(40, 60), square(0, 100))).toBe(false);
    expect(ringContains(square(0, 100), square(110, 120))).toBe(false);
  });

  it('drops repeated consecutive vertices and the wrap-around duplicate', () => {
    const ring: Vec2[] = [[0, 0], [0, 0], [10, 0], [10, 10], [10, 10], [0, 10], [0, 0]];
    expect(dedupeRing(ring)).toEqual([[0, 0], [10, 0], [10, 10], [0, 10]]);
  });
});

describe('simplifyRing', () => {
  it('keeps the ring untouched when no tolerance is requested', () => {
    const ring = circleRing(100, 64);
    expect(simplifyRing(ring, 0)).toHaveLength(64);
  });

  it('removes vertices that sit inside the tolerance band', () => {
    const simplified = simplifyRing(circleRing(100, 64), 1);
    expect(simplified.length).toBeLessThan(64);
    expect(simplified.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps sharp corners of a rectangle', () => {
    const simplified = simplifyRing(square(0, 20), 2);
    expect(simplified).toHaveLength(4);
    expect(ringArea(simplified)).toBeCloseTo(400, 6);
  });
});

describe('classifyRings / selectPrimaryRings', () => {
  it('assigns nesting depth to outline, hole and island', () => {
    const classified = classifyRings([square(40, 60), square(0, 100), square(45, 55)]);
    const byDepth = new Map(classified.map((entry) => [entry.area, entry.depth]));
    expect(byDepth.get(100 * 100)).toBe(0);
    expect(byDepth.get(20 * 20)).toBe(1);
    expect(byDepth.get(10 * 10)).toBe(2);
  });

  it('picks the largest outline and the holes inside it', () => {
    const classification = classifyRings([square(0, 100), square(40, 60), square(200, 300), square(45, 55)]);
    const selection = selectPrimaryRings(classification);
    expect(selection.outer).not.toBeNull();
    expect(ringArea(selection.outer!)).toBeCloseTo(100 * 100, 6);
    expect(selection.holes).toHaveLength(1);
    expect(ringArea(selection.holes[0])).toBeCloseTo(20 * 20, 6);
    expect(selection.strayParts).toHaveLength(1);
    expect(ringArea(selection.strayParts[0])).toBeCloseTo(100 * 100, 6);
    expect(selection.islands).toHaveLength(1);
  });

  it('reports nothing usable for degenerate input', () => {
    const selection = selectPrimaryRings(classifyRings([[[0, 0], [1, 1]]]));
    expect(selection.outer).toBeNull();
    expect(selection.holes).toEqual([]);
  });
});

describe('minimumEnclosingCircle', () => {
  it('matches the circumcircle of a triangle', () => {
    const circle = minimumEnclosingCircle([[0, 0], [10, 0], [5, 5]]);
    expect(circle.center[0]).toBeCloseTo(5, 9);
    expect(circle.center[1]).toBeCloseTo(0, 9);
    expect(circle.radius).toBeCloseTo(5, 9);
  });

  it('centres a single repeated point', () => {
    const circle = minimumEnclosingCircle([[7, 3], [7, 3], [7, 3]]);
    expect(circle.center).toEqual([7, 3]);
    expect(circle.radius).toBeCloseTo(0, 9);
  });

  it('is deterministic for the same input', () => {
    const points = circleRing(50, 37);
    expect(minimumEnclosingCircle(points)).toEqual(minimumEnclosingCircle(points));
  });
});

describe('centerCandidates', () => {
  it('offers centroid, circumcircle and bounding-box centres', () => {
    const candidates = centerCandidates(square(0, 10, [20, 20]));
    expect(candidates.map((candidate) => candidate.id)).toEqual(['centroid', 'circle', 'bbox']);
    for (const candidate of candidates) {
      expect(candidate.point[0]).toBeCloseTo(25, 9);
      expect(candidate.point[1]).toBeCloseTo(25, 9);
    }
  });

  it('returns nothing for a degenerate outline', () => {
    expect(centerCandidates([[0, 0], [1, 1]])).toEqual([]);
  });
});
