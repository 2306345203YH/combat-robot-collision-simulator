import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPERIMENT } from '../defaults';
import type { Experiment, WeaponConfig } from '../types';
import { armorMassProperties, getArmorProfile, getWeaponProfile, rpmAtStart, triangulateProfile, validateExperiment, weaponMassProperties } from './geometry';

const weapon = (overrides: Partial<WeaponConfig> = {}): WeaponConfig => ({
  ...DEFAULT_EXPERIMENT.a.weapon,
  ...overrides,
  axisOffset: overrides.axisOffset ?? [0, 0],
});

describe('geometry profiles', () => {
  it('keeps a ring hole through triangulation and area calculation', () => {
    const ring = weapon({ shape: 'ring', radius: 0.1, innerRadius: 0.04, thickness: 0.01, density: 1000 });
    const profile = getWeaponProfile(ring);
    expect(profile.holes).toHaveLength(1);
    expect(triangulateProfile(profile).indices.length).toBeGreaterThan(0);
    const props = weaponMassProperties(ring);
    expect(props.area).toBeCloseTo(Math.PI * (0.1 ** 2 - 0.04 ** 2), 5);
    expect(props.inertia[2]).toBeGreaterThan(0);
    expect(props.inertia[0]).toBeCloseTo(props.inertia[1], 10);
  });

  it('uses analytic disk inertia and applies axis offset to centroid', () => {
    const disk = weapon({ shape: 'disk', radius: 0.1, thickness: 0.01, density: 1000, axisOffset: [0.02, -0.03] });
    const props = weaponMassProperties(disk);
    expect(props.mass).toBeCloseTo(Math.PI * 0.1 ** 2 * 0.01 * 1000, 8);
    expect(props.centroid[0]).toBeCloseTo(-0.02, 12);
    expect(props.centroid[1]).toBeCloseTo(0.03, 12);
    expect(props.productXY).toBeCloseTo(0, 12);
    expect(props.principalInertia[0]).toBeCloseTo(props.inertia[0], 12);
  });

  it('preserves tooth protrusions and builds a two-segment armor bend', () => {
    const tooth = getWeaponProfile(weapon({ shape: 'tooth2', radius: 0.05, width: 0.02 }));
    expect(Math.max(...tooth.outer.map(([x, y]) => Math.hypot(x, y)))).toBeGreaterThan(0.05);
    const armor = { ...DEFAULT_EXPERIMENT.armor, shape: 'bent' as const, angleDeg: 55 };
    expect(getArmorProfile(armor).outer.length).toBe(6);
    expect(armorMassProperties(armor).mass).toBeGreaterThan(0);
  });
});

describe('validation and startup values', () => {
  it('returns unsigned starting RPM independent of direction', () => {
    expect(rpmAtStart(weapon({ rpmMode:'direct', initialRpm:1200, direction:-1 }))).toBe(1200);
    expect(rpmAtStart(weapon({ rpmMode:'ramp', peakRpm:3000, initialRpm:999, spinupTime:2, elapsedSpinup:1 }))).toBe(1500);
  });

  it('reports contradictory RPM and malformed values', () => {
    const bad = structuredClone(DEFAULT_EXPERIMENT) as Experiment;
    bad.a.weapon.initialRpm = 5000;
    bad.a.weapon.rpmMode = 'direct';
    bad.a.weapon.peakRpm = 1000;
    bad.a.weapon.density = -1;
    bad.settings.restitution = 1.2;
    const issues = validateExperiment(bad);
    expect(issues.some((issue) => issue.path === 'a.weapon.initialRpm')).toBe(true);
    expect(issues.some((issue) => issue.path === 'a.weapon.density')).toBe(true);
    expect(issues.some((issue) => issue.path === 'settings.restitution')).toBe(true);
  });
});

