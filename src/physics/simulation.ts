import * as RAPIER from '@dimforge/rapier3d-compat';
import type { ArmorConfig, BodyId, ContactEvent, Experiment, Frame, MassProperties, Pose, RobotConfig, SimulationResult, Vec3, WeaponConfig } from '../types';
import { armorMassProperties, getArmorProfile, getWeaponProfile, rpmAtStart, triangulateProfile, validateExperiment, weaponMassProperties } from './geometry';
import { getInitialPoses } from './scene';
import { snapshotMotion, readContactImpulse } from './contacts';

type BodyMap = Partial<Record<BodyId, RAPIER.RigidBody>>;
type ColliderMap = Partial<Record<BodyId, RAPIER.Collider[]>>;
type WeaponBodyId = 'aWeapon' | 'bWeapon';
type Quat = [number, number, number, number];

let rapierReady: Promise<void> | undefined;
async function ensureRapier(): Promise<void> {
  rapierReady ??= RAPIER.init();
  await rapierReady;
}

const qx = (angle: number): [number, number, number, number] => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];
const qy = (angle: number): [number, number, number, number] => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
const qz = (angle: number): [number, number, number, number] => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];
const qrotate = (q: Quat, v: Vec3): Vec3 => {
  const p: Quat = [v[0], v[1], v[2], 0];
  const out = qmul(qmul(q, p), qconj(q));
  return [out[0], out[1], out[2]];
};
const vecAdd = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vecSub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vecScale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const asVec3 = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];
const asQuat = (v: { x: number; y: number; z: number; w: number }): Quat => [v.x, v.y, v.z, v.w];
const rapierVec = (v: Vec3): { x: number; y: number; z: number } => ({ x: v[0], y: v[1], z: v[2] });
const rapierQuat = (q: Quat): { x: number; y: number; z: number; w: number } => ({ x: q[0], y: q[1], z: q[2], w: q[3] });
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

interface Runtime {
  world: RAPIER.World;
  bodies: BodyMap;
  colliders: ColliderMap;
  attack: RAPIER.Collider[];
  targets: RAPIER.Collider[];
  ground: RAPIER.Collider[];
  configs: { aWeapon: WeaponConfig; bWeapon?: WeaponConfig; armor?: ArmorConfig };
  props: { aWeapon: MassProperties; bWeapon?: MassProperties; armor?: MassProperties };
  initial: Partial<Record<BodyId, Pose>>;
  driveDirections: { a: Vec3; b?: Vec3 };
  driveWork: number;
  impulse: number;
  warnings: string[];
}

const collisionGroups = (membership: number, filter: number): number => ((filter << 16) | membership) >>> 0;
const DEFAULT_GROUPS = collisionGroups(0x0001, 0xffff);
const GROUND_GROUPS = collisionGroups(0x0002, 0xffff);
const NO_GROUND_GROUPS = collisionGroups(0x0001, 0xfffd);

function bodyMassProperties(mass: number, length: number, height: number, width: number): MassProperties {
  const m = Math.max(mass, 1e-5);
  return {
    mass: m,
    volume: 0,
    area: 0,
    centroid: [0, 0, 0],
    inertia: [m * (width ** 2 + height ** 2) / 12, m * (length ** 2 + width ** 2) / 12, m * (length ** 2 + height ** 2) / 12],
    productXY: 0,
    principalInertia: [m * (width ** 2 + height ** 2) / 12, m * (length ** 2 + width ** 2) / 12, m * (length ** 2 + height ** 2) / 12],
    principalRotation: [0, 0, 0, 1],
    axisInertia: m * (length ** 2 + height ** 2) / 12,
    radius: Math.hypot(length, width, height) / 2,
  };
}

function createBody(world: RAPIER.World, id: BodyId, pose: Pose, props: MassProperties, fixed: boolean): RAPIER.RigidBody {
  const d = (fixed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic())
    .setTranslation(...pose.position)
    .setRotation(rapierQuat(pose.rotation));
  if (!fixed) d.setAdditionalMassProperties(Math.max(props.mass, 1e-5), rapierVec(props.centroid), rapierVec(props.principalInertia), rapierQuat(props.principalRotation)).setCcdEnabled(true).setLinearDamping(0).setAngularDamping(0);
  const body = world.createRigidBody(d);
  body.userData = id;
  return body;
}

