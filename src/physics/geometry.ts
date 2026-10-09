import earcut from 'earcut';
import type { ArmorConfig, Experiment, MassProperties, Profile, RobotConfig, ValidationIssue, Vec2, WeaponConfig } from '../types';

const TAU = Math.PI * 2;
const EPS = 1e-10;

const finite = (value: number): boolean => Number.isFinite(value);
const point = (x: number, y: number): Vec2 => [x, y];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const scale = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
const rotate = (p: Vec2, radians: number): Vec2 => [p[0] * Math.cos(radians) - p[1] * Math.sin(radians), p[0] * Math.sin(radians) + p[1] * Math.cos(radians)];

function circlePoints(radius: number, count = 128): Vec2[] {
  return Array.from({ length: count }, (_, i) => {
    const t = (i / count) * TAU;
    return point(radius * Math.cos(t), radius * Math.sin(t));
  });
}

function translateProfile(profile: Profile, offset: Vec2): Profile {
  const move = (ring: Vec2[]) => ring.map((p) => sub(p, offset));
  return { outer: move(profile.outer), holes: profile.holes.map(move) };
}

/** Build a weapon's 2-D swept outline in metres, with the spin axis at (0, 0). */
export function getWeaponProfile(w: WeaponConfig): Profile {
  const radius = Math.max(0, w.radius);
  let profile: Profile;
  switch (w.shape) {
    case 'disk':
      profile = { outer: circlePoints(radius), holes: [] };
      break;
    case 'ring':
      profile = { outer: circlePoints(radius), holes: w.innerRadius > 0 ? [circlePoints(Math.min(w.innerRadius, radius * 0.999999))] : [] };
      break;
    case 'bar': {
      const halfL = Math.max(w.length, EPS) / 2;
      const halfW = Math.max(w.width, EPS) / 2;
      profile = { outer: [point(-halfL, -halfW), point(halfL, -halfW), point(halfL, halfW), point(-halfL, halfW)], holes: [] };
      break;
    }
    case 'custom':
      profile = w.profile;
      break;
    case 'tooth1':
    case 'tooth2': {
      // A radial outline keeps the tooth attached to the disk while avoiding a
      // polygon boolean dependency. The extra vertices make the protrusions
      // explicit to renderers and collision proxies.
      const count = 128;
      const toothDepth = Math.max(w.width, EPS);
      const toothHalfAngle = Math.min(Math.PI / 4, Math.max(0.03, Math.atan2(Math.max(w.width, EPS), Math.max(radius, EPS))));
      const toothCenters = w.shape === 'tooth1' ? [0] : [0, Math.PI];
      const outer: Vec2[] = [];
      for (let i = 0; i < count; i += 1) {
        const theta = (i / count) * TAU;
        const hasTooth = toothCenters.some((center) => {
          const delta = Math.atan2(Math.sin(theta - center), Math.cos(theta - center));
          return Math.abs(delta) <= toothHalfAngle;
        });
        const radial = hasTooth ? radius + toothDepth : radius;
        outer.push(point(radial * Math.cos(theta), radial * Math.sin(theta)));
      }
      profile = { outer, holes: [] };
      break;
    }
    default:
      profile = { outer: [], holes: [] };
  }
  return translateProfile(profile, w.axisOffset ?? [0, 0]);
}

function segmentNormal(a: Vec2, b: Vec2): Vec2 {
  const d = sub(b, a);
  const length = Math.hypot(d[0], d[1]) || 1;
  return [-d[1] / length, d[0] / length];
}

