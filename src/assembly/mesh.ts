import type { Vec3 } from '../types';
import type { AssemblyPart, AssemblyTarget } from './types';
import { defaultPartMaterial } from './materials';

export interface OcctNode { name:string; meshes:number[]; children:OcctNode[] }
export interface OcctMesh { name:string; color?:[number,number,number]; attributes:{position:{array:number[]}}; index:{array:number[]} }
export interface OcctResult { success:boolean; root:OcctNode; meshes:OcctMesh[] }
export const dot3=(a:Vec3,b:Vec3)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export const sub3=(a:Vec3,b:Vec3):Vec3=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
export const cross3=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export function meshBounds(vertices:number[]){
  const min:Vec3=[Infinity,Infinity,Infinity],max:Vec3=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<vertices.length;i+=3)for(let k=0;k<3;k++){min[k]=Math.min(min[k],vertices[i+k]);max[k]=Math.max(max[k],vertices[i+k]);}
  return {min,max,size:min.map((v,k)=>max[k]-v) as Vec3,center:min.map((v,k)=>(v+max[k])/2) as Vec3};
}
export function meshMetrics(vertices:number[],indices:number[]){
  let signed=0,area=0;
  for(let i=0;i<indices.length;i+=3){
    const p=indices.slice(i,i+3).map(j=>vertices.slice(j*3,j*3+3) as Vec3);
    signed+=dot3(p[0],cross3(p[1],p[2]))/6;
    area+=Math.hypot(...cross3(sub3(p[1],p[0]),sub3(p[2],p[0])))/2;
  }
  return {volume:Math.abs(signed),area};
}
export function assemblyMass(target:AssemblyTarget|undefined):number {
  return target?.parts.filter(p=>p.enabled).reduce((n,p)=>n+p.volume*p.material.density,0)??0;
}
export function convertOcct(result:OcctResult,filename:string,upAxis:'y'|'z'|'auto'='auto',tolerance=.0004):AssemblyTarget {
  if(!result.success||!result.meshes?.length)throw new Error('STEP 未包含可离散化的实体，请检查文件是否完整。');
  if(upAxis==='auto'){
    let minY=Infinity,maxY=-Infinity,minZ=Infinity,maxZ=-Infinity;
    for(const mesh of result.meshes){const v=mesh.attributes.position.array;for(let i=0;i<v.length;i+=3){minY=Math.min(minY,v[i+1]);maxY=Math.max(maxY,v[i+1]);minZ=Math.min(minZ,v[i+2]);maxZ=Math.max(maxZ,v[i+2]);}}
    upAxis=maxY-minY<=maxZ-minZ?'y':'z';
  }
  const paths=new Map<number,string>();
  const walk=(node:OcctNode,parent:string)=>{const path=[parent,node.name].filter(Boolean).join(' / ');for(const i of node.meshes??[])paths.set(i,path);for(const child of node.children??[])walk(child,path)};
  walk(result.root,'');
  const raw=result.meshes.map(m=>{
    const v=m.attributes.position.array;
    if(!v.length&&!m.index.array.length)return [];
    if(v.length%3||!v.every(Number.isFinite)||m.index.array.length%3||m.index.array.some(i=>!Number.isInteger(i)||i<0||i>=v.length/3))throw new Error('STEP 网格包含无效坐标或三角形。');
    const out:number[]=[];for(let i=0;i<v.length;i+=3)out.push(v[i],upAxis==='z'?v[i+2]:v[i+1],upAxis==='z'?-v[i+1]:v[i+2]);return out;
  });
  if(raw.reduce((n,v)=>n+v.length/3,0)>1500000)throw new Error('模型超过 150 万网格顶点，请提高离散容差后重试。');
  const allMin:Vec3=[Infinity,Infinity,Infinity],allMax:Vec3=[-Infinity,-Infinity,-Infinity];
  raw.forEach(v=>{if(!v.length)return;const b=meshBounds(v);for(let k=0;k<3;k++){allMin[k]=Math.min(allMin[k],b.min[k]);allMax[k]=Math.max(allMax[k],b.max[k])}});
  if(!Number.isFinite(allMin[0]))throw new Error('STEP 只包含空装配节点，没有可用网格。');
  const origin:Vec3=[(allMin[0]+allMax[0])/2,allMin[1],(allMin[2]+allMax[2])/2];
  const warnings=['全部部件初始使用可编辑的铝合金场景假设，未从 CAD 推断材料；运行前请逐件核对。'];
  const empty=raw.filter(v=>!v.length).length;if(empty)warnings.push(`文件包含 ${empty} 个无几何的空节点，未将它们创建成碰撞实体。`);
  const parts:AssemblyPart[]=raw.flatMap((v,i)=>{
    if(!v.length)return [];
    const b=meshBounds(v);const center=sub3(b.center,origin);
    const local=v.map((n,j)=>n-b.center[j%3]);const metrics=meshMetrics(local,result.meshes[i].index.array);
    return [{id:`part-${i}`,name:result.meshes[i].name||paths.get(i)?.split(' / ').at(-1)||`部件 ${i+1}`,path:paths.get(i)??'',vertices:local,indices:result.meshes[i].index.array,center,size:b.size,...metrics,color:result.meshes[i].color??[.65,.72,.78],material:defaultPartMaterial(),enabled:metrics.volume>=1e-12,thickness:Math.max(.0001,Math.min(...b.size,metrics.area>0?2*metrics.volume/metrics.area:Infinity)),jointStrength:20,damageEnabled:true}];
  });
  const flatParts=parts.filter(p=>!p.enabled).length;if(flatParts)warnings.push(`${flatParts} 个无有效实体体积的薄面/标注网格只供观察，不参与碰撞；如需受力，请在 CAD 中生成有厚度实体。`);
  if(parts.length>500)throw new Error('本次装配超过 500 个部件，请先在 CAD 中精简紧固件或拆分子装配。');
  return {filename,parts,size:sub3(allMax,allMin),upAxis,mount:'free',speed:0,heightOffset:0,damageEnabled:true,meshTolerance:tolerance,warnings};
}

export function reorientAssembly(target:AssemblyTarget,upAxis:'y'|'z'|'auto'):AssemblyTarget {
  const wanted=upAxis==='auto'?(target.upAxis==='y'?(target.size[1]<=target.size[2]?'y':'z'):(target.size[2]<=target.size[1]?'y':'z')):upAxis;
  if(wanted===target.upAxis)return target;
  const turn=(p:Vec3):Vec3=>wanted==='y'?[p[0],-p[2],p[1]]:[p[0],p[2],-p[1]];
  const centers=target.parts.map(p=>turn(p.center));const size:Vec3=[target.size[0],target.size[2],target.size[1]];
  let bottom=Infinity;target.parts.forEach((p,i)=>bottom=Math.min(bottom,centers[i][1]-p.size[2]/2));
  const minZ=Math.min(...target.parts.map((p,i)=>centers[i][2]-p.size[1]/2)),maxZ=Math.max(...target.parts.map((p,i)=>centers[i][2]+p.size[1]/2)),centerZ=(minZ+maxZ)/2;
  const parts=target.parts.map((p,i)=>{const vertices:number[]=[];for(let j=0;j<p.vertices.length;j+=3)vertices.push(...turn(p.vertices.slice(j,j+3) as Vec3));return {...p,vertices,center:[centers[i][0],centers[i][1]-bottom,centers[i][2]-centerZ] as Vec3,size:[p.size[0],p.size[2],p.size[1]] as Vec3}});
  return {...target,parts,size,upAxis:wanted};
}
