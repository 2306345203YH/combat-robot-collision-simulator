import { describe,it,expect } from 'vitest';
import { convertOcct,meshMetrics } from './mesh';
import { cubeOcct } from './test-fixtures';
import { accumulateDamage,dentMesh } from './damage';
import { splitMesh } from './fracture';
describe('reduced-order material damage',()=>{
  it('separates elastic, permanent dent and material fracture thresholds',()=>{
    const p=convertOcct(cubeOcct(),'cube.step').parts[0];p.thickness=.002;p.jointStrength=1000;
    const hit=(energy:number)=>accumulateDamage(p,undefined,energy,.1,.02,[-.01,0,0],[1,0,0],.005,.1);
    expect(hit(1e-5).kind).toBe('elastic');expect(hit(.2).kind).toBe('dented');expect(hit(100).kind).toBe('fractured');
    const d=hit(.2);const deformed=dentMesh(p,d);expect(deformed.vertices.length).toBeGreaterThan(p.vertices.length);
    expect(deformed.vertices.some((v,i)=>i%3===0&&v>-.01&&v<-.009)).toBe(true);
  });
  it('material strength changes the outcome for the same contact work',()=>{
    const p=convertOcct(cubeOcct(),'c.step').parts[0];p.thickness=.002;const high=accumulateDamage(p,undefined,1,.1,0,[0,0,0],[1,0,0],.005,.1);
    p.material={...p.material,yieldStrength:1e5,ultimateStrength:2e5,fractureEnergy:1,fractureStrain:.001};
    const low=accumulateDamage(p,undefined,1,.1,0,[0,0,0],[1,0,0],.005,.1);expect(low.kind).toBe('fractured');expect(high.kind).not.toBe('fractured');
  });
  it('does not create plastic work for zero input, but connection failure is independent',()=>{
    const p=convertOcct(cubeOcct(),'c.step').parts[0];p.jointStrength=.1;const d=accumulateDamage(p,undefined,0,.2,.01,[0,0,0],[1,0,0],.005,.2);expect(d.energy).toBe(0);expect(d.dentDepth).toBe(0);expect(d.kind).toBe('detached');
  });
});
describe('real mesh planar fracture',()=>{
  it('splits CAD triangles, caps cut faces and preserves total closed volume',()=>{
    const p=convertOcct(cubeOcct(),'cube.step').parts[0],fragments=splitMesh(p.vertices,p.indices,[1,0,0]);expect(fragments).toHaveLength(2);
    const volumes=fragments.map(f=>meshMetrics(f.vertices,f.indices).volume);expect(volumes[0]+volumes[1]).toBeCloseTo(p.volume,12);expect(fragments.reduce((n,f)=>n+f.fraction,0)).toBeCloseTo(1);
    expect(fragments[0].vertices.filter((_,i)=>i%3===0).every(v=>v>=-1e-9)).toBe(true);expect(fragments[1].vertices.filter((_,i)=>i%3===0).every(v=>v<=1e-9)).toBe(true);
  });
  it('handles an oblique fracture without discarding source geometry',()=>{
    const p=convertOcct(cubeOcct(),'cube.step').parts[0];const out=splitMesh(p.vertices,p.indices,[1,.3,.6]);expect(out).toHaveLength(2);expect(out.reduce((n,f)=>n+meshMetrics(f.vertices,f.indices).volume,0)).toBeCloseTo(p.volume,10);
  });
});
