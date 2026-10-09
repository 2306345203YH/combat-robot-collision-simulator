import { describe, expect, it } from 'vitest';
import { parseSvg, parseSvgDocument, parseTransform, pathToPolylines } from './svg';
import { ringsToProfile } from './profile';
import { ringArea } from '../physics/contour';

const svg = (body: string, attrs = 'width="100mm" height="100mm" viewBox="0 0 100 100"'): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

describe('parseSvgDocument', () => {
  it('builds a tree and skips declarations and comments', () => {
    const root = parseSvgDocument('<?xml version="1.0"?><!-- hi --><svg a="1"><g><rect width="2"/></g></svg>');
    const svgNode = root.children[0];
    expect(svgNode.name).toBe('svg');
    expect(svgNode.attrs.a).toBe('1');
    expect(svgNode.children[0].children[0].name).toBe('rect');
  });

  it('does not trip over a ">" inside an attribute value', () => {
    const root = parseSvgDocument('<svg d="M0>1"><path/></svg>');
    expect(root.children[0].attrs.d).toBe('M0>1');
    expect(root.children[0].children[0].name).toBe('path');
  });
});

describe('parseTransform', () => {
  it('composes translate and scale in order', () => {
    const matrix = parseTransform('translate(10,20) scale(2)');
    expect(matrix).toEqual([2, 0, 0, 2, 10, 20]);
  });

  it('rotates about a given centre', () => {
    const matrix = parseTransform('rotate(90 5 5)');
    // (5,5) is the fixed point of the rotation.
    expect(matrix[0] * 5 + matrix[2] * 5 + matrix[4]).toBeCloseTo(5, 9);
    expect(matrix[1] * 5 + matrix[3] * 5 + matrix[5]).toBeCloseTo(5, 9);
  });
});

describe('pathToPolylines', () => {
  it('reads an absolute closed polygon', () => {
    const chains = pathToPolylines('M0 0 L10 0 L10 10 L0 10 Z');
    expect(chains).toHaveLength(1);
    expect(chains[0][0]).toEqual([0, 0]);
    expect(chains[0][chains[0].length - 1]).toEqual([0, 0]);
    expect(Math.abs(ringArea(chains[0]))).toBeCloseTo(100, 6);
  });

  it('handles relative commands and implicit repeats', () => {
    const chains = pathToPolylines('m10 10 h10 v10 h-10 z');
    expect(Math.abs(ringArea(chains[0]))).toBeCloseTo(100, 6);
  });

  it('samples curves into a smooth chain', () => {
    const chains = pathToPolylines('M0 0 C0 10 10 10 10 0');
    expect(chains[0].length).toBeGreaterThan(8);
    expect(chains[0][chains[0].length - 1][0]).toBeCloseTo(10, 9);
    expect(chains[0][chains[0].length - 1][1]).toBeCloseTo(0, 9);
  });

  it('approximates an arc with the right endpoint and radius', () => {
    const chains = pathToPolylines('M0 0 A10 10 0 0 1 10 10');
    const last = chains[0][chains[0].length - 1];
    expect(last[0]).toBeCloseTo(10, 6);
    expect(last[1]).toBeCloseTo(10, 6);
    expect(chains[0].length).toBeGreaterThan(4);
  });

  it('treats extra moveto pairs as line segments', () => {
    const chains = pathToPolylines('M0 0 10 0 10 10 0 10 Z');
    expect(Math.abs(ringArea(chains[0]))).toBeCloseTo(100, 6);
  });
});

