/**
 * Grayscale preparation for the weapon-image tracer.
 *
 * The tracer only ever sees a scalar field plus an alpha mask, which keeps the
 * contour maths free of DOM types and unit-testable in plain Node.
 */

export interface GrayField {
  /** 0–255 luma, composited over white. */
  data: Float32Array;
  /** 0–255 source alpha; transparent pixels can never become foreground. */
  alpha: Uint8Array;
  width: number;
  height: number;
  hasTransparency: boolean;
  /** Share of pixels below the alpha cutoff, in 0–1. */
  transparentRatio: number;
}

export type Polarity = 'bright' | 'dark';

const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;
/** Below this alpha a pixel is treated as fully transparent. */
export const ALPHA_CUTOFF = 96;

/** Converts RGBA bytes into a composited grayscale field. */
export function toGrayField(pixels: Uint8ClampedArray, width: number, height: number): GrayField {
  const count = width * height;
  const data = new Float32Array(count);
  const alpha = new Uint8Array(count);
  let transparent = 0;
  for (let i = 0; i < count; i += 1) {
    const offset = i * 4;
    const a = pixels[offset + 3];
    alpha[i] = a;
    if (a < ALPHA_CUTOFF) transparent += 1;
    const mix = a / 255;
    const r = pixels[offset] * mix + 255 * (1 - mix);
    const g = pixels[offset + 1] * mix + 255 * (1 - mix);
    const b = pixels[offset + 2] * mix + 255 * (1 - mix);
    data[i] = LUMA_R * r + LUMA_G * g + LUMA_B * b;
  }
  return { data, alpha, width, height, hasTransparency: transparent > 0, transparentRatio: count ? transparent / count : 0 };
}

/**
 * Otsu's between-class variance maximisation over a 256-bin histogram.
 *
 * The returned level is the midpoint between the two class means rather than
 * the winning histogram bin. On hard black-and-white artwork Otsu's bin is 0
 * (the level sits below the object), which would make the background count as
 * foreground; the midpoint stays inside the real gap.
 */
export function otsuThreshold(gray: Float32Array): number {
  const histogram = new Float64Array(256);
  for (let i = 0; i < gray.length; i += 1) {
    const bin = Math.min(255, Math.max(0, Math.round(gray[i])));
    histogram[bin] += 1;
  }
  const total = gray.length;
  if (!total) return 128;
  let sum = 0;
  for (let bin = 0; bin < 256; bin += 1) sum += bin * histogram[bin];
  let sumBackground = 0;
  let weightBackground = 0;
  let best = 128;
  let bestVariance = -1;
  for (let bin = 0; bin < 256; bin += 1) {
    weightBackground += histogram[bin];
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += bin * histogram[bin];
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const variance = weightBackground * weightForeground * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = (meanBackground + meanForeground) / 2;
    }
  }
  return Math.min(255, Math.max(0, best));
}

/**
 * Decides which side of the threshold holds the object, by looking at the
 * image border: whatever frames the picture is the background.
 */
export function autoPolarity(gray: Float32Array, width: number, height: number, threshold: number): Polarity {
  const band = Math.max(1, Math.min(3, Math.floor(Math.min(width, height) / 20)));
  let sum = 0;
  let count = 0;
  const accumulate = (x: number, y: number) => {
    sum += gray[y * width + x];
    count += 1;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const onBorder = x < band || y < band || x >= width - band || y >= height - band;
      if (onBorder) accumulate(x, y);
    }
  }
  if (!count) return 'bright';
  // Strictly brighter than the level: otherwise a black border at level 0 would
  // be misread as a bright background.
  return sum / count > threshold ? 'dark' : 'bright';
}

/** Separable Gaussian blur; `sigma <= 0` returns a copy. */
export function gaussianBlur(gray: Float32Array, width: number, height: number, sigma: number): Float32Array {
  if (sigma <= 0 || width < 2 || height < 2) return gray.slice();
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  const denominator = 2 * sigma * sigma;
  let kernelSum = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const value = Math.exp(-(i * i) / denominator);
    kernel[i + radius] = value;
    kernelSum += value;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= kernelSum;

  const horizontal = new Float32Array(gray.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sampleX = Math.min(width - 1, Math.max(0, x + k));
        sum += gray[row + sampleX] * kernel[k + radius];
      }
      horizontal[row + x] = sum;
    }
  }

  const out = new Float32Array(gray.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sampleY = Math.min(height - 1, Math.max(0, y + k));
        sum += horizontal[sampleY * width + x] * kernel[k + radius];
      }
      out[y * width + x] = sum;
    }
  }
  return out;
}

/**
 * Forces transparent pixels to the far side of the threshold so the tracer can
 * never pick them up, whatever the smoothing did to them.
 */
export function maskOutTransparency(gray: Float32Array, alpha: Uint8Array, threshold: number, polarity: Polarity): Float32Array {
  const out = gray.slice();
  const backgroundValue = polarity === 'bright' ? threshold - 1e3 : threshold + 1e3;
  for (let i = 0; i < out.length; i += 1) {
    if (alpha[i] < ALPHA_CUTOFF) out[i] = backgroundValue;
  }
  return out;
}
