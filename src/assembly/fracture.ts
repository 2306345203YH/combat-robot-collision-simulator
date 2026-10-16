import earcut from 'earcut';
import type { Vec3 } from '../types';
import { cross3,dot3,sub3,meshMetrics } from './mesh';

export interface FragmentMesh {vertices:number[];indices:number[];fraction:number}
const normalize=(v:Vec3):Vec3=>{const n=Math.hypot(...v);return n>1e-12?v.map(x=>x/n) as Vec3:[1,0,0]};
const key=(p:Vec3)=>p.map(n=>Math.round(n*1e8)).join(',');
/** A deterministic planar fracture approximation. Clips real CAD triangles and
 * closes the cut loops; no random particles or replacement bounding boxes. */
export function splitMesh(vertices:number[],indices:number[],direction:Vec3):FragmentMesh[] {
  const normal=normalize(direction),u=normalize(cross3(normal,Math.abs(normal[1])<.9?[0,1,0]:[1,0,0])),v=cross3(normal,u);
  const endpoints=new Map<string,Vec3>(),segments:Array<[string,string]>=[];
  const sides=[{vertices:[] as number[],indices:[] as number[],fraction:0},{vertices:[] as number[],indices:[] as number[],fraction:0}];
  const append=(out:FragmentMesh,p:Vec3)=>{out.indices.push(out.vertices.length/3);out.vertices.push(...p)};
  for(let i=0;i<indices.length;i+=3){
    const tri=indices.slice(i,i+3).map(j=>vertices.slice(j*3,j*3+3) as Vec3),cuts:Vec3[]=[];
    for(let j=0;j<3;j++){const a=tri[j],b=tri[(j+1)%3],da=dot3(a,normal),db=dot3(b,normal);if(da*db< -1e-20){const t=da/(da-db);cuts.push(a.map((n,k)=>n+t*(b[k]-n)) as Vec3)}else if(Math.abs(da)<1e-10)cuts.push(a);}
    const unique=[...new Map(cuts.map(p=>[key(p),p])).values()];if(unique.length===2){const a=key(unique[0]),b=key(unique[1]);endpoints.set(a,unique[0]);endpoints.set(b,unique[1]);segments.push([a,b]);}
    for(let side=0;side<2;side++){
      const sign=side===0?1:-1,poly:Vec3[]=[];
      for(let j=0;j<3;j++){const a=tri[j],b=tri[(j+1)%3],da=dot3(a,normal)*sign,db=dot3(b,normal)*sign;if(da>=-1e-10)poly.push(a);if((da>=0)!==(db>=0)){const t=da/(da-db);poly.push(a.map((n,k)=>n+t*(b[k]-n)) as Vec3)}}
      for(let j=1;j+1<poly.length;j++){append(sides[side],poly[0]);append(sides[side],poly[j]);append(sides[side],poly[j+1]);}
    }
  }
  const graph=new Map<string,Set<string>>();for(const [a,b]of segments){if(a===b)continue;if(!graph.has(a))graph.set(a,new Set());if(!graph.has(b))graph.set(b,new Set());graph.get(a)!.add(b);graph.get(b)!.add(a)}
  const visited=new Set<string>(),loops:Vec3[][]=[];
  for(const first of graph.keys()){
    if(visited.has(first))continue;const loop:Vec3[]=[];let current=first,previous='';
    for(let guard=0;guard<graph.size+1;guard++){if(visited.has(current))break;visited.add(current);loop.push(endpoints.get(current)!);const next=[...graph.get(current)!].find(k=>k!==previous);if(!next)break;previous=current;current=next;if(current===first){if(loop.length>=3)loops.push(loop);break;}}
  }
  const flat=loops.map(loop=>loop.map(p=>[dot3(p,u),dot3(p,v)]));
  const contains=(polygon:number[][],p:number[])=>{let inside=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside};
  const depth=flat.map((p,i)=>flat.reduce((n,other,j)=>n+(j!==i&&contains(other,p[0])?1:0),0));
  for(let i=0;i<loops.length;i++)if(depth[i]%2===0){
    const holes=loops.map((_,j)=>j).filter(j=>depth[j]===depth[i]+1&&contains(flat[i],flat[j][0]));const ringIds=[i,...holes],points:Vec3[]=[],coords:number[]=[],offsets:number[]=[];
    ringIds.forEach((j,n)=>{if(n)offsets.push(points.length);points.push(...loops[j]);coords.push(...flat[j].flat())});
    const cap=earcut(coords,offsets,2);
    for(let j=0;j<cap.length;j+=3){const tri=cap.slice(j,j+3).map(k=>points[k]);const face=cross3(sub3(tri[1],tri[0]),sub3(tri[2],tri[0]));if(dot3(face,normal)<0)[tri[1],tri[2]]=[tri[2],tri[1]];for(const p of [tri[0],tri[2],tri[1]])append(sides[0],p);for(const p of tri)append(sides[1],p);}
  }
  const volumes=sides.map(s=>meshMetrics(s.vertices,s.indices).volume),total=volumes[0]+volumes[1];
  if(!sides.every(s=>s.indices.length>=12)||Math.min(...volumes)<1e-12||total<=0)return [];
  sides.forEach((s,i)=>s.fraction=volumes[i]/total);return sides;
}
