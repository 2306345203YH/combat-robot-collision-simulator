/**
 * Shared plumbing for turning a CAD/vector drawing into a weapon profile.
 *
 * Every importer returns closed rings in the file's own coordinate system; this
 * module applies the unit scale, classifies the rings into an outline plus
 * holes, simplifies to a point budget and hands back metres in profile space
 * (x right, y up) — the same space the profile editor already edits in.
 */
import type { Vec2 } from '../types';
import { boundsOf, classifyRings, ringArea, selectPrimaryRings, simplifyRing } from '../physics/contour';
import type { Bounds } from '../physics/contour';

export type FileUnit = 'mm' | 'cm' | 'm' | 'in';

export const UNIT_TO_METERS: Record<FileUnit, number> = { mm: 0.001, cm: 0.01, m: 1, in: 0.0254 };

export const UNIT_LABELS: Record<FileUnit, string> = { mm: '毫米 mm', cm: '厘米 cm', m: '米 m', in: '英寸 in' };

export interface ImportedDrawing {
  /** Closed rings in file units, file orientation. */
  rings: Vec2[][];
  /** Unit taken from the file; the user can override it in the dialog. */
  unit: FileUnit;
  /** True when the file's y axis points down (SVG) and must be mirrored. */
  yDown: boolean;
  warnings: string[];
}

export interface ProfileImportOptions {
  /** Point budget for the imported profile. */
  maxPoints?: number;
  /** Starting Douglas–Peucker tolerance in metres. */
  simplifyTolerance?: number;
}

export interface ImportedProfile {
  outer: Vec2[];
  holes: Vec2[][];
  bounds: Bounds;
  /** Tolerance actually used after fitting the point budget. */
  toleranceUsed: number;
  warnings: string[];
}

const DEFAULT_MAX_POINTS = 900;

/**
 * Chords needed to keep a sampled arc within 0.01 units of the true curve.
 *
 * Rounded up to a multiple of four so a full circle always carries exact
 * points at 0°, 90°, 180° and 270° — otherwise the measured diameter of a
 * circle comes out slightly under its true value.
 */
export const arcSegmentCount = (radius: number, sweep: number): number => {
  const safeRadius = Math.max(Math.abs(radius), 1e-6);
  const step = Math.acos(Math.min(1, Math.max(-1, 1 - 0.01 / safeRadius)));
  const raw = Math.ceil(Math.abs(sweep) / Math.max(step, 1e-4));
  return Math.min(512, Math.max(8, Math.ceil(raw / 4) * 4));
};

export const countRingPoints = (outer: Vec2[], holes: Vec2[][]): number =>
  outer.length + holes.reduce((sum, hole) => sum + hole.length, 0);

const withWinding = (ring: Vec2[], counterClockwise: boolean): Vec2[] => {
  const isCounterClockwise = ringArea(ring) > 0;
  return isCounterClockwise === counterClockwise ? ring : ring.slice().reverse();
};

/**
 * Classifies the imported rings and converts them to metres.
 *
 * Throws when nothing usable was found, so the caller can surface a single
 * clear message instead of an empty profile.
 */
export function ringsToProfile(drawing: ImportedDrawing, unit: FileUnit, options: ProfileImportOptions = {}): ImportedProfile {
  const scale = UNIT_TO_METERS[unit];
  const warnings = [...drawing.warnings];
  const converted = drawing.rings
    .map((ring) => ring.map(([x, y]): Vec2 => [x * scale, (drawing.yDown ? -y : y) * scale]))
    .filter((ring) => ring.length >= 3 && Math.abs(ringArea(ring)) > 1e-12);

  if (!converted.length) throw new Error('文件里没有找到可用的闭合轮廓，请确认图形已经闭合。');

  const classified = classifyRings(converted);
  const selection = selectPrimaryRings(classified);
  if (!selection.outer) throw new Error('文件里的轮廓过小或退化，无法作为武器外形。');

  if (selection.strayParts.length) warnings.push(`文件里有 ${selection.strayParts.length} 个额外的闭合区域，已只采用面积最大的外轮廓。`);
  if (selection.islands.length) warnings.push(`检测到 ${selection.islands.length} 个孔中实心岛，本版轮廓模型不支持，已忽略。`);

  const maxPoints = options.maxPoints ?? DEFAULT_MAX_POINTS;
  let tolerance = Math.max(options.simplifyTolerance ?? 0, 0);
  let outer = simplifyRing(selection.outer, tolerance);
  let holes = selection.holes.map((hole) => simplifyRing(hole, tolerance));
  let passes = 0;
  while (countRingPoints(outer, holes) > maxPoints && passes < 24) {
    tolerance = tolerance > 0 ? tolerance * 1.4 : scale * 0.2;
    outer = simplifyRing(selection.outer, tolerance);
    holes = selection.holes.map((hole) => simplifyRing(hole, tolerance));
    passes += 1;
  }
  if (outer.length < 3) {
    outer = selection.outer;
    holes = selection.holes;
    warnings.push('轮廓过于破碎，已回退到未简化的导入结果。');
  }
  holes = holes.filter((hole) => hole.length >= 3);
  const totalPoints = countRingPoints(outer, holes);
  if (totalPoints > maxPoints) warnings.push(`导入轮廓有 ${totalPoints} 个点，超过建议上限 ${maxPoints}；应用后请在画布上手动简化。`);

  return {
    outer: withWinding(outer, true),
    holes: holes.map((hole) => withWinding(hole, false)),
    bounds: boundsOf(outer),
    toleranceUsed: tolerance,
    warnings,
  };
}