describe('physical invariants and inactive fields',()=>{
 it('reproduces the proposal disk example including the full tensor',()=>{
  const w=weapon({shape:'disk',radius:.05,thickness:.006,density:7850});
  const p=weaponMassProperties(w);
  expect(p.mass).toBeCloseTo(.36992253496019817,12);
  expect(p.axisInertia).toBeCloseTo(.00046240316870024774,12);
  expect(.5*p.axisInertia*(3000*Math.PI/30)**2).toBeCloseTo(22.81868174440815,10);
  expect(p.inertia[0]).toBeCloseTo(p.mass*(3*.05**2+.006**2)/12,12);
  expect(p.radius).toBeCloseTo(.05,12);
 });
 it('applies parallel axis and reconstructs a non-diagonal inertia tensor',()=>{
  const w=weapon({shape:'bar',length:.14,width:.025,axisOffset:[.02,.01]});
  const p=weaponMassProperties(w);
  expect(p.axisInertia).toBeCloseTo(p.inertia[2]+p.mass*(.02**2+.01**2),12);
  const raw=getWeaponProfile({...w,axisOffset:[0,0]});const phi=.37;
  const rotated={outer:raw.outer.map(([x,y])=>[x*Math.cos(phi)-y*Math.sin(phi),x*Math.sin(phi)+y*Math.cos(phi)] as [number,number]),holes:[]};
  const q=weaponMassProperties({...w,shape:'custom',profile:rotated});
  const a=2*Math.atan2(q.principalRotation[2],q.principalRotation[3]);
  const [l1,l2]=q.principalInertia;
  expect(l1*Math.cos(a)**2+l2*Math.sin(a)**2).toBeCloseTo(q.inertia[0],12);
  expect((l1-l2)*Math.cos(a)*Math.sin(a)).toBeCloseTo(q.productXY,12);
 });
 it('keeps armor installation out of local geometry and accepts the full 0-180 degree range',()=>{
  expect(getArmorProfile({...DEFAULT_EXPERIMENT.armor,angleDeg:0})).toEqual(getArmorProfile({...DEFAULT_EXPERIMENT.armor,angleDeg:90}));
  expect(validateExperiment({...DEFAULT_EXPERIMENT,armor:{...DEFAULT_EXPERIMENT.armor,angleDeg:180}}).filter(i=>i.level==='error')).toEqual([]);
  expect(validateExperiment({...DEFAULT_EXPERIMENT,armor:{...DEFAULT_EXPERIMENT.armor,angleDeg:181}}).some(i=>i.path==='armor.angleDeg')).toBe(true);
  expect(validateExperiment(DEFAULT_EXPERIMENT).filter(i=>i.level==='error')).toEqual([]);
  const e=structuredClone(DEFAULT_EXPERIMENT);e.b.weapon.density=-1;e.b.robot.mass=.1;
  expect(validateExperiment(e).filter(i=>i.level==='error')).toEqual([]);
 });
 it('rejects a crossing hole even when its first point is inside',()=>{
  const e=structuredClone(DEFAULT_EXPERIMENT);e.a.weapon.shape='custom';e.a.weapon.profile={outer:[[-.05,-.05],[.05,-.05],[.05,.05],[-.05,.05]],holes:[[[0,0],[.07,0],[0,.02]]]};
  expect(validateExperiment(e).some(i=>i.level==='error'&&i.path.includes('holes'))).toBe(true);
 });
  it('removes the own-chassis geometry restriction when the switch is off',()=>{
  // A weapon whose sweep reaches back over the chassis, but still clears the ground.
  const sunk=structuredClone(DEFAULT_EXPERIMENT);
  sunk.a.robot.overhang=.05;
  sunk.a.robot.weaponHeight=weaponMassProperties(sunk.a.weapon).radius+.01;
  expect(validateExperiment(sunk).some(i=>i.level==='error'&&i.path==='a.robot.overhang')).toBe(true);
  sunk.settings.allowWeaponChassisOverlap=true;
  const issues=validateExperiment(sunk);
  expect(issues.filter(i=>i.level==='error')).toEqual([]);
  expect(issues.some(i=>i.path==='a.robot.overhang')).toBe(false);
 });
 it('keeps weapon-ground validation independent from own-chassis overlap',()=>{
  const sunk=structuredClone(DEFAULT_EXPERIMENT);
  sunk.settings.allowWeaponChassisOverlap=true;
  sunk.a.robot.weaponHeight=weaponMassProperties(sunk.a.weapon).radius/2;
  expect(validateExperiment(sunk).some(i=>i.level==='error'&&i.path==='a.robot.weaponHeight')).toBe(false);
  sunk.settings.allowWeaponGroundContact=false;
  expect(validateExperiment(sunk).some(i=>i.level==='error'&&i.path==='a.robot.weaponHeight')).toBe(true);
 });
 it('allows armor to start below the ground only when the armor-ground switch is off',()=>{
  const sunk=structuredClone(DEFAULT_EXPERIMENT);
  sunk.armor.height=-.005;
  expect(validateExperiment(sunk).some(i=>i.level==='error'&&i.path==='armor.height')).toBe(true);
  sunk.settings.allowArmorGroundOverlap=true;
  expect(validateExperiment(sunk).some(i=>i.level==='error'&&i.path==='armor.height')).toBe(false);
 });
});
