import * as R from '@dimforge/rapier3d-compat';
import type { Pose,Vec3,Quat } from '../types';
import type { AssemblyTarget,AssemblyPart,PartDamage,AssemblyFrame } from './types';
import type { MotionSnapshot } from '../physics/contacts';
import { accumulateDamage,dentMesh } from './damage';
import { splitMesh } from './fracture';
import { dot3,sub3,cross3 } from './mesh';

export interface FragmentRecord {id:string;partId:string;vertices:number[];indices:number[]}
interface Entry {part:AssemblyPart;body:R.RigidBody;collider:R.Collider;colliders?:R.Collider[];damage?:PartDamage;impulse:number;detached:boolean}
export interface AssemblyPhysics {
  root:R.RigidBody; entries:Map<string,Entry>; handles:Map<number,string>;
  bodies:Map<string,R.RigidBody>; fragments:FragmentRecord[]; warnings:string[]; config:AssemblyTarget;
}
const rv=(v:Vec3)=>({x:v[0],y:v[1],z:v[2]});
const vv=(v:R.Vector):Vec3=>[v.x,v.y,v.z];
const qq=(q:R.Rotation):Quat=>[q.x,q.y,q.z,q.w];
export function rotate(q:Quat,p:Vec3):Vec3 {
  const u:Vec3=[q[0],q[1],q[2]],t=cross3(u,p).map(v=>v*2) as Vec3,c=cross3(u,t);return p.map((v,i)=>v+q[3]*t[i]+c[i]) as Vec3;
}
const inverse=(q:Quat):Quat=>[-q[0],-q[1],-q[2],q[3]];
function colliderDesc(part:AssemblyPart,vertices=part.vertices,mass=part.volume*part.material.density){
  const desc=R.ColliderDesc.convexHull(new Float32Array(vertices));
  if(!desc)throw new Error(`${part.name} 无法建立凸包碰撞体，请检查几何或禁用该部件。`);
  return desc.setMass(mass).setFriction(part.material.friction).setRestitution(part.material.restitution);
}
export function createAssemblyPhysics(world:R.World,target:AssemblyTarget,pose:Pose,heading:Vec3):AssemblyPhysics {
  const q=pose.rotation;const desc=(target.mount==='fixed'?R.RigidBodyDesc.fixed():R.RigidBodyDesc.dynamic()).setTranslation(...pose.position).setRotation({x:q[0],y:q[1],z:q[2],w:q[3]}).setCcdEnabled(true);
  const root=world.createRigidBody(desc);root.userData='targetAssembly';
  const entries=new Map<string,Entry>(),handles=new Map<number,string>();
  for(const p of target.parts)if(p.enabled){const collider=world.createCollider(colliderDesc(p).setTranslation(...p.center),root);entries.set(p.id,{part:p,body:root,collider,impulse:0,detached:false});handles.set(collider.handle,p.id);}
  root.recomputeMassPropertiesFromColliders();if(target.mount==='free')root.setLinvel(rv(heading.map(v=>v*target.speed) as Vec3),true);
  return {root,entries,handles,bodies:new Map(),fragments:[],warnings:[],config:target};
}
/** Register a pre-existing profile body without changing its mass or colliders. */
export function registerArmorDamage(body:R.RigidBody,colliders:R.Collider[],target:AssemblyTarget):AssemblyPhysics{
 const part=target.parts[0];if(!colliders.length)throw new Error('护甲没有有效碰撞体。');
 return {root:body,entries:new Map([[part.id,{part,body,collider:colliders[0],colliders,impulse:0,detached:false}]]),handles:new Map(colliders.map(c=>[c.handle,part.id])),bodies:new Map(),fragments:[],warnings:[],config:target};
}
function velocityBefore(body:R.RigidBody,p:Vec3,snapshot:MotionSnapshot):Vec3 {
  if(body.isFixed())return [0,0,0];const state=snapshot.get(body.handle);if(!state)return vv(body.velocityAtPoint(rv(p)));const spin=cross3(state.angular,sub3(p,state.com));return state.linear.map((v,i)=>v+spin[i]) as Vec3;
}
export function irreversibleContactWork(attacker:R.RigidBody,target:R.RigidBody,contact:{point:Vec3;normal:Vec3;impulse:number},before:MotionSnapshot):number {
  const u0=dot3(sub3(velocityBefore(attacker,contact.point,before),velocityBefore(target,contact.point,before)),contact.normal);
  const u1=dot3(sub3(vv(attacker.velocityAtPoint(rv(contact.point))),vv(target.velocityAtPoint(rv(contact.point)))),contact.normal);
  return Math.max(0,.5*contact.impulse*(u0+u1));
}
function release(world:R.World,runtime:AssemblyPhysics,entry:Entry,fracture:boolean){
  const p=entry.part,parent=entry.body,q=qq(parent.rotation()),t=vv(parent.translation()),partPosition=entry.detached?t:t.map((v,i)=>v+rotate(q,p.center)[i]) as Vec3;
  const oldCom=vv(parent.worldCom()),oldVelocity=vv(parent.linvel()),oldAngular=vv(parent.angvel());
  const velocityAt=(point:Vec3)=>{const w=cross3(oldAngular,sub3(point,oldCom));return oldVelocity.map((v,i)=>v+w[i]) as Vec3};
  const damaged=entry.damage?dentMesh(p,entry.damage):{vertices:p.vertices,indices:p.indices};
  const pieces=fracture?splitMesh(damaged.vertices,damaged.indices,entry.damage!.normal):[];
  if(fracture&&!pieces.length){runtime.warnings.push(`${p.name} 简化裂面未形成两个有效实体，按整件脱落处理。`);}
  const sources=pieces.length?pieces:[{vertices:damaged.vertices,indices:damaged.indices,fraction:1}];
  for(const collider of entry.colliders??[entry.collider]){runtime.handles.delete(collider.handle);world.removeCollider(collider,true);}entry.colliders=undefined;
  if(entry.detached){world.removeRigidBody(parent);runtime.bodies.delete(p.id);}else if(!parent.isFixed()){
    parent.recomputeMassPropertiesFromColliders();parent.setLinvel(rv(velocityAt(vv(parent.worldCom()))),true);
  }
  const totalMass=p.volume*p.material.density;
  sources.forEach((source,i)=>{
    const id=pieces.length?`${p.id}:fragment-${i}`:p.id;
    const body=world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(...partPosition).setRotation({x:q[0],y:q[1],z:q[2],w:q[3]}).setCcdEnabled(true));body.userData=id;
    const collider=world.createCollider(colliderDesc(p,source.vertices,totalMass*source.fraction),body);
    body.recomputeMassPropertiesFromColliders();body.setLinvel(rv(velocityAt(vv(body.worldCom()))),true);body.setAngvel(rv(oldAngular),true);
    runtime.bodies.set(id,body);runtime.handles.set(collider.handle,p.id);
    if(pieces.length)runtime.fragments.push({id,partId:p.id,vertices:source.vertices,indices:source.indices});
    else{entry.body=body;entry.collider=collider;}
  });
  entry.detached=true;
}
export function processAssemblyHit(world:R.World,runtime:AssemblyPhysics,attacker:R.RigidBody,collider:R.Collider,contact:{point:Vec3;normal:Vec3;impulse:number},before:MotionSnapshot,time:number,weaponThickness:number){
  const id=runtime.handles.get(collider.handle),entry=id?runtime.entries.get(id):undefined;
  if(!entry||!runtime.config.damageEnabled||!entry.part.damageEnabled||entry.damage?.fractureAt!==undefined)return;
  const parent=entry.body,rotation=qq(parent.rotation()),local=rotate(inverse(rotation),sub3(contact.point,vv(parent.translation())));
  const point=entry.detached?local:sub3(local,entry.part.center),normal=rotate(inverse(rotation),contact.normal);
  const radius=Math.max(.001,Math.min(Math.max(...entry.part.size)/3,Math.max(entry.part.thickness,weaponThickness)*2));
  const work=irreversibleContactWork(attacker,parent,contact,before);entry.impulse+=contact.impulse;
  const wasDetached=entry.detached;
  entry.damage=accumulateDamage(entry.part,entry.damage,work,contact.impulse,time,point,normal,radius,entry.impulse);
  if(entry.damage.fractureAt!==undefined||(!wasDetached&&entry.damage.detachedAt!==undefined))release(world,runtime,entry,entry.damage.fractureAt!==undefined);
}
export function assemblyFrame(runtime:AssemblyPhysics):AssemblyFrame {
  const poses:Record<string,Pose>={};runtime.bodies.forEach((body,id)=>{poses[id]={position:vv(body.translation()),rotation:qq(body.rotation())}});
  const damage:Record<string,PartDamage>={};runtime.entries.forEach((e,id)=>{if(e.damage)damage[id]={...e.damage}});return {poses,damage};
}
