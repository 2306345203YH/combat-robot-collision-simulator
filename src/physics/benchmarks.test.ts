import { describe, expect, it } from 'vitest';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { readContactImpulse, snapshotMotion } from './contacts';

let initialized: Promise<void> | undefined;
async function initRapier(): Promise<void> {
  initialized ??= RAPIER.init();
  await initialized;
}

interface CollisionRun {
  before: { a: number; b: number };
  after: { a: number; b: number };
  energyBefore: number;
  energyAfter: number;
  momentumBefore: number;
  momentumAfter: number;
  impulseTotal: number;
  contactSteps: number;
  lateImpulse: number;
}

function runHeadOn(restitution: number): CollisionRun {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  world.timestep = 1 / 10000;
  world.integrationParameters.numSolverIterations = 8;
  world.integrationParameters.numInternalPgsIterations = 1;
  world.integrationParameters.normalizedAllowedLinearError = 0.001;
  world.integrationParameters.normalizedPredictionDistance = 0.002;

  const bodyA = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(-0.25, 0, 0).setLinvel(1, 0, 0).setLinearDamping(0).setAngularDamping(0),
  );
  const bodyB = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(0.25, 0, 0).setLinvel(-1, 0, 0).setLinearDamping(0).setAngularDamping(0),
  );
  const colliderA = world.createCollider(RAPIER.ColliderDesc.ball(0.1).setFriction(0).setRestitution(restitution), bodyA);
  const colliderB = world.createCollider(RAPIER.ColliderDesc.ball(0.1).setFriction(0).setRestitution(restitution), bodyB);
  // Keep the benchmark's mass path identical to the product path.  The
  // collider density is the source of mass; recomputing here also catches
  // accidental use of a descriptor's default unit mass.
  bodyA.recomputeMassPropertiesFromColliders();
  bodyB.recomputeMassPropertiesFromColliders();

  const beforeA = bodyA.linvel().x;
  const beforeB = bodyB.linvel().x;
  const energyBefore = 0.5 * bodyA.mass() * beforeA ** 2 + 0.5 * bodyB.mass() * beforeB ** 2;
  const momentumBefore = bodyA.mass() * beforeA + bodyB.mass() * beforeB;
  let contactSteps = 0;
  let impulseTotal = 0;
  let lateImpulse = 0;
  let hadContact = false;
  let lastContactStep = -1;

  const totalSteps = 10000;
  for (let step = 0; step < totalSteps; step += 1) {
    // The product records the pre-step motion so a warm-started impulse left
    // after separation cannot be mistaken for a new collision impulse.
    const beforeMotion = snapshotMotion([bodyA, bodyB]);
    world.step();
    const contact = readContactImpulse(world, colliderA, colliderB, beforeMotion);
    if (contact) {
      if (hadContact && step > lastContactStep + 24) {
        // The product reader should return no value for a solver cache that
        // remains after a long separation. Keep this signal if it regresses.
        lateImpulse = Math.max(lateImpulse, contact.impulse);
      } else {
        impulseTotal += contact.impulse;
        hadContact = true;
        contactSteps += 1;
        lastContactStep = step;
      }
    }
  }

  const afterA = bodyA.linvel().x;
  const afterB = bodyB.linvel().x;
  const energyAfter = 0.5 * bodyA.mass() * afterA ** 2 + 0.5 * bodyB.mass() * afterB ** 2;
  const momentumAfter = bodyA.mass() * afterA + bodyB.mass() * afterB;
  world.free();
  return { before: { a: beforeA, b: beforeB }, after: { a: afterA, b: afterB }, energyBefore, energyAfter, momentumBefore, momentumAfter, impulseTotal, contactSteps, lateImpulse };
}