function setContactMaterial(desc: RAPIER.ColliderDesc, config: Experiment): RAPIER.ColliderDesc {
  return desc.setDensity(0).setFriction(config.settings.friction).setRestitution(config.settings.restitution);
}

function createBoxCollider(world: RAPIER.World, body: RAPIER.RigidBody, length: number, height: number, width: number, config: Experiment, ground = false): RAPIER.Collider {
  const desc = setContactMaterial(RAPIER.ColliderDesc.cuboid(length / 2, height / 2, width / 2), config);
  desc.setCollisionGroups(ground ? GROUND_GROUPS : DEFAULT_GROUPS);
  if(ground){
    // All moving colliders share contact mu. Combining by multiplication
    // produces exactly the requested ground mu, independently of contact mu.
    const mu=config.settings.friction;
    desc.setFriction(mu>0?config.settings.groundFriction/mu:config.settings.groundFriction)
      .setFrictionCombineRule(mu>0?RAPIER.CoefficientCombineRule.Multiply:RAPIER.CoefficientCombineRule.Max)
      .setRestitution(0).setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Min);
  }
  return world.createCollider(desc, body);
}

function transformedPoint(p: Vec3, horizontal: boolean): Vec3 {
  if (!horizontal) return p;
  // SceneViewport applies this same base transform inside its mesh. Keeping it
  // on the collider points lets the rigid-body pose remain phase-only.
  return qrotate(qx(-Math.PI / 2), p);
}

function createProfileColliders(world: RAPIER.World, body: RAPIER.RigidBody, profile: { outer: [number, number][]; holes: [number, number][][] }, depth: number, horizontal: boolean, config: Experiment, groups = DEFAULT_GROUPS): RAPIER.Collider[] {
  const tri = triangulateProfile(profile);
  const colliders: RAPIER.Collider[] = [];
  for (let i = 0; i + 2 < tri.indices.length; i += 3) {
    const points: number[] = [];
    for (const index of [tri.indices[i], tri.indices[i + 1], tri.indices[i + 2]]) {
      const x = tri.vertices[index * 2]; const y = tri.vertices[index * 2 + 1];
      const lo = transformedPoint([x, y, -depth / 2], horizontal); const hi = transformedPoint([x, y, depth / 2], horizontal);
      points.push(...lo, ...hi);
    }
    const hull = RAPIER.ColliderDesc.convexHull(new Float32Array(points));
    if (hull) colliders.push(world.createCollider(setContactMaterial(hull, config).setCollisionGroups(groups), body));
  }
  return colliders;
}

function weaponBodyProps(w: WeaponConfig, p: MassProperties): MassProperties {
  if (w.axis !== 'horizontal') return p;
  const base = qx(-Math.PI / 2);
  return { ...p, centroid: qrotate(base, p.centroid), principalRotation: qmul(base, p.principalRotation) };
}

function attachRevolute(world: RAPIER.World, parent: RAPIER.RigidBody, child: RAPIER.RigidBody, config: Experiment, anchorParent: Vec3, axis: Vec3): void {
  const joint = world.createImpulseJoint(RAPIER.JointData.revolute(rapierVec(anchorParent), rapierVec([0, 0, 0]), rapierVec(axis)), parent, child, true);
  joint.setContactsEnabled(false);
}

function configureFixed(world: RAPIER.World, parent: RAPIER.RigidBody, child: RAPIER.RigidBody, anchorParent: Vec3, angle: number): void {
  // The parent starts unrotated and the armor starts at `angle`; both local
  // joint frames therefore map to the same world frame at t=0.
  const joint = world.createImpulseJoint(RAPIER.JointData.fixed(rapierVec(anchorParent), rapierQuat(qz(angle)), rapierVec([0, 0, 0]), rapierQuat([0, 0, 0, 1])), parent, child, true);
  joint.setContactsEnabled(false);
}

