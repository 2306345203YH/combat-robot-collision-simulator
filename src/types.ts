export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export interface Profile { outer: Vec2[]; holes: Vec2[][] }
export interface DrawingImage { dataUrl: string; width: number; height: number; scale: number; origin: Vec2 }
export type WeaponShape = 'disk' | 'ring' | 'bar' | 'tooth2' | 'tooth1' | 'custom';
export interface WeaponConfig {
 name: string; materialId: string; materialName: string; density: number;
 shape: WeaponShape; radius: number; innerRadius: number; length: number; width: number; thickness: number;
 axisOffset: Vec2; profile: Profile; drawing?: DrawingImage;
 axis: 'vertical' | 'horizontal'; peakRpm: number; spinupTime: number; elapsedSpinup: number;
 rpmMode: 'ramp' | 'direct'; initialRpm: number; direction: 1 | -1; phaseDeg: number; driveEnabled: boolean;
}
export interface RobotConfig { mass: number; length: number; width: number; height: number; maxSpeed: number; speed: number; weaponHeight: number; overhang: number }
export interface Combatant { weapon: WeaponConfig; robot: RobotConfig }
export interface ArmorConfig {
 name: string; materialId: string; materialName: string; density: number; shape: 'plate' | 'bent' | 'custom';
 length: number; width: number; thickness: number; angleDeg: number; height: number;
 mount: 'fixed' | 'robot'; profile: Profile; drawing?: DrawingImage;
}
export interface Experiment {
 schemaVersion: 1; name: string; mode: 'weapon-armor' | 'weapon-weapon'; a: Combatant; b: Combatant; armor: ArmorConfig;
 settings: {
  duration: number; step: number; restitution: number; friction: number; groundFriction: number;
  gap: number; startDistance: number; lateralOffset: number; aHeadingDeg: number; bHeadingDeg: number;
  gravity: number; seed: number; randomPhase: boolean; forwardDriveTime: number;
  allowWeaponChassisOverlap: boolean; allowArmorGroundOverlap: boolean; allowWeaponGroundContact: boolean;
 };
}
export interface MassProperties { mass: number; volume: number; area: number; centroid: Vec3; inertia: Vec3; productXY: number; principalInertia: Vec3; principalRotation: Quat; axisInertia: number; radius: number }
export type BodyId = 'aChassis' | 'aWeapon' | 'bChassis' | 'bWeapon' | 'bArmor';
export interface Pose { position: Vec3; rotation: Quat }
export interface Frame { time: number; poses: Partial<Record<BodyId, Pose>>; rpmA: number; rpmB: number; speedA: number; speedB: number; rotationalA: number; rotationalB: number; kinetic: number; potential: number; driveWork: number; impulse: number }
export interface ContactEvent { time: number; point: Vec3; normal: Vec3; impulse: number; pair: string; rpmBeforeA: number; rpmAfterA: number; rpmBeforeB: number; rpmAfterB: number }
export interface SimulationResult {
 id: string; createdAt: string; engine: string; config: Experiment; frames: Frame[]; events: ContactEvent[];
 summary: { initialEnergy: number; finalEnergy: number; driveWork: number; dissipated: number; totalImpulse: number; maxJointError: number; maxJointAngleError?: number; maxJointVelocityError?: number; elapsedMs: number; steps: number; actualStep: number; energyGain: number; status: 'ok' | 'review'; warnings: string[] };
}
export interface ValidationIssue { path: string; message: string; level: 'error' | 'warning' }
export interface MaterialOption { id: string; name: string; density: number; note: string; source: string }
