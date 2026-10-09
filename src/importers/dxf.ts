/**
 * Minimal but faithful 2D DXF reader.
 *
 * Only the ENTITIES geometry that a flat weapon drawing can be made of is
 * understood, which keeps the parser self-contained (no new dependency) while
 * still handling the entities real CAD exports actually use: polylines with
 * bulges, circles, arcs, ellipses and NURBS splines.
 */
import type { Vec2 } from '../types';
import { arcSegmentCount } from './profile';
import type { FileUnit, ImportedDrawing } from './profile';

interface Pair {
  code: number;
  value: string;
}

interface Entity {
  type: string;
  groups: Pair[];
  children: Entity[];
}

/** DXF `$INSUNITS` values mapped onto the units this app can convert. */
const INSUNITS: Record<number, FileUnit> = { 1: 'in', 4: 'mm', 5: 'cm', 6: 'm' };

const BINARY_SENTINEL = 'AutoCAD Binary DXF';

/** Splits the code/value stream of a text DXF file. */
function tokenize(text: string): Pair[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  const pairs: Pair[] = [];
  let index = 0;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  for (; index + 1 < lines.length; index += 2) {
    const code = Number.parseInt(lines[index].trim(), 10);
    if (!Number.isFinite(code)) {
      throw new Error(`DXF 第 ${index + 1} 行不是有效的组码，文件可能已损坏或不是文本格式的 DXF。`);
    }
    pairs.push({ code, value: lines[index + 1] });
  }
  return pairs;
}

/** Walks the pair stream and returns the HEADER units plus the ENTITIES list. */
function readStructure(pairs: Pair[]): { entities: Entity[]; insUnits: number | null } {
  const entities: Entity[] = [];
  let section = '';
  let expectSectionName = false;
  let headerVariable = '';
  let insUnits: number | null = null;
  let current: Entity | null = null;
  let target: Entity | null = null;

  const flush = () => {
    if (current) entities.push(current);
    current = null;
    target = null;
  };

  for (const pair of pairs) {
    if (pair.code === 0) {
      const name = pair.value.trim().toUpperCase();
      if (name === 'SECTION') {
        flush();
        section = '';
        expectSectionName = true;
        continue;
      }
      if (name === 'ENDSEC' || name === 'EOF') {
        flush();
        section = '';
        continue;
      }
      if (section !== 'ENTITIES') continue;
      if (name === 'VERTEX' && current && current.type === 'POLYLINE') {
        const vertex: Entity = { type: 'VERTEX', groups: [], children: [] };
        current.children.push(vertex);
        target = vertex;
        continue;
      }
      if (name === 'SEQEND' || name === 'ATTRIB') continue;
      flush();
      current = { type: name, groups: [], children: [] };
      target = current;
      continue;
    }
    if (expectSectionName && pair.code === 2) {
      section = pair.value.trim().toUpperCase();
      expectSectionName = false;
      continue;
    }
    if (section === 'HEADER') {
      if (pair.code === 9) headerVariable = pair.value.trim().toUpperCase();
      else if (pair.code === 70 && headerVariable === '$INSUNITS') {
        const value = Number.parseInt(pair.value.trim(), 10);
        if (Number.isFinite(value)) insUnits = value;
      }
      continue;
    }
    if (section === 'ENTITIES' && target) target.groups.push(pair);
  }
  flush();
  return { entities, insUnits };
}

const numbersOf = (entity: Entity, code: number): number[] =>
  entity.groups.filter((group) => group.code === code).map((group) => Number.parseFloat(group.value)).filter((value) => Number.isFinite(value));

const numberOf = (entity: Entity, code: number, fallback = 0): number => {
  const found = entity.groups.find((group) => group.code === code);
  const value = found ? Number.parseFloat(found.value) : Number.NaN;
  return Number.isFinite(value) ? value : fallback;
};