function makeRuntime(config: Experiment): Runtime {
  const world = new RAPIER.World({ x: 0, y: -config.settings.gravity, z: 0 });
  world.timestep = config.settings.step;
  world.integrationParameters.numSolverIterations = 12;
  world.integrationParameters.numInternalPgsIterations = 4;
  world.integrationParameters.maxCcdSubsteps=1;
  world.integrationParameters.normalizedAllowedLinearError=.00005;
  world.integrationParameters.normalizedPredictionDistance=.0005;
  const initial = getInitialPoses(config);
  const bodies: BodyMap = {}; const colliders: ColliderMap = {};
  const aWeaponProps = weaponMassProperties(config.a.weapon);
  const aChassisMass = Math.max(config.a.robot.mass - aWeaponProps.mass, 1e-4);
  bodies.aChassis = createBody(world, 'aChassis', initial.aChassis!, bodyMassProperties(aChassisMass, config.a.robot.length, config.a.robot.height, config.a.robot.width), false);
  bodies.aWeapon = createBody(world, 'aWeapon', initial.aWeapon!, weaponBodyProps(config.a.weapon, aWeaponProps), false);
  colliders.aChassis = [createBoxCollider(world, bodies.aChassis, config.a.robot.length, config.a.robot.height, config.a.robot.width, config)];
  const weaponGroups = config.settings.allowWeaponGroundContact ? DEFAULT_GROUPS : NO_GROUND_GROUPS;
  colliders.aWeapon = createProfileColliders(world, bodies.aWeapon, getWeaponProfile(config.a.weapon), config.a.weapon.thickness, config.a.weapon.axis === 'horizontal', config, weaponGroups);
  attachRevolute(world, bodies.aChassis, bodies.aWeapon, config, [config.a.robot.overhang, config.a.robot.weaponHeight - config.a.robot.height / 2, 0], config.a.weapon.axis === 'horizontal' ? [0, 1, 0] : [0, 0, 1]);

  let bWeaponProps: MassProperties | undefined;
  let armorProps: MassProperties | undefined;
  if (config.mode === 'weapon-weapon') {
    bWeaponProps = weaponMassProperties(config.b.weapon);
    const bChassisMass = Math.max(config.b.robot.mass - bWeaponProps.mass, 1e-4);
    bodies.bChassis = createBody(world, 'bChassis', initial.bChassis!, bodyMassProperties(bChassisMass, config.b.robot.length, config.b.robot.height, config.b.robot.width), false);
    bodies.bWeapon = createBody(world, 'bWeapon', initial.bWeapon!, weaponBodyProps(config.b.weapon, bWeaponProps), false);
    colliders.bChassis = [createBoxCollider(world, bodies.bChassis, config.b.robot.length, config.b.robot.height, config.b.robot.width, config)];
    colliders.bWeapon = createProfileColliders(world, bodies.bWeapon, getWeaponProfile(config.b.weapon), config.b.weapon.thickness, config.b.weapon.axis === 'horizontal', config, weaponGroups);
    attachRevolute(world, bodies.bChassis, bodies.bWeapon, config, [-config.b.robot.overhang, config.b.robot.weaponHeight - config.b.robot.height / 2, 0], config.b.weapon.axis === 'horizontal' ? [0, 1, 0] : [0, 0, 1]);
  } else {
    armorProps = armorMassProperties(config.armor);
    const armorFixed = config.armor.mount === 'fixed';
    bodies.bArmor = createBody(world, 'bArmor', initial.bArmor!, armorProps, armorFixed);
    const armorGroups = config.settings.allowArmorGroundOverlap ? NO_GROUND_GROUPS : DEFAULT_GROUPS;
    colliders.bArmor = createProfileColliders(world, bodies.bArmor, getArmorProfile(config.armor), config.armor.width, false, config, armorGroups);
    if (!armorFixed) {
      const bChassisMass = Math.max(config.b.robot.mass - armorProps.mass, 1e-4);
      bodies.bChassis = createBody(world, 'bChassis', initial.bChassis!, bodyMassProperties(bChassisMass, config.b.robot.length, config.b.robot.height, config.b.robot.width), false);
      colliders.bChassis = [createBoxCollider(world, bodies.bChassis, config.b.robot.length, config.b.robot.height, config.b.robot.width, config)];
      const parentRotation = initial.bChassis!.rotation;
      configureFixed(world, bodies.bChassis, bodies.bArmor, qrotate(qconj(parentRotation), vecSub(initial.bArmor!.position, initial.bChassis!.position)), (90 - config.armor.angleDeg) * Math.PI / 180);
    }
  }
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.1, 0));
  const groundCollider = createBoxCollider(world, ground, 8, 0.2, 8, config, true);
  for (const body of Object.values(bodies)) body?.recomputeMassPropertiesFromColliders();
  const heading = (deg: number, local: Vec3): Vec3 => qrotate(qy(deg * Math.PI / 180), local);
  const aHeading = heading(config.settings.aHeadingDeg, [1, 0, 0]);
  const bHeading = heading(config.settings.bHeadingDeg, [-1, 0, 0]);
  bodies.aChassis.setLinvel(rapierVec(vecScale(aHeading, config.a.robot.speed)), true);
  const setWeaponState = (id: WeaponBodyId, chassisId: BodyId, w: WeaponConfig, speed: number): void => {
    const body = bodies[id]; const chassis = bodies[chassisId]; if (!body) return;
    const omega = rpmAtStart(w) * Math.PI / 30 * w.direction; const axis = axisFor(w); body.setAngvel(rapierVec(vecScale(axis, omega)), true);
    const chassisVelocity = chassis ? asVec3(chassis.linvel()) : [speed, 0, 0] as Vec3;
    const bodyRotation = asQuat(body.rotation()); const baseCentroid = w.axis === 'horizontal' ? qrotate(qx(-Math.PI / 2), weaponMassProperties(w).centroid) : weaponMassProperties(w).centroid; const rCom = qrotate(bodyRotation, baseCentroid);
    body.setLinvel(rapierVec(vecAdd(chassisVelocity, cross(vecScale(axis, omega), rCom))), true);
  };
  setWeaponState('aWeapon', 'aChassis', config.a.weapon, config.a.robot.speed);
  if (config.mode === 'weapon-weapon' && bodies.bChassis && bodies.bWeapon) {
    bodies.bChassis.setLinvel(rapierVec(vecScale(bHeading, config.b.robot.speed)), true);
    setWeaponState('bWeapon', 'bChassis', config.b.weapon, config.b.robot.speed);
  } else if (config.armor.mount === 'robot' && bodies.bChassis && bodies.bArmor) {
    const velocity = rapierVec(vecScale(bHeading, config.b.robot.speed));
    bodies.bChassis.setLinvel(velocity, true);
    bodies.bArmor.setLinvel(velocity, true);
  }
  const attack = [...(colliders.aWeapon ?? [])];
  const targets = config.mode === 'weapon-weapon' ? [...(colliders.bWeapon ?? [])] : [...(colliders.bArmor ?? [])];
  const horizontalDirection = (q: Quat, local: Vec3): Vec3 => {
    const forward = qrotate(q, local); const length = Math.hypot(forward[0], forward[2]);
    return length > 1e-8 ? [forward[0] / length, 0, forward[2] / length] : [local[0], 0, local[2]];
  };
  return { world, bodies, colliders, attack, targets, ground: [groundCollider], configs: { aWeapon: config.a.weapon, bWeapon: config.mode === 'weapon-weapon' ? config.b.weapon : undefined, armor: config.mode === 'weapon-armor' ? config.armor : undefined }, props: { aWeapon: aWeaponProps, bWeapon: bWeaponProps, armor: armorProps }, initial, driveDirections: { a: horizontalDirection(initial.aChassis!.rotation, [1, 0, 0]), b: initial.bChassis ? horizontalDirection(initial.bChassis.rotation, [-1, 0, 0]) : undefined }, driveWork: 0, impulse: 0, warnings: [] };
}

