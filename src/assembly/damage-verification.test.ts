import {describe,it,expect} from 'vitest';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {cloneExperiment,DEFAULT_EXPERIMENT} from '../defaults';
import {weaponFromOcct} from '../importers/weaponModel';
import {convertOcct,meshMetrics} from './mesh';
import {PART_MATERIALS} from './materials';
import {simulate} from '../physics/simulation';
import {dentMesh} from './damage';
import {parseProject} from '../exports';

const dir=process.env.WEAPON_DAMAGE_FIXTURES;
describe.skipIf(!dir||!existsSync(dir+'/test-target-coupon-raw.json'))('real STEP weapon against real STEP coupon: damage evidence',()=>{
 it('proves geometry deformation, capped fracture meshes, independently moving fragments and negative controls',async()=>{
  const base=cloneExperiment(DEFAULT_EXPERIMENT);base.mode='weapon-assembly';base.name='验收夹具 · STEP 武器与 STEP 试片';
  base.a.weapon.shape='mesh';base.a.weapon.model=weaponFromOcct(JSON.parse(readFileSync(dir+'/test-bar-with-bore-raw.json','utf8')),'test-bar-with-bore.step','z');
  base.a.weapon.density=2700;base.a.weapon.rpmMode='direct';base.a.weapon.initialRpm=1500;base.a.weapon.peakRpm=1500;
  base.assembly=convertOcct(JSON.parse(readFileSync(dir+'/test-target-coupon-raw.json','utf8')),'test-target-coupon.step','z');base.assembly.mount='fixed';base.assembly.parts[0].thickness=.003;base.assembly.parts[0].jointStrength=1e9;
  base.settings.duration=.22;base.settings.startDistance=.005;base.settings.forwardDriveTime=.22;base.a.robot.speed=1.2;
  const evidence:any={fixture:'synthetic CAD acceptance coupon/bar, not user robot or empirical validation',cases:{},crackPropagation:false};
  for(const kind of ['pla15','petg15','strong','dent','off']){
   const c=cloneExperiment(base),p=c.assembly!.parts[0];
   if(kind==='pla15'||kind==='petg15')p.material={...PART_MATERIALS[kind]};
   if(kind==='strong')p.material={...p.material,yieldStrength:1e12,ultimateStrength:2e12};
   if(kind==='dent')p.material={...p.material,name:'仅验收用延性卡',yieldStrength:1e5,ultimateStrength:2e5,fractureStrain:10,fractureEnergy:1e9};
   if(kind==='off'){p.material={...PART_MATERIALS.pla15};c.assembly!.damageEnabled=false;}
   const r=await simulate(c);expect(r.events.some(e=>e.pair.startsWith('aWeapon-part-'))).toBe(true);expect(r.frames.every(f=>Number.isFinite(f.kinetic))).toBe(true);
   const d=r.damage?.[0];let changedVertices=0,maximumShift=0;
   if(kind==='pla15'||kind==='petg15'){
    expect(d?.kind).toBe('fractured');expect(r.fragments).toHaveLength(2);
    const ids=r.fragments!.map(f=>f.id),frames=r.frames.filter(f=>ids.every(id=>f.assembly?.poses[id]));expect(frames.length).toBeGreaterThan(2);
    for(const id of ids){const first=frames[0].assembly!.poses[id],last=frames.at(-1)!.assembly!.poses[id];expect(Math.hypot(...last.position.map((v,k)=>v-first.position[k]))).toBeGreaterThan(1e-6);}
    expect(r.fragments!.every(f=>meshMetrics(f.vertices,f.indices).volume>0)).toBe(true);
    expect(parseProject(JSON.stringify({config:c,result:r})).result?.fragments).toHaveLength(2);
   }else if(kind==='strong'){expect(r.fragments).toHaveLength(0);expect(d?.kind).toBe('elastic');expect(d?.dentDepth).toBe(0);}
   else if(kind==='off'){expect(r.damage).toHaveLength(0);expect(r.fragments).toHaveLength(0);}
   else{
    expect(d?.kind).toBe('dented');expect(d!.dentDepth).toBeGreaterThan(0);expect(r.fragments).toHaveLength(0);
    const deformed=dentMesh(p,d!);for(let i=0;i<deformed.vertices.length;i+=3){const distanceToSurface=Math.min(...[0,1,2].map(k=>Math.abs(Math.abs(deformed.vertices[i+k])-p.size[k]/2)));if(distanceToSurface>1e-8){changedVertices++;maximumShift=Math.max(maximumShift,distanceToSurface);}}
    expect(changedVertices).toBeGreaterThan(0);expect(maximumShift).toBeGreaterThan(1e-7);
   }
   evidence.cases[kind]={events:r.events.length,contactImpulse:r.summary.totalImpulse,damage:r.damage,fragments:r.fragments?.map(f=>({id:f.id,triangles:f.indices.length/3,volume:meshMetrics(f.vertices,f.indices).volume})),frames:r.frames.length,independentPoseFrames:r.frames.filter(f=>Object.keys(f.assembly?.poses??{}).length>0).length,changedVertices,maximumShift,warnings:r.summary.warnings};
   if(process.env.DAMAGE_QA_OUTPUT){mkdirSync(process.env.DAMAGE_QA_OUTPUT,{recursive:true});writeFileSync(process.env.DAMAGE_QA_OUTPUT+'/'+kind+'-project.json',JSON.stringify({format:'robot-collision-lab',version:1,config:c,result:r}));}
  }
  if(process.env.DAMAGE_QA_OUTPUT)writeFileSync(process.env.DAMAGE_QA_OUTPUT+'/damage-evidence.json',JSON.stringify(evidence,null,2));
 },60000);
});
