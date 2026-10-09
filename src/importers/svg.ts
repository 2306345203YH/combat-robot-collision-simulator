/**
 * Self-contained SVG reader for flat weapon outlines.
 *
 * The XML subset, the path grammar and the transform stack are all parsed here
 * rather than through `DOMParser` / `getPointAtLength`, so the importer keeps
 * working in Node (where the unit tests run) and never depends on rendering.
 */
import type { Vec2 } from '../types';
import { arcSegmentCount } from './profile';
import type { FileUnit, ImportedDrawing } from './profile';

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

const applyMatrix = (m: Matrix, point: Vec2): Vec2 => [m[0] * point[0] + m[2] * point[1] + m[4], m[1] * point[0] + m[3] * point[1] + m[5]];

/** Finds the end of a tag while skipping `>` characters inside quotes. */
function findTagEnd(text: string, start: number): number {
  let quote = '';
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index;
  }
  return -1;
}

function parseAttributes(text: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match = pattern.exec(text);
  while (match) {
    attrs[match[1].toLowerCase()] = match[3] ?? match[4] ?? '';
    match = pattern.exec(text);
  }
  return attrs;
}

/** Minimal well-formed-XML reader: enough for SVG, no entity expansion. */
export function parseSvgDocument(text: string): XmlNode {
  const root: XmlNode = { name: '#document', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  let index = 0;
  while (index < text.length) {
    const open = text.indexOf('<', index);
    if (open < 0) break;
    if (text.startsWith('<!--', open)) {
      const end = text.indexOf('-->', open);
      index = end < 0 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith('<?', open) || text.startsWith('<!', open)) {
      const end = text.indexOf('>', open);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    const close = findTagEnd(text, open + 1);
    if (close < 0) break;
    const body = text.slice(open + 1, close).trim();
    index = close + 1;
    if (body.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClosing = body.endsWith('/');
    const content = selfClosing ? body.slice(0, -1) : body;
    const separator = content.search(/\s/);
    const name = (separator < 0 ? content : content.slice(0, separator)).toLowerCase();
    if (!name) continue;
    const node: XmlNode = { name, attrs: parseAttributes(separator < 0 ? '' : content.slice(separator)), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

/** Parses an SVG `transform` list into a single matrix. */
export function parseTransform(text: string): Matrix {
  let matrix: Matrix = IDENTITY;
  const pattern = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match = pattern.exec(text);
  while (match) {
    const args = match[2].split(/[\s,]+/).map(Number.parseFloat).filter(Number.isFinite);
    let next: Matrix = IDENTITY;
    switch (match[1]) {
      case 'matrix':
        if (args.length >= 6) next = [args[0], args[1], args[2], args[3], args[4], args[5]];
        break;
      case 'translate':
        next = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
        break;
      case 'scale': {
        const sx = args[0] ?? 1;
        next = [sx, 0, 0, args[1] ?? sx, 0, 0];
        break;
      }
      case 'rotate': {
        const angle = ((args[0] ?? 0) * Math.PI) / 180;
        const rotation: Matrix = [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];
        next = args.length >= 3 ? multiply(multiply([1, 0, 0, 1, args[1], args[2]], rotation), [1, 0, 0, 1, -args[1], -args[2]]) : rotation;
        break;
      }
      case 'skewX':
        next = [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        next = [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
      default:
        break;
    }
    matrix = multiply(matrix, next);
    match = pattern.exec(text);
  }
  return matrix;
}

const PATH_TOKEN = /[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

function pathCommands(d: string): Array<{ command: string; args: number[] }> {
  const result: Array<{ command: string; args: number[] }> = [];
  let current: { command: string; args: number[] } | null = null;
  for (const token of d.match(PATH_TOKEN) ?? []) {
    if (/[A-Za-z]/.test(token)) {
      if (current) result.push(current);
      current = { command: token, args: [] };
    } else if (current) {
      current.args.push(Number.parseFloat(token));
    }
  }
  if (current) result.push(current);
  return result;
}

/** SVG endpoint-parameterised arc → sampled centre-parameterised points. */
function arcToPoints(from: Vec2, rx: number, ry: number, rotationDeg: number, largeArc: number, sweepFlag: number, to: Vec2): Vec2[] {
  if (rx === 0 || ry === 0) return [to];
  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx2 = (from[0] - to[0]) / 2;
  const dy2 = (from[1] - to[1]) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;
  let radiusX = Math.abs(rx);
  let radiusY = Math.abs(ry);
  const lambda = (x1p * x1p) / (radiusX * radiusX) + (y1p * y1p) / (radiusY * radiusY);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    radiusX *= scale;
    radiusY *= scale;
  }
  const denominator = radiusX * radiusX * y1p * y1p + radiusY * radiusY * x1p * x1p;
  const numerator = radiusX * radiusX * radiusY * radiusY - denominator;
  const coefficient = (largeArc === sweepFlag ? -1 : 1) * Math.sqrt(Math.max(0, numerator / (denominator || 1)));
  const cxp = (coefficient * radiusX * y1p) / radiusY;
  const cyp = (-coefficient * radiusY * x1p) / radiusX;
  const cx = cosPhi * cxp - sinPhi * cyp + (from[0] + to[0]) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (from[1] + to[1]) / 2;
  const angleBetween = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const lengths = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const base = Math.acos(Math.min(1, Math.max(-1, dot / (lengths || 1))));
    return ux * vy - uy * vx < 0 ? -base : base;
  };
  const startAngle = angleBetween(1, 0, (x1p - cxp) / radiusX, (y1p - cyp) / radiusY);
  let sweep = angleBetween((x1p - cxp) / radiusX, (y1p - cyp) / radiusY, (-x1p - cxp) / radiusX, (-y1p - cyp) / radiusY);
  if (!sweepFlag && sweep > 0) sweep -= Math.PI * 2;
  if (sweepFlag && sweep < 0) sweep += Math.PI * 2;
  const count = arcSegmentCount(Math.max(radiusX, radiusY), sweep);
  const points: Vec2[] = [];
  for (let i = 1; i <= count; i += 1) {
    const t = startAngle + (sweep * i) / count;
    const x = radiusX * Math.cos(t);
    const y = radiusY * Math.sin(t);
    points.push([cosPhi * x - sinPhi * y + cx, sinPhi * x + cosPhi * y + cy]);
  }
  return points;
}

/** Samples a cubic Bézier from `from` with a fixed step count. */
function cubicPoints(from: Vec2, c1: Vec2, c2: Vec2, end: Vec2, steps = 16): Vec2[] {
  const points: Vec2[] = [];
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const u = 1 - t;
    points.push([
      u * u * u * from[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * end[0],
      u * u * u * from[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * end[1],
    ]);
  }
  return points;
}

function quadraticPoints(from: Vec2, control: Vec2, end: Vec2, steps = 16): Vec2[] {
  const points: Vec2[] = [];
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const u = 1 - t;
    points.push([u * u * from[0] + 2 * u * t * control[0] + t * t * end[0], u * u * from[1] + 2 * u * t * control[1] + t * t * end[1]]);
  }
  return points;
}

/** Converts an SVG path into one or more point chains. */
export function pathToPolylines(d: string): Vec2[][] {
  const chains: Vec2[][] = [];
  let current: Vec2[] = [];
  let cursor: Vec2 = [0, 0];
  let subpathStart: Vec2 = [0, 0];
  let lastCubicControl: Vec2 | null = null;
  let lastQuadraticControl: Vec2 | null = null;
  let previous = '';

  const finish = () => {
    if (current.length >= 2) chains.push(current);
    current = [];
  };
  /** Appends one vertex and advances the pen. */
  const push = (point: Vec2) => {
    current.push([point[0], point[1]]);
    cursor = [point[0], point[1]];
  };
  const repeatCount = (command: string): number => ({ M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }[command] ?? 0);

  for (const { command, args } of pathCommands(d)) {
    const upper = command.toUpperCase();
    const relative = command !== upper;
    const absolute = (x: number, y: number): Vec2 => (relative ? [x + cursor[0], y + cursor[1]] : [x, y]);
    const step = repeatCount(upper);

    if (upper === 'Z') {
      if (current.length >= 2) {
        current.push([subpathStart[0], subpathStart[1]]);
        cursor = [subpathStart[0], subpathStart[1]];
      }
      finish();
      lastCubicControl = null;
      lastQuadraticControl = null;
      previous = 'Z';
      continue;
    }

    let index = 0;
    let effective = upper;
    while (index + step <= args.length) {
      // Extra coordinate groups after the first are implicit repeats; after a
      // moveto they behave like lineto.
      if (index > 0 && effective === 'M') effective = 'L';
      let consumed = step;
      switch (effective) {
        case 'M': {
          const point = absolute(args[index], args[index + 1]);
          finish();
          current = [[point[0], point[1]]];
          cursor = point;
          subpathStart = point;
          break;
        }
        case 'L':
          push(absolute(args[index], args[index + 1]));
          break;
        case 'H':
          push(relative ? [cursor[0] + args[index], cursor[1]] : [args[index], cursor[1]]);
          break;
        case 'V':
          push(relative ? [cursor[0], cursor[1] + args[index]] : [cursor[0], args[index]]);
          break;
        case 'C':
        case 'S': {
          const from: Vec2 = [cursor[0], cursor[1]];
          const c1: Vec2 = effective === 'S'
            ? lastCubicControl && (previous === 'C' || previous === 'S')
              ? [2 * from[0] - lastCubicControl[0], 2 * from[1] - lastCubicControl[1]]
              : from
            : absolute(args[index], args[index + 1]);
          const offset = effective === 'S' ? 0 : 2;
          const c2 = absolute(args[index + offset], args[index + offset + 1]);
          const end = absolute(args[index + offset + 2], args[index + offset + 3]);
          for (const point of cubicPoints(from, c1, c2, end)) push(point);
          lastCubicControl = c2;
          break;
        }
        case 'Q':
        case 'T': {
          const from: Vec2 = [cursor[0], cursor[1]];
          const control: Vec2 = effective === 'T'
            ? lastQuadraticControl && (previous === 'Q' || previous === 'T')
              ? [2 * from[0] - lastQuadraticControl[0], 2 * from[1] - lastQuadraticControl[1]]
              : from
            : absolute(args[index], args[index + 1]);
          const offset = effective === 'T' ? 0 : 2;
          const end = absolute(args[index + offset], args[index + offset + 1]);
          for (const point of quadraticPoints(from, control, end)) push(point);
          lastQuadraticControl = control;
          break;
        }
        case 'A': {
          const from: Vec2 = [cursor[0], cursor[1]];
          const end = absolute(args[index + 5], args[index + 6]);
          for (const point of arcToPoints(from, args[index], args[index + 1], args[index + 2], args[index + 3], args[index + 4], end)) push(point);
          break;
        }
        default:
          consumed = 0;
          index = args.length;
          break;
      }
      if (effective !== 'C' && effective !== 'S') lastCubicControl = null;
      if (effective !== 'Q' && effective !== 'T') lastQuadraticControl = null;
      previous = effective;
      index += consumed;
      if (consumed === 0) break;
    }
  }
  finish();
  return chains;
}

const numberAttribute = (node: XmlNode, name: string, fallback = 0): number => {
  const raw = node.attrs[name];
  if (raw === undefined) return fallback;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
};

const pointsAttribute = (value: string): Vec2[] => {
  const numbers = (value.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []).map(Number.parseFloat);
  const points: Vec2[] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) points.push([numbers[i], numbers[i + 1]]);
  return points;
};

const rectPoints = (node: XmlNode): Vec2[][] => {
  const x = numberAttribute(node, 'x');
  const y = numberAttribute(node, 'y');
  const width = numberAttribute(node, 'width');
  const height = numberAttribute(node, 'height');
  if (!(width > 0) || !(height > 0)) return [];
  const declared = node.attrs.rx !== undefined ? numberAttribute(node, 'rx') : numberAttribute(node, 'ry');
  const radius = Number.isFinite(declared) && declared > 0 ? Math.min(declared, width / 2, height / 2) : 0;
  if (!radius) return [[[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]]];
  const count = arcSegmentCount(radius, Math.PI / 2);
  const corner = (centre: Vec2, startAngle: number): Vec2[] => {
    const points: Vec2[] = [];
    for (let step = 0; step <= count; step += 1) {
      const angle = startAngle + (Math.PI / 2) * (step / count);
      points.push([centre[0] + radius * Math.cos(angle), centre[1] + radius * Math.sin(angle)]);
    }
    return points;
  };
  const points: Vec2[] = [
    [x + radius, y],
    [x + width - radius, y],
    ...corner([x + width - radius, y + radius], -Math.PI / 2),
    [x + width, y + height - radius],
    ...corner([x + width - radius, y + height - radius], 0),
    [x + radius, y + height],
    ...corner([x + radius, y + height - radius], Math.PI / 2),
    [x, y + radius],
    ...corner([x + radius, y + radius], Math.PI),
    [x + radius, y],
  ];
  return [points];
};

function shapeToChains(node: XmlNode, warnings: string[]): Vec2[][] {
  switch (node.name) {
    case 'path':
      return pathToPolylines(node.attrs.d ?? '');
    case 'polygon': {
      const points = pointsAttribute(node.attrs.points ?? '');
      return points.length >= 3 ? [[...points, points[0]]] : [];
    }
    case 'polyline': {
      const points = pointsAttribute(node.attrs.points ?? '');
      return points.length >= 2 ? [points] : [];
    }
    case 'rect':
      return rectPoints(node);
    case 'circle': {
      const cx = numberAttribute(node, 'cx');
      const cy = numberAttribute(node, 'cy');
      const r = numberAttribute(node, 'r');
      if (!(r > 0)) return [];
      const count = arcSegmentCount(r, Math.PI * 2);
      const points: Vec2[] = [];
      for (let step = 0; step <= count; step += 1) {
        const angle = (step / count) * Math.PI * 2;
        points.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
      }
      return [points];
    }
    case 'ellipse': {
      const cx = numberAttribute(node, 'cx');
      const cy = numberAttribute(node, 'cy');
      const rx = numberAttribute(node, 'rx');
      const ry = numberAttribute(node, 'ry');
      if (!(rx > 0) || !(ry > 0)) return [];
      const count = arcSegmentCount(Math.max(rx, ry), Math.PI * 2);
      const points: Vec2[] = [];
      for (let step = 0; step <= count; step += 1) {
        const angle = (step / count) * Math.PI * 2;
        points.push([cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]);
      }
      return [points];
    }
    case 'line': {
      const points: Vec2[] = [
        [numberAttribute(node, 'x1'), numberAttribute(node, 'y1')],
        [numberAttribute(node, 'x2'), numberAttribute(node, 'y2')],
      ];
      return [points];
    }
    case 'use':
    case 'image':
    case 'text':
      warnings.push(`已忽略 <${node.name}> 元素：导入器只读取几何图形。`);
      return [];
    default:
      return [];
  }
}

const LENGTH_UNITS: Record<string, { unit: FileUnit; factor: number }> = {
  mm: { unit: 'mm', factor: 1 },
  cm: { unit: 'cm', factor: 1 },
  m: { unit: 'm', factor: 1 },
  in: { unit: 'in', factor: 1 },
  pt: { unit: 'mm', factor: 25.4 / 72 },
  pc: { unit: 'mm', factor: 25.4 / 6 },
};

function parseLength(value: string | undefined): { length: number; unit: FileUnit | null } | null {
  if (!value) return null;
  const match = /^\s*([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)\s*([a-z%]*)\s*$/i.exec(value);
  if (!match) return null;
  const length = Number.parseFloat(match[1]);
  if (!Number.isFinite(length)) return null;
  const suffix = match[2].toLowerCase();
  if (!suffix || suffix === 'px') return { length, unit: null };
  const known = LENGTH_UNITS[suffix];
  return known ? { length: length * known.factor, unit: known.unit } : { length, unit: null };
}

function collect(node: XmlNode, matrix: Matrix, chains: Vec2[][], warnings: string[]): void {
  const own = node.attrs.transform ? parseTransform(node.attrs.transform) : IDENTITY;
  const combined = multiply(matrix, own);
  if (node.name !== '#document' && node.name !== 'svg' && node.name !== 'g') {
    for (const chain of shapeToChains(node, warnings)) {
      if (chain.length >= 2) chains.push(chain.map((point) => applyMatrix(combined, point)));
    }
  }
  for (const child of node.children) collect(child, combined, chains, warnings);
}

/** Parses an SVG document into closed rings in file units. */
export function parseSvg(text: string, fallbackUnit: FileUnit = 'mm'): ImportedDrawing {
  const warnings: string[] = [];
  const document = parseSvgDocument(text);
  const root = document.children.find((child) => child.name === 'svg');
  if (!root) throw new Error('文件里没有找到 <svg> 根元素，可能不是 SVG。');

  const chains: Vec2[][] = [];
  collect(root, IDENTITY, chains, warnings);
  const usable = chains.filter((chain) => chain.length >= 3);
  if (!usable.length) throw new Error('SVG 里没有解析出可用的闭合图形（path / polygon / circle / rect 等）。');
  if (chains.length > usable.length) warnings.push(`有 ${chains.length - usable.length} 段图形点数不足，已忽略。`);

  const width = parseLength(root.attrs.width);
  const height = parseLength(root.attrs.height);
  const viewBox = (root.attrs.viewbox ?? '').split(/[\s,]+/).map(Number.parseFloat).filter(Number.isFinite);

  let unit: FileUnit = fallbackUnit;
  let userScale = 1;
  if (width?.unit && viewBox.length === 4 && viewBox[2] > 0 && width.length > 0) {
    unit = width.unit;
    userScale = width.length / viewBox[2];
  } else if (height?.unit && viewBox.length === 4 && viewBox[3] > 0 && height.length > 0) {
    unit = height.unit;
    userScale = height.length / viewBox[3];
  } else {
    warnings.push('SVG 没有声明带物理单位的宽度/高度，已按 1 用户单位 = 1 所选单位处理；尺寸不对时请改单位或直接改轮廓。');
  }

  const rings = usable.map((chain) => chain.map(([x, y]): Vec2 => [x * userScale, y * userScale]));
  return { rings, unit, yDown: true, warnings };
}
