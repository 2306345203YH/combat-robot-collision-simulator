import type { ValidationIssue } from '../types';
import type { AssemblyTarget } from './types';

export function validateAssembly(target:AssemblyTarget|undefined):ValidationIssue[]{
  const out:ValidationIssue[]=[];const err=(path:string,message:string)=>out.push({path:'assembly.'+path,message,level:'error'});
  if(!target||!Array.isArray(target.parts)||!target.parts.length){err('parts','请先导入含实体部件的 STEP 目标车体。');return out;}
  if(target.parts.length>500)err('parts','目标最多包含 500 个部件。');
  if(typeof target.filename!=='string'||!['y','z'].includes(target.upAxis)||typeof target.damageEnabled!=='boolean')err('metadata','装配文件名、向上轴或损伤开关无效。');
  if(!Array.isArray(target.warnings)||!target.warnings.every(w=>typeof w==='string'))err('warnings','装配导入诊断无效。');
  if(!['free','fixed'].includes(target.mount))err('mount','目标约束无效。');
  for(const key of ['speed','heightOffset'] as const)if(!Number.isFinite(target[key])||target[key]<0)err(key,'目标速度与抬高量需为非负有限值。');
  if(!Array.isArray(target.size)||target.size.length!==3||target.size.some(v=>!Number.isFinite(v)||v<=0||v>10))err('size','目标尺寸需大于 0 且每轴不超过 10 m，请检查导入单位。');
  const ids=new Set<string>();let enabled=0,vertices=0;
  for(const p of target.parts){
    if(!p||typeof p.id!=='string'||ids.has(p.id)){err('parts','部件 ID 缺失或重复。');continue;}ids.add(p.id);
    if(typeof p.enabled!=='boolean'||typeof p.damageEnabled!=='boolean')err(p.id,'部件开关必须为布尔值。');
    if(p.enabled)enabled++;
    if(typeof p.name!=='string'||typeof p.path!=='string'||!p.material||typeof p.material.name!=='string'||typeof p.material.source!=='string'){err(p.id,'部件名称、装配路径或材料缺失。');continue;}
    const m=p.material;
    for(const key of ['density','youngModulus','yieldStrength','ultimateStrength','fractureStrain','fractureEnergy'] as const)if(!Number.isFinite(m[key])||m[key]<=0)err(p.id+'.'+key,`${p.name} 材料性能必须为正有限值。`);
    if(m.ultimateStrength<m.yieldStrength)err(p.id+'.ultimateStrength',`${p.name} 极限强度不能低于屈服强度。`);
    for(const key of ['friction','restitution'] as const)if(!Number.isFinite(m[key])||m[key]<0||(key==='restitution'&&m[key]>1))err(p.id+'.'+key,`${p.name} 摩擦/恢复系数无效。`);
    if(!Array.isArray(p.vertices)||p.vertices.length%3||!p.vertices.every(Number.isFinite)||!Array.isArray(p.indices)||p.indices.length%3||p.indices.some(i=>!Number.isInteger(i)||i<0||i>=p.vertices.length/3)){err(p.id+'.mesh',`${p.name} 网格无效。`);continue;}vertices+=p.vertices.length/3;
    if(!Array.isArray(p.center)||p.center.length!==3||!p.center.every(Number.isFinite))err(p.id+'.center','部件位置无效。');
    if(!Array.isArray(p.size)||p.size.length!==3||p.size.some(v=>!Number.isFinite(v)||v<0))err(p.id+'.size','部件尺寸无效。');
    if(!Array.isArray(p.color)||p.color.length!==3||!p.color.every(Number.isFinite))err(p.id+'.color','部件颜色无效。');
    for(const key of ['volume','area','thickness','jointStrength'] as const)if(!Number.isFinite(p[key])||(p.enabled||key==='thickness'||key==='jointStrength'?p[key]<=0:p[key]<0))err(p.id+'.'+key,`${p.name} 体积、面积、有效厚度和连接失效冲量无效。`);
  }
  if(!enabled)err('parts','至少启用一个目标部件。');
  if(vertices>1500000)err('mesh','超过 150 万顶点，请简化模型。');
  if(!out.length)out.push({path:'assembly.damage',level:'warning',message:'装配损伤采用局部能量/材料阈值估算与简化裂面，非有限元；凸包接触不精确保留孔洞/凹腔，材料及连接参数需实测校准。'});
  return out;
}
