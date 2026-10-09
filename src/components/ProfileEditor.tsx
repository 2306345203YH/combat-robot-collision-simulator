import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import {
  Check,
  CircleDot,
  Crosshair,
  FileUp,
  ImagePlus,
  Maximize2,
  Minus,
  MousePointer2,
  PenLine,
  Plus,
  RotateCcw,
  Ruler,
  ScanLine,
  Sparkles,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { DrawingImage, Profile, Vec2 } from '../types';
import { centerCandidates } from '../physics/contour';
import { toGrayField } from '../imaging/threshold';
import type { GrayField } from '../imaging/threshold';
import { DEFAULT_TRACE_SETTINGS, traceOutlines } from '../imaging/trace';
import type { TraceSettings, TracedOutline } from '../imaging/trace';
import { parseDxf } from '../importers/dxf';
import { UNIT_LABELS, ringsToProfile } from '../importers/profile';
import type { FileUnit } from '../importers/profile';
import { parseSvg } from '../importers/svg';
import './ProfileEditor.css';

type EditorKind = 'weapon' | 'armor';
type EditorMode = 'select' | 'outer' | 'hole' | 'calibrate';
type PolygonName = 'outer' | 'hole';
type ViewBox = { x: number; y: number; width: number; height: number };
type DragState = { polygon: PolygonName; polygonIndex: number; vertexIndex: number } | null;

export interface ProfileEditorProps {
  title: string;
  profile: Profile;
  axisOffset?: Vec2;
  image?: DrawingImage;
  onApply: (payload: { profile: Profile; axisOffset: Vec2; image?: DrawingImage }) => void;
  onClose: () => void;
  kind: EditorKind;
}

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_DRAWING_BYTES = 16 * 1024 * 1024;
const SVG_WIDTH = 960;
const SVG_HEIGHT = 560;
/** Longest edge of the working copy used for tracing; keeps big photos fast. */
const MAX_WORK_SIZE = 1400;

/** A downscaled copy of the uploaded picture plus the factor back to source pixels. */
interface WorkingField {
  field: GrayField;
  toSource: number;
}

const scaleRing = (ring: Vec2[], factor: number): Vec2[] => ring.map(([x, y]): Vec2 => [x * factor, y * factor]);

/**
 * Rescales a trace from the downscaled working copy back into source-image
 * pixels, which is the coordinate space the canvas draws in.
 */
const scaleTraced = (traced: TracedOutline, factor: number): TracedOutline => {
  if (factor === 1 || !traced.outer) return traced;
  const outer = scaleRing(traced.outer, factor);
  return {
    ...traced,
    outer,
    holes: traced.holes.map((hole) => scaleRing(hole, factor)),
    centers: centerCandidates(outer),
    rings: traced.rings.map((entry) => ({ ...entry, ring: scaleRing(entry.ring, factor) })),
  };
};

const readFileAsText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('文件读取失败，请重试。'));
    reader.readAsText(file, 'utf-8');
  });

const cloneVec = (point: Vec2): Vec2 => [point[0], point[1]];
const cloneProfile = (profile: Profile): Profile => ({
  outer: profile.outer.map(cloneVec),
  holes: profile.holes.map((hole) => hole.map(cloneVec)),
});
const cloneImage = (image?: DrawingImage): DrawingImage | undefined =>
  image ? { ...image, origin: cloneVec(image.origin) } : undefined;

const worldToCanvasStatic = (point: Vec2, image?: DrawingImage): Vec2 => {
  if (image && image.scale > 0) {
    return [image.origin[0] + point[0] / image.scale, image.origin[1] - point[1] / image.scale];
  }
  // When no calibration exists, use one canvas unit per millimetre and keep world Y up.
  return [point[0] * 1000, -point[1] * 1000];
};

const canvasToWorldStatic = (point: Vec2, image?: DrawingImage): Vec2 => {
  if (image && image.scale > 0) {
    return [(point[0] - image.origin[0]) * image.scale, (image.origin[1] - point[1]) * image.scale];
  }
  return [point[0] / 1000, -point[1] / 1000];
};

const fitViewFor = (image: DrawingImage | undefined, profile: Profile): ViewBox => {
  const points = [...profile.outer, ...profile.holes.flat()].map((point) => worldToCanvasStatic(point, image));
  if (image) {
    points.push([0, 0], [image.width, image.height]);
  }
  if (!points.length) return { x: -100, y: -100, width: 200, height: 200 };
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = Math.max(maxX - minX, 40);
  const height = Math.max(maxY - minY, 40);
  const padding = Math.max(width, height) * 0.14;
  return { x: minX - padding, y: minY - padding, width: width + padding * 2, height: height + padding * 2 };
};

const cross = (a: Vec2, b: Vec2, c: Vec2): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const between = (a: number, b: number, value: number): boolean => value >= Math.min(a, b) - 1e-9 && value <= Math.max(a, b) + 1e-9;

