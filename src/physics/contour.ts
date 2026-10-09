/**
 * Shared planar-contour kernel.
 *
 * Used by the image tracer and the CAD importers to turn raw closed rings into
 * the `Profile` shape the rest of the app already understands: one outer ring
 * plus zero or more hole rings.  Everything here is pure and unit-tested; the
 * existing editors keep their own validators so their behaviour is unchanged.
 */
import type { Vec2 } from '../types';

const EPS = 1e-12;

export interface Bounds {
  min: Vec2;
  max: Vec2;
  center: Vec2;
  width: number;
  height: number;
}

export interface ClassifiedRing {
  ring: Vec2[];
  /** 0 = solid outline, 1 = hole, 2 = island inside a hole, … */
  depth: number;
  /** Index of the smallest ring that contains this one, or -1 for depth 0. */
  parent: number;
  /** Absolute area. */
  area: number;
}

/** Shoelace signed area; positive for counter-clockwise rings. */
export function ringArea(ring: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** Area centroid; falls back to the vertex average for degenerate rings. */
export function ringCentroid(ring: Vec2[]): Vec2 {
  if (!ring.length) return [0, 0];
  const area = ringArea(ring);
  if (Math.abs(area) < EPS) {
    return ring.reduce<Vec2>((acc, p) => [acc[0] + p[0] / ring.length, acc[1] + p[1] / ring.length], [0, 0]);
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const cross = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * cross;
    cy += (a[1] + b[1]) * cross;
  }
  return [cx / (6 * area), cy / (6 * area)];
}

export function boundsOf(points: Vec2[]): Bounds {
  if (!points.length) return { min: [0, 0], max: [0, 0], center: [0, 0], width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { min: [minX, minY], max: [maxX, maxY], center: [(minX + maxX) / 2, (minY + maxY) / 2], width: maxX - minX, height: maxY - minY };
}

/** Even-odd ray casting. Points exactly on the edge are not handled specially. */
export function pointInRing(point: Vec2, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const crosses = yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

/**
 * True when `outer` encloses `inner`. Rings produced by the tracer or the CAD
 * importers never cross each other, so a majority vote over the inner ring's
 * vertices is enough and stays robust to a single grazing vertex.
 */
export function ringContains(outer: Vec2[], inner: Vec2[]): boolean {
  if (inner.length === 0 || outer.length < 3) return false;
  let inside = 0;
  for (const point of inner) if (pointInRing(point, outer)) inside += 1;
  return inside * 2 > inner.length;
}

/** Drops repeated consecutive points (and the wrap-around duplicate). */
export function dedupeRing(ring: Vec2[], tolerance = 1e-9): Vec2[] {
  const out: Vec2[] = [];
  for (const point of ring) {
    const last = out[out.length - 1];
    if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) <= tolerance) continue;
    out.push([point[0], point[1]]);
  }
  while (out.length > 1) {
    const first = out[0];
    const last = out[out.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) > tolerance) break;
    out.pop();
  }
  return out;
}

const pointSegmentDistanceSq = (p: Vec2, a: Vec2, b: Vec2): number => {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < EPS) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2;
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq;
  t = Math.min(1, Math.max(0, t));
  return (p[0] - (a[0] + t * dx)) ** 2 + (p[1] - (a[1] + t * dy)) ** 2;
};

