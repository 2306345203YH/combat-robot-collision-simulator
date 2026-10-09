/**
 * Sub-pixel outline extraction for uploaded weapon images.
 *
 * Pipeline: optional Gaussian smoothing → marching squares over the grayscale
 * field → nesting classification → Douglas–Peucker simplification.  Working on
 * the smoothed scalar field (instead of a hard binary bitmap) is what gives
 * smooth, sub-pixel rings on round parts such as disks and rims.
 */
import type { Vec2 } from '../types';
import { centerCandidates, classifyRings, dedupeRing, ringArea, selectPrimaryRings, simplifyRing } from '../physics/contour';
import type { CenterCandidate } from '../physics/contour';
import { autoPolarity, gaussianBlur, maskOutTransparency, otsuThreshold } from './threshold';
import type { GrayField, Polarity } from './threshold';

/**
 * How the object is separated from its surroundings.
 *
 * `auto` uses the transparency mask when the picture really has a cut-out
 * background, and falls back to brightness otherwise.
 */
export type ForegroundMode = 'auto' | 'alpha' | 'bright' | 'dark';

export interface TraceSettings {
  /** null = Otsu automatic threshold (tone modes only). */
  threshold: number | null;
  foreground: ForegroundMode;
  /** Gaussian smoothing radius in pixels; 0 keeps the raw edges. */
  smoothSigma: number;
  /** Douglas–Peucker tolerance in pixels. */
  simplifyTolerance: number;
  /** Rings smaller than this (px²) are dropped from the hole list. */
  minHoleArea: number;
  /** Separate parts smaller than this (px²) are ignored. */
  minPartArea: number;
  /** Point budget for the whole profile; the tracer raises the tolerance to fit. */
  maxPoints: number;
}

export const DEFAULT_TRACE_SETTINGS: TraceSettings = {
  threshold: null,
  foreground: 'auto',
  smoothSigma: 1.5,
  simplifyTolerance: 1,
  minHoleArea: 64,
  minPartArea: 64,
  maxPoints: 900,
};

export interface TracedRing {
  ring: Vec2[];
  /** Absolute area in px². */
  area: number;
  depth: number;
  accepted: boolean;
  label: string;
}

export interface TracedOutline {
  outer: Vec2[] | null;
  holes: Vec2[][];
  centers: CenterCandidate[];
  /** Every closed ring that was found, largest first, for the preview overlay. */
  rings: TracedRing[];
  threshold: number;
  /** 'alpha' when the object came from the transparency mask instead of tones. */
  mode: 'tone' | 'alpha';
  /** Only meaningful in tone mode. */
  polarity: Polarity;
  /** Tolerance actually used after the point-budget pass. */
  toleranceUsed: number;
  warnings: string[];
}

/** Share of transparent pixels that makes `auto` prefer the cut-out mask. */
const ALPHA_AUTO_MIN_RATIO = 0.05;
const ALPHA_AUTO_MAX_RATIO = 0.98;
/** Level used for the transparency mask: the 50 % coverage line. */
const ALPHA_LEVEL = 127.5;

const PAD = 2;
const KEY_SCALE = 1e6;
const EDGE_TOP = 0;
const EDGE_RIGHT = 1;
const EDGE_BOTTOM = 2;
const EDGE_LEFT = 3;

/** Segment table for the 16 marching-squares cases, edges listed in pairs. */
const CASE_SEGMENTS: number[][] = [
  [],
  [EDGE_LEFT, EDGE_TOP],
  [EDGE_TOP, EDGE_RIGHT],
  [EDGE_LEFT, EDGE_RIGHT],
  [EDGE_RIGHT, EDGE_BOTTOM],
  [],
  [EDGE_TOP, EDGE_BOTTOM],
  [EDGE_LEFT, EDGE_BOTTOM],
  [EDGE_BOTTOM, EDGE_LEFT],
  [EDGE_TOP, EDGE_BOTTOM],
  [],
  [EDGE_RIGHT, EDGE_BOTTOM],
  [EDGE_LEFT, EDGE_RIGHT],
  [EDGE_TOP, EDGE_RIGHT],
  [EDGE_LEFT, EDGE_TOP],
  [],
];

/** Diagonal pairs for the two ambiguous (saddle) cases. */
const SADDLE_LINKED: number[] = [EDGE_TOP, EDGE_RIGHT, EDGE_BOTTOM, EDGE_LEFT];
const SADDLE_SPLIT: number[] = [EDGE_LEFT, EDGE_TOP, EDGE_RIGHT, EDGE_BOTTOM];

interface PaddedField {
  data: Float32Array;
  width: number;
  height: number;
}

function padField(gray: Float32Array, width: number, height: number, value: number): PaddedField {
  const paddedWidth = width + PAD * 2;
  const paddedHeight = height + PAD * 2;
  const data = new Float32Array(paddedWidth * paddedHeight).fill(value);
  for (let y = 0; y < height; y += 1) {
    data.set(gray.subarray(y * width, y * width + width), (y + PAD) * paddedWidth + PAD);
  }
  return { data, width: paddedWidth, height: paddedHeight };
}