const segmentsIntersect = (a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean => {
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  const proper = ((abC > 1e-9 && abD < -1e-9) || (abC < -1e-9 && abD > 1e-9)) && ((cdA > 1e-9 && cdB < -1e-9) || (cdA < -1e-9 && cdB > 1e-9));
  if (proper) return true;
  if (Math.abs(abC) < 1e-9 && between(a[0], b[0], c[0]) && between(a[1], b[1], c[1])) return true;
  if (Math.abs(abD) < 1e-9 && between(a[0], b[0], d[0]) && between(a[1], b[1], d[1])) return true;
  if (Math.abs(cdA) < 1e-9 && between(c[0], d[0], a[0]) && between(c[1], d[1], a[1])) return true;
  if (Math.abs(cdB) < 1e-9 && between(c[0], d[0], b[0]) && between(c[1], d[1], b[1])) return true;
  return false;
};

const hasSelfIntersection = (polygon: Vec2[]): boolean => {
  if (polygon.length < 4) return false;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    for (let j = i + 1; j < polygon.length; j += 1) {
      const c = polygon[j];
      const d = polygon[(j + 1) % polygon.length];
      if (i === j || (i + 1) % polygon.length === j || i === (j + 1) % polygon.length) continue;
      if (i === 0 && j === polygon.length - 1) continue;
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
};

const polygonArea = (polygon: Vec2[]): number => polygon.reduce((sum, point, index) => {
  const next = polygon[(index + 1) % polygon.length];
  return sum + point[0] * next[1] - next[0] * point[1];
}, 0) / 2;

const pointInPolygon = (point: Vec2, polygon: Vec2[]): boolean => {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    const intersects = yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
};

const geometryIssues = (profile: Profile): string[] => {
  const issues: string[] = [];
  if (profile.outer.length < 3) issues.push('外轮廓至少需要 3 个点。');
  if (profile.outer.length >= 3 && Math.abs(polygonArea(profile.outer)) < 1e-10) issues.push('外轮廓面积为零，请调整点位。');
  if (hasSelfIntersection(profile.outer)) issues.push('外轮廓存在自相交线段。');
  profile.holes.forEach((hole, index) => {
    if (hole.length < 3) issues.push(`孔 ${index + 1} 至少需要 3 个点。`);
    if (hole.length >= 3 && Math.abs(polygonArea(hole)) < 1e-10) issues.push(`孔 ${index + 1} 面积为零。`);
    if (hasSelfIntersection(hole)) issues.push(`孔 ${index + 1} 存在自相交线段。`);
    if (profile.outer.length >= 3 && hole.length >= 3 && !hole.every((point) => pointInPolygon(point, profile.outer))) {
      issues.push(`孔 ${index + 1} 必须完全位于外轮廓内部。`);
    }
    if (profile.outer.length >= 3 && hole.length >= 3) {
      for (let i = 0; i < hole.length; i += 1) {
        const hA = hole[i];
        const hB = hole[(i + 1) % hole.length];
        for (let j = 0; j < profile.outer.length; j += 1) {
          if (segmentsIntersect(hA, hB, profile.outer[j], profile.outer[(j + 1) % profile.outer.length])) {
            issues.push(`孔 ${index + 1} 与外轮廓相交。`);
            i = hole.length;
            break;
          }
        }
      }
    }
  });
  for (let i = 0; i < profile.holes.length; i += 1) {
    for (let j = i + 1; j < profile.holes.length; j += 1) {
      if (profile.holes[i].some((point) => pointInPolygon(point, profile.holes[j])) || profile.holes[j].some((point) => pointInPolygon(point, profile.holes[i]))) {
        issues.push(`孔 ${i + 1} 与孔 ${j + 1} 重叠。`);
      }
    }
  }
  return issues;
};

const niceGrid = (viewBox: ViewBox, image?: DrawingImage): { stepUnits: number; stepMm: number } => {
  const mmPerUnit = image && image.scale > 0 ? image.scale * 1000 : 1;
  const targetMm = Math.max(1, (viewBox.width * mmPerUnit) / 14);
  const exponent = Math.pow(10, Math.floor(Math.log10(targetMm)));
  const normalized = targetMm / exponent;
  const nice = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
  const stepMm = nice * exponent;
  return { stepUnits: stepMm / mmPerUnit, stepMm };
};

const pointDistance = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const svgPath = (points: Vec2[], close = true): string => {
  if (!points.length) return '';
  const commands = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point[0]} ${point[1]}`).join(' ');
  return close ? `${commands} Z` : commands;
};

const formatMm = (meters: number): string => {
  const value = meters * 1000;
  return Number.isFinite(value) ? value.toFixed(Math.abs(value) >= 100 ? 1 : 2) : '0.00';
};

type FlipAxis = 'horizontal' | 'vertical';

/** Mirrors a profile around its current outer bounding-box centre. */
const flipProfile = (profile: Profile, axisOffset: Vec2, axis: FlipAxis): { profile: Profile; axisOffset: Vec2 } => {
  if (!profile.outer.length) return { profile: cloneProfile(profile), axisOffset: cloneVec(axisOffset) };
  const xs = profile.outer.map(([x]) => x);
  const ys = profile.outer.map(([, y]) => y);
  const center: Vec2 = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
  const mirror = ([x, y]: Vec2): Vec2 => axis === 'horizontal' ? [2 * center[0] - x, y] : [x, 2 * center[1] - y];
  return {
    profile: { outer: profile.outer.map(mirror), holes: profile.holes.map((hole) => hole.map(mirror)) },
    axisOffset: mirror(axisOffset),
  };
};

export default function ProfileEditor({ title, profile, axisOffset, image, onApply, onClose, kind }: ProfileEditorProps) {
  const initialProfile = useMemo(() => cloneProfile(profile), [profile]);
  const initialImage = useMemo(() => cloneImage(image), [image]);
  const [outer, setOuter] = useState<Vec2[]>(initialProfile.outer);
  const [holes, setHoles] = useState<Vec2[][]>(initialProfile.holes);
  const [editorImage, setEditorImage] = useState<DrawingImage | undefined>(initialImage);
  const [workingAxisOffset, setWorkingAxisOffset] = useState<Vec2>(() => cloneVec(axisOffset ?? [0, 0]));
  const [mode, setMode] = useState<EditorMode>('select');
  const [draft, setDraft] = useState<Vec2[]>([]);
  const [selected, setSelected] = useState<{ polygon: PolygonName; polygonIndex: number; vertexIndex: number } | null>(null);
  const [viewBox, setViewBox] = useState<ViewBox>(() => fitViewFor(initialImage, initialProfile));
  const [calibrationPoints, setCalibrationPoints] = useState<Vec2[]>([]);
  const [knownLengthMm, setKnownLengthMm] = useState('100');
  const [calibrationReady, setCalibrationReady] = useState(Boolean(initialImage && initialImage.scale > 0));
  const [calibrationConfirmed, setCalibrationConfirmed] = useState(Boolean(initialImage && initialImage.scale > 0));
  const [uploadedImage, setUploadedImage] = useState(false);
  const [notice, setNotice] = useState('选择“绘制外轮廓”后，在画布上逐点单击；点击首点或“完成闭合”结束。');
  const [fileError, setFileError] = useState('');
  const [traceOptions, setTraceOptions] = useState<TraceSettings>(DEFAULT_TRACE_SETTINGS);
  const [traceResult, setTraceResult] = useState<TracedOutline | null>(null);
  const [traceBusy, setTraceBusy] = useState(false);
  const [traceError, setTraceError] = useState('');
  const [drawingBusy, setDrawingBusy] = useState(false);
  const [cadUnit, setCadUnit] = useState<FileUnit>('mm');
  const [drawingNotes, setDrawingNotes] = useState<string[]>([]);

  const svgRef = useRef<SVGSVGElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const drawingRef = useRef<HTMLInputElement>(null);
  const workingRef = useRef<WorkingField | null>(null);
  const dragRef = useRef<DragState>(null);
  const baseRef = useRef({ profile: initialProfile, image: initialImage, axisOffset: cloneVec(axisOffset ?? [0, 0]) });

  useEffect(() => {
    const nextProfile = cloneProfile(profile);
    const nextImage = cloneImage(image);
    baseRef.current = { profile: nextProfile, image: nextImage, axisOffset: cloneVec(axisOffset ?? [0, 0]) };
    setOuter(nextProfile.outer);
    setHoles(nextProfile.holes);
    setEditorImage(nextImage);
    setWorkingAxisOffset(cloneVec(axisOffset ?? [0, 0]));
    setDraft([]);
    setSelected(null);
    setMode('select');
    setCalibrationPoints([]);
    setCalibrationReady(Boolean(nextImage && nextImage.scale > 0));
    setCalibrationConfirmed(Boolean(nextImage && nextImage.scale > 0));
    setUploadedImage(false);
    setViewBox(fitViewFor(nextImage, nextProfile));
    workingRef.current = null;
    setTraceResult(null);
    setTraceError('');
    setDrawingNotes([]);
  }, [axisOffset, image, profile]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        setDraft((points) => points.slice(0, -1));
      }
      if (event.key === 'Tab') {
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'));
        if (!focusable.length) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const firstFocusable = dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])');
    firstFocusable?.focus();
  }, []);

  const worldToCanvas = useCallback((point: Vec2): Vec2 => worldToCanvasStatic(point, editorImage), [editorImage]);
  const canvasToWorld = useCallback((point: Vec2): Vec2 => canvasToWorldStatic(point, editorImage), [editorImage]);

  const clientToCanvas = useCallback((clientX: number, clientY: number): Vec2 => {
    const svg = svgRef.current;
    if (!svg) return [0, 0];
    const rect = svg.getBoundingClientRect();
    const scale = Math.min(rect.width / viewBox.width, rect.height / viewBox.height);
    const renderedWidth = viewBox.width * scale;
    const renderedHeight = viewBox.height * scale;
    const offsetX = (rect.width - renderedWidth) / 2;
    const offsetY = (rect.height - renderedHeight) / 2;
    return [
      viewBox.x + (clientX - rect.left - offsetX) / scale,
      viewBox.y + (clientY - rect.top - offsetY) / scale,
    ];
  }, [viewBox]);

  const setVertex = useCallback((polygon: PolygonName, polygonIndex: number, vertexIndex: number, point: Vec2) => {
    if (polygon === 'outer') {
      setOuter((current) => current.map((vertex, index) => (index === vertexIndex ? cloneVec(point) : vertex)));
    } else {
      setHoles((current) => current.map((hole, index) => index === polygonIndex ? hole.map((vertex, vertexIndexInHole) => vertexIndexInHole === vertexIndex ? cloneVec(point) : vertex) : hole));
    }
  }, []);

  const finishDraft = useCallback(() => {
    if (draft.length < 3) {
      setNotice('闭合轮廓至少需要 3 个点。');
      return;
    }
    const testProfile: Profile = mode === 'outer' ? { outer: draft, holes } : { outer, holes: [...holes, draft] };
    const issues = geometryIssues(testProfile);
    const relevant = mode === 'outer' ? issues.filter((issue) => !issue.startsWith('孔')) : issues.filter((issue) => issue.includes(`孔 ${holes.length + 1}`) || issue.includes('外轮廓'));
    if (relevant.length) {
      setNotice(relevant[0]);
      return;
    }
    if (mode === 'outer') setOuter(draft.map(cloneVec));
    else setHoles((current) => [...current, draft.map(cloneVec)]);
    setDraft([]);
    setMode('select');
    setNotice(mode === 'outer' ? '外轮廓已闭合，可以拖动顶点或继续添加孔。' : '孔已闭合，可以继续添加孔或修改顶点。');
  }, [draft, holes, mode, outer]);

  const handleSvgPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (mode === 'select') return;
    const canvasPoint = clientToCanvas(event.clientX, event.clientY);
    if (mode === 'calibrate') {
      setCalibrationPoints((current) => {
        const next = current.length >= 2 ? [canvasPoint] : [...current, canvasPoint];
        setCalibrationReady(false);
        setCalibrationConfirmed(false);
        return next;
      });
      return;
    }
    const point = canvasToWorld(canvasPoint);
    if (draft.length >= 3 && pointDistance(canvasPoint, worldToCanvas(draft[0])) < Math.max(viewBox.width / 65, 8)) {
      finishDraft();
      return;
    }
    setDraft((current) => [...current, point]);
  };

  const handleVertexPointerDown = (event: ReactPointerEvent<SVGCircleElement>, polygon: PolygonName, polygonIndex: number, vertexIndex: number) => {
    if (mode !== 'select') return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { polygon, polygonIndex, vertexIndex };
    setSelected({ polygon, polygonIndex, vertexIndex });
    setNotice('拖动中；也可以在右侧顶点表中输入毫米坐标。');
  };

  const handleSvgPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    const point = canvasToWorld(clientToCanvas(event.clientX, event.clientY));
    setVertex(dragRef.current.polygon, dragRef.current.polygonIndex, dragRef.current.vertexIndex, point);
  };

  const handleSvgPointerUp = () => {
    dragRef.current = null;
  };

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
    const isJpeg = file.type === 'image/jpeg' || /\.(jpe?g)$/i.test(file.name);
    if (!isPng && !isJpeg) {
      setFileError('请选择 PNG 或 JPG 图片。');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setFileError('图片不能超过 15 MB。');
      return;
    }
    setFileError('');
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const preview = new window.Image();
      preview.onload = () => {
        const next: DrawingImage = {
          dataUrl,
          width: preview.naturalWidth,
          height: preview.naturalHeight,
          scale: 0,
          origin: [preview.naturalWidth / 2, preview.naturalHeight / 2],
        };
        setEditorImage(next);
        setOuter([]);
        setHoles([]);
        setWorkingAxisOffset([0, 0]);
        setUploadedImage(true);
        setCalibrationPoints([]);
        setCalibrationReady(false);
        setCalibrationConfirmed(false);
        // A second upload in the same editor must not reuse the previous
        // image's cached pixel field.
        workingRef.current = null;
        setMode('calibrate');
        setViewBox(fitViewFor(next, { outer: [], holes: [] }));
        setNotice('图片已载入，旧轮廓已清空。请完成校准后重新描边。');
      };
      preview.onerror = () => setFileError('图片读取失败，请换一张 PNG 或 JPG。');
      preview.src = dataUrl;
    };
    reader.onerror = () => setFileError('图片读取失败，请重试。');
    reader.readAsDataURL(file);
  };

  const calculateCalibration = () => {
    if (!editorImage || calibrationPoints.length !== 2) {
      setNotice('请先在图上点击两个标定点。');
      return;
    }
    const lengthMm = Number(knownLengthMm);
    const pixels = pointDistance(calibrationPoints[0], calibrationPoints[1]);
    if (!Number.isFinite(lengthMm) || lengthMm <= 0 || pixels < 1) {
      setNotice('已知长度必须为正数，且两个标定点不能重合。');
      return;
    }
    const next: DrawingImage = { ...editorImage, scale: lengthMm / 1000 / pixels, origin: cloneVec(calibrationPoints[0]) };
    // Re-calibration must keep an existing outline attached to the same image
    // pixels. Profiles are stored in metres, so round-trip through the old
    // pixel transform before applying the new scale and origin.
    const remapPoint = (point: Vec2): Vec2 => canvasToWorldStatic(worldToCanvasStatic(point, editorImage), next);
    setOuter((current) => current.map(remapPoint));
    setHoles((current) => current.map((hole) => hole.map(remapPoint)));
    if (editorImage.scale > 0) setWorkingAxisOffset((current) => remapPoint(current));
    setEditorImage(next);
    setCalibrationReady(true);
    setCalibrationConfirmed(false);
    setNotice('比例已计算。检查比例线后点击“确认比例”，再应用轮廓。');
  };

  const handleApply = () => {
    const issues = geometryIssues({ outer, holes });
    if (issues.length) {
      setNotice(issues[0]);
      return;
    }
    if (uploadedImage && (!editorImage || editorImage.scale <= 0 || !calibrationReady || !calibrationConfirmed)) {
      setNotice('上传图片必须完成两点校准并确认比例后才能应用。');
      setMode('calibrate');
      return;
    }
    onApply({
      profile: { outer: outer.map(cloneVec), holes: holes.map((hole) => hole.map(cloneVec)) },
      axisOffset: kind === 'weapon' ? cloneVec(workingAxisOffset) : [0, 0],
      image: cloneImage(editorImage),
    });
  };

  const handleReset = () => {
    setOuter(baseRef.current.profile.outer.map(cloneVec));
    setHoles(baseRef.current.profile.holes.map((hole) => hole.map(cloneVec)));
    setEditorImage(cloneImage(baseRef.current.image));
    setWorkingAxisOffset(cloneVec(baseRef.current.axisOffset));
    setDraft([]);
    setSelected(null);
    setMode('select');
    setUploadedImage(false);
    setCalibrationPoints([]);
    setCalibrationReady(Boolean(baseRef.current.image && baseRef.current.image.scale > 0));
    setCalibrationConfirmed(Boolean(baseRef.current.image && baseRef.current.image.scale > 0));
    setViewBox(fitViewFor(baseRef.current.image, baseRef.current.profile));
    setNotice('已恢复打开编辑器时的轮廓。');
  };

  const updateAxisOffset = (axisIndex: 0 | 1, value: string) => {
    const numeric = Number(value);
    setWorkingAxisOffset((current) => [axisIndex === 0 ? (Number.isFinite(numeric) ? numeric / 1000 : 0) : current[0], axisIndex === 1 ? (Number.isFinite(numeric) ? numeric / 1000 : 0) : current[1]]);
  };

  const updateVertexMm = (polygon: PolygonName, polygonIndex: number, vertexIndex: number, axisIndex: 0 | 1, value: string) => {
    const numeric = Number(value);
    const meters = Number.isFinite(numeric) ? numeric / 1000 : 0;
    const current = polygon === 'outer' ? outer[vertexIndex] : holes[polygonIndex]?.[vertexIndex];
    if (!current) return;
    setVertex(polygon, polygonIndex, vertexIndex, axisIndex === 0 ? [meters, current[1]] : [current[0], meters]);
  };

  const removeHole = (index: number) => {
    setHoles((current) => current.filter((_, holeIndex) => holeIndex !== index));
    setSelected(null);
  };

  const handleClear = () => {
    setOuter([]);
    setHoles([]);
    setDraft([]);
    setSelected(null);
    setMode('select');
    setNotice('轮廓已清空。请重新绘制外轮廓。');
  };

  const handleFlip = (axis: FlipAxis) => {
    if (outer.length < 3) {
      setNotice('请先导入或绘制一个外轮廓，再进行翻转。');
      return;
    }
    const flipped = flipProfile({ outer, holes }, workingAxisOffset, axis);
    setOuter(flipped.profile.outer);
    setHoles(flipped.profile.holes);
    setWorkingAxisOffset(flipped.axisOffset);
    setDraft([]);
    setSelected(null);
    setTraceResult(null);
    setNotice(axis === 'horizontal' ? '已左右翻转当前轮廓，轴心同步翻转。' : '已上下翻转当前轮廓，轴心同步翻转。');
  };

  const patchTrace = (patch: Partial<TraceSettings>) => {
    setTraceOptions((current) => ({ ...current, ...patch }));
  };

  /**
   * Draws the uploaded picture into an offscreen canvas and reads it back as a
   * grayscale field. The copy is capped at `MAX_WORK_SIZE` so tracing stays
   * responsive on phone photos, and `toSource` maps results back to full size.
   */
  const ensureWorkingField = useCallback(async (): Promise<WorkingField> => {
    if (workingRef.current) return workingRef.current;
    if (!editorImage) throw new Error('请先上传 PNG / JPG 图片。');
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new window.Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('图片解码失败，请重新上传。'));
      element.src = editorImage.dataUrl;
    });
    const longest = Math.max(image.naturalWidth, image.naturalHeight);
    const ratio = longest > MAX_WORK_SIZE ? MAX_WORK_SIZE / longest : 1;
    const width = Math.max(1, Math.round(image.naturalWidth * ratio));
    const height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('当前浏览器不支持读取画布像素。');
    context.drawImage(image, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    const working: WorkingField = { field: toGrayField(data, width, height), toSource: 1 / ratio };
    workingRef.current = working;
    return working;
  }, [editorImage]);

  const runTrace = async () => {
    if (!editorImage) {
      setTraceError('请先上传 PNG / JPG 图片。');
      return;
    }
    setTraceBusy(true);
    setTraceError('');
    try {
      const working = await ensureWorkingField();
      // Yield once so the "识别中" label paints before the synchronous scan.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const traced = scaleTraced(traceOutlines(working.field, traceOptions), working.toSource);
      setTraceResult(traced);
      if (!traced.outer) {
        setNotice(traced.warnings[0] ?? '没有识别到轮廓，请调整识别参数。');
      } else {
        setNotice(`识别到 ${traced.outer.length} 个外轮廓点、${traced.holes.length} 个孔；确认后再写入轮廓。`);
      }
    } catch (error) {
      setTraceResult(null);
      setTraceError(error instanceof Error ? error.message : '识别失败。');
    } finally {
      setTraceBusy(false);
    }
  };

  const requireCalibration = (): boolean => {
    if (editorImage && editorImage.scale > 0) return true;
    setNotice('请先完成两点校准并确认比例，识别结果才能换算成真实尺寸。');
    setMode('calibrate');
    return false;
  };

  const applyTrace = () => {
    if (!traceResult?.outer) return;
    if (!requireCalibration()) return;
    setOuter(traceResult.outer.map(canvasToWorld));
    setHoles(traceResult.holes.map((hole) => hole.map(canvasToWorld)));
    setDraft([]);
    setSelected(null);
    setMode('select');
    setNotice('识别结果已写入轮廓。可以继续拖动顶点、输入毫米坐标或增删点。');
  };

  const useCenterCandidate = (point: Vec2) => {
    if (!requireCalibration()) return;
    setWorkingAxisOffset(canvasToWorld(point));
    setNotice('轴心已设为所选中心点，可继续用轴心 X / Y 微调。');
  };

  const insertVertex = () => {
    if (!selected) return;
    const ring = selected.polygon === 'outer' ? outer : holes[selected.polygonIndex];
    if (!ring || ring.length < 2) return;
    const current = ring[selected.vertexIndex];
    const next = ring[(selected.vertexIndex + 1) % ring.length];
    const midpoint: Vec2 = [(current[0] + next[0]) / 2, (current[1] + next[1]) / 2];
    if (selected.polygon === 'outer') {
      setOuter((points) => [...points.slice(0, selected.vertexIndex + 1), midpoint, ...points.slice(selected.vertexIndex + 1)]);
    } else {
      setHoles((list) => list.map((hole, index) => (index === selected.polygonIndex ? [...hole.slice(0, selected.vertexIndex + 1), midpoint, ...hole.slice(selected.vertexIndex + 1)] : hole)));
    }
    setSelected({ ...selected, vertexIndex: selected.vertexIndex + 1 });
    setNotice('已在选中点和下一个点之间插入一个新点。');
  };

  const deleteVertex = () => {
    if (!selected) return;
    if (selected.polygon === 'outer') {
      if (outer.length <= 3) {
        setNotice('外轮廓至少需要保留 3 个点。');
        return;
      }
      setOuter((points) => points.filter((_, index) => index !== selected.vertexIndex));
    } else {
      const hole = holes[selected.polygonIndex];
      if (!hole) return;
      if (hole.length <= 3) {
        removeHole(selected.polygonIndex);
        setNotice('该孔不足 3 个点，已整孔删除。');
        return;
      }
      setHoles((list) => list.map((item, index) => (index === selected.polygonIndex ? item.filter((_, vertexIndex) => vertexIndex !== selected.vertexIndex) : item)));
    }
    setSelected(null);
    setNotice('已删除选中点。');
  };

  /**
   * CAD drawings carry real dimensions, so an imported outline lands directly
   * in profile metres and needs no two-point calibration. Any background photo
   * is dropped, because the two coordinate systems cannot be reconciled
   * without guessing.
   */
  const handleDrawingFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const isDxf = /\.dxf$/i.test(file.name);
    const isSvg = /\.svg$/i.test(file.name);
    if (!isDxf && !isSvg) {
      setFileError('图纸只支持 .dxf 与 .svg 文件。');
      return;
    }
    if (file.size > MAX_DRAWING_BYTES) {
      setFileError('图纸文件不能超过 16 MB。');
      return;
    }
    setFileError('');
    setDrawingBusy(true);
    setDrawingNotes([]);
    try {
      const text = await readFileAsText(file);
      const drawing = isDxf ? parseDxf(text, cadUnit) : parseSvg(text, cadUnit);
      // Parsers return the unit actually declared by the file when available;
      // the select value is only the fallback for unitless drawings.
      const resolvedUnit = drawing.unit;
      const imported = ringsToProfile(drawing, resolvedUnit);
      setOuter(imported.outer);
      setHoles(imported.holes);
      setEditorImage(undefined);
      setUploadedImage(false);
      setCalibrationReady(false);
      setCalibrationConfirmed(false);
      setCalibrationPoints([]);
      setWorkingAxisOffset([0, 0]);
      setDraft([]);
      setSelected(null);
      setMode('select');
      setTraceResult(null);
      workingRef.current = null;
      setViewBox(fitViewFor(undefined, { outer: imported.outer, holes: imported.holes }));
      setDrawingNotes([...drawing.warnings, ...imported.warnings]);
      setCadUnit(resolvedUnit);
      setNotice(`已从 ${isDxf ? 'DXF' : 'SVG'} 读入 ${imported.outer.length} 个外轮廓点和 ${imported.holes.length} 个孔（真实尺寸，单位 ${UNIT_LABELS[resolvedUnit]}）。`);
    } catch (error) {
      setFileError(error instanceof Error ? error.message : '图纸解析失败。');
    } finally {
      setDrawingBusy(false);
    }
  };

  const grid = useMemo(() => niceGrid(viewBox, editorImage), [editorImage, viewBox]);  const issues = useMemo(() => geometryIssues({ outer, holes }), [holes, outer]);
  const outerCanvas = outer.map(worldToCanvas);
  const holeCanvas = holes.map((hole) => hole.map(worldToCanvas));
  const draftCanvas = draft.map(worldToCanvas);
  const profileFillPath = outerCanvas.length >= 3
    ? [svgPath(outerCanvas), ...holeCanvas.filter((hole) => hole.length >= 3).map((hole) => svgPath(hole))].join(' ')
    : '';
  const allCanvas = [outerCanvas, ...holeCanvas].flat();
  const dimensions = useMemo(() => {
    if (!outer.length) return null;
    const xs = outer.map((point) => point[0]);
    const ys = outer.map((point) => point[1]);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
  }, [outer]);
  const dimensionCanvas = dimensions ? {
    minX: worldToCanvas([dimensions.minX, 0])[0],
    maxX: worldToCanvas([dimensions.maxX, 0])[0],
    minY: worldToCanvas([0, dimensions.maxY])[1],
    maxY: worldToCanvas([0, dimensions.minY])[1],
  } : null;
  const editorStyle = { '--pe-accent': kind === 'weapon' ? '#1677ff' : '#f28a35' } as CSSProperties;

  const renderVertex = (point: Vec2, polygon: PolygonName, polygonIndex: number, vertexIndex: number, color: string) => {
    const canvasPoint = worldToCanvas(point);
    const isSelected = selected?.polygon === polygon && selected.polygonIndex === polygonIndex && selected.vertexIndex === vertexIndex;
    return <circle
      key={`${polygon}-${polygonIndex}-${vertexIndex}`}
      cx={canvasPoint[0]}
      cy={canvasPoint[1]}
      r={isSelected ? 6 : 4.5}
      className={`pe-vertex ${isSelected ? 'is-selected' : ''}`}
      fill={color}
      tabIndex={mode === 'select' ? 0 : -1}
      role="button"
      aria-label={`${polygon === 'outer' ? '外轮廓' : `孔 ${polygonIndex + 1}`} 顶点 ${vertexIndex + 1}`}
      onPointerDown={(event) => handleVertexPointerDown(event, polygon, polygonIndex, vertexIndex)}
      onFocus={() => setSelected({ polygon, polygonIndex, vertexIndex })}
    />;
  };

  return (
    <div className="pe-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="pe-dialog" role="dialog" aria-modal="true" aria-labelledby="pe-dialog-title" style={editorStyle}>
        <header className="pe-header">
          <div>
            <div className="pe-kicker">PROFILE EDITOR / {kind === 'weapon' ? 'WEAPON' : 'ARMOR'}</div>
            <h2 id="pe-dialog-title">{title}</h2>
            <p className="pe-subtitle">用真实尺寸建立可检查的二维轮廓：可以直接导入 CAD 图纸，或上传图片后自动识别轮廓，识别结果都能逐点修改。</p>
          </div>
          <button className="pe-icon-button" type="button" onClick={onClose} aria-label="关闭剖面编辑器"><X size={18} /></button>
        </header>

        <div className="pe-body">
          <aside className="pe-sidebar" aria-label="轮廓编辑工具">
            <div className="pe-section-heading"><span>编辑工具</span><span className="pe-step">01</span></div>
            <div className="pe-tool-grid">
              <button type="button" className={`pe-tool-button ${mode === 'select' ? 'is-active' : ''}`} onClick={() => { setMode('select'); setDraft([]); }}><MousePointer2 size={16} />选择 / 拖动</button>
              <button type="button" className={`pe-tool-button ${mode === 'outer' ? 'is-active' : ''}`} onClick={() => { setMode('outer'); setDraft([]); setNotice('单击添加外轮廓点；点回首点或按“完成闭合”。'); }}><PenLine size={16} />绘制外轮廓</button>
              <button type="button" className={`pe-tool-button ${mode === 'hole' ? 'is-active' : ''}`} onClick={() => { setMode('hole'); setDraft([]); setNotice('单击添加孔轮廓点；孔必须完全落在外轮廓内。'); }}><CircleDot size={16} />绘制孔</button>
              {editorImage && <button type="button" className={`pe-tool-button ${mode === 'calibrate' ? 'is-active' : ''}`} onClick={() => { setMode('calibrate'); setCalibrationPoints([]); setNotice('在图片上点击两个已知距离的点。'); }}><Ruler size={16} />两点校准</button>}
            </div>

            <div className="pe-section-heading"><span>底图与图纸导入</span><span className="pe-step">02</span></div>
            <input ref={fileRef} className="pe-visually-hidden" type="file" accept="image/png,image/jpeg" onChange={handleFile} />
            <input ref={drawingRef} className="pe-visually-hidden" type="file" accept=".dxf,.svg,image/vnd.dxf,image/svg+xml" onChange={handleDrawingFile} />
            <button type="button" className="pe-secondary-button pe-full-button" onClick={() => fileRef.current?.click()}><Upload size={16} />上传 PNG / JPG</button>
            <button type="button" className="pe-secondary-button pe-full-button" onClick={() => drawingRef.current?.click()} disabled={drawingBusy}><FileUp size={16} />{drawingBusy ? '正在解析图纸…' : '导入 DXF / SVG 图纸'}</button>
            <label className="pe-field pe-field-inline"><span>图纸单位</span><select value={cadUnit} onChange={(event) => setCadUnit(event.target.value as FileUnit)} aria-label="图纸单位">{Object.entries(UNIT_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <p className="pe-help">DXF 会先读文件自带的单位声明；SVG 带物理单位时也自动换算。CAD 图纸是真实尺寸，导入后不需要两点校准。导入会替换当前轮廓并移除背景图。</p>
            {drawingNotes.length > 0 && <ul className="pe-note-list">{drawingNotes.map((note, index) => <li key={`note-${index}`}>{note}</li>)}</ul>}
            <div className="pe-action-row">
              <button type="button" className="pe-secondary-button" onClick={() => handleFlip('horizontal')} disabled={outer.length < 3}>左右翻转</button>
              <button type="button" className="pe-secondary-button" onClick={() => handleFlip('vertical')} disabled={outer.length < 3}>上下翻转</button>
            </div>
            <p className="pe-help">围绕当前外轮廓包围盒中心翻转，孔洞、轴心和已编辑点位会同步变化；图片底图本身不翻转。</p>
            {editorImage ? <div className="pe-image-card">
              <div className="pe-image-card-title"><ImagePlus size={15} />本地图片已载入</div>
              <div className="pe-image-meta">{editorImage.width} × {editorImage.height}px · {editorImage.scale > 0 ? `${(editorImage.scale * 1000).toFixed(3)} mm/px` : '未校准'}</div>
              <button type="button" className="pe-text-button" onClick={() => { setEditorImage(undefined); setUploadedImage(false); setCalibrationReady(false); setCalibrationConfirmed(false); setCalibrationPoints([]); setMode('select'); setTraceResult(null); workingRef.current = null; setViewBox(fitViewFor(undefined, { outer, holes })); }}>移除图片</button>
            </div> : <p className="pe-help">没有图片时也可以直接绘制参数化轮廓或导入 CAD 图纸。</p>}
            {fileError && <p className="pe-error" role="alert">{fileError}</p>}

            {editorImage && <div className="pe-calibration-card">
              <div className="pe-card-label">两点校准</div>
              <label className="pe-field pe-field-inline"><span>已知长度</span><span className="pe-input-suffix"><input type="number" min="0.01" step="0.1" value={knownLengthMm} onChange={(event) => setKnownLengthMm(event.target.value)} aria-label="已知长度" /><b>mm</b></span></label>
              <div className="pe-calibration-status">{calibrationPoints.length}/2 个点{calibrationReady ? ' · 比例已计算' : ''}</div>
              <button type="button" className="pe-secondary-button pe-full-button" onClick={calculateCalibration} disabled={calibrationPoints.length !== 2}><Ruler size={15} />计算比例</button>
              <button type="button" className={`pe-confirm-button pe-full-button ${calibrationConfirmed ? 'is-confirmed' : ''}`} onClick={() => setCalibrationConfirmed(true)} disabled={!calibrationReady}><Check size={15} />{calibrationConfirmed ? '比例已确认' : '确认比例'}</button>
            </div>}

            {editorImage && <div className="pe-trace-card">
              <div className="pe-card-label"><ScanLine size={14} />二值化自动识别</div>
              <label className="pe-field pe-field-inline"><span>前景判定</span><select aria-label="前景判定" value={traceOptions.foreground} onChange={(event) => patchTrace({ foreground: event.target.value as TraceSettings['foreground'] })}>
                <option value="auto">自动</option>
                <option value="alpha">透明背景（PNG）</option>
                <option value="bright">亮色物体</option>
                <option value="dark">深色物体</option>
              </select></label>
              <label className="pe-field pe-field-inline"><span>阈值</span><span className="pe-input-suffix"><input type="number" min="0" max="255" step="1" aria-label="二值化阈值" placeholder="自动" disabled={traceOptions.foreground === 'alpha'} value={traceOptions.threshold ?? ''} onChange={(event) => patchTrace({ threshold: event.target.value === '' ? null : Number(event.target.value) })} /><b>/255</b></span></label>
              <label className="pe-slider-field"><span>平滑半径<b>{traceOptions.smoothSigma.toFixed(1)} px</b></span><input type="range" min="0" max="5" step="0.5" value={traceOptions.smoothSigma} onChange={(event) => patchTrace({ smoothSigma: Number(event.target.value) })} /></label>
              <label className="pe-slider-field"><span>简化容差<b>{traceOptions.simplifyTolerance.toFixed(1)} px</b></span><input type="range" min="0" max="8" step="0.5" value={traceOptions.simplifyTolerance} onChange={(event) => patchTrace({ simplifyTolerance: Number(event.target.value) })} /></label>
              <label className="pe-slider-field"><span>最小孔面积<b>{traceOptions.minHoleArea} px²</b></span><input type="range" min="0" max="2000" step="20" value={traceOptions.minHoleArea} onChange={(event) => patchTrace({ minHoleArea: Number(event.target.value) })} /></label>
              <button type="button" className="pe-secondary-button pe-full-button" onClick={runTrace} disabled={traceBusy}><Sparkles size={15} />{traceBusy ? '正在识别…' : traceResult ? '重新识别' : '识别轮廓'}</button>
              {traceResult && <button type="button" className="pe-confirm-button pe-full-button" onClick={applyTrace} disabled={!traceResult.outer}><Check size={15} />把识别结果写入轮廓</button>}
              <p className="pe-help">识别先看图片是否带透明背景，否则按明暗阈值处理。结果会画成虚线预览，写入后仍可逐点修改。</p>
              {traceResult && <div className="pe-trace-meta">阈值 {traceResult.threshold.toFixed(1)} · {traceResult.mode === 'alpha' ? '透明背景' : traceResult.polarity === 'bright' ? '亮色物体' : '深色物体'} · 简化到 {traceResult.toleranceUsed.toFixed(2)} px</div>}
              {traceResult && traceResult.centers.length > 0 && <div className="pe-center-picks">
                <div className="pe-card-label"><Crosshair size={13} />可能的中心点</div>
                <div className="pe-center-buttons">{traceResult.centers.map((candidate) => <button key={candidate.id} type="button" className="pe-chip" title={candidate.note} onClick={() => useCenterCandidate(candidate.point)}>{candidate.label}</button>)}</div>
              </div>}
              {traceResult && traceResult.warnings.length > 0 && <ul className="pe-note-list">{traceResult.warnings.map((warning, index) => <li key={`trace-warning-${index}`}>{warning}</li>)}</ul>}
              {traceError && <p className="pe-error" role="alert">{traceError}</p>}
            </div>}

            {kind === 'weapon' && <>
              <div className="pe-section-heading"><span>旋转轴心定位</span><span className="pe-step">04</span></div>
              <p className="pe-help">编辑器只保存轴心偏移；旋转轴向由外部武器参数页管理。</p>
              <div className="pe-axis-fields">
                <label className="pe-field"><span>轴心 X</span><span className="pe-input-suffix"><input type="number" step="0.1" value={formatMm(workingAxisOffset[0])} onChange={(event) => updateAxisOffset(0, event.target.value)} /><b>mm</b></span></label>
                <label className="pe-field"><span>轴心 Y</span><span className="pe-input-suffix"><input type="number" step="0.1" value={formatMm(workingAxisOffset[1])} onChange={(event) => updateAxisOffset(1, event.target.value)} /><b>mm</b></span></label>
              </div>
            </>}

            <div className="pe-section-heading"><span>点位操作</span><span className="pe-step">05</span></div>
            <div className="pe-action-row">
              <button type="button" className="pe-secondary-button" onClick={() => setDraft((current) => current.slice(0, -1))} disabled={!draft.length}><Undo2 size={15} />撤销点</button>
              <button type="button" className="pe-secondary-button" onClick={finishDraft} disabled={draft.length < 3}><Check size={15} />完成闭合</button>
            </div>
            <div className="pe-action-row">
              <button type="button" className="pe-secondary-button" onClick={insertVertex} disabled={!selected}><Plus size={15} />插入点</button>
              <button type="button" className="pe-secondary-button" onClick={deleteVertex} disabled={!selected}><Minus size={15} />删除点</button>
            </div>
            <p className="pe-help">{selected ? `已选中${selected.polygon === 'outer' ? '外轮廓' : `孔 ${selected.polygonIndex + 1}`}第 ${selected.vertexIndex + 1} 点：插入点会加在它与下一点之间，删除点会移除它。` : '在画布上或右侧顶点表里选中一个点，就能插入或删除它。'}</p>
            <div className="pe-action-row">
              <button type="button" className="pe-secondary-button" onClick={handleClear}><Trash2 size={15} />清空轮廓</button>
              <button type="button" className="pe-secondary-button" onClick={handleReset}><RotateCcw size={15} />恢复初始</button>
            </div>
            <p className="pe-help">快捷键：Esc 关闭，Ctrl/Cmd + Z 撤销当前绘制点。</p>
          </aside>

          <main className="pe-workspace">
            <div className="pe-workspace-toolbar">
              <div className="pe-mode-pill"><span className={`pe-mode-dot pe-mode-${mode}`} />{mode === 'select' ? '选择模式' : mode === 'outer' ? '绘制外轮廓' : mode === 'hole' ? '绘制孔' : '图片校准'}</div>
              <div className="pe-zoom-controls" aria-label="画布缩放">
                <button type="button" onClick={() => setViewBox((current) => { const width = current.width / 1.2; const height = current.height / 1.2; return { x: current.x + (current.width - width) / 2, y: current.y + (current.height - height) / 2, width, height }; })} aria-label="放大"><ZoomIn size={16} /></button>
                <button type="button" onClick={() => setViewBox((current) => { const width = current.width * 1.2; const height = current.height * 1.2; return { x: current.x - (width - current.width) / 2, y: current.y - (height - current.height) / 2, width, height }; })} aria-label="缩小"><ZoomOut size={16} /></button>
                <button type="button" onClick={() => setViewBox(fitViewFor(editorImage, { outer, holes }))} aria-label="缩放至适合"><Maximize2 size={16} /></button>
              </div>
            </div>
            <div className="pe-canvas-wrap">
              <svg
                ref={svgRef}
                className="pe-canvas"
                viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
                preserveAspectRatio="xMidYMid meet"
                onPointerDown={handleSvgPointerDown}
                onPointerMove={handleSvgPointerMove}
                onPointerUp={handleSvgPointerUp}
                onPointerLeave={handleSvgPointerUp}
                aria-label="轮廓编辑画布"
              >
                <defs>
                  <pattern id="pe-grid-pattern" patternUnits="userSpaceOnUse" width={grid.stepUnits} height={grid.stepUnits}>
                    <path d={`M ${grid.stepUnits} 0 L 0 0 0 ${grid.stepUnits}`} fill="none" stroke="#d8e2ee" strokeWidth={Math.max(grid.stepUnits * 0.012, 0.35)} />
                  </pattern>
                  <marker id="pe-arrow" markerWidth="7" markerHeight="7" refX="3.5" refY="3.5" orient="auto-start-reverse"><path d="M 0 0 L 7 3.5 L 0 7 z" fill="#73849b" /></marker>
                </defs>
                <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill="#f7faff" />
                <rect x={viewBox.x} y={viewBox.y} width={viewBox.width} height={viewBox.height} fill="url(#pe-grid-pattern)" />
                {editorImage && <image href={editorImage.dataUrl} x="0" y="0" width={editorImage.width} height={editorImage.height} opacity="0.34" preserveAspectRatio="none" pointerEvents="none" />}
                <line x1={viewBox.x} x2={viewBox.x + viewBox.width} y1={0} y2={0} className="pe-axis-line" />
                <line y1={viewBox.y} y2={viewBox.y + viewBox.height} x1={0} x2={0} className="pe-axis-line" />
                {profileFillPath && <path d={profileFillPath} className="pe-outline-fill" fillRule="evenodd" />}
                {outerCanvas.length >= 2 && <polyline points={outerCanvas.map((point) => point.join(',')).join(' ')} className="pe-outline-line" />}
                {outerCanvas.length >= 3 && <line x1={outerCanvas[outerCanvas.length - 1][0]} y1={outerCanvas[outerCanvas.length - 1][1]} x2={outerCanvas[0][0]} y2={outerCanvas[0][1]} className="pe-outline-line" />}
                {holeCanvas.map((hole, index) => hole.length >= 2 && <g key={`hole-line-${index}`}><polyline points={hole.map((point) => point.join(',')).join(' ')} className="pe-hole-line" />{hole.length >= 3 && <line x1={hole[hole.length - 1][0]} y1={hole[hole.length - 1][1]} x2={hole[0][0]} y2={hole[0][1]} className="pe-hole-line" />}</g>)}
                {traceResult && <g className="pe-trace-preview" pointerEvents="none">
                  {traceResult.rings.filter((entry) => entry.accepted && entry.ring.length >= 3).map((entry, index) => <polyline key={`trace-ring-${index}`} points={entry.ring.map((point) => point.join(',')).join(' ')} className="pe-trace-line" />)}
                  {traceResult.rings.filter((entry) => !entry.accepted && entry.ring.length >= 3).map((entry, index) => <polyline key={`trace-rejected-${index}`} points={entry.ring.map((point) => point.join(',')).join(' ')} className="pe-trace-rejected" />)}
                  {traceResult.centers.map((candidate) => <g key={`trace-center-${candidate.id}`}><circle cx={candidate.point[0]} cy={candidate.point[1]} r={4} className="pe-trace-center" /><text x={candidate.point[0] + 8} y={candidate.point[1] - 8} className="pe-trace-center-label">{candidate.label}</text></g>)}
                </g>}
                {draftCanvas.length > 0 && <><polyline points={draftCanvas.map((point) => point.join(',')).join(' ')} className="pe-draft-line" />{draftCanvas.length >= 3 && <line x1={draftCanvas[draftCanvas.length - 1][0]} y1={draftCanvas[draftCanvas.length - 1][1]} x2={draftCanvas[0][0]} y2={draftCanvas[0][1]} className="pe-draft-close-line" />}</>}
                {outer.map((point, index) => renderVertex(point, 'outer', 0, index, '#1677ff'))}
                {holes.map((hole, holeIndex) => hole.map((point, vertexIndex) => renderVertex(point, 'hole', holeIndex, vertexIndex, '#f28a35')))}
                {draftCanvas.map((point, index) => <circle key={`draft-${index}`} cx={point[0]} cy={point[1]} r={index === 0 ? 5.5 : 4} className={`pe-draft-point ${index === 0 ? 'is-start' : ''}`} />)}
                {calibrationPoints.map((point, index) => <g key={`calibration-${index}`}><circle cx={point[0]} cy={point[1]} r={7} className="pe-calibration-point" /><text x={point[0] + 10} y={point[1] - 10} className="pe-calibration-label">{index + 1}</text></g>)}
                {kind === 'weapon' && <g className="pe-crosshair" aria-label="旋转轴心参考线"><line x1={worldToCanvas(workingAxisOffset)[0] - viewBox.width * .035} y1={worldToCanvas(workingAxisOffset)[1]} x2={worldToCanvas(workingAxisOffset)[0] + viewBox.width * .035} y2={worldToCanvas(workingAxisOffset)[1]} /><line x1={worldToCanvas(workingAxisOffset)[0]} y1={worldToCanvas(workingAxisOffset)[1] - viewBox.height * .035} x2={worldToCanvas(workingAxisOffset)[0]} y2={worldToCanvas(workingAxisOffset)[1] + viewBox.height * .035} /><circle cx={worldToCanvas(workingAxisOffset)[0]} cy={worldToCanvas(workingAxisOffset)[1]} r={5} /></g>}
                {dimensionCanvas && <g className="pe-dimensions"><line x1={dimensionCanvas.minX} y1={dimensionCanvas.minY - viewBox.height * .035} x2={dimensionCanvas.maxX} y2={dimensionCanvas.minY - viewBox.height * .035} markerStart="url(#pe-arrow)" markerEnd="url(#pe-arrow)" /><text x={(dimensionCanvas.minX + dimensionCanvas.maxX) / 2} y={dimensionCanvas.minY - viewBox.height * .05} textAnchor="middle">宽 {formatMm(dimensions!.maxX - dimensions!.minX)} mm</text><line x1={dimensionCanvas.maxX + viewBox.width * .035} y1={dimensionCanvas.minY} x2={dimensionCanvas.maxX + viewBox.width * .035} y2={dimensionCanvas.maxY} markerStart="url(#pe-arrow)" markerEnd="url(#pe-arrow)" /><text x={dimensionCanvas.maxX + viewBox.width * .05} y={(dimensionCanvas.minY + dimensionCanvas.maxY) / 2} textAnchor="middle" transform={`rotate(90 ${dimensionCanvas.maxX + viewBox.width * .05} ${(dimensionCanvas.minY + dimensionCanvas.maxY) / 2})`}>高 {formatMm(dimensions!.maxY - dimensions!.minY)} mm</text></g>}
                <text x={viewBox.x + viewBox.width * .02} y={viewBox.y + viewBox.height * .95} className="pe-canvas-note">网格 {grid.stepMm >= 10 ? grid.stepMm.toFixed(0) : grid.stepMm.toFixed(1)} mm · 当前画布坐标随窗口自动缩放</text>
              </svg>
            </div>
            <div className="pe-canvas-footer"><span><Crosshair size={14} />蓝色外轮廓 · 橙色孔 ·{traceResult ? ' 虚线为识别预览 ·' : ''} 参考轴 {kind === 'weapon' ? '已显示' : '不适用'}</span><span>{allCanvas.length} 个已保存点{draft.length ? ` · ${draft.length} 个待闭合点` : ''}</span></div>
          </main>

          <aside className="pe-inspector" aria-label="尺寸与顶点">
            <div className="pe-section-heading"><span>几何摘要</span><span className="pe-step">06</span></div>
            <div className={`pe-validation ${issues.length ? 'has-issues' : 'is-valid'}`} role="status">
              {issues.length ? <TriangleAlert size={16} /> : <Check size={16} />}
              <div><strong>{issues.length ? '需要检查' : '轮廓可应用'}</strong><span>{issues.length ? issues[0] : `${outer.length} 个外轮廓点 · ${holes.length} 个孔`}</span></div>
            </div>
            <div className="pe-summary-grid"><div><span>宽度</span><strong>{dimensions ? `${formatMm(dimensions.maxX - dimensions.minX)} mm` : '—'}</strong></div><div><span>高度</span><strong>{dimensions ? `${formatMm(dimensions.maxY - dimensions.minY)} mm` : '—'}</strong></div><div><span>孔数量</span><strong>{holes.length}</strong></div><div><span>图片比例</span><strong>{editorImage?.scale ? `${(editorImage.scale * 1000).toFixed(3)} mm/px` : '—'}</strong></div></div>

            <div className="pe-section-heading pe-vertex-heading"><span>顶点坐标（mm）</span><span className="pe-coordinate-hint">X / Y</span></div>
            <div className="pe-vertex-scroll">
              <div className="pe-vertex-group"><div className="pe-group-title"><span><span className="pe-swatch pe-swatch-blue" />外轮廓</span><span>{outer.length}</span></div>{outer.map((point, index) => <div className={`pe-vertex-row ${selected?.polygon === 'outer' && selected.vertexIndex === index ? 'is-selected' : ''}`} key={`outer-row-${index}`}><button type="button" className="pe-index-button" onClick={() => { setSelected({ polygon: 'outer', polygonIndex: 0, vertexIndex: index }); setMode('select'); }}>{index + 1}</button><input aria-label={`外轮廓 ${index + 1} X 坐标毫米`} type="number" step="0.1" value={formatMm(point[0])} onChange={(event) => updateVertexMm('outer', 0, index, 0, event.target.value)} /><input aria-label={`外轮廓 ${index + 1} Y 坐标毫米`} type="number" step="0.1" value={formatMm(point[1])} onChange={(event) => updateVertexMm('outer', 0, index, 1, event.target.value)} /></div>)}</div>
              {holes.map((hole, holeIndex) => <div className="pe-vertex-group" key={`hole-group-${holeIndex}`}><div className="pe-group-title"><span><span className="pe-swatch pe-swatch-orange" />孔 {holeIndex + 1}</span><button type="button" className="pe-mini-delete" aria-label={`删除孔 ${holeIndex + 1}`} onClick={() => removeHole(holeIndex)}><Trash2 size={13} /></button></div>{hole.map((point, vertexIndex) => <div className={`pe-vertex-row ${selected?.polygon === 'hole' && selected.polygonIndex === holeIndex && selected.vertexIndex === vertexIndex ? 'is-selected' : ''}`} key={`hole-${holeIndex}-${vertexIndex}`}><button type="button" className="pe-index-button pe-index-orange" onClick={() => { setSelected({ polygon: 'hole', polygonIndex: holeIndex, vertexIndex }); setMode('select'); }}>{vertexIndex + 1}</button><input aria-label={`孔 ${holeIndex + 1} ${vertexIndex + 1} X 坐标毫米`} type="number" step="0.1" value={formatMm(point[0])} onChange={(event) => updateVertexMm('hole', holeIndex, vertexIndex, 0, event.target.value)} /><input aria-label={`孔 ${holeIndex + 1} ${vertexIndex + 1} Y 坐标毫米`} type="number" step="0.1" value={formatMm(point[1])} onChange={(event) => updateVertexMm('hole', holeIndex, vertexIndex, 1, event.target.value)} /></div>)}</div>)}
            </div>
            <div className="pe-status" role="status" aria-live="polite"><span className="pe-status-dot" />{notice}</div>
          </aside>
        </div>

        <footer className="pe-footer">
          <div className="pe-footer-note"><span className="pe-local-badge">LOCAL</span><span>图片仅在本机读取；应用后保存米制轮廓坐标。</span></div>
          <div className="pe-footer-actions"><button type="button" className="pe-cancel-button" onClick={onClose}>取消</button><button type="button" className="pe-apply-button" onClick={handleApply} disabled={Boolean(issues.length) || (uploadedImage && !calibrationConfirmed)}><Plus size={16} />应用轮廓</button></div>
        </footer>
      </section>
    </div>
  );
}