/** Iterative Ramer–Douglas–Peucker over an open chain. */
function simplifyChain(chain: Vec2[], tolerance: number): Vec2[] {
  if (chain.length < 3) return chain.slice();
  const keep = new Uint8Array(chain.length);
  keep[0] = 1;
  keep[chain.length - 1] = 1;
  const toleranceSq = tolerance * tolerance;
  const stack: Array<[number, number]> = [[0, chain.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    let worst = -1;
    let worstIndex = -1;
    for (let i = start + 1; i < end; i += 1) {
      const distance = pointSegmentDistanceSq(chain[i], chain[start], chain[end]);
      if (distance > worst) {
        worst = distance;
        worstIndex = i;
      }
    }
    if (worstIndex > 0 && worst > toleranceSq) {
      keep[worstIndex] = 1;
      stack.push([start, worstIndex], [worstIndex, end]);
    }
  }
  return chain.filter((_, index) => keep[index] === 1);
}

/**
 * Ramer–Douglas–Peucker for a closed ring. The ring is split at the vertex
 * farthest from the first point so both chains keep the true extreme corners.
 */
export function simplifyRing(ring: Vec2[], tolerance: number): Vec2[] {
  const points = dedupeRing(ring);
  if (points.length < 4 || tolerance <= 0) return points;
  let farIndex = 0;
  let farDistance = -1;
  for (let i = 1; i < points.length; i += 1) {
    const distance = pointSegmentDistanceSq(points[i], points[0], points[0]);
    if (distance > farDistance) {
      farDistance = distance;
      farIndex = i;
    }
  }
  if (farIndex < 2) return points;
  const head = simplifyChain(points.slice(0, farIndex + 1), tolerance);
  const tail = simplifyChain([...points.slice(farIndex), points[0]], tolerance);
  const merged = dedupeRing([...head.slice(0, -1), ...tail.slice(0, -1)]);
  return merged.length >= 3 ? merged : points;
}

/**
 * Assigns every ring a nesting depth by counting containers. Depth 0 is a solid
 * outline, depth 1 a hole, depth 2 an island inside a hole.
 */
export function classifyRings(rings: Vec2[][]): ClassifiedRing[] {
  const entries = rings
    .map((ring) => ({ ring, area: Math.abs(ringArea(ring)) }))
    .filter((entry) => entry.ring.length >= 3 && entry.area > EPS)
    .sort((a, b) => b.area - a.area);
  return entries.map((entry, index) => {
    let depth = 0;
    let parent = -1;
    let parentArea = Infinity;
    for (let other = 0; other < entries.length; other += 1) {
      if (other === index) continue;
      if (entries[other].area <= entry.area) continue;
      if (!ringContains(entries[other].ring, entry.ring)) continue;
      depth += 1;
      if (entries[other].area < parentArea) {
        parentArea = entries[other].area;
        parent = other;
      }
    }
    return { ring: entry.ring, depth, parent, area: entry.area };
  });
}

export interface RingSelection {
  /** Largest depth-0 ring, or null when nothing usable was found. */
  outer: Vec2[] | null;
  /** Depth-1 rings nested directly inside `outer`. */
  holes: Vec2[][];
  /** Other depth-0 rings: separate parts that are not part of the chosen outline. */
  strayParts: Vec2[][];
  /** Depth ≥2 rings: solid islands inside holes, which the profile model cannot express. */
  islands: Vec2[][];
}

/** Picks the primary outline plus its holes, and reports what had to be ignored. */
export function selectPrimaryRings(classified: ClassifiedRing[]): RingSelection {
  const outers = classified.filter((entry) => entry.depth % 2 === 0);
  if (!outers.length) return { outer: null, holes: [], strayParts: [], islands: [] };
  const primaryIndex = outers[0];
  const outer = primaryIndex.ring;
  const holes: Vec2[][] = [];
  const strayParts: Vec2[][] = [];
  const islands: Vec2[][] = [];
  for (const entry of classified) {
    if (entry === primaryIndex) continue;
    if (entry.depth === 0) {
      strayParts.push(entry.ring);
      continue;
    }
    if (entry.depth % 2 === 1) {
      if (ringContains(outer, entry.ring)) holes.push(entry.ring);
      else strayParts.push(entry.ring);
      continue;
    }
    islands.push(entry.ring);
  }
  return { outer, holes, strayParts, islands };
}

/** Minimum enclosing circle (Welzl, incremental form with a fixed shuffle). */
export function minimumEnclosingCircle(points: Vec2[]): { center: Vec2; radius: number } {
  if (!points.length) return { center: [0, 0], radius: 0 };
  const shuffled = points.map((point): Vec2 => [point[0], point[1]]);
  let seed = 0x9e3779b9;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = swap;
  }
  const distance = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const fromTwo = (a: Vec2, b: Vec2) => ({ center: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Vec2, radius: distance(a, b) / 2 });
  const fromThree = (a: Vec2, b: Vec2, c: Vec2) => {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-12) return null;
    const aSq = a[0] * a[0] + a[1] * a[1];
    const bSq = b[0] * b[0] + b[1] * b[1];
    const cSq = c[0] * c[0] + c[1] * c[1];
    const center: Vec2 = [(aSq * (b[1] - c[1]) + bSq * (c[1] - a[1]) + cSq * (a[1] - b[1])) / d, (aSq * (c[0] - b[0]) + bSq * (a[0] - c[0]) + cSq * (b[0] - a[0])) / d];
    return { center, radius: distance(a, center) };
  };
  let circle = { center: shuffled[0], radius: 0 };
  for (let i = 1; i < shuffled.length; i += 1) {
    if (distance(shuffled[i], circle.center) <= circle.radius + 1e-9) continue;
    circle = { center: shuffled[i], radius: 0 };
    for (let j = 0; j < i; j += 1) {
      if (distance(shuffled[j], circle.center) <= circle.radius + 1e-9) continue;
      circle = fromTwo(shuffled[i], shuffled[j]);
      for (let k = 0; k < j; k += 1) {
        if (distance(shuffled[k], circle.center) <= circle.radius + 1e-9) continue;
        circle = fromThree(shuffled[i], shuffled[j], shuffled[k]) ?? circle;
      }
    }
  }
  return circle;
}

export interface CenterCandidate {
  id: 'centroid' | 'bbox' | 'circle';
  label: string;
  point: Vec2;
  note: string;
}

/** Plausible rotation-centre candidates for an outline. */
export function centerCandidates(ring: Vec2[]): CenterCandidate[] {
  if (ring.length < 3) return [];
  const centroid = ringCentroid(ring);
  const bounds = boundsOf(ring);
  const circle = minimumEnclosingCircle(ring);
  return [
    { id: 'centroid', label: '面积质心', point: centroid, note: '按轮廓面积计算；形状不均匀时与旋转轴心不一定重合。' },
    { id: 'circle', label: '最小外接圆圆心', point: circle.center, note: `外接半径 ${circle.radius.toFixed(2)} px；圆盘、齿盘类轮廓更接近真实轴心。` },
    { id: 'bbox', label: '包围盒中心', point: bounds.center, note: '轮廓包围范围的中点，仅作为对照。' },
  ];
}