const edgeCrossing = (v0: number, v1: number): number => {
  const denominator = v0 - v1;
  return Math.abs(denominator) < 1e-12 ? 0.5 : v0 / denominator;
};

/** Collects boundary segments for every cell, then chains them into closed rings. */
function marchingSquares(field: PaddedField, threshold: number): Vec2[][] {
  const { data, width, height } = field;
  const segmentPairs: Array<[Vec2, Vec2]> = [];
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const a = data[y * width + x] - threshold;
      const b = data[y * width + x + 1] - threshold;
      const c = data[(y + 1) * width + x + 1] - threshold;
      const d = data[(y + 1) * width + x] - threshold;
      let index = 0;
      if (a > 0) index |= 1;
      if (b > 0) index |= 2;
      if (c > 0) index |= 4;
      if (d > 0) index |= 8;
      if (index === 0 || index === 15) continue;
      const edges: Vec2[] = [
        [x + edgeCrossing(a, b), y],
        [x + 1, y + edgeCrossing(b, c)],
        [x + edgeCrossing(d, c), y + 1],
        [x, y + edgeCrossing(a, d)],
      ];
      let pairs = CASE_SEGMENTS[index];
      if (index === 5) {
        // a and c are inside; a positive centre joins them diagonally.
        pairs = (a + b + c + d) / 4 > 0 ? SADDLE_LINKED : SADDLE_SPLIT;
      } else if (index === 10) {
        // b and d are inside; a positive centre joins them diagonally.
        pairs = (a + b + c + d) / 4 > 0 ? SADDLE_SPLIT : SADDLE_LINKED;
      }
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        segmentPairs.push([edges[pairs[i]], edges[pairs[i + 1]]]);
      }
    }
  }
  return chainSegments(segmentPairs);
}

const pointKey = (point: Vec2): string => `${Math.round(point[0] * KEY_SCALE)}:${Math.round(point[1] * KEY_SCALE)}`;

function chainSegments(segments: Array<[Vec2, Vec2]>): Vec2[][] {
  const lookup = new Map<string, number[]>();
  segments.forEach((segment, index) => {
    for (const point of segment) {
      const key = pointKey(point);
      const list = lookup.get(key);
      if (list) list.push(index);
      else lookup.set(key, [index]);
    }
  });
  const used = new Uint8Array(segments.length);
  const rings: Vec2[][] = [];
  for (let start = 0; start < segments.length; start += 1) {
    if (used[start]) continue;
    used[start] = 1;
    const ring: Vec2[] = [segments[start][0], segments[start][1]];
    const startKey = pointKey(segments[start][0]);
    let tailKey = pointKey(segments[start][1]);
    let closed = false;
    for (let guard = 0; guard <= segments.length; guard += 1) {
      const candidates = lookup.get(tailKey);
      if (!candidates) break;
      let next = -1;
      for (const candidate of candidates) {
        if (!used[candidate]) {
          next = candidate;
          break;
        }
      }
      if (next < 0) break;
      used[next] = 1;
      const [p0, p1] = segments[next];
      const to = pointKey(p0) === tailKey ? p1 : p0;
      const toKey = pointKey(to);
      if (toKey === startKey) {
        closed = true;
        break;
      }
      ring.push(to);
      tailKey = toKey;
    }
    if (closed && ring.length >= 3) rings.push(ring);
  }
  return rings;
}

const withWinding = (ring: Vec2[], counterClockwise: boolean): Vec2[] => {
  const isCounterClockwise = ringArea(ring) > 0;
  return isCounterClockwise === counterClockwise ? ring : ring.slice().reverse();
};

/** Counts points across an outline and its holes. */
export const countProfilePoints = (outer: Vec2[] | null, holes: Vec2[][]): number =>
  (outer?.length ?? 0) + holes.reduce((sum, hole) => sum + hole.length, 0);

/**
 * Extracts the primary outline, its holes and rotation-centre candidates from a
 * grayscale field.  Coordinates are returned in source pixel space.
 */
