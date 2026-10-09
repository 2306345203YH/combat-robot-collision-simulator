import { describe, expect, it } from 'vitest';
import { ALPHA_CUTOFF, autoPolarity, gaussianBlur, maskOutTransparency, otsuThreshold, toGrayField } from './threshold';

const pixelsOf = (values: Array<[number, number, number, number]>): Uint8ClampedArray => new Uint8ClampedArray(values.flat());

describe('toGrayField', () => {
  it('converts opaque colours by luma', () => {
    const field = toGrayField(pixelsOf([[255, 255, 255, 255], [0, 0, 0, 255], [255, 0, 0, 255]]), 3, 1);
    expect(field.data[0]).toBeCloseTo(255, 4);
    expect(field.data[1]).toBeCloseTo(0, 4);
    expect(field.data[2]).toBeCloseTo(76.245, 2);
    expect(field.hasTransparency).toBe(false);
  });

  it('composites transparent pixels over white and flags them', () => {
    const field = toGrayField(pixelsOf([[0, 0, 0, 0], [0, 0, 0, 128], [0, 0, 0, 255]]), 3, 1);
    expect(field.data[0]).toBeCloseTo(255, 4);
    expect(field.data[1]).toBeCloseTo(127, 4);
    expect(field.data[2]).toBeCloseTo(0, 4);
    expect(field.alpha[0]).toBe(0);
    expect(field.hasTransparency).toBe(true);
    expect(field.transparentRatio).toBeCloseTo(1 / 3, 6);
  });

  it('reports no transparency for a fully opaque image', () => {
    const field = toGrayField(pixelsOf([[1, 2, 3, 255], [4, 5, 6, 255]]), 2, 1);
    expect(field.hasTransparency).toBe(false);
    expect(field.transparentRatio).toBe(0);
  });
});

describe('otsuThreshold', () => {
  it('separates a bright object from a dark background', () => {
    const gray = new Float32Array(100).fill(0);
    gray.fill(255, 0, 40);
    const threshold = otsuThreshold(gray);
    expect(threshold).toBeGreaterThan(0);
    expect(threshold).toBeLessThan(255);
    expect(threshold).toBeCloseTo(127.5, 4);
  });

  it('separates a dark object from a bright background', () => {
    const gray = new Float32Array(100).fill(255);
    gray.fill(0, 0, 40);
    expect(otsuThreshold(gray)).toBeCloseTo(127.5, 4);
  });

  it('returns a neutral level for a uniform image', () => {
    expect(otsuThreshold(new Float32Array(64).fill(200))).toBe(128);
  });
});

describe('autoPolarity', () => {
  it('treats a bright object on a dark border as bright', () => {
    const width = 32;
    const height = 32;
    const gray = new Float32Array(width * height).fill(0);
    for (let y = 8; y < 24; y += 1) for (let x = 8; x < 24; x += 1) gray[y * width + x] = 255;
    expect(autoPolarity(gray, width, height, otsuThreshold(gray))).toBe('bright');
  });

  it('treats a dark object on a bright border as dark', () => {
    const width = 32;
    const height = 32;
    const gray = new Float32Array(width * height).fill(255);
    for (let y = 8; y < 24; y += 1) for (let x = 8; x < 24; x += 1) gray[y * width + x] = 0;
    expect(autoPolarity(gray, width, height, otsuThreshold(gray))).toBe('dark');
  });
});

describe('gaussianBlur', () => {
  it('leaves a constant field unchanged', () => {
    const gray = new Float32Array(64).fill(120);
    const blurred = gaussianBlur(gray, 8, 8, 1.5);
    for (const value of blurred) expect(value).toBeCloseTo(120, 3);
  });

  it('spreads a single bright pixel while preserving the total', () => {
    const gray = new Float32Array(81);
    gray[40] = 100;
    const blurred = gaussianBlur(gray, 9, 9, 1);
    expect(blurred[40]).toBeLessThan(100);
    expect(blurred[39]).toBeGreaterThan(0);
    const total = blurred.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(100, 3);
  });

  it('returns a copy when smoothing is disabled', () => {
    const gray = new Float32Array(4).fill(7);
    const untouched = gaussianBlur(gray, 2, 2, 0);
    expect(Array.from(untouched)).toEqual([7, 7, 7, 7]);
    untouched[0] = 1;
    expect(gray[0]).toBe(7);
  });
});

describe('maskOutTransparency', () => {
  it('forces transparent pixels to the far side of the level', () => {
    const gray = new Float32Array([255, 255, 255]);
    const alpha = new Uint8Array([255, ALPHA_CUTOFF - 1, 255]);
    const masked = maskOutTransparency(gray, alpha, 128, 'bright');
    expect(masked[0]).toBe(255);
    expect(masked[1]).toBeLessThan(0);
    expect(masked[2]).toBe(255);
    expect(gray[1]).toBe(255);
  });

  it('pushes transparent pixels above the level for dark objects', () => {
    const masked = maskOutTransparency(new Float32Array([0]), new Uint8Array([0]), 128, 'dark');
    expect(masked[0]).toBeGreaterThan(128);
  });
});
