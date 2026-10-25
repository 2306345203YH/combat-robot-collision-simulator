import { Matrix4, Quaternion } from 'three';
import type { MassProperties, Vec3, WeaponConfig, WeaponModel } from '../types';
import { cross3, dot3, meshBounds } from '../assembly/mesh';

/** Source model coordinates are centred once at import and never scaled by UI. */
export function weaponMesh(w:WeaponConfig):{vertices:number[];indices:number[]} {
 const m=w.model;if(!m)throw new Error('尚未导入实体武器。');
 const vertices:number[]=[];
 for(let i=0;i<m.vertices.length;i+=3){const [x,y,z]=m.vertices.slice(i,i+3).map((v,k)=>v-m.axisPoint[k]);
  // Proper rotations (determinant +1), source spin direction -> local +Z.
  vertices.push(...(m.spinAxis==='x'?[-z,y,x]:m.spinAxis==='y'?[x,-z,y]:[x,y,z]));
 }
 return {vertices,indices:m.indices};
}

export function principalAxes(tensor:number[][]):{values:Vec3;rotation:[number,number,number,number]} {
 const a=tensor.map(row=>[...row]),v=[[1,0,0],[0,1,0],[0,0,1]];
 for(let iteration=0;iteration<40;iteration++){
  let p=0,q=1;for(const [i,j]of [[0,2],[1,2]])if(Math.abs(a[i][j])>Math.abs(a[p][q])){p=i;q=j;}
  if(Math.abs(a[p][q])<Math.max(1e-20,Math.max(...a.map((r,i)=>Math.abs(r[i])))*1e-13))break;
  const angle=.5*Math.atan2(2*a[p][q],a[q][q]-a[p][p]),c=Math.cos(angle),s=Math.sin(angle);
  const app=a[p][p],aqq=a[q][q],apq=a[p][q];
  for(let k=0;k<3;k++)if(k!==p&&k!==q){const akp=a[k][p],akq=a[k][q];a[k][p]=a[p][k]=c*akp-s*akq;a[k][q]=a[q][k]=s*akp+c*akq;}
  a[p][p]=c*c*app-2*s*c*apq+s*s*aqq;a[q][q]=s*s*app+2*s*c*apq+c*c*aqq;a[p][q]=a[q][p]=0;
  for(let k=0;k<3;k++){const vp=v[k][p],vq=v[k][q];v[k][p]=c*vp-s*vq;v[k][q]=s*vp+c*vq;}
 }
 const matrix=new Matrix4().set(v[0][0],v[0][1],v[0][2],0,v[1][0],v[1][1],v[1][2],0,v[2][0],v[2][1],v[2][2],0,0,0,0,1);
 return {values:[a[0][0],a[1][1],a[2][2]],rotation:new Quaternion().setFromRotationMatrix(matrix).normalize().toArray()};
}

/** Signed tetrahedral integrals: real closed volume, COM and full inertia tensor. */
export function meshMassProperties(vertices:number[],indices:number[],density:number):MassProperties {
 let volume=0,area=0;const first=[0,0,0],second=[[0,0,0],[0,0,0],[0,0,0]];
 for(let i=0;i<indices.length;i+=3){const points=indices.slice(i,i+3).map(j=>vertices.slice(j*3,j*3+3) as Vec3),[a,b,c]=points;
  const dv=dot3(a,cross3(b,c))/6;volume+=dv;
  area+=Math.hypot(...cross3(b.map((v,k)=>v-a[k]) as Vec3,c.map((v,k)=>v-a[k]) as Vec3))/2;
  for(let j=0;j<3;j++){first[j]+=dv*(a[j]+b[j]+c[j])/4;
   for(let k=0;k<3;k++){const diagonal=points.reduce((n,p)=>n+p[j]*p[k],0);second[j][k]+=dv*((a[j]+b[j]+c[j])*(a[k]+b[k]+c[k])+diagonal)/20;}
  }
 }
 if(Math.abs(volume)<1e-15)throw new Error('武器网格没有有效封闭体积。');
 const sign=Math.sign(volume);volume=Math.abs(volume);const mass=volume*density,centroid=first.map(x=>x*sign/volume) as Vec3;
 const covariance=second.map((r,j)=>r.map((x,k)=>density*sign*x-mass*centroid[j]*centroid[k]));
 const trace=covariance[0][0]+covariance[1][1]+covariance[2][2];
 const tensor=covariance.map((r,j)=>r.map((x,k)=>(j===k?trace:0)-x)),axes=principalAxes(tensor);
 if(!axes.values.every(x=>Number.isFinite(x)&&x>0))throw new Error('武器网格惯量无效，请检查封闭性和面方向。');
 let radius=0;for(let i=0;i<vertices.length;i+=3)radius=Math.max(radius,Math.hypot(vertices[i],vertices[i+1]));
 return {mass,volume,area,centroid,inertia:[tensor[0][0],tensor[1][1],tensor[2][2]],productXY:tensor[0][1],principalInertia:axes.values,principalRotation:axes.rotation,axisInertia:tensor[2][2]+mass*(centroid[0]**2+centroid[1]**2),radius};
}

