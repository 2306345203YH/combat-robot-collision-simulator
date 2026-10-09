import { describe, expect, it } from 'vitest';
import { parseProject } from './exports';
import { DEFAULT_EXPERIMENT, normalizeExperiment } from './defaults';
import { validateExperiment } from './physics/geometry';
import type { Experiment } from './types';

const project = (config: unknown): string => JSON.stringify({ format: 'robot-collision-lab', version: 1, config });

/** Drops a settings key to imitate a project saved before that switch existed. */
const withoutOverlapSwitch = (): Experiment => {
  const older = structuredClone(DEFAULT_EXPERIMENT) as unknown as { settings: Record<string, unknown> };
  delete older.settings.allowWeaponChassisOverlap;
  return older as unknown as Experiment;
};

const withoutForwardDriveSetting = (): Experiment => {
  const older = structuredClone(DEFAULT_EXPERIMENT) as unknown as { settings: Record<string, unknown> };
  delete older.settings.forwardDriveTime;
  return older as unknown as Experiment;
};

describe('normalizeExperiment', () => {
  it('fills in a switch that the saved project predates', () => {
    const fixed = normalizeExperiment(withoutOverlapSwitch());
    expect(fixed.settings.allowWeaponChassisOverlap).toBe(false);
    expect(validateExperiment(fixed).filter((issue) => issue.level === 'error')).toEqual([]);
  });

  it('keeps an explicitly enabled switch', () => {
    const enabled = structuredClone(DEFAULT_EXPERIMENT);
    enabled.settings.allowWeaponChassisOverlap = true;
    expect(normalizeExperiment(enabled).settings.allowWeaponChassisOverlap).toBe(true);
  });

  it('fills the forward-drive window for older projects', () => {
    const fixed = normalizeExperiment(withoutForwardDriveSetting());
    expect(fixed.settings.forwardDriveTime).toBe(DEFAULT_EXPERIMENT.settings.forwardDriveTime);
  });
});

describe('parseProject', () => {
  it('round-trips the default project', () => {
    const parsed = parseProject(project(DEFAULT_EXPERIMENT));
    expect(parsed.config.name).toBe(DEFAULT_EXPERIMENT.name);
    expect(parsed.result).toBeNull();
  });

  it('still imports a project written before the overlap switch existed', () => {
    const parsed = parseProject(project(withoutOverlapSwitch()));
    expect(parsed.config.settings.allowWeaponChassisOverlap).toBe(false);
  });

  it('rejects a project whose field is the wrong type', () => {
    const broken = structuredClone(DEFAULT_EXPERIMENT) as unknown as { settings: Record<string, unknown> };
    broken.settings.allowWeaponChassisOverlap = 'yes';
    expect(() => parseProject(project(broken))).toThrow(/类型或数值无效/);
  });

  it('rejects a project whose forward-drive window is not numeric', () => {
    const broken = structuredClone(DEFAULT_EXPERIMENT) as unknown as { settings: Record<string, unknown> };
    broken.settings.forwardDriveTime = '0.5';
    expect(() => parseProject(project(broken))).toThrow(/类型或数值无效/);
  });

  it('rejects a foreign file', () => {
    expect(() => parseProject('{"hello":1}')).toThrow(/不是有效的第一版/);
  });
});