describe('parseSvg', () => {
  it('reads a rect with millimetre units into millimetres', () => {
    const drawing = parseSvg(svg('<rect x="10" y="10" width="40" height="20"/>'));
    expect(drawing.unit).toBe('mm');
    expect(drawing.rings).toHaveLength(1);
    expect(Math.abs(ringArea(drawing.rings[0]))).toBeCloseTo(800, 3);
    const profile = ringsToProfile(drawing, drawing.unit);
    expect(profile.bounds.width).toBeCloseTo(0.04, 6);
    expect(profile.bounds.height).toBeCloseTo(0.02, 6);
  });

  it('applies the viewBox-to-width scale', () => {
    const drawing = parseSvg(svg('<rect x="0" y="0" width="50" height="50"/>', 'width="200mm" height="200mm" viewBox="0 0 100 100"'));
    const profile = ringsToProfile(drawing, drawing.unit);
    expect(profile.bounds.width).toBeCloseTo(0.1, 6);
  });

  it('mirrors the y axis because SVG grows downwards', () => {
    const drawing = parseSvg(svg('<rect x="0" y="0" width="10" height="10"/>'));
    expect(drawing.yDown).toBe(true);
    const profile = ringsToProfile(drawing, drawing.unit);
    expect(profile.outer.every(([, y]) => y <= 1e-9)).toBe(true);
  });

  it('separates a cut-out from the outline', () => {
    const drawing = parseSvg(svg('<path d="M0 0 H100 V100 H0 Z M25 25 H75 V75 H25 Z" fill-rule="evenodd"/>'));
    const profile = ringsToProfile(drawing, drawing.unit);
    expect(Math.abs(ringArea(profile.outer))).toBeCloseTo(0.01, 6);
    expect(profile.holes).toHaveLength(1);
    expect(Math.abs(ringArea(profile.holes[0]))).toBeCloseTo(0.0025, 6);
  });

  it('inherits transforms from ancestor groups', () => {
    const drawing = parseSvg(svg('<g transform="translate(10,20)"><rect x="0" y="0" width="10" height="10"/></g>'));
    expect(drawing.rings[0].some(([x, y]) => Math.abs(x - 10) < 1e-6 && Math.abs(y - 20) < 1e-6)).toBe(true);
  });

  it('reads circles and rounded rects as closed rings', () => {
    const circle = ringsToProfile(parseSvg(svg('<circle cx="50" cy="50" r="20"/>')), 'mm');
    expect(circle.bounds.width).toBeCloseTo(0.04, 3);
    const rounded = ringsToProfile(parseSvg(svg('<rect x="0" y="0" width="40" height="40" rx="10"/>')), 'mm');
    expect(rounded.bounds.width).toBeCloseTo(0.04, 6);
    expect(rounded.outer.length).toBeGreaterThan(20);
  });

  it('falls back to the chosen unit and warns when no physical size is declared', () => {
    const drawing = parseSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>', 'cm');
    expect(drawing.unit).toBe('cm');
    expect(drawing.warnings.join(' ')).toContain('物理单位');
  });

  it('throws on a file without geometry', () => {
    expect(() => parseSvg('<svg></svg>')).toThrow(/没有解析出可用/);
    expect(() => parseSvg('<html></html>')).toThrow(/svg/);
  });
});

describe('ringsToProfile', () => {
  it('keeps the largest of several separate parts and says so', () => {
    const profile = ringsToProfile({
      rings: [
        [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
        [[200, 0], [220, 0], [220, 20], [200, 20], [200, 0]],
      ],
      unit: 'mm',
      yDown: false,
      warnings: [],
    }, 'mm');
    expect(profile.bounds.width).toBeCloseTo(0.1, 6);
    expect(profile.warnings.join(' ')).toContain('额外');
  });

  it('converts inches to metres', () => {
    const profile = ringsToProfile({ rings: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]], unit: 'in', yDown: false, warnings: [] }, 'in');
    expect(profile.bounds.width).toBeCloseTo(0.0254, 8);
  });

  it('throws when there is nothing usable', () => {
    expect(() => ringsToProfile({ rings: [[[0, 0], [1, 1]]], unit: 'mm', yDown: false, warnings: [] }, 'mm')).toThrow(/闭合轮廓/);
  });
});