export function traceOutlines(field: GrayField, settings: TraceSettings): TracedOutline {
  const warnings: string[] = [];
  const wantsAlpha = settings.foreground === 'alpha'
    || (settings.foreground === 'auto' && field.hasTransparency && field.transparentRatio >= ALPHA_AUTO_MIN_RATIO && field.transparentRatio <= ALPHA_AUTO_MAX_RATIO);
  let mode: 'tone' | 'alpha' = wantsAlpha ? 'alpha' : 'tone';
  let polarity: Polarity = 'bright';
  let threshold: number;

  if (mode === 'alpha') {
    if (!field.hasTransparency) warnings.push('图片没有透明通道，透明背景模式会把整张图片当作物体轮廓。');
    threshold = ALPHA_LEVEL;
  } else {
    threshold = settings.threshold ?? otsuThreshold(field.data);
    polarity = settings.foreground === 'bright' || settings.foreground === 'dark'
      ? settings.foreground
      : autoPolarity(field.data, field.width, field.height, threshold);
  }

  const source = mode === 'alpha' ? Float32Array.from(field.alpha) : field.data;
  let working = settings.smoothSigma > 0 ? gaussianBlur(source, field.width, field.height, settings.smoothSigma) : source.slice();
  if (mode === 'tone') {
    working = maskOutTransparency(working, field.alpha, threshold, polarity);
    if (polarity === 'dark') {
      // Mirror the field so "above threshold" always means "inside the object".
      for (let i = 0; i < working.length; i += 1) working[i] = 2 * threshold - working[i];
    }
  }
  const padded = padField(working, field.width, field.height, threshold - 1e3);
  const rawRings = marchingSquares(padded, threshold)
    .map((ring) => dedupeRing(ring.map(([x, y]): Vec2 => [x - PAD, y - PAD])))
    .filter((ring) => ring.length >= 3);

  const empty = (message: string): TracedOutline => ({
    outer: null,
    holes: [],
    centers: [],
    rings: [],
    threshold,
    mode,
    polarity,
    toleranceUsed: settings.simplifyTolerance,
    warnings: [...warnings, message],
  });

  if (!rawRings.length) return empty('未检测到闭合轮廓。请调整阈值、前景极性，或确认图片里确实有分离的物体。');

  const classified = classifyRings(rawRings);
  const selection = selectPrimaryRings(classified);
  if (!selection.outer) return empty('检测到的区域过小或退化，无法作为轮廓。请调整阈值或最小零件面积。');

  const primary = selection.outer;
  const parts = classified.filter((entry) => entry.depth === 0);
  const keptParts = parts.filter((entry) => entry.area >= settings.minPartArea);
  const strayParts = keptParts.filter((entry) => entry.ring !== primary);
  if (strayParts.length) warnings.push(`检测到 ${strayParts.length} 个独立区域，已只采用面积最大的外轮廓；其余区域可在画布上手动补充或裁剪图片。`);

  const acceptedHoleRings = new Set(selection.holes.filter((hole) => Math.abs(ringArea(hole)) >= settings.minHoleArea));
  const droppedHoles = selection.holes.length - acceptedHoleRings.size;
  if (droppedHoles > 0) warnings.push(`已按最小孔面积忽略 ${droppedHoles} 个小孔。`);
  if (selection.islands.length) warnings.push(`孔内检测到 ${selection.islands.length} 个实心岛，本版轮廓模型不支持嵌套实体，已忽略。`);

  const baseHoles = [...acceptedHoleRings];
  let tolerance = Math.max(settings.simplifyTolerance, 0);
  let outer = simplifyRing(primary, tolerance);
  let holes = baseHoles.map((hole) => simplifyRing(hole, tolerance));
  let passes = 0;
  while (countProfilePoints(outer, holes) > settings.maxPoints && passes < 24) {
    tolerance = tolerance > 0 ? tolerance * 1.4 : 0.35;
    outer = simplifyRing(primary, tolerance);
    holes = baseHoles.map((hole) => simplifyRing(hole, tolerance));
    passes += 1;
  }
  if (passes >= 24) warnings.push('自动简化达到上限仍超过点预算，请手动提高简化容差。');
  if (outer.length < 3) {
    outer = primary;
    holes = baseHoles;
    warnings.push('轮廓过于破碎，已回退到未简化的识别结果。');
  }
  holes = holes.filter((hole) => hole.length >= 3);
  const totalPoints = countProfilePoints(outer, holes);
  if (totalPoints > settings.maxPoints) warnings.push(`轮廓仍有 ${totalPoints} 个点，超过单次预算 ${settings.maxPoints}；应用前请提高简化容差。`);

  const orderedOuter = withWinding(outer, true);
  const orderedHoles = holes.map((hole) => withWinding(hole, false));

  const rings: TracedRing[] = classified.map((entry) => {
    if (entry.ring === primary) return { ring: entry.ring, area: entry.area, depth: entry.depth, accepted: true, label: '外轮廓' };
    if (acceptedHoleRings.has(entry.ring)) return { ring: entry.ring, area: entry.area, depth: entry.depth, accepted: true, label: '孔' };
    if (entry.depth === 0) return { ring: entry.ring, area: entry.area, depth: entry.depth, accepted: false, label: '独立区域（未采用）' };
    if (entry.depth % 2 === 1) return { ring: entry.ring, area: entry.area, depth: entry.depth, accepted: false, label: '孔（小于最小面积）' };
    return { ring: entry.ring, area: entry.area, depth: entry.depth, accepted: false, label: '内部实心岛（不支持）' };
  });

  return { outer: orderedOuter, holes: orderedHoles, centers: centerCandidates(orderedOuter), rings, threshold, mode, polarity, toleranceUsed: tolerance, warnings };
}