/** Reads 10/20 pairs in file order, which is how vertices are stored. */
function vertexPairs(groups: Pair[]): Array<{ point: Vec2; bulge: number }> {
  const vertices: Array<{ point: Vec2; bulge: number }> = [];
  let x: number | null = null;
  for (const { code, value } of groups) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) continue;
    if (code === 10) x = parsed;
    else if (code === 20 && x !== null) {
      vertices.push({ point: [x, parsed], bulge: 0 });
      x = null;
    } else if (code === 42 && vertices.length) {
      vertices[vertices.length - 1].bulge = parsed;
    }
  }
  return vertices;
}

/** Number of chords needed for a sampled circular arc. */
const arcSegments = arcSegmentCount;

function sampleCircle(cx: number, cy: number, radius: number, startDeg = 0, endDeg = 360): Vec2[] {
  const radians = (deg: number) => (deg * Math.PI) / 180;
  let sweepDeg = ((endDeg - startDeg) % 360 + 360) % 360;
  if (sweepDeg < 1e-9) sweepDeg = 360;
  const sweep = radians(sweepDeg);
  const count = arcSegments(radius, sweep);
  const out: Vec2[] = [];
  for (let i = 0; i <= count; i += 1) {
    const angle = radians(startDeg) + sweep * (i / count);
    out.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return out;
}

function sampleEllipse(cx: number, cy: number, mx: number, my: number, ratio: number, startParam: number, endParam: number): Vec2[] {
  const nx = -my * ratio;
  const ny = mx * ratio;
  let sweep = endParam - startParam;
  if (sweep <= 1e-9) sweep += Math.PI * 2;
  const count = arcSegments(Math.hypot(mx, my), sweep);
  const out: Vec2[] = [];
  for (let i = 0; i <= count; i += 1) {
    const t = startParam + sweep * (i / count);
    out.push([cx + mx * Math.cos(t) + nx * Math.sin(t), cy + my * Math.cos(t) + ny * Math.sin(t)]);
  }
  return out;
}

/** Knight's de Boor evaluation of a (rational) B-spline. */
function sampleSpline(control: Vec2[], weights: number[], knots: number[], degree: number, samples: number): Vec2[] | null {
  const count = control.length;
  if (degree < 1 || count < degree + 1 || knots.length < count + degree + 1) return null;
  const resolvedWeights = weights.length === count ? weights : control.map(() => 1);
  const homogeneous = control.map(([x, y], index): [number, number, number] => [x * resolvedWeights[index], y * resolvedWeights[index], resolvedWeights[index]]);
  const tMin = knots[degree];
  const tMax = knots[count];
  if (!(tMax > tMin)) return null;
  const out: Vec2[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = Math.min(tMin + ((tMax - tMin) * i) / samples, tMax - 1e-12);
    let span = degree;
    for (let k = degree; k < count; k += 1) {
      if (t >= knots[k] && t < knots[k + 1]) {
        span = k;
        break;
      }
    }
    const dx: number[] = [];
    const dy: number[] = [];
    const dw: number[] = [];
    for (let j = 0; j <= degree; j += 1) {
      const source = homogeneous[Math.min(count - 1, Math.max(0, span - degree + j))];
      dx[j] = source[0];
      dy[j] = source[1];
      dw[j] = source[2];
    }
    for (let r = 1; r <= degree; r += 1) {
      for (let j = degree; j >= r; j -= 1) {
        const base = span - degree + j;
        const denominator = knots[base + degree - r + 1] - knots[base];
        const alpha = Math.abs(denominator) < 1e-12 ? 0 : (t - knots[base]) / denominator;
        dx[j] = (1 - alpha) * dx[j - 1] + alpha * dx[j];
        dy[j] = (1 - alpha) * dy[j - 1] + alpha * dy[j];
        dw[j] = (1 - alpha) * dw[j - 1] + alpha * dw[j];
      }
    }
    const weight = Math.abs(dw[degree]) < 1e-12 ? 1 : dw[degree];
    out.push([dx[degree] / weight, dy[degree] / weight]);
  }
  return out;
}

/** Expands one polyline vertex run into points, replacing bulged spans with arcs. */
function polylineToPoints(vertices: Array<{ point: Vec2; bulge: number }>, closed: boolean): Vec2[] {
  if (!vertices.length) return [];
  const points: Vec2[] = [];
  const segmentCount = closed ? vertices.length : vertices.length - 1;
  for (let i = 0; i < segmentCount; i += 1) {
    const from = vertices[i];
    const to = vertices[(i + 1) % vertices.length];
    const arc = from.bulge ? bulgeArc(from.point, to.point, from.bulge) : [from.point, to.point];
    points.push(...(points.length ? arc.slice(1) : arc));
  }
  if (!closed) points.push(vertices[vertices.length - 1].point);
  return points;
}

/** Circular arc spanned by a DXF polyline bulge value. */
export function bulgeArc(from: Vec2, to: Vec2, bulge: number): Vec2[] {
  const theta = 4 * Math.atan(bulge);
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12 || Math.abs(theta) < 1e-6) return [from, to];
  const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
  const offset = Math.sqrt(Math.max(0, radius * radius - (chord / 2) ** 2));
  // A positive bulge sweeps counter-clockwise; past a half turn the centre
  // moves to the other side of the chord.
  const sign = (bulge > 0 ? 1 : -1) * (Math.abs(theta) > Math.PI ? -1 : 1);
  const cx = (from[0] + to[0]) / 2 + (sign * offset * -dy) / chord;
  const cy = (from[1] + to[1]) / 2 + (sign * offset * dx) / chord;
  const startAngle = Math.atan2(from[1] - cy, from[0] - cx);
  let sweep = Math.atan2(to[1] - cy, to[0] - cx) - startAngle;
  if (bulge > 0) {
    while (sweep <= 1e-12) sweep += Math.PI * 2;
  } else {
    while (sweep >= -1e-12) sweep -= Math.PI * 2;
  }
  const count = arcSegments(radius, sweep);
  const out: Vec2[] = [];
  for (let i = 0; i <= count; i += 1) {
    const angle = startAngle + sweep * (i / count);
    out.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return out;
}

const samePoint = (a: Vec2, b: Vec2, tolerance: number): boolean => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance;

/**
 * Joins open edges end-to-end.
 *
 * Returns the loops that actually closed, plus the chains that dead-ended —
 * the caller reports those instead of silently treating an arc as a ring.
 */
export function chainEdges(edges: Vec2[][], tolerance: number): { rings: Vec2[][]; openChains: Vec2[][] } {
  const pending = edges.filter((edge) => edge.length >= 2).map((edge) => edge.map(([x, y]): Vec2 => [x, y]));
  const used = new Array<boolean>(pending.length).fill(false);
  const rings: Vec2[][] = [];
  const openChains: Vec2[][] = [];
  for (let seed = 0; seed < pending.length; seed += 1) {
    if (used[seed]) continue;
    used[seed] = true;
    let chain = pending[seed];
    let extended = true;
    while (extended) {
      extended = false;
      const tail = chain[chain.length - 1];
      if (samePoint(chain[0], tail, tolerance)) break;
      for (let index = 0; index < pending.length; index += 1) {
        if (used[index]) continue;
        const candidate = pending[index];
        const head = candidate[0];
        const candidateTail = candidate[candidate.length - 1];
        if (samePoint(tail, head, tolerance)) chain = chain.concat(candidate.slice(1));
        else if (samePoint(tail, candidateTail, tolerance)) chain = chain.concat(candidate.slice().reverse().slice(1));
        else if (samePoint(chain[0], candidateTail, tolerance)) chain = candidate.slice(0, -1).concat(chain);
        else if (samePoint(chain[0], head, tolerance)) chain = candidate.slice().reverse().slice(0, -1).concat(chain);
        else continue;
        used[index] = true;
        extended = true;
        break;
      }
    }
    if (chain.length < 3) continue;
    if (samePoint(chain[0], chain[chain.length - 1], tolerance)) rings.push(chain);
    else openChains.push(chain);
  }
  return { rings, openChains };
}

function entityToEdges(entity: Entity, warnings: string[]): Vec2[][] {
  const closedFlag = numberOf(entity, 70);
  switch (entity.type) {
    case 'LINE': {
      const start: Vec2 = [numberOf(entity, 10), numberOf(entity, 20)];
      const end: Vec2 = [numberOf(entity, 11), numberOf(entity, 21)];
      return [[start, end]];
    }
    case 'LWPOLYLINE':
      return entity.groups.length ? [polylineToPoints(vertexPairs(entity.groups), (closedFlag & 1) !== 0)] : [];
    case 'POLYLINE': {
      const vertices = entity.children
        .filter((child) => child.type === 'VERTEX')
        .map((child) => ({ point: [numberOf(child, 10), numberOf(child, 20)] as Vec2, bulge: numberOf(child, 42) }));
      return vertices.length ? [polylineToPoints(vertices, (closedFlag & 1) !== 0)] : [];
    }
    case 'CIRCLE':
      return [sampleCircle(numberOf(entity, 10), numberOf(entity, 20), numberOf(entity, 40))];
    case 'ARC':
      return [sampleCircle(numberOf(entity, 10), numberOf(entity, 20), numberOf(entity, 40), numberOf(entity, 50), numberOf(entity, 51))];
    case 'ELLIPSE':
      return [sampleEllipse(numberOf(entity, 10), numberOf(entity, 20), numberOf(entity, 11), numberOf(entity, 21), numberOf(entity, 40, 1), numberOf(entity, 41), numberOf(entity, 42, Math.PI * 2))];
    case 'SPLINE': {
      const control: Vec2[] = [];
      let x: number | null = null;
      for (const { code, value } of entity.groups) {
        const parsed = Number.parseFloat(value);
        if (!Number.isFinite(parsed)) continue;
        if (code === 10) x = parsed;
        else if (code === 20 && x !== null) {
          control.push([x, parsed]);
          x = null;
        }
      }
      const degree = Math.max(1, Math.round(numberOf(entity, 71, 3)));
      const sampled = sampleSpline(control, numbersOf(entity, 41), numbersOf(entity, 40), degree, 160);
      if (sampled) return [sampled];
      warnings.push('有一个 SPLINE 缺少节点或控制点，已退化为控制多边形近似。');
      return control.length >= 2 ? [control] : [];
    }
    default:
      return [];
  }
}

/** Parses a text DXF file into closed rings in file units. */
export function parseDxf(text: string, fallbackUnit: FileUnit = 'mm'): ImportedDrawing {
  if (text.startsWith(BINARY_SENTINEL)) throw new Error('这是二进制 DXF 文件，请先在 CAD 里另存为 ASCII/文本 DXF 再上传。');
  const warnings: string[] = [];
  const { entities, insUnits } = readStructure(tokenize(text));
  if (!entities.length) throw new Error('DXF 里没有找到 ENTITIES 段中的图形实体。');

  const edges: Vec2[][] = [];
  for (const entity of entities) edges.push(...entityToEdges(entity, warnings));
  const usable = edges.filter((edge) => edge.length >= 2);
  if (!usable.length) throw new Error('DXF 里没有解析出可用的直线、多段线、圆或圆弧。');

  const all = usable.flat();
  const xs = all.map(([x]) => x);
  const ys = all.map(([, y]) => y);
  const diagonal = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  const { rings, openChains } = chainEdges(usable, Math.max(1e-9, diagonal * 1e-5));

  let unit = fallbackUnit;
  if (insUnits !== null && INSUNITS[insUnits]) unit = INSUNITS[insUnits];
  else if (insUnits !== null && insUnits !== 0) warnings.push(`DXF 声明的单位代码 ${insUnits} 暂不支持，已按手动选择的单位换算。`);
  else warnings.push('DXF 没有声明绘图单位（$INSUNITS），默认按毫米处理；如果尺寸不对请在单位下拉里改。');

  if (openChains.length) warnings.push(`有 ${openChains.length} 段线没有闭合成环，已忽略；请确认图形是封闭的。`);

  return { rings, unit, yDown: false, warnings };
}