export function validateWeaponModel(m:WeaponModel|undefined):string[] {
 if(!m)return ['请先导入 STEP 单零件或 STL 武器。'];
 const errors:string[]=[];
 if(typeof m.filename!=='string'||!['step','stl'].includes(m.format)||!['m','mm','cm','inch'].includes(m.sourceUnit)||!['x','y','z'].includes(m.spinAxis))errors.push('实体武器格式、单位或转轴无效。');
 for(const key of ['axisPoint','sourceCenter','size'] as const)if(!Array.isArray(m[key])||m[key].length!==3||!m[key].every(Number.isFinite))errors.push('实体武器轴心或尺寸无效。');
 if(!Array.isArray(m.vertices)||m.vertices.length<12||m.vertices.length%3||m.vertices.length>1500000||!m.vertices.every(Number.isFinite)||!Array.isArray(m.indices)||m.indices.length<12||m.indices.length>3000000||m.indices.length%3||m.indices.some(i=>!Number.isInteger(i)||i<0||i>=m.vertices.length/3))errors.push('实体武器网格无效或超出 50 万顶点/100 万三角面上限。');
 if(!Array.isArray(m.warnings)||!m.warnings.every(x=>typeof x==='string'))errors.push('实体武器诊断无效。');
 if(!errors.length){const bounds=meshBounds(m.vertices);if(bounds.size.some(x=>x<=0||x>2))errors.push('实体武器每轴尺寸需大于 0 且不超过 2 m，请检查导入单位。');
  if(m.size.some((v,k)=>Math.abs(v-bounds.size[k])>1e-8))errors.push('实体武器尺寸与网格不一致。');
  try{meshMassProperties(m.vertices,m.indices,1)}catch(e){errors.push((e as Error).message)}
 }
 return errors;
}

export function validateWeaponMaterial(w:WeaponConfig):string[]{
 if(!w.material)return [];
 const m=w.material,errors:string[]=[];
 if(typeof m.name!=='string'||typeof m.source!=='string')errors.push('武器材料名称和来源无效。');
 for(const key of ['density','youngModulus','yieldStrength','ultimateStrength','fractureStrain','fractureEnergy'] as const)if(!Number.isFinite(m[key])||m[key]<=0)errors.push('武器材料 '+key+' 必须为正有限值。');
 if(m.ultimateStrength<m.yieldStrength)errors.push('武器材料极限强度不能低于屈服强度。');
 return errors;
}

export function weaponAxialBounds(w:WeaponConfig):[number,number] {
 if(w.shape!=='mesh')return [-w.thickness/2,w.thickness/2];
 const {vertices}=weaponMesh(w);let lo=Infinity,hi=-Infinity;for(let i=2;i<vertices.length;i+=3){lo=Math.min(lo,vertices[i]);hi=Math.max(hi,vertices[i]);}return [lo,hi];
}
