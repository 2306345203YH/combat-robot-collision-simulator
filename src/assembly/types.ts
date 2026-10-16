import type { Pose, Vec3 } from '../types';

export interface PartMaterial {
  name: string; density: number; youngModulus: number; yieldStrength: number;
  ultimateStrength: number; fractureStrain: number; fractureEnergy: number;
  friction: number; restitution: number; source: string;
}
export interface AssemblyPart {
  id: string; name: string; path: string; vertices: number[]; indices: number[];
  center: Vec3; size: Vec3; volume: number; area: number;
  color: [number,number,number]; material: PartMaterial;
  enabled: boolean; thickness: number; jointStrength: number; damageEnabled: boolean;
}
export interface AssemblyTarget {
  filename: string; parts: AssemblyPart[]; size: Vec3; upAxis: 'y'|'z';
  mount: 'free'|'fixed'; speed: number; heightOffset: number; damageEnabled: boolean;
  meshTolerance: number; warnings: string[];
}
export type DamageKind='elastic'|'dented'|'fractured'|'detached';
export interface PartDamage {
  partId: string; kind: DamageKind; time: number; energy: number; plasticWork: number;
  peakStress: number; dentDepth: number; damage: number; point: Vec3; normal: Vec3;
  radius: number; detachedAt?: number; fractureAt?: number;
}
export interface DamageFrame { [partId:string]: PartDamage }
export interface AssemblyFrame { poses: Record<string,Pose>; damage: DamageFrame }
