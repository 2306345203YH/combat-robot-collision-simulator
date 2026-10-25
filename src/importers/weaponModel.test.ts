import {describe,it,expect} from 'vitest';
import { makeWeaponModel,weaponFromOcct,weaponFromStl } from './weaponModel';
import { cubeVertices,cubeIndices,cubeOcct } from '../assembly/test-fixtures';
import { meshMassProperties,weaponMesh,validateWeaponModel } from '../physics/weaponMesh';
import { weaponMassProperties,validateExperiment } from '../physics/geometry';
import { DEFAULT_EXPERIMENT,cloneExperiment } from '../defaults';
import { parseProject } from '../exports';
import { simulate } from '../physics/simulation';
import { readFileSync,existsSync,writeFileSync } from 'node:fs';

function stl(binary:boolean){
 if(!binary)return new TextEncoder().encode('solid cube\n'+Array.from({length:12},(_,t)=>'facet normal 0 0 0\nouter loop\n'+cubeIndices.slice(t*3,t*3+3).map(j=>'vertex '+cubeVertices.slice(j*3,j*3+3).map(x=>x*1000).join(' ')).join('\n')+'\nendloop\nendfacet').join('\n')+'\nendsolid cube').buffer;
 const buffer=new ArrayBuffer(84+12*50),v=new DataView(buffer);new Uint8Array(buffer).set(new TextEncoder().encode('solid binary STL header'));v.setUint32(80,12,true);
 for(let i=0;i<12;i++)for(let j=0;j<3;j++)for(let k=0;k<3;k++)v.setFloat32(84+i*50+12+j*12+k*4,cubeVertices[cubeIndices[i*3+j]*3+k]*1000,true);
 return buffer;
}
describe('immutable STEP/STL weapon models',()=>{
 it('imports ASCII and binary STL (including solid-prefixed binary) with explicit units',()=>{for(const binary of [false,true]){const m=weaponFromStl(stl(binary),'cube.stl','mm','z');expect(m.vertices).toHaveLength(24);expect(m.size).toEqual([.02,.02,.02]);expect(meshMassProperties(m.vertices,m.indices,1000).mass).toBeCloseTo(.008,12);expect(validateWeaponModel(m)).toEqual([]);}});
 it('uses real volume, centroid and full inertia, with a parallel-axis term only on shaft inertia',()=>{
  const model=makeWeaponModel(cubeVertices.map((v,i)=>v*[3,2,.5][i%3]),cubeIndices,'bar.stl','stl','m','z'),w={...DEFAULT_EXPERIMENT.a.weapon,shape:'mesh' as const,model,density:1000};
  const p=weaponMassProperties(w),mass=.06*.04*.01*1000;expect(p.mass).toBeCloseTo(mass,12);expect(p.inertia[0]).toBeCloseTo(mass*(.04**2+.01**2)/12,12);expect(p.axisInertia).toBeCloseTo(mass*(.06**2+.04**2)/12,12);
  w.model={...model,axisPoint:[.005,-.003,.002]};const shifted=weaponMassProperties(w);expect(shifted.mass).toBeCloseTo(p.mass,12);shifted.inertia.forEach((v,i)=>expect(v).toBeCloseTo(p.inertia[i],12));expect(shifted.centroid).toEqual(expect.arrayContaining([expect.closeTo(-.005,10),expect.closeTo(.003,10),expect.closeTo(-.002,10)]));expect(shifted.axisInertia).toBeCloseTo(p.axisInertia+mass*(.005**2+.003**2),12);
  expect(w.model.vertices).toEqual(model.vertices);expect(weaponMesh(w).vertices[0]).toBeCloseTo(model.vertices[0]-.005);
 });
 it('rotates principal inertia axes correctly for a non-axis-aligned bar',()=>{
  const angle=.43,c=Math.cos(angle),s=Math.sin(angle),base=cubeVertices.map((v,i)=>v*[3,2,.5][i%3]),rotated:number[]=[];
  for(let i=0;i<base.length;i+=3)rotated.push(c*base[i]-s*base[i+1],s*base[i]+c*base[i+1],base[i+2]);
  const p=meshMassProperties(rotated,cubeIndices,1000),q=p.principalRotation;
  // Reconstruct R diag(I) R^T from the returned quaternion and check against integral tensor.
  const [x,y,z,w]=q,R=[[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],[2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],[2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]];
  for(let j=0;j<3;j++)expect(R[j].reduce((n,v,k)=>n+v*v*p.principalInertia[k],0)).toBeCloseTo(p.inertia[j],12);
  expect(R[0].reduce((n,v,k)=>n+v*R[1][k]*p.principalInertia[k],0)).toBeCloseTo(p.productXY,12);
 });
 it('accepts a STEP single part and rejects an assembly, open surface or inconsistent winding',()=>{
  expect(weaponFromOcct(cubeOcct(),'single.step','x').format).toBe('step');const multi=cubeOcct();multi.meshes.push(structuredClone(multi.meshes[0]));expect(()=>weaponFromOcct(multi,'assembly.step','z')).toThrow('单零件');
  expect(()=>makeWeaponModel(cubeVertices,cubeIndices.slice(3),'open.stl','stl','m','z')).toThrow('未封闭');const bad=[...cubeIndices];[bad[0],bad[1]]=[bad[1],bad[0]];expect(()=>makeWeaponModel(cubeVertices,bad,'bad.stl','stl','m','z')).toThrow('方向不一致');
 });
 it('keeps imported model/shaft/material in exported JSON and rejects corrupt model indices',()=>{
  const c=cloneExperiment(DEFAULT_EXPERIMENT);c.a.weapon.shape='mesh';c.a.weapon.model=weaponFromStl(stl(true),'cube.stl','mm','y');c.a.weapon.model.axisPoint=[.001,.002,.003];expect(parseProject(JSON.stringify({config:c})).config.a.weapon.model).toEqual(c.a.weapon.model);
  c.a.weapon.model.indices[0]=999999;expect(()=>parseProject(JSON.stringify({config:c}))).toThrow('网格');
 });
 it('uses source-axis choice and the true axial size instead of editable template thickness',()=>{
  const c=cloneExperiment(DEFAULT_EXPERIMENT);c.a.weapon.shape='mesh';c.a.weapon.model=makeWeaponModel(cubeVertices.map((v,i)=>v*[3,2,.5][i%3]),cubeIndices,'bar.stl','stl','m','x');c.a.weapon.thickness=-1;c.a.weapon.radius=-1;
  expect(validateExperiment(c).filter(e=>e.level==='error')).toEqual([]);const p=weaponMassProperties(c.a.weapon);expect(p.radius).toBeCloseTo(Math.hypot(.005,.02),10);expect(p.axisInertia).toBeCloseTo(p.mass*(.04**2+.01**2)/12,10);
 });
 it('collides with an imported weapon on both A and B and records changed shaft speeds',async()=>{
  const c=cloneExperiment(DEFAULT_EXPERIMENT);c.mode='weapon-weapon';c.settings.duration=.12;c.settings.startDistance=.003;c.settings.forwardDriveTime=0;
  const model=makeWeaponModel(cubeVertices.map((v,i)=>v*[7.5,1.5,.4][i%3]),cubeIndices,'test-bar.stl','stl','m','z');
  for(const side of ['a','b'] as const){c[side].weapon={...c[side].weapon,shape:'mesh',model:structuredClone(model),density:2700,peakRpm:1000,initialRpm:1000,rpmMode:'direct'};c[side].robot.speed=1;}
  const r=await simulate(c);expect(r.events.some(e=>e.pair==='aWeapon-bWeapon')).toBe(true);expect(r.frames.every(f=>Number.isFinite(f.kinetic))).toBe(true);expect(r.frames.at(-1)!.rpmA).not.toBeCloseTo(r.frames[0].rpmA,1);
 },20000);
});
const fixture=process.env.WEAPON_STEP_RAW;
const browserProject=process.env.WEAPON_BROWSER_PROJECT;
describe.skipIf(!browserProject||!existsSync(browserProject))('actual browser imported weapon project',()=>{
 it('restores actual STEP/STL meshes, shifted shaft, printed cards and worker collision result',()=>{
  const {config:c,result:r}=parseProject(readFileSync(browserProject!,'utf8'));expect(c.a.weapon.model?.format).toBe('step');expect(c.b.weapon.model?.format).toBe('stl');expect(c.a.weapon.model?.axisPoint).toEqual([.005,0,.002]);expect(c.a.weapon.density).toBe(186);expect(c.b.weapon.density).toBe(190.5);expect(c.a.weapon.material?.source).toContain('不是15%试样实测');expect(r?.events.some(e=>e.pair==='aWeapon-bWeapon')).toBe(true);
 });
 it('rejects invalid saved material strengths rather than silently treating them as a valid card',()=>{
  const data=JSON.parse(readFileSync(browserProject!,'utf8'));data.config.a.weapon.material.youngModulus=-1;expect(()=>parseProject(JSON.stringify(data))).toThrow('youngModulus');
 });
});
describe.skipIf(!fixture||!existsSync(fixture))('actual OCCT weapon bore',()=>{
 it('preserves a real STEP bore in mass and mesh while locking geometric fields',()=>{const raw=JSON.parse(readFileSync(fixture!,'utf8')),m=weaponFromOcct(raw,'test-bar-with-bore.step','z'),p=meshMassProperties(m.vertices,m.indices,1000);expect(m.format).toBe('step');expect(p.volume).toBeCloseTo((150*30-Math.PI*25)*8*1e-9,7);expect(m.indices.length).toBeGreaterThan(36);if(process.env.WEAPON_QA_OUTPUT)writeFileSync(process.env.WEAPON_QA_OUTPUT,JSON.stringify({model:m,properties:p}));});
});
