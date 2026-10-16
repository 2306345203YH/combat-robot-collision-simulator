import { describe,it,expect } from 'vitest';
import { cloneExperiment,DEFAULT_EXPERIMENT } from '../defaults';
import { cubeOcct } from './test-fixtures';
import { convertOcct } from './mesh';
import { simulate } from '../physics/simulation';
import { getInitialPoses } from '../physics/scene';
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import * as RAPIER from '@dimforge/rapier3d-compat';
import { createAssemblyPhysics } from './physics';
import { parseProject } from '../exports';

function scenario(){
  const c=cloneExperiment(DEFAULT_EXPERIMENT);c.mode='weapon-assembly';c.settings.duration=.12;c.settings.startDistance=.005;c.settings.forwardDriveTime=0;c.settings.step=1/3000;c.a.robot.speed=2;
  const data=cubeOcct();data.meshes[0].attributes.position.array=data.meshes[0].attributes.position.array.map((v,i)=>v*[2,5,7.5][i%3]);
  c.assembly=convertOcct(data,'target.step');const p=c.assembly.parts[0];p.thickness=.003;p.jointStrength=1000;p.material={...p.material,yieldStrength:1e5,ultimateStrength:2e5,fractureEnergy:1,fractureStrain:.001};return c;
}
describe('assembly collision and material response',()=>{
  it('uses each material density for the physical target mass',async()=>{
    await RAPIER.init();const c=scenario(),target=c.assembly!;target.parts[0].material.density=1000;const world=new RAPIER.World({x:0,y:0,z:0});
    try{const r=createAssemblyPhysics(world,target,{position:[0,0,0],rotation:[0,0,0,1]},[-1,0,0]);expect(r.root.mass()).toBeCloseTo(target.parts[0].volume*1000,5);}finally{world.free()}
  });
  it('contacts actual part hulls, fractures real meshes and advances separate fragments',async()=>{
    const c=scenario(),r=await simulate(c);
    expect(r.events.some(e=>e.pair==='aWeapon-part-0')).toBe(true);
    expect(r.damage?.some(d=>d.kind==='fractured')).toBe(true);
    expect(r.fragments).toHaveLength(2);
    expect(Object.keys(r.frames.at(-1)!.assembly!.poses)).toHaveLength(2);
    expect(r.frames.some(f=>Object.keys(f.assembly?.poses??{}).length===0)).toBe(true);
    expect(r.damage![0].energy).toBeLessThan(r.summary.initialEnergy+r.summary.driveWork+1);
    expect(r.frames.every(f=>Number.isFinite(f.kinetic+f.potential))).toBe(true);
  },20000);
  it('a stronger material retains the target under the same attack',async()=>{
    const c=scenario();c.assembly!.parts[0].material.yieldStrength=1e12;c.assembly!.parts[0].material.ultimateStrength=2e12;
    const r=await simulate(c);expect(r.events.some(e=>e.pair==='aWeapon-part-0')).toBe(true);expect(r.fragments).toHaveLength(0);expect(r.damage?.every(d=>d.kind==='elastic')).toBe(true);
    const p=r.frames.at(-1)!.poses.targetAssembly!;const start=getInitialPoses(c).targetAssembly!;expect(Math.hypot(...p.position.map((v,i)=>v-start.position[i]))).toBeGreaterThan(1e-5);
  },20000);
  it('connection failure releases a whole part without faking a material crack',async()=>{
    const c=scenario();c.assembly!.parts[0].material.yieldStrength=1e12;c.assembly!.parts[0].material.ultimateStrength=2e12;c.assembly!.parts[0].jointStrength=.0001;
    const r=await simulate(c);expect(r.damage?.[0].kind).toBe('detached');expect(r.fragments).toHaveLength(0);expect(r.frames.at(-1)!.assembly?.poses['part-0']).toBeDefined();
  },20000);
  it('damage-off keeps rigid collision, and fixed constraints keep assembly pose',async()=>{
    const c=scenario();c.assembly!.damageEnabled=false;c.assembly!.mount='fixed';const r=await simulate(c);expect(r.events.length).toBeGreaterThan(0);expect(r.damage).toHaveLength(0);expect(r.fragments).toHaveLength(0);expect(r.frames.at(-1)!.poses.targetAssembly).toEqual(r.frames[0].poses.targetAssembly);
  },20000);
});
const fixture=process.env.STEP_MESH_FIXTURE;
const browserFixture=process.env.ASSEMBLY_BROWSER_PROJECT;
describe.skipIf(!browserFixture||!existsSync(browserFixture))('actual browser STEP project persistence',()=>{
  it('restores imported geometry, edited material, fracture pieces and their timeline',()=>{
    const p=parseProject(readFileSync(browserFixture!,'utf8'));
    expect(p.config.mode).toBe('weapon-assembly');expect(p.config.assembly?.parts).toHaveLength(276);expect(p.result?.fragments).toHaveLength(2);expect(p.result?.frames.some(f=>Object.keys(f.assembly?.poses??{}).length===2)).toBe(true);expect(p.config.assembly?.parts.find(p=>p.id==='part-6')?.material.name).toContain('弱侧板');
  });
  it('drops corrupt fragment replay while preserving valid experiment inputs',()=>{
    const raw=JSON.parse(readFileSync(browserFixture!,'utf8'));raw.result.fragments[0].indices[0]=999999999;
    const parsed=parseProject(JSON.stringify(raw));expect(parsed.config.assembly?.parts).toHaveLength(276);expect(parsed.result).toBeNull();
  });
});
describe.skipIf(!fixture||!existsSync(fixture))('actual Boxbot full assembly collision',()=>{
  it('uses all enabled CAD parts as a target and records contact with real component IDs',async()=>{
    const c=cloneExperiment(DEFAULT_EXPERIMENT);c.mode='weapon-assembly';c.assembly=convertOcct(JSON.parse(readFileSync(fixture!,'utf8')),'Boxbot.STEP');
    c.settings.duration=.3;c.settings.startDistance=.005;c.settings.forwardDriveTime=0;c.a.robot.weaponHeight=.13;
    const r=await simulate(c);
    if(process.env.ASSEMBLY_QA_OUTPUT)writeFileSync(process.env.ASSEMBLY_QA_OUTPUT,JSON.stringify({size:c.assembly.size,up:c.assembly.upAxis,enabled:c.assembly.parts.filter(p=>p.enabled).length,parts:c.assembly.parts.map(p=>({id:p.id,name:p.name,center:p.center,size:p.size,volume:p.volume,enabled:p.enabled})),events:r.events,damage:r.damage,summary:r.summary,first:r.frames[0],last:r.frames.at(-1)},null,2));
    expect(r.config.assembly?.parts).toHaveLength(276);expect(r.events.some(e=>e.pair.startsWith('aWeapon-part-'))).toBe(true);expect(r.frames.every(f=>Number.isFinite(f.kinetic+f.potential))).toBe(true);
  },60000);
});