function axisFor(w: WeaponConfig): Vec3 { return w.axis === 'horizontal' ? [0, 1, 0] : [0, 0, 1]; }
function weaponOmega(body: RAPIER.RigidBody | undefined, w: WeaponConfig, chassis?: RAPIER.RigidBody): number {
  if (!body) return 0;
  const own = asVec3(body.angvel()); const base = chassis ? asVec3(chassis.angvel()) : [0, 0, 0] as Vec3;
  return dot(vecSub(own, base), qrotate(asQuat((chassis??body).rotation()),axisFor(w)));
}
function kinetic(body: RAPIER.RigidBody): number {
  const v = asVec3(body.linvel()); const linear = 0.5 * body.mass() * dot(v, v);
  const worldOmega = asVec3(body.angvel()); const localOmega = qrotate(qconj(asQuat(body.rotation())), worldOmega);
  const principalFrame = asQuat(body.principalInertiaLocalFrame());
  const principalOmega = qrotate(qconj(principalFrame), localOmega);
  const I = asVec3(body.principalInertia());
  return linear + 0.5 * (I[0] * principalOmega[0] ** 2 + I[1] * principalOmega[1] ** 2 + I[2] * principalOmega[2] ** 2);
}
function potential(body: RAPIER.RigidBody, gravity: number): number { return body.mass() * gravity * body.worldCom().y; }
function poseOf(body: RAPIER.RigidBody | undefined): Pose | undefined {
  if (!body) return undefined;
  const p = body.translation(); const q = body.rotation();
  return { position: [p.x, p.y, p.z], rotation: [q.x, q.y, q.z, q.w] };
}
function frameOf(runtime: Runtime, config: Experiment, time: number): Frame {
  const poses: Partial<Record<BodyId, Pose>> = {};
  for (const id of ['aChassis', 'aWeapon', 'bChassis', 'bWeapon', 'bArmor'] as BodyId[]) { const p = poseOf(runtime.bodies[id]); if (p) poses[id] = p; }
  const aOmega = weaponOmega(runtime.bodies.aWeapon, config.a.weapon, runtime.bodies.aChassis); const bOmega = config.mode === 'weapon-weapon' ? weaponOmega(runtime.bodies.bWeapon, config.b.weapon, runtime.bodies.bChassis) : 0;
  const rpmA = aOmega * 30 / Math.PI; const rpmB = bOmega * 30 / Math.PI;
  let totalKinetic = 0; let potentialEnergy = 0;
  for (const body of Object.values(runtime.bodies)) if (body) { totalKinetic += kinetic(body); potentialEnergy += potential(body, config.settings.gravity); }
  const rotationalA = 0.5 * runtime.props.aWeapon.axisInertia * aOmega ** 2;
  const rotationalB = runtime.props.bWeapon ? 0.5 * runtime.props.bWeapon.axisInertia * bOmega ** 2 : 0;
  const speedA = runtime.bodies.aChassis ? norm(asVec3(runtime.bodies.aChassis.linvel())) : 0;
  const speedB = runtime.bodies.bChassis ? norm(asVec3(runtime.bodies.bChassis.linvel())) : 0;
  return { time, poses, rpmA, rpmB, speedA, speedB, rotationalA, rotationalB, kinetic: totalKinetic, potential: potentialEnergy, driveWork: runtime.driveWork, impulse: runtime.impulse };
}

