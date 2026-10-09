import { describe, expect, it } from 'vitest';
import { cloneExperiment, DEFAULT_EXPERIMENT } from '../defaults';
import type { Experiment } from '../types';
import { rpmAtStart, weaponMassProperties } from './geometry';
import { getInitialPoses } from './scene';
import { simulate } from './simulation';

function shortConfig(): Experiment {
  const c = cloneExperiment(DEFAULT_EXPERIMENT);
  c.settings.duration = 0.08;
  c.settings.step = 1 / 3000;
  c.a.robot.speed = 2;
  c.a.weapon.driveEnabled = false;
  return c;
}

describe('Rapier simulation', () => {
  it('creates finite default poses and a real armor contact', async () => {
    const config = shortConfig();
    const poses = getInitialPoses(config);
    expect(poses.aWeapon?.position.every(Number.isFinite)).toBe(true);
    const result = await simulate(config);
    expect(result.frames.length).toBeGreaterThan(2);
    expect(result.frames.every((frame) => Number.isFinite(frame.kinetic) && Number.isFinite(frame.rotationalA))).toBe(true);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.summary.totalImpulse).toBeGreaterThan(0);
    expect(result.summary.maxJointError).toBeLessThan(1e-4);
    const first = result.events[0];
    expect(Math.abs(first.rpmAfterA)).toBeLessThan(Math.abs(first.rpmBeforeA));
  }, 20_000);

  it('runs two independently spinning weapons', async () => {
    const config = shortConfig();
    config.mode = 'weapon-weapon';
    config.b.robot.speed = 2;
    config.settings.gap = 0.025;
    const result = await simulate(config);
    expect(result.events.some((event) => event.pair === 'aWeapon-bWeapon')).toBe(true);
    expect(result.frames.at(-1)?.rpmA).toBeDefined();
  }, 20_000);

  it('supports horizontal rotors and mobile armor without NaN', async () => {
    const config = shortConfig();
    config.a.weapon.axis = 'horizontal';
    config.armor.mount = 'robot';
    config.b.robot.speed = 0;
    config.settings.duration = 0.03;
    const result = await simulate(config);
    expect(result.frames.flatMap((frame) => Object.values(frame.poses)).every((pose) => !pose || pose.position.every(Number.isFinite))).toBe(true);
    expect(result.summary.finalEnergy).toBeGreaterThanOrEqual(0);
  }, 20_000);

  it('keeps free spin energy finite when gravity and drives are disabled', async () => {
    const config = shortConfig();
    config.settings.duration = 0.02;
    config.settings.gravity = 0;
    config.a.robot.speed = 0;
    const result = await simulate(config);
    const expected = 0.5 * weaponMassProperties(config.a.weapon).axisInertia * (rpmAtStart(config.a.weapon) * Math.PI / 30) ** 2;
    expect(result.frames[0].rotationalA).toBeCloseTo(expected, Math.max(1, Math.round(Math.log10(expected))));
    expect(Math.abs(result.summary.energyGain)).toBeLessThan(Math.max(0.01, result.summary.initialEnergy * 0.05));
  }, 20_000);

  it('matches the analytic frame-0 energy including chassis translation', async () => {
    const config = shortConfig();
    config.settings.gravity = 0;
    const result = await simulate(config);
    const p = weaponMassProperties(config.a.weapon);
    const omega = rpmAtStart(config.a.weapon) * Math.PI / 30;
    const expected = 0.5 * config.a.robot.mass * config.a.robot.speed ** 2 + 0.5 * p.axisInertia * omega ** 2;
    expect(result.frames[0].kinetic).toBeCloseTo(expected, Math.max(0, Math.round(Math.log10(expected)) - 1));
  }, 20_000);

  it('is stable when the physical step is halved', async () => {
    const coarse = shortConfig();
    coarse.settings.duration = 0.07;
    coarse.settings.gap = 0.025;
    const fine = cloneExperiment(coarse);
    fine.settings.step = coarse.settings.step / 2;
    const [a, b] = await Promise.all([simulate(coarse), simulate(fine)]);
    expect(a.events.length).toBeGreaterThan(0);
    expect(b.events.length).toBeGreaterThan(0);
    const impulseRelative = Math.abs(a.summary.totalImpulse - b.summary.totalImpulse) / Math.max(a.summary.totalImpulse, b.summary.totalImpulse, 1e-9);
    const rpmA = Math.abs(a.frames.at(-1)!.rpmA - b.frames.at(-1)!.rpmA) / Math.max(Math.abs(a.frames.at(-1)!.rpmA), Math.abs(b.frames.at(-1)!.rpmA), 1);
    expect(impulseRelative).toBeLessThan(0.05);
    expect(rpmA).toBeLessThan(0.05);
  }, 30_000);

  it('replays random phase from the same seed exactly', async () => {
    const config = shortConfig();
    config.settings.randomPhase = true;
    config.settings.duration = 0.025;
    const [a, b] = await Promise.all([simulate(config), simulate(config)]);
    expect(a.frames[0].poses.aWeapon).toEqual(b.frames[0].poses.aWeapon);
    expect(a.events.map((event) => [event.time, event.impulse])).toEqual(b.events.map((event) => [event.time, event.impulse]));
    const other = cloneExperiment(config);
    other.settings.seed += 1;
    const c = await simulate(other);
    expect(c.frames[0].poses.aWeapon).not.toEqual(a.frames[0].poses.aWeapon);
  }, 30_000);

  it('records a weapon hitting the ground as a visible contact event', async () => {
    const config = shortConfig();
    config.mode = 'weapon-armor';
    config.settings.gravity = 0;
    config.settings.duration = 0.02;
    config.settings.allowWeaponChassisOverlap = true;
    config.settings.allowWeaponGroundContact = true;
    config.a.robot.speed = 0;
    config.a.robot.weaponHeight = 0.004;
    config.a.weapon.axis = 'horizontal';
    config.a.weapon.thickness = 0.008;
    const result = await simulate(config);
    expect(result.events.some((event) => event.pair === 'aWeapon-ground')).toBe(true);
  }, 20_000);

  it('uses heading settings for both pose and approach velocity', async () => {
    const config = shortConfig();
    config.settings.aHeadingDeg = 30;
    config.settings.bHeadingDeg = -20;
    const poses = getInitialPoses(config);
    expect(poses.aChassis?.rotation).not.toEqual([0, 0, 0, 1]);
    expect(Math.abs(poses.aWeapon?.position[2] ?? 0)).toBeGreaterThan(1e-4);
    const result = await simulate({ ...config, settings: { ...config.settings, duration: 0.005 } });
    result.frames[0].poses.aChassis?.rotation.forEach((value, index) => expect(value).toBeCloseTo(poses.aChassis!.rotation[index], 5));
    expect(result.frames[0].speedA).toBeCloseTo(config.a.robot.speed, 6);
  }, 20_000);

  it('keeps advancing after an oblique armor contact during the drive window', async () => {
    const config = shortConfig();
    config.settings.duration = 0.08;
    config.settings.forwardDriveTime = 0.08;
    config.settings.aHeadingDeg = 18;
    config.armor.angleDeg = 52;
    config.a.robot.speed = 2;
    const initialPose = getInitialPoses(config).aChassis!;
    const initial = initialPose.position;
    const result = await simulate(config);
    const final = result.frames.at(-1)!.poses.aChassis!.position;
    expect(result.events.length).toBeGreaterThan(0);
    expect(Math.hypot(final[0] - initial[0], final[2] - initial[2])).toBeGreaterThan(0.01);
    expect(result.frames.at(-1)!.speedA).toBeGreaterThan(0.2);
    const finalRotation = result.frames.at(-1)!.poses.aChassis!.rotation;
    expect(finalRotation.some((value, index) => Math.abs(value - initialPose.rotation[index]) > 1e-4)).toBe(true);
  }, 20_000);
});