/** Build armor side section. `length` follows local y; `thickness` follows x. */
export function getArmorProfile(a: ArmorConfig): Profile {
  if (a.shape === 'custom') return a.profile;
  const t = Math.max(a.thickness, EPS);
  const length = Math.max(a.length, EPS);
  const angle = Math.PI / 6; // Intrinsic 30-degree fold; mounting tilt is applied by the body pose.
  if (a.shape === 'plate') {
    const base: Vec2[] = [point(-t / 2, -length / 2), point(t / 2, -length / 2), point(t / 2, length / 2), point(-t / 2, length / 2)];
    return { outer: base, holes: [] };
  }

  // A folded plate is represented by a six-vertex mitered polygon around a
  // two-segment centre line. It is a legal polygon and can be triangulated
  // without thickening the profile a second time.
  const p0 = point(0, -length / 2);
  const p1 = point(0, 0);
  const p2 = add(p1, point(Math.sin(angle) * length / 2, Math.cos(angle) * length / 2));
  const n0 = scale(segmentNormal(p0, p1), t / 2);
  const n1 = scale(segmentNormal(p1, p2), t / 2);
  return { outer: [add(p0, n0), add(p1, n0), add(p2, n1), sub(p2, n1), sub(p1, n0), sub(p0, n0)], holes: [] };
}

interface PlanarIntegrals { area: number; cxNumerator: number; cyNumerator: number; x2: number; y2: number; xy: number }

function ringIntegrals(ring: Vec2[], role: 1 | -1): PlanarIntegrals {
  if (ring.length < 3) return { area: 0, cxNumerator: 0, cyNumerator: 0, x2: 0, y2: 0, xy: 0 };
  let area = 0; let cx = 0; let cy = 0; let x2 = 0; let y2 = 0; let xy = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x0, y0] = ring[i]; const [x1, y1] = ring[(i + 1) % ring.length]; const cross = x0 * y1 - x1 * y0;
    area += cross / 2;
    cx += (x0 + x1) * cross / 6;
    cy += (y0 + y1) * cross / 6;
    x2 += (x0 * x0 + x0 * x1 + x1 * x1) * cross / 12;
    y2 += (y0 * y0 + y0 * y1 + y1 * y1) * cross / 12;
    xy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * cross / 24;
  }
  const orientation = area >= 0 ? 1 : -1;
  const factor = role * orientation;
  return { area: area * factor, cxNumerator: cx * factor, cyNumerator: cy * factor, x2: x2 * factor, y2: y2 * factor, xy: xy * factor };
}

function profileIntegrals(profile: Profile): PlanarIntegrals {
  const rings = [ringIntegrals(profile.outer, 1), ...profile.holes.map((hole) => ringIntegrals(hole, -1))];
  return rings.reduce((sum, current) => ({
    area: sum.area + current.area,
    cxNumerator: sum.cxNumerator + current.cxNumerator,
    cyNumerator: sum.cyNumerator + current.cyNumerator,
    x2: sum.x2 + current.x2,
    y2: sum.y2 + current.y2,
    xy: sum.xy + current.xy,
  }), { area: 0, cxNumerator: 0, cyNumerator: 0, x2: 0, y2: 0, xy: 0 });
}

