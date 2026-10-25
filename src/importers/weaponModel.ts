import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { Vec3, WeaponModel } from '../types';
import type { OcctResult } from '../assembly/mesh';
import { meshBounds } from '../assembly/mesh';
import { meshMassProperties, validateWeaponModel } from '../physics/weaponMesh';
import { importStepRaw,MAX_STEP_BYTES } from './step';

export interface WeaponImportOptions {unit:'mm'|'cm'|'m'|'inch';spinAxis:'x'|'y'|'z';signal?:AbortSignal;onProgress?:(message:string)=>void}
const unitScale={mm:.001,cm:.01,m:1,inch:.0254};

/** Weld CAD/STL face seams; enforce a closed, consistently wound solid for mass integrals. */
export function closedMesh(vertices:number[],indices:number[]):{vertices:number[];indices:number[]} {
 if(vertices.length>1500000||indices.length>3000000)throw new Error('实体武器超过 50 万顶点或 100 万三角面，请先简化。');
 if(!vertices.length||vertices.length%3||!vertices.every(Number.isFinite)||indices.length%3||indices.some(i=>!Number.isInteger(i)||i<0||i>=vertices.length/3))throw new Error('武器包含无效坐标或三角形。');
 const bounds=meshBounds(vertices),tolerance=Math.max(1e-10,Math.max(...bounds.size)*1e-7),map=new Map<string,number>(),unique:number[]=[],remap:number[]=[];
 for(let i=0;i<vertices.length;i+=3){const p=vertices.slice(i,i+3),key=p.map(x=>Math.round(x/tolerance)).join(',');let index=map.get(key);if(index===undefined){index=unique.length/3;map.set(key,index);unique.push(...p)}remap.push(index);}
 const tris:number[]=[];for(let i=0;i<indices.length;i+=3){const t=indices.slice(i,i+3).map(j=>remap[j]);if(new Set(t).size!==3)continue;tris.push(...t);}
 const edges=new Map<string,{count:number;direction:number}>();
 for(let i=0;i<tris.length;i+=3)for(let k=0;k<3;k++){const a=tris[i+k],b=tris[i+(k+1)%3],key=`${Math.min(a,b)},${Math.max(a,b)}`,e=edges.get(key)??{count:0,direction:0};e.count++;e.direction+=a<b?1:-1;edges.set(key,e);}
 if(!tris.length||[...edges.values()].some(e=>e.count!==2))throw new Error('武器网格未封闭或存在非流形边；请在 CAD/切片软件中修复为封闭实体后重试。');
 if([...edges.values()].some(e=>e.direction!==0))throw new Error('武器三角面方向不一致；请先统一法线后重试。');
 return {vertices:unique,indices:tris};
}

export function makeWeaponModel(vertices:number[],indices:number[],filename:string,format:'step'|'stl',sourceUnit:WeaponModel['sourceUnit'],spinAxis:WeaponModel['spinAxis']):WeaponModel {
 const cleaned=closedMesh(vertices,indices),bounds=meshBounds(cleaned.vertices),center=bounds.center;
 const local=cleaned.vertices.map((v,i)=>v-center[i%3]);
 const model:WeaponModel={filename,format,sourceUnit,sourceCenter:center,size:bounds.size,vertices:local,indices:cleaned.indices,axisPoint:[0,0,0],spinAxis,warnings:['轴心默认在模型包围盒中心，请按轴孔核对。','显示原始三角面；动态接触使用整体凸包近似，会填平孔洞与凹腔，质量和惯量仍由原网格积分。','导入后几何尺寸锁定；更改外形/尺寸请重新从 CAD 导出。']};
 const errors=validateWeaponModel(model);if(errors.length)throw new Error(errors.join('；'));
 // Assert the exact real-mesh mass integral at import, before replacing current weapon.
 meshMassProperties(local,model.indices,1);return model;
}

export function weaponFromOcct(raw:OcctResult,filename:string,spinAxis:WeaponModel['spinAxis']):WeaponModel {
 const meshes=raw.meshes?.filter(m=>m.attributes.position.array.length&&m.index.array.length)??[];
 if(!raw.success||meshes.length!==1)throw new Error(`武器 STEP 需为单零件（一个非空网格），当前为 ${meshes.length} 个；请单独导出武器零件，整车装配请从目标车体入口导入。`);
 return makeWeaponModel(meshes[0].attributes.position.array,meshes[0].index.array,filename,'step','m',spinAxis);
}

export function weaponFromStl(buffer:ArrayBuffer,filename:string,unit:WeaponImportOptions['unit'],spinAxis:WeaponModel['spinAxis']):WeaponModel {
 if(buffer.byteLength>MAX_STEP_BYTES)throw new Error('模型文件超过 120 MB。');
 // Binary STL has no magic signature; check count/length even when header starts "solid".
 const binary=buffer.byteLength>=84&&84+new DataView(buffer).getUint32(80,true)*50===buffer.byteLength;
 if(binary&&new DataView(buffer).getUint32(80,true)>1000000)throw new Error('STL 超过 100 万三角面，请先简化。');
 const geo=new STLLoader().parse(buffer);
 try{const positions=Array.from(geo.getAttribute('position').array).map(v=>v*unitScale[unit]);return makeWeaponModel(positions,Array.from({length:positions.length/3},(_,i)=>i),filename,'stl',unit,spinAxis);}finally{geo.dispose()}
}

export async function importWeaponModel(file:File,options:WeaponImportOptions):Promise<WeaponModel> {
 if(file.size>MAX_STEP_BYTES)throw new Error('模型文件超过 120 MB，请先简化。');
 if(options.signal?.aborted)throw new Error('已取消武器模型导入。');
 if(/\.(step|stp)$/i.test(file.name))return weaponFromOcct(await importStepRaw(file,{tolerance:.0001,signal:options.signal,onProgress:options.onProgress}),file.name,options.spinAxis);
 if(!/\.stl$/i.test(file.name))throw new Error('请选择 STEP/STP 单零件或 STL 文件。');
 options.onProgress?.('正在读取 STL、检查封闭体积…');const buffer=await file.arrayBuffer();
 if(options.signal?.aborted)throw new Error('已取消武器模型导入。');return weaponFromStl(buffer,file.name,options.unit,options.spinAxis);
}
