import type { ArmorConfig, BodyId, Experiment, Pose, Vec2, Vec3, WeaponConfig } from '../types';
import { getArmorProfile, getWeaponProfile, weaponMassProperties } from './geometry';

const qz = (angle: number): [number, number, number, number] => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
const qy = (angle: number): [number, number, number, number] => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
type Q = [number, number, number, number];
const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
const qrotate = (q: Q, v: Vec3): Vec3 => {
  const p: Q = [v[0], v[1], v[2], 0]; const out = qmul(qmul(q, p), qconj(q));
  return [out[0], out[1], out[2]];
};
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const distanceX = (points: Vec2[], rotation = 0): number => {
  const c = Math.cos(rotation); const s = Math.sin(rotation);
  return Math.max(...points.map(([x, y]) => Math.abs(x * c - y * s)), 0.001);
};
const weaponExtentX = (w: WeaponConfig): number => weaponMassProperties(w).radius;
const armorExtentX = (a: ArmorConfig): number => distanceX(getArmorProfile(a).outer, (90 - a.angleDeg) * Math.PI / 180);
const pose = (position: Vec3, rotation: [number, number, number, number]): Pose => ({ position, rotation });

/**
 * Deterministic initial placement shared by the Rapier worker and the Three.js
 * preview. The two active objects are separated by `settings.gap` along x;
 * the first integration steps therefore create a reproducible impact.
 */
export function getInitialPoses(config: Experiment): Partial<Record<BodyId, Pose>> {
  let seed=config.settings.seed>>>0;
  const phase=(w:WeaponConfig)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return (config.settings.randomPhase?seed/4294967296*360:w.phaseDeg)*Math.PI/180};
  const phaseA=phase(config.a.weapon),phaseB=phase(config.b.weapon);
  const aExt = weaponExtentX(config.a.weapon);
  const aOverhang = config.a.robot.overhang;
  const lateral = config.settings.lateralOffset;
  const gap = Number.isFinite(config.settings.startDistance) ? config.settings.startDistance : config.settings.gap;
  const aYaw = qy((config.settings.aHeadingDeg ?? 0) * Math.PI / 180);
  const bYaw = qy((config.settings.bHeadingDeg ?? 0) * Math.PI / 180);
  const aHeading: Vec3 = qrotate(aYaw, [1, 0, 0]);
  const bHeading: Vec3 = qrotate(bYaw, [-1, 0, 0]);
  const aY = config.a.robot.weaponHeight;
  const aChassisX = config.mode === 'weapon-weapon'
    ? -(aExt + aOverhang + weaponExtentX(config.b.weapon) + config.b.robot.overhang + gap) / 2
    : -(aExt + aOverhang + armorExtentX(config.armor) + gap);
  const aChassis: Vec3 = [aHeading[0] * aChassisX, config.a.robot.height / 2, aHeading[2] * aChassisX];
  const aAnchor: Vec3 = [config.a.robot.overhang, config.a.robot.weaponHeight - config.a.robot.height / 2, 0];
  const aWeapon: Vec3 = add(aChassis, qrotate(aYaw, aAnchor));
  const result: Partial<Record<BodyId, Pose>> = {
    aChassis: pose(aChassis, aYaw),
    aWeapon: pose(aWeapon, qmul(aYaw, config.a.weapon.axis === 'horizontal' ? qy(phaseA) : qz(phaseA))),
  };

  if (config.mode === 'weapon-weapon') {
    const bX = (aExt + aOverhang + weaponExtentX(config.b.weapon) + config.b.robot.overhang + gap) / 2;
    const bChassis: Vec3 = [-bHeading[0] * bX, config.b.robot.height / 2, -bHeading[2] * bX + lateral];
    const bAnchor: Vec3 = [-config.b.robot.overhang, config.b.robot.weaponHeight - config.b.robot.height / 2, 0];
    result.bChassis = pose(bChassis, bYaw);
    result.bWeapon = pose(add(bChassis, qrotate(bYaw, bAnchor)), qmul(bYaw, config.b.weapon.axis === 'horizontal' ? qy(phaseB) : qz(phaseB)));
  } else {
    const armorX = 0;
    result.bArmor = pose([armorX, config.armor.height, lateral], qmul(bYaw, qz((90 - config.armor.angleDeg) * Math.PI / 180)));
    if (config.armor.mount === 'robot') {
      const chassisOffset = qrotate(bYaw, [armorExtentX(config.armor) + config.b.robot.length / 2 + .005, config.b.robot.height / 2 - config.armor.height, 0]);
      const chassis: Vec3 = add([armorX, config.armor.height, lateral], chassisOffset);
      result.bChassis = pose(chassis, bYaw);
    }
  }
  return result;
}