describe('Rapier free rigid-body collision baselines', () => {
  it('initializes and exchanges equal-mass head-on velocities for e=1', async () => {
    await initRapier();
    const run = runHeadOn(1);
    expect(run.contactSteps).toBeGreaterThan(0);
    const expectedImpulse = bodyMassForBenchmark() * (run.before.a - run.after.a);
    expect(Math.abs(run.impulseTotal - expectedImpulse) / expectedImpulse).toBeLessThan(0.01);
    expect(run.after.a).toBeCloseTo(run.before.b, 2);
    expect(run.after.b).toBeCloseTo(run.before.a, 2);
    expect(Math.abs(run.momentumAfter - run.momentumBefore) / 2).toBeLessThan(0.01);
    expect(Math.abs(run.energyAfter - run.energyBefore) / run.energyBefore).toBeLessThan(0.01);
    expect(run.lateImpulse).toBeLessThan(1e-8);
  });

  it('does not increase energy and removes normal relative speed for e=0', async () => {
    await initRapier();
    const run = runHeadOn(0);
    expect(run.contactSteps).toBeGreaterThan(0);
    const expectedImpulse = bodyMassForBenchmark() * (run.before.a - run.after.a);
    expect(Math.abs(run.impulseTotal - expectedImpulse) / expectedImpulse).toBeLessThan(0.01);
    expect(run.energyAfter).toBeLessThanOrEqual(run.energyBefore * 1.01);
    expect(Math.abs(run.momentumAfter - run.momentumBefore) / 2).toBeLessThan(0.01);
    expect(Math.abs(run.after.a - run.after.b)).toBeLessThan(0.03);
    expect(run.lateImpulse).toBeLessThan(1e-8);
  });

  it('conserves angular momentum for an eccentric frictionless impact', async () => {
    await initRapier();
    const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    world.timestep = 1 / 100000;
    world.integrationParameters.numSolverIterations = 8;
    world.integrationParameters.numInternalPgsIterations = 1;

    const radius = 0.1;
    // The relative velocity is along the (off-origin) center line.  A shared
    // transverse velocity gives the system non-zero orbital angular momentum
    // while keeping the sphere impact frictionless and analytically central.
    const normalLength = Math.hypot(0.5, 0.12);
    const nx = 0.5 / normalLength;
    const nz = 0.12 / normalLength;
    const bodyA = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(-0.1, 0, -0.06).setLinvel(nx, 0.5, nz).setLinearDamping(0).setAngularDamping(0),
    );
    const bodyB = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0.4, 0, 0.06).setLinvel(-nx, 0.5, -nz).setLinearDamping(0).setAngularDamping(0),
    );
    world.createCollider(RAPIER.ColliderDesc.ball(radius).setFriction(0).setRestitution(1), bodyA);
    world.createCollider(RAPIER.ColliderDesc.ball(radius).setFriction(0).setRestitution(1), bodyB);
    bodyA.recomputeMassPropertiesFromColliders();
    bodyB.recomputeMassPropertiesFromColliders();

    const initial = totalAngularMomentum([bodyA, bodyB], radius);
    for (let step = 0; step < 100000; step += 1) world.step();
    const final = totalAngularMomentum([bodyA, bodyB], radius);
    const error = Math.hypot(final[0] - initial[0], final[1] - initial[1], final[2] - initial[2]);
    const scale = Math.max(Math.hypot(...initial), 1e-8);
    // This deliberately eccentric compound baseline uses a conservative 5% gate;
    // the product simulation reports stricter joint and energy residuals.
    expect(error / scale).toBeLessThan(0.05);
    world.free();
  });
});

function bodyMassForBenchmark(): number {
  return (4 / 3) * Math.PI * 0.1 ** 3;
}

function totalAngularMomentum(bodies: RAPIER.RigidBody[], radius: number): [number, number, number] {
  const result: [number, number, number] = [0, 0, 0];
  for (const body of bodies) {
    const r = body.worldCom();
    const v = body.linvel();
    const mass = body.mass();
    result[0] += r.y * (mass * v.z) - r.z * (mass * v.y);
    result[1] += r.z * (mass * v.x) - r.x * (mass * v.z);
    result[2] += r.x * (mass * v.y) - r.y * (mass * v.x);
    // A sphere has isotropic inertia, so its body-frame spin contributes Iω
    // directly in world coordinates (frictionless impact should leave it 0).
    const w = body.angvel();
    const sphereInertia = (2 / 5) * mass * radius ** 2;
    result[0] += sphereInertia * w.x;
    result[1] += sphereInertia * w.y;
    result[2] += sphereInertia * w.z;
  }
  return result;
}
