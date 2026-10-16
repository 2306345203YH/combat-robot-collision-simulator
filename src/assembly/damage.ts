import type { Vec3 } from '../types';
import type { AssemblyPart, PartDamage } from './types';
import { dot3,sub3,cross3 } from './mesh';

/** Local work model: elastic storage, plastic work and a fracture-energy budget.
 * Input is irreversible contact work, not the attacker's entire kinetic energy.
 * This is an editable reduced-order scenario, not a stress/strain field solver. */
export function accumulateDamage(part:AssemblyPart,previous:PartDamage|undefined,work:number,impulse:number,time:number,point:Vec3,normal:Vec3,radius:number,totalImpulse:number):PartDamage{
  const m=part.material,area=Math.min(Math.PI*radius**2,part.area/2),volume=Math.max(1e-15,Math.min(area*part.thickness,part.volume));
  const energy=(previous?.energy??0)+Math.max(0,work);
  const elasticCapacity=m.yieldStrength**2/(2*m.youngModulus)*volume;
  const plasticWork=Math.max(0,energy-elasticCapacity);
  const flow=(m.yieldStrength+m.ultimateStrength)/2;
  const crackArea=Math.max(1e-12,2*radius*part.thickness);
  const fractureBudget=flow*volume*m.fractureStrain+m.fractureEnergy*crackArea;
  const damage=Math.min(1,plasticWork/Math.max(fractureBudget,1e-15));
  const peakStress=Math.max(previous?.peakStress??0,plasticWork>0?m.yieldStrength+(m.ultimateStrength-m.yieldStrength)*damage:Math.sqrt(2*energy*m.youngModulus/volume));
  const dentDepth=Math.min(part.thickness*.8,plasticWork/Math.max(flow*area,1e-15));
  const fractured=previous?.fractureAt!==undefined||damage>=1;
  const detached=previous?.detachedAt!==undefined||totalImpulse>=part.jointStrength;
  return {partId:part.id,kind:fractured?'fractured':detached?'detached':dentDepth>1e-8?'dented':'elastic',time,energy,plasticWork,peakStress,dentDepth,damage,point,normal,radius,fractureAt:fractured?(previous?.fractureAt??time):undefined,detachedAt:detached||fractured?(previous?.detachedAt??time):undefined};
}

/** Subdivide near the impact so a coarse CAD face can visibly develop a dent. */
export function dentMesh(part:AssemblyPart,damage:PartDamage):{vertices:number[];indices:number[]}{
  if(damage.dentDepth<=0)return {vertices:part.vertices,indices:part.indices};
  const vertices:number[]=[],indices:number[]=[];
  const radius=damage.radius,point=damage.point,normal=damage.normal;
  const put=(p:Vec3)=>{const delta=sub3(p,point),distance=Math.hypot(...delta);const weight=Math.exp(-2*(distance/radius)**2);const shift=damage.dentDepth*weight;indices.push(vertices.length/3);vertices.push(p[0]+normal[0]*shift,p[1]+normal[1]*shift,p[2]+normal[2]*shift)};
  const mid=(a:Vec3,b:Vec3):Vec3=>[(a[0]+b[0])/2,(a[1]+b[1])/2,(a[2]+b[2])/2];
  const add=(a:Vec3,b:Vec3,c:Vec3,depth:number)=>{
    const edge=Math.max(Math.hypot(...sub3(a,b)),Math.hypot(...sub3(b,c)),Math.hypot(...sub3(c,a)));
    const center:Vec3=[(a[0]+b[0]+c[0])/3,(a[1]+b[1]+c[1])/3,(a[2]+b[2]+c[2])/3];
    if(depth<4&&edge>radius*.6&&Math.hypot(...sub3(center,point))<radius*2+edge&&vertices.length<450000){const ab=mid(a,b),bc=mid(b,c),ca=mid(c,a);add(a,ab,ca,depth+1);add(ab,b,bc,depth+1);add(ca,bc,c,depth+1);add(ab,bc,ca,depth+1)}else{put(a);put(b);put(c)};
  };
  for(let i=0;i<part.indices.length;i+=3)add(...part.indices.slice(i,i+3).map(j=>part.vertices.slice(j*3,j*3+3) as Vec3) as [Vec3,Vec3,Vec3],0);
  return {vertices,indices};
}