function quaternionZ(angle: number): [number, number, number, number] {
  return [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
}

function fromAnalytic(area: number, centroid: Vec2, ixxArea: number, iyyArea: number, ixyArea: number, depth: number, density: number): MassProperties {
  const safeArea = Math.max(area, 0);
  const volume = safeArea * depth;
  const mass = Math.max(0, density) * volume;
  const ixx = density * depth * ixxArea + mass * depth * depth / 12;
  const iyy = density * depth * iyyArea + mass * depth * depth / 12;
  const izz = density * depth * (ixxArea + iyyArea);
  const product = density * depth * ixyArea;
  const mean = (ixx + iyy) / 2;
  const delta = Math.hypot((ixx - iyy) / 2, product);
  const principalA = Math.max(0, mean - delta);
  const principalB = Math.max(0, mean + delta);
  const angle = 0.5 * Math.atan2(2 * product, ixx - iyy);
  const radius = mass > EPS ? Math.sqrt(Math.max(0, izz / mass)) : 0;
  return { mass, volume, area: safeArea, centroid: [centroid[0], centroid[1], 0], inertia: [ixx, iyy, izz], productXY: product, principalInertia: [principalB, principalA, izz], principalRotation: quaternionZ(angle), axisInertia: izz, radius };
}

function polygonMassProperties(profile: Profile, depth: number, density: number): MassProperties {
  const integrals = profileIntegrals(profile);
  if (integrals.area <= EPS) return fromAnalytic(0, [0, 0], 0, 0, 0, depth, density);
  const cx = integrals.cxNumerator / integrals.area; const cy = integrals.cyNumerator / integrals.area;
  const x2Centroid = integrals.x2 - integrals.area * cx * cx;
  const y2Centroid = integrals.y2 - integrals.area * cy * cy;
  const xyCentroid = integrals.xy - integrals.area * cx * cy;
  return fromAnalytic(integrals.area, [cx, cy], y2Centroid, x2Centroid, -xyCentroid, depth, density);
}

/** Mass properties of a constant-density extruded weapon profile. */
function weaponMassPropertiesBase(w: WeaponConfig): MassProperties {
  const depth = Math.max(w.thickness, 0);
  const density = Math.max(w.density, 0);
  const offset: Vec2 = w.axisOffset ?? [0, 0];
  if (w.shape === 'disk') {
    const r = Math.max(w.radius, 0); const area = Math.PI * r * r; const areaMoment = Math.PI * r ** 4 / 4;
    return fromAnalytic(area, [-offset[0], -offset[1]], areaMoment, areaMoment, 0, depth, density);
  }
  if (w.shape === 'ring') {
    const outer = Math.max(w.radius, 0); const inner = Math.min(Math.max(w.innerRadius, 0), outer);
    const area = Math.PI * (outer ** 2 - inner ** 2); const areaMoment = Math.PI * (outer ** 4 - inner ** 4) / 4;
    return fromAnalytic(area, [-offset[0], -offset[1]], areaMoment, areaMoment, 0, depth, density);
  }
  if (w.shape === 'bar') {
    const length = Math.max(w.length, 0); const width = Math.max(w.width, 0); const area = length * width;
    return fromAnalytic(area, [-offset[0], -offset[1]], length * width ** 3 / 12, width * length ** 3 / 12, 0, depth, density);
  }
  return polygonMassProperties(getWeaponProfile(w), depth, density);
}

/** Axis properties include the parallel-axis term; tip radius is geometric. */
export function weaponMassProperties(w: WeaponConfig): MassProperties {
  const p = weaponMassPropertiesBase(w);
  p.axisInertia = p.inertia[2] + p.mass * (p.centroid[0] ** 2 + p.centroid[1] ** 2);
  p.radius = Math.max(0, ...getWeaponProfile(w).outer.map(([x,y]) => Math.hypot(x,y)));
  return p;
}

/** Mass properties of an armor side section extruded across its width. */
export function armorMassProperties(a: ArmorConfig): MassProperties {
  return polygonMassProperties(getArmorProfile(a), Math.max(a.width, 0), Math.max(a.density, 0));
}

/** Triangulate a profile for Three.js or a worker-side collision mesh. */
export function triangulateProfile(profile: Profile): { vertices: number[]; indices: number[] } {
  const vertices: number[] = [];
  const holes: number[] = [];
  const rings = [profile.outer, ...profile.holes];
  rings.forEach((ring, ringIndex) => {
    if (ringIndex > 0) holes.push(vertices.length / 2);
    ring.forEach(([x, y]) => { vertices.push(x, y); });
  });
  return { vertices, indices: earcut(vertices, holes, 2) };
}

function orient(a: Vec2, b: Vec2, c: Vec2): number { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return Math.abs(orient(a, b, p)) < 1e-9 && p[0] >= Math.min(a[0], b[0]) - 1e-9 && p[0] <= Math.max(a[0], b[0]) + 1e-9 && p[1] >= Math.min(a[1], b[1]) - 1e-9 && p[1] <= Math.max(a[1], b[1]) + 1e-9;
}
function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orient(a, b, c); const o2 = orient(a, b, d); const o3 = orient(c, d, a); const o4 = orient(c, d, b);
  if (((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS)) && ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))) return true;
  return (Math.abs(o1) < EPS && onSegment(a, b, c)) || (Math.abs(o2) < EPS && onSegment(a, b, d)) || (Math.abs(o3) < EPS && onSegment(c, d, a)) || (Math.abs(o4) < EPS && onSegment(c, d, b));
}
function selfIntersects(ring: Vec2[]): boolean {
  for (let i = 0; i < ring.length; i += 1) for (let j = i + 1; j < ring.length; j += 1) {
    if (j === i || j === i + 1 || (i === 0 && j === ring.length - 1)) continue;
    if (segmentsIntersect(ring[i], ring[(i + 1) % ring.length], ring[j], ring[(j + 1) % ring.length])) return true;
  }
  return false;
}
function pointInPolygon(p: Vec2, ring: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    const intersects = ((yi > p[1]) !== (yj > p[1])) && p[0] < (xj - xi) * (p[1] - yi) / ((yj - yi) || EPS) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}
function validateProfile(profile: Profile, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (profile.outer.length < 3 || Math.abs(ringIntegrals(profile.outer, 1).area) <= EPS) issues.push({ path, level: 'error', message: '外轮廓至少需要 3 个不共线点。' });
  if (selfIntersects(profile.outer)) issues.push({ path, level: 'error', message: '外轮廓存在自交。' });
  const ringsIntersect = (a: Vec2[], b: Vec2[]) => a.some((p,i) => b.some((q,j) => segmentsIntersect(p,a[(i+1)%a.length],q,b[(j+1)%b.length])));
  profile.holes.forEach((hole, index) => {
    const holePath = `${path}.holes[${index}]`;
    if (hole.length < 3 || Math.abs(ringIntegrals(hole, 1).area) <= EPS) issues.push({ path: holePath, level: 'error', message: '孔洞必须是有效的闭合多边形。' });
    if (selfIntersects(hole)) issues.push({ path: holePath, level: 'error', message: '孔洞轮廓存在自交。' });
    if (hole.some(p => !pointInPolygon(p, profile.outer)) || ringsIntersect(hole, profile.outer)) issues.push({ path: holePath, level: 'error', message: '孔洞必须完全位于外轮廓内，不能接触或穿过外边界。' });
    if (profile.holes.some((other,j) => j!==index && (ringsIntersect(hole,other) || hole.some(p=>pointInPolygon(p,other)) || other.some(p=>pointInPolygon(p,hole))))) issues.push({ path: holePath, level: 'error', message: '孔洞不能互相重叠或嵌套。' });
  });
  return issues;
}