function applyDrive(runtime: Runtime, config: Experiment, dt: number): number {
  let work = 0;
  const entries: Array<[WeaponBodyId, BodyId, WeaponConfig, MassProperties]> = [['aWeapon', 'aChassis', config.a.weapon, runtime.props.aWeapon]];
  if (config.mode === 'weapon-weapon' && runtime.props.bWeapon) entries.push(['bWeapon', 'bChassis', config.b.weapon, runtime.props.bWeapon]);
  for (const [weaponId, chassisId, weapon, props] of entries) {
    if (!weapon.driveEnabled) continue;
    const body = runtime.bodies[weaponId]; if (!body) continue;
    const current = weaponOmega(body, weapon, runtime.bodies[chassisId]); const target = Math.max(0, weapon.peakRpm) * Math.PI / 30 * weapon.direction;
    const acceleration = Math.abs(target)/weapon.spinupTime;
    const torque = Math.min(props.axisInertia * acceleration,props.axisInertia*Math.abs(target-current)/dt);
    const sign = Math.sign(target - current) || weapon.direction;
    const applied = torque * sign;
    const axis = qrotate(asQuat(runtime.bodies[chassisId]!.rotation()),axisFor(weapon));
    body.resetTorques(false);
    body.addTorque(rapierVec(vecScale(axis, applied)), true);
    const chassis = runtime.bodies[chassisId]; if (chassis) { chassis.resetTorques(false); chassis.addTorque(rapierVec(vecScale(axis, -applied)), true); }
    work += applied * current * dt;
  }
  return work;
}

