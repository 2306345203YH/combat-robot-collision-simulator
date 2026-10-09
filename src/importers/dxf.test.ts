import { describe, expect, it } from 'vitest';
import { bulgeArc, chainEdges, parseDxf } from './dxf';
import { ringsToProfile } from './profile';
import { ringArea } from '../physics/contour';

/** Builds the code/value pair stream DXF files are made of. */
const dxf = (lines: Array<[number, string | number]>): string => lines.map(([code, value]) => `${code}\n${value}`).join('\n');

const withEntities = (entities: Array<[number, string | number]>, header?: Array<[number, string | number]>): string => dxf([
  ...(header ?? []),
  [0, 'SECTION'], [2, 'ENTITIES'],
  ...entities,
  [0, 'ENDSEC'], [0, 'EOF'],
]);

describe('parseDxf', () => {
  it('reads a closed LWPOLYLINE as one ring', () => {
    const drawing = parseDxf(withEntities([
      [0, 'LWPOLYLINE'], [70, 1], [90, 4],
      [10, 0], [20, 0],
      [10, 100], [20, 0],
      [10, 100], [20, 60],
      [10, 0], [20, 60],
    ]));
    expect(drawing.rings).toHaveLength(1);
    expect(Math.abs(ringArea(drawing.rings[0]))).toBeCloseTo(6000, 3);
    expect(drawing.yDown).toBe(false);
    expect(drawing.unit).toBe('mm');
  });

  it('joins separate LINE entities into a closed ring', () => {
    const drawing = parseDxf(withEntities([
      [0, 'LINE'], [10, 0], [20, 0], [11, 40], [21, 0],
      [0, 'LINE'], [10, 40], [20, 0], [11, 40], [21, 20],
      [0, 'LINE'], [10, 40], [20, 20], [11, 0], [21, 20],
      [0, 'LINE'], [10, 0], [20, 20], [11, 0], [21, 0],
    ]));
    expect(drawing.rings).toHaveLength(1);
    expect(Math.abs(ringArea(drawing.rings[0]))).toBeCloseTo(800, 3);
  });

  it('reads POLYLINE vertices held in child VERTEX entities', () => {
    const drawing = parseDxf(withEntities([
      [0, 'POLYLINE'], [70, 1],
      [0, 'VERTEX'], [10, 0], [20, 0],
      [0, 'VERTEX'], [10, 10], [20, 0],
      [0, 'VERTEX'], [10, 10], [20, 10],
      [0, 'SEQEND'],
    ]));
    expect(drawing.rings).toHaveLength(1);
    expect(Math.abs(ringArea(drawing.rings[0]))).toBeCloseTo(50, 3);
  });

  it('samples a CIRCLE into a closed ring', () => {
    const drawing = parseDxf(withEntities([[0, 'CIRCLE'], [10, 0], [20, 0], [40, 25]]));
    expect(drawing.rings).toHaveLength(1);
    // The ring is an inscribed polygon, so it is slightly smaller than the
    // exact circle area.
    const area = Math.abs(ringArea(drawing.rings[0]));
    expect(area).toBeGreaterThan(Math.PI * 625 * 0.999);
    expect(area).toBeLessThanOrEqual(Math.PI * 625);
  });

  it('ignores an ARC that cannot close', () => {
    const quarter = parseDxf(withEntities([[0, 'ARC'], [10, 0], [20, 0], [40, 10], [50, 0], [51, 90]]));
    expect(quarter.rings).toHaveLength(0);
    expect(quarter.warnings.join(' ')).toContain('没有闭合');
  });

  it('closes two complementary ARCs into one ring', () => {
    const full = parseDxf(withEntities([
      [0, 'ARC'], [10, 0], [20, 0], [40, 10], [50, 0], [51, 180],
      [0, 'ARC'], [10, 0], [20, 0], [40, 10], [50, 180], [51, 360],
    ]));
    expect(full.rings).toHaveLength(1);
    const area = Math.abs(ringArea(full.rings[0]));
    expect(area).toBeGreaterThan(Math.PI * 100 * 0.999);
    expect(area).toBeLessThanOrEqual(Math.PI * 100);
  });

  it('honours $INSUNITS from the header', () => {
    const header: Array<[number, string | number]> = [
      [0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 1], [0, 'ENDSEC'],
    ];
    const drawing = parseDxf(withEntities([[0, 'CIRCLE'], [10, 0], [20, 0], [40, 1]], header));
    expect(drawing.unit).toBe('in');
    const profile = ringsToProfile(drawing, drawing.unit);
    expect(profile.bounds.width).toBeCloseTo(0.0508, 4);
  });

  it('rejects binary DXF with an actionable message', () => {
    expect(() => parseDxf('AutoCAD Binary DXF\r\n\u001a\u0000rest')).toThrow(/二进制/);
  });

  it('reports a corrupt group-code stream instead of guessing', () => {
    expect(() => parseDxf('not-a-code\nvalue\n')).toThrow(/组码/);
  });

  it('throws when the file has no usable geometry', () => {
    expect(() => parseDxf(withEntities([[0, 'TEXT'], [1, 'hello']]))).toThrow(/没有解析出可用/);
  });
});

describe('bulgeArc', () => {
  it('returns the straight segment for a zero bulge', () => {
    expect(bulgeArc([0, 0], [10, 0], 0)).toEqual([[0, 0], [10, 0]]);
  });

  it('bulges counter-clockwise for a positive value', () => {
    // bulge = tan(90°/4) = 1 is a quarter turn; the arc must leave (0,0) below
    // the chord for a counter-clockwise sweep in a y-up frame.
    const points = bulgeArc([0, 0], [10, 0], 1);
    expect(points.length).toBeGreaterThan(4);
    const middle = points[Math.floor(points.length / 2)];
    expect(middle[1]).toBeLessThan(0);
    expect(Math.abs(points[points.length - 1][0] - 10)).toBeLessThan(1e-6);
    expect(Math.abs(points[points.length - 1][1])).toBeLessThan(1e-6);
  });

  it('sweeps past a half turn when |bulge| > 1', () => {
    const points = bulgeArc([0, 0], [10, 0], 2);
    const middle = points[Math.floor(points.length / 2)];
    expect(middle[0]).toBeLessThan(10);
    expect(points.length).toBeGreaterThan(10);
  });
});

describe('chainEdges', () => {
  it('reverses candidates to close a loop', () => {
    const { rings, openChains } = chainEdges([
      [[0, 0], [10, 0]],
      [[10, 10], [10, 0]],
      [[0, 10], [10, 10]],
      [[0, 0], [0, 10]],
    ], 1e-6);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(5);
    expect(openChains).toHaveLength(0);
  });

  it('reports a multi-point chain that never closes', () => {
    const { rings, openChains } = chainEdges([[[0, 0], [5, 0], [10, 0], [10, 10]]], 1e-6);
    expect(rings).toHaveLength(0);
    expect(openChains).toHaveLength(1);
  });

  it('drops chains that are too short to be an outline', () => {
    const { rings, openChains } = chainEdges([[[0, 0], [10, 0]]], 1e-6);
    expect(rings).toHaveLength(0);
    expect(openChains).toHaveLength(0);
  });
});
