import { describe,it,expect } from 'vitest';
import { readFileSync,existsSync } from 'node:fs';
import { convertOcct,assemblyMass,meshMetrics,reorientAssembly,type OcctResult } from './mesh';
import { validateAssembly } from './validation';

import { cubeVertices,cubeIndices,cubeOcct } from './test-fixtures';
describe('STEP assembly geometry',()=>{
  it('uses closed mesh volume rather than the whole assembly bounding box',()=>{
    const m=meshMetrics(cubeVertices,cubeIndices);expect(m.volume).toBeCloseTo(.02**3,12);expect(m.area).toBeCloseTo(6*.02**2,12);
  });
  it('retains names, hierarchy, source-independent meter dimensions and CAD-to-Y up rotation',()=>{
    const a=convertOcct(cubeOcct(),'robot.step');expect(a.parts[0].name).toBe('侧板');expect(a.parts[0].path).toBe('机器人 / 底盘');expect(a.size).toEqual([.02,.02,.02]);expect(a.parts[0].center).toEqual([0,.01,0]);expect(assemblyMass(a)).toBeCloseTo(.02**3*2700);expect(validateAssembly(a).filter(x=>x.level==='error')).toHaveLength(0);
  });
  it('rejects invalid triangle indices instead of silently changing the target',()=>{const r=cubeOcct();r.meshes[0].index.array[0]=500;expect(()=>convertOcct(r,'bad.step')).toThrow('无效');});
  it('density affects mass and disabled parts are omitted',()=>{const a=convertOcct(cubeOcct(),'a.step');a.parts[0].material.density=1000;expect(assemblyMass(a)).toBeCloseTo(.008);a.parts[0].enabled=false;expect(assemblyMass(a)).toBe(0);expect(validateAssembly(a).some(x=>x.message.includes('至少启用'))).toBe(true);});
  it('rejects nonphysical material inputs',()=>{const a=convertOcct(cubeOcct(),'a.step');a.parts[0].material.ultimateStrength=1;expect(validateAssembly(a).some(x=>x.path.endsWith('ultimateStrength'))).toBe(true);});
  it('can correct an imported up axis without losing material or mass',()=>{
    const a=convertOcct(cubeOcct(),'a.step','z');a.parts[0].material.name='custom';const b=reorientAssembly(a,'y');
    expect(b.upAxis).toBe('y');expect(b.parts[0].material.name).toBe('custom');expect(assemblyMass(b)).toBeCloseTo(assemblyMass(a));expect(b.parts[0].center[1]).toBeCloseTo(.01);
  });
});
const sample=process.env.STEP_MESH_FIXTURE;
describe.skipIf(!sample||!existsSync(sample))('actual Boxbot STEP fixture',()=>{
  it('retains every imported CAD component, finite volume and real assembly scale',()=>{
    const a=convertOcct(JSON.parse(readFileSync(sample!,'utf8')),'Boxbot.step');
    expect(a.parts).toHaveLength(276);expect(a.parts.reduce((n,p)=>n+p.indices.length/3,0)).toBe(114127);
    expect(a.size.every(v=>v>.01&&v<1)).toBe(true);expect(assemblyMass(a)).toBeGreaterThan(0);
    expect(validateAssembly(a).filter(x=>x.level==='error')).toHaveLength(0);
    console.log(JSON.stringify({parts:a.parts.length,size:a.size,mass:assemblyMass(a),disabled:a.parts.filter(p=>!p.enabled).length,warnings:a.warnings.length}));
  });
});