function addPositive(issues: ValidationIssue[], path: string, value: number, label: string, allowZero = false): void {
  if (!finite(value) || (allowZero ? value < 0 : value <= 0)) issues.push({ path, level: 'error', message: `${label}必须是${allowZero ? '非负' : '正'}有限数值（SI 单位）。` });
}

/** Validate inputs before handing them to a physics worker. */
export function validateExperiment(config: Experiment): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const weapons: [string, WeaponConfig][] = [['a.weapon', config.a.weapon]];
  if(config.mode==='weapon-weapon') weapons.push(['b.weapon',config.b.weapon]);
  const err=(path:string,message:string)=>issues.push({path,message,level:'error'});
  weapons.forEach(([path,w])=>{
    if(!['disk','ring','bar','tooth1','tooth2','custom'].includes(w.shape)) err(path+'.shape','未知武器模板。');
    addPositive(issues,path+'.density',w.density,'密度');addPositive(issues,path+'.thickness',w.thickness,'武器厚度');
    if(w.shape!=='bar'&&w.shape!=='custom')addPositive(issues,path+'.radius',w.radius,'半径');
    if(w.shape==='ring'){addPositive(issues,path+'.innerRadius',w.innerRadius,'孔半径',true);if(w.innerRadius>=w.radius)err(path+'.innerRadius','孔半径必须小于外半径。');}
    if(w.shape==='bar'){addPositive(issues,path+'.length',w.length,'武器长度');addPositive(issues,path+'.width',w.width,'武器宽度');}
    if(w.shape==='tooth1'||w.shape==='tooth2')addPositive(issues,path+'.width',w.width,'齿突出量');
    addPositive(issues,path+'.peakRpm',w.peakRpm,'峰值转速',true);
    if(w.rpmMode==='ramp'){addPositive(issues,path+'.spinupTime',w.spinupTime,'升速时间');addPositive(issues,path+'.elapsedSpinup',w.elapsedSpinup,'已升速时间',true);}
    else {addPositive(issues,path+'.initialRpm',w.initialRpm,'实际初始转速',true);if(w.initialRpm>w.peakRpm)err(path+'.initialRpm','实际初始转速不能高于峰值转速。');}
    if(w.driveEnabled)addPositive(issues,path+'.spinupTime',w.spinupTime,'驱动升速时间');
    if(!['vertical','horizontal'].includes(w.axis))err(path+'.axis','旋转平面无效。');
    if(w.direction!==1&&w.direction!==-1)err(path+'.direction','旋转方向必须为正向或负向。');
    if(!finite(w.phaseDeg))err(path+'.phaseDeg','初始相位必须为有限数值。');
    if(!Array.isArray(w.axisOffset)||w.axisOffset.length!==2||!w.axisOffset.every(finite))err(path+'.axisOffset','轴心偏移无效。');
    const profile=getWeaponProfile(w);
    if(profile.outer.length+profile.holes.flat().length>1024)err(path+'.profile','第一版轮廓最多 1024 个顶点，请先简化轮廓。');
    if([...profile.outer,...profile.holes.flat()].some(p=>p.length!==2||!p.every(finite)))err(path+'.profile','轮廓点必须是有限的二维坐标。');
    else issues.push(...validateProfile(profile,path+'.profile'));
  });
  const robots:[string,RobotConfig,number,WeaponConfig|null][]=[['a.robot',config.a.robot,weaponMassProperties(config.a.weapon).mass,config.a.weapon]];
  if(config.mode==='weapon-weapon')robots.push(['b.robot',config.b.robot,weaponMassProperties(config.b.weapon).mass,config.b.weapon]);
  else if(config.armor.mount==='robot')robots.push(['b.robot',config.b.robot,armorMassProperties(config.armor).mass,null]);
  robots.forEach(([path,r,partMass,w])=>{
    for(const key of ['mass','length','width','height'] as const)addPositive(issues,path+'.'+key,r[key],{mass:'整车总质量',length:'车体长度',width:'车体宽度',height:'车体高度'}[key]);
    addPositive(issues,path+'.speed',r.speed,'本次车速',true);addPositive(issues,path+'.maxSpeed',r.maxSpeed,'最大车速',true);
    if(r.speed>r.maxSpeed)err(path+'.speed','本次车速不能超过最大车速。');
    if(r.mass<=partMass)err(path+'.mass','整车总质量必须大于单独建模的武器或护甲质量。');
    if(w){addPositive(issues,path+'.weaponHeight',r.weaponHeight,'轴心安装高度');addPositive(issues,path+'.overhang',r.overhang,'轴心前伸量',true);
      const weaponRadius=weaponMassProperties(w).radius;
      const sweep=w.axis==='vertical'?weaponRadius:w.thickness/2;
      const bodyGapX=Math.max(0,r.overhang-r.length/2), bodyGapY=Math.max(0,r.weaponHeight-r.height);
      // The weapon is joined to its own chassis with contacts disabled, so the
      // solver never pushes it out. This check is a design guard against an
      // impossible-looking machine; the switch downgrades it to a warning for
      // builds that intentionally sink the weapon into the chassis.
      if(w.axis==='vertical'?Math.hypot(bodyGapX,bodyGapY)<weaponRadius-1e-5:(r.weaponHeight-w.thickness/2<r.height&&bodyGapX<weaponRadius)){
        const message='武器扫掠范围与简化车体重叠，请增加轴心前伸量或安装高度。';
        if(!config.settings.allowWeaponChassisOverlap) err(path+'.overhang',message);
      }
      if(r.weaponHeight < sweep && !config.settings.allowWeaponGroundContact)err(path+'.weaponHeight','武器旋转包络进入地面；打开“允许武器触地测试”后可将它作为打地工况。');
    }
  });
  if(config.mode==='weapon-armor'){
    const a=config.armor;
    for(const key of ['density','width'] as const)addPositive(issues,'armor.'+key,a[key],key==='density'?'护甲密度':'护甲宽度');
    if(a.shape!=='custom'){addPositive(issues,'armor.length',a.length,'板长');addPositive(issues,'armor.thickness',a.thickness,'真实板厚');}
    if(!['plate','bent','custom'].includes(a.shape))err('armor.shape','护甲形状无效。');
    if(!['fixed','robot'].includes(a.mount))err('armor.mount','护甲安装方式无效。');
    if(!finite(a.angleDeg)||a.angleDeg<0||a.angleDeg>180)err('armor.angleDeg','护甲安装倾角必须在 0° 到 180° 之间。');
    const p=getArmorProfile(a);issues.push(...validateProfile(p,'armor.profile'));
    const theta=(90-a.angleDeg)*Math.PI/180;
    const bottom=Math.min(...p.outer.map(([x,y])=>x*Math.sin(theta)+y*Math.cos(theta)))+a.height;
    if(!finite(a.height))err('armor.height','护甲中心安装高度必须是有限数值。');
    else if(bottom < -.00001 && !config.settings.allowArmorGroundOverlap)err('armor.height','护甲底边进入地面；关闭“限制护甲穿地”后可模拟完全接地。');
  }
  addPositive(issues,'settings.duration',config.settings.duration,'模拟时长');addPositive(issues,'settings.step',config.settings.step,'时间步长');addPositive(issues,'settings.forwardDriveTime',config.settings.forwardDriveTime,'持续前进时长',true);
  if(config.settings.duration>3)err('settings.duration','第一版单次模拟时长上限为 3 s；请缩短工况以控制本机计算量。');
  if(finite(config.settings.forwardDriveTime) && config.settings.forwardDriveTime>config.settings.duration)issues.push({path:'settings.forwardDriveTime',level:'warning',message:'持续前进时长超过模拟时长，求解只会持续到本次模拟结束。'});
  if(config.settings.step>1/240||config.settings.step<1/100000)err('settings.step','目标求解频率需在 240–100000 Hz 之间。');
  if(!finite(config.settings.restitution)||config.settings.restitution<0||config.settings.restitution>1)err('settings.restitution','恢复系数必须在 0 到 1 之间。');
  for(const k of ['friction','groundFriction','gravity','gap','startDistance'] as const)addPositive(issues,'settings.'+k,config.settings[k],{friction:'接触摩擦',groundFriction:'地面摩擦',gravity:'重力',gap:'初始间距兼容值',startDistance:'起始表面距离'}[k],true);
  for(const k of ['aHeadingDeg','bHeadingDeg'] as const)if(!finite(config.settings[k]))err('settings.'+k,'车体面向角度必须是有限数值。');
  if(!finite(config.settings.lateralOffset))err('settings.lateralOffset','横向偏移必须为有限数值。');
  if(!Number.isInteger(config.settings.seed))err('settings.seed','随机种子应为整数。');
  return issues;
}

/** Unsigned startup RPM; the direct and linear-ramp inputs are exclusive. */
export function rpmAtStart(w: WeaponConfig): number {
  return w.rpmMode==='ramp' ? Math.max(0,w.peakRpm)*Math.min(Math.max(0,w.elapsedSpinup)/Math.max(w.spinupTime,Number.EPSILON),1) : Math.max(0,w.initialRpm);
}