/**
 * Keep the robot moving through the configured approach window. This models a
 * driver/traction input instead of overwriting the angular response produced
 * by the contact solver: only the horizontal velocity error is corrected.
 * A value of zero intentionally restores a free-flight collision.
 */
function applyForwardDrive(runtime: Runtime, config: Experiment, time: number, dt: number): number {
  if (config.settings.forwardDriveTime <= 0 || time >= config.settings.forwardDriveTime) return 0;
  const entries: Array<[BodyId, RobotConfig, Vec3, BodyId[]]> = [
    ['aChassis', config.a.robot, runtime.driveDirections.a, ['aWeapon']],
  ];
  // Keep the active A-side driver as the primary approach input. For a mobile
  // armor target we also advance B; weapon-versus-weapon tests retain their
  // independent initial velocities to avoid two opposing traction loops
  // pinning the contact manifold indefinitely.
  if (config.armor.mount === 'robot' && runtime.driveDirections.b) entries.push(['bChassis', config.b.robot, runtime.driveDirections.b, ['bArmor']]);
  let work = 0;
  for (const [id, robot, direction, attachedIds] of entries) {
    const body = runtime.bodies[id];
    if (!body || robot.speed <= 0) continue;
    const velocity = asVec3(body.linvel());
    const error: Vec3 = [direction[0] * robot.speed - velocity[0], 0, direction[2] * robot.speed - velocity[2]];
    // A bounded traction acceleration avoids injecting an impulse large enough
    // to make the revolute joint visibly drift during an impact.
    const maxAcceleration = 0.5;
    const invDt = 1 / Math.max(dt, 1e-6);
    const acceleration: Vec3 = [Math.max(-maxAcceleration, Math.min(maxAcceleration, error[0] * invDt)), 0, Math.max(-maxAcceleration, Math.min(maxAcceleration, error[2] * invDt))];
    const drivenIds = [id, ...attachedIds];
    for (const drivenId of drivenIds) {
      const drivenBody = runtime.bodies[drivenId];
      if (!drivenBody) continue;
      const force = vecScale(acceleration, drivenBody.mass());
      drivenBody.addForce(rapierVec(force), true);
      work += dot(force, asVec3(drivenBody.linvel())) * dt;
    }
  }
  return work;
}

function jointError(runtime: Runtime, config: Experiment): {position:number;angle:number;velocity:number} {
  let max = 0,angle=0,velocity=0;
  const checks: Array<[BodyId, BodyId, Vec3]> = [['aChassis', 'aWeapon', [config.a.robot.overhang, config.a.robot.weaponHeight - config.a.robot.height / 2, 0]]];
  if (config.mode === 'weapon-weapon') checks.push(['bChassis', 'bWeapon', [-config.b.robot.overhang, config.b.robot.weaponHeight - config.b.robot.height / 2, 0]]);
  else if (config.armor.mount === 'robot') checks.push(['bChassis', 'bArmor', vecSub(runtime.initial.bArmor!.position,runtime.initial.bChassis!.position)]);
  for (const [parentId, childId, anchor] of checks) {
    const parent = runtime.bodies[parentId]; const child = runtime.bodies[childId]; if (!parent || !child) continue;
    const pp = asVec3(parent.translation()); const pq = parent.rotation(); const expected = vecAdd(pp, qrotate([pq.x, pq.y, pq.z, pq.w], anchor));
    max = Math.max(max, norm(vecSub(asVec3(child.translation()), expected)));
    velocity=Math.max(velocity,norm(vecSub(asVec3(parent.velocityAtPoint(rapierVec(expected))),asVec3(child.velocityAtPoint(rapierVec(expected))))));
    if(childId==='aWeapon'||childId==='bWeapon'){
      const w=childId==='aWeapon'?config.a.weapon:config.b.weapon;
      const axis=axisFor(w),a=qrotate(asQuat(parent.rotation()),axis),b=qrotate(asQuat(child.rotation()),axis);
      angle=Math.max(angle,Math.acos(Math.min(1,Math.max(-1,dot(a,b)/(norm(a)*norm(b))))));
    }
  }
  return {position:max,angle,velocity};
}

