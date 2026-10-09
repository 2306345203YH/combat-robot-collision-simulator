import type * as RAPIER from '@dimforge/rapier3d-compat';
import type { Vec3 } from '../types';
type Motion={linear:Vec3;angular:Vec3;com:Vec3};
export type MotionSnapshot=Map<number,Motion>;
const vec=(v:RAPIER.Vector):Vec3=>[v.x,v.y,v.z];
const dot=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const sub=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
function toWorld(c:RAPIER.Collider,p:RAPIER.Vector):Vec3{
 const q=c.rotation(),t=c.translation();
 const ux=2*(q.y*p.z-q.z*p.y),uy=2*(q.z*p.x-q.x*p.z),uz=2*(q.x*p.y-q.y*p.x);
 return [p.x+q.w*ux+q.y*uz-q.z*uy+t.x,p.y+q.w*uy+q.z*ux-q.x*uz+t.y,p.z+q.w*uz+q.x*uy-q.y*ux+t.z];
}
export function snapshotMotion(bodies:(RAPIER.RigidBody|undefined)[]):MotionSnapshot{
 const result:MotionSnapshot=new Map();
 bodies.forEach(b=>{if(b)result.set(b.handle,{linear:vec(b.linvel()),angular:vec(b.angvel()),com:vec(b.worldCom())})});return result;
}
function atPoint(body:RAPIER.RigidBody|null,p:Vec3,before:MotionSnapshot):Vec3{
 if(!body||body.isFixed())return [0,0,0];
 const m=before.get(body.handle);if(!m)return vec(body.velocityAtPoint({x:p[0],y:p[1],z:p[2]}));
 const r=sub(p,m.com),w=m.angular;
 return [m.linear[0]+w[1]*r[2]-w[2]*r[1],m.linear[1]+w[2]*r[0]-w[0]*r[2],m.linear[2]+w[0]*r[1]-w[1]*r[0]];
}
/** Rapier may retain warm-start impulses after separation. Count active,
 * closing/resting contacts, using pre-step velocity to preserve rebound J. */
export function readContactImpulse(world:RAPIER.World,first:RAPIER.Collider,second:RAPIER.Collider,before:MotionSnapshot):{impulse:number;point:Vec3;normal:Vec3}|undefined{
 let total=0;const point:Vec3=[0,0,0],normal:Vec3=[0,0,0];
 world.contactPair(first,second,(m,flipped)=>{
  if(m.numSolverContacts()===0)return;
  const one=flipped?second:first,two=flipped?first:second,n=vec(m.normal());
  for(let i=0;i<m.numContacts();i++){
   const a=m.localContactPoint1(i),b=m.localContactPoint2(i);if(!a||!b)continue;
   const pa=toWorld(one,a),pb=toWorld(two,b),p:Vec3=[(pa[0]+pb[0])/2,(pa[1]+pb[1])/2,(pa[2]+pb[2])/2];
   const separatingSpeed=dot(sub(atPoint(two.parent(),p,before),atPoint(one.parent(),p,before)),n);
   const gap=dot(sub(pb,pa),n);
   if(separatingSpeed>1e-6||(gap>5e-6&&separatingSpeed>=-1e-6))continue;
   const j=Math.max(0,m.contactImpulse(i));if(!Number.isFinite(j)||j<=1e-10)continue;
   total+=j;for(let k=0;k<3;k++){point[k]+=j*p[k];normal[k]+=j*n[k]*(flipped?-1:1)}
  }
 });
 if(total<=0)return;
 for(let k=0;k<3;k++)point[k]/=total;
 const len=Math.hypot(...normal);if(len>0)for(let k=0;k<3;k++)normal[k]/=len;
 return {impulse:total,point,normal};
}