/** Run a deterministic Rapier rigid-body experiment. */
export async function simulate(config: Experiment, onProgress?: (progress: number) => void): Promise<SimulationResult> {
  await ensureRapier();
  const issues = validateExperiment(config);
  const errors = issues.filter((issue) => issue.level === 'error');
  if (errors.length) throw new Error(errors.map((issue) => `${issue.path}: ${issue.message}`).join('；'));
  const snapshot = structuredClone(config) as Experiment;
  const weapons=snapshot.mode==='weapon-weapon'?[snapshot.a.weapon,snapshot.b.weapon]:[snapshot.a.weapon];
  const maxOmega=Math.max(...weapons.map(w=>Math.max(rpmAtStart(w),w.driveEnabled?w.peakRpm:0)*Math.PI/30));
  const tipSpeed=weapons.reduce((s,w)=>s+Math.max(rpmAtStart(w),w.driveEnabled?w.peakRpm:0)*Math.PI/30*weaponMassProperties(w).radius,0)+snapshot.a.robot.speed+(snapshot.mode==='weapon-weapon'||snapshot.armor.mount==='robot'?snapshot.b.robot.speed:0);
  const minFeature=Math.min(...weapons.map(w=>w.thickness),snapshot.mode==='weapon-armor'&&snapshot.armor.shape!=='custom'?snapshot.armor.thickness:Infinity);
  const requestedDt=Math.min(snapshot.settings.step,maxOmega>0?.035/maxOmega:Infinity,tipSpeed>0?minFeature/(2*tipSpeed):Infinity);
  const steps=Math.ceil(snapshot.settings.duration/requestedDt-1e-9);
  if(steps>160000||requestedDt<1e-6)throw new Error('当前转速或最小厚度需要超出第一版计算范围的时间步。请降低转速、缩短时长或使用更精细的专用求解器；本次不输出有效结论。');
  const dt=snapshot.settings.duration/steps;
  const runtime = makeRuntime(snapshot);
  try {
  const started = performance.now();
  const sampleHz=Math.min(2400,Math.max(600,maxOmega/(2*Math.PI)*12));
  const sampleEvery = Math.max(1, Math.round(1 / (sampleHz * dt)));
  const frames: Frame[] = []; const events: ContactEvent[] = []; const active = new Map<string, { index: number; step: number }>();
  const initialFrame = frameOf(runtime, snapshot, 0); frames.push(initialFrame);
  const initialEnergy = initialFrame.kinetic + initialFrame.potential;
  let maxJointError = 0,maxJointAngleError=0,maxJointVelocityError=0;
  const targetHandles = new Set(runtime.targets.map((target) => target.handle));
  const groundHandles = new Set(runtime.ground.map((ground) => ground.handle));
  let time = 0;
  for (let step = 1; step <= steps; step += 1) {
    const beforeA = weaponOmega(runtime.bodies.aWeapon, snapshot.a.weapon, runtime.bodies.aChassis) * 30 / Math.PI;
    const beforeB = snapshot.mode === 'weapon-weapon' && runtime.bodies.bWeapon ? weaponOmega(runtime.bodies.bWeapon, snapshot.b.weapon, runtime.bodies.bChassis) * 30 / Math.PI : 0;
    const stepDt = Math.min(dt, Math.max(0, snapshot.settings.duration - time));
    if (stepDt <= 0) break;
    runtime.world.timestep = stepDt;
    runtime.driveWork += applyDrive(runtime, snapshot, stepDt);
    runtime.driveWork += applyForwardDrive(runtime, snapshot, time, stepDt);
    const motionBefore=snapshotMotion(Object.values(runtime.bodies));
    runtime.world.step();
    time = step===steps?snapshot.settings.duration:step*dt;
    const afterA = weaponOmega(runtime.bodies.aWeapon, snapshot.a.weapon, runtime.bodies.aChassis) * 30 / Math.PI;
    const afterB = snapshot.mode === 'weapon-weapon' && runtime.bodies.bWeapon ? weaponOmega(runtime.bodies.bWeapon, snapshot.b.weapon, runtime.bodies.bChassis) * 30 / Math.PI : 0;
    const pairContacts = new Map<string, { impulse: number; point: Vec3; normal: Vec3 }>();
    let contactChanged=false;
    for (const attack of runtime.attack) {
      runtime.world.contactPairsWith(attack, (other) => {
        if (!targetHandles.has(other.handle) && !groundHandles.has(other.handle)) return;
        const contact = readContactImpulse(runtime.world, attack, other, motionBefore); if (!contact || contact.impulse <= 1e-9) return;
        const pair = groundHandles.has(other.handle) ? 'aWeapon-ground' : snapshot.mode === 'weapon-weapon' ? 'aWeapon-bWeapon' : 'aWeapon-bArmor';
        const prior = pairContacts.get(pair);
        if (prior) { prior.impulse += contact.impulse; prior.point = contact.point; prior.normal = contact.normal; } else pairContacts.set(pair, contact);
      });
    }
    for (const [pair, contact] of pairContacts) {
      runtime.impulse += contact.impulse;
      const previous = active.get(pair);
      if (previous && previous.step >= step - 1) {
        const event = events[previous.index]; event.impulse += contact.impulse; event.point = contact.point; event.normal = contact.normal; event.rpmAfterA = afterA; event.rpmAfterB = afterB; previous.step = step;
      } else {
        contactChanged=true;
        events.push({ time, point: contact.point, normal: contact.normal, impulse: contact.impulse, pair, rpmBeforeA: beforeA, rpmAfterA: afterA, rpmBeforeB: beforeB, rpmAfterB: afterB });
        active.set(pair, { index: events.length - 1, step });
      }
    }
    for(const [pair,a]of active)if(a.step<step){contactChanged=true;active.delete(pair)}
    const residual=jointError(runtime,snapshot);
    maxJointError = Math.max(maxJointError,residual.position);maxJointAngleError=Math.max(maxJointAngleError,residual.angle);maxJointVelocityError=Math.max(maxJointVelocityError,residual.velocity);
    if (step % sampleEvery === 0 || step === steps || contactChanged){
      const frame=frameOf(runtime,snapshot,time);
      if(!Number.isFinite(frame.kinetic+frame.potential+frame.rpmA+frame.rpmB))throw new Error('求解出现非有限数值，本次计算无效。请检查尺寸与转速。');
      frames.push(frame);
      if(frames.length>10000)throw new Error('接触过于频繁，超过第一版记录上限，请缩短模拟时长。');
    }
    if (step % Math.max(1, Math.floor(steps / 100)) === 0) onProgress?.(step / steps);
  }
  const finalFrame = frames.at(-1)!; const finalEnergy = finalFrame.kinetic + finalFrame.potential;
  const dissipated = initialEnergy + runtime.driveWork - finalEnergy;
  const warnings = issues.filter((issue) => issue.level === 'warning').map((issue) => `${issue.path}: ${issue.message}`);
  if (!events.length) warnings.push('本次计算未记录到武器与目标的有效接触冲量；请检查初始间距、安装高度、速度和仿真时长。');
  if (dissipated < -Math.max(0.01, initialEnergy * 0.02)) warnings.push('机械能增加超过驱动做功容差，建议减小时间步或提高求解迭代。');
  if (maxJointError > 1e-4) warnings.push(`关节轴心位置漂移 ${(maxJointError * 1000).toFixed(3)} mm，超过 0.1 mm 门槛。`);
  if(maxJointAngleError>Math.PI/1800)warnings.push(`转轴偏转 ${(maxJointAngleError*180/Math.PI).toFixed(3)}°，超过 0.1° 门槛。`);
  if(maxJointVelocityError>.01)warnings.push(`轴心速度残差 ${maxJointVelocityError.toFixed(4)} m/s，超过 0.01 m/s 门槛。`);
  const elapsedMs = performance.now() - started;
  const result: SimulationResult = {
    id: `sim-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(), engine: 'Rapier3D 0.20.0 · CCD · compound convex-hull', config: snapshot, frames, events,
    summary: { initialEnergy, finalEnergy, driveWork: runtime.driveWork, dissipated, totalImpulse: runtime.impulse, maxJointError,maxJointAngleError,maxJointVelocityError, elapsedMs, steps, actualStep: dt, energyGain: finalEnergy - initialEnergy -runtime.driveWork, status: warnings.length ? 'review' : 'ok', warnings },
  };
  return result;
  } finally {runtime.world.free()}
}
