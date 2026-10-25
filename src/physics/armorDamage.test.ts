import {describe,it,expect} from 'vitest';
import {cloneExperiment,DEFAULT_EXPERIMENT} from '../defaults';
import {PART_MATERIALS} from '../assembly/materials';
import {armorDamagePart,armorDamageTarget} from './armorDamage';
import {meshMetrics} from '../assembly/mesh';
import {splitMesh} from '../assembly/fracture';
import {simulate} from './simulation';
import {parseProject} from '../exports';

function armorCase(){const c=cloneExperiment(DEFAULT_EXPERIMENT);c.settings.duration=.08;c.settings.step=1/3000;c.settings.forwardDriveTime=.08;c.a.robot.speed=2;c.armor.damageEnabled=true;c.armor.material={...PART_MATERIALS.pla15,name:'PLA 护甲验收卡'};c.armor.materialName='PLA 护甲验收卡';c.armor.materialId='pla15';c.armor.density=PART_MATERIALS.pla15.density;return c;}
describe('ordinary armor damage switch',()=>{
 it('builds the exact plate/bent/custom extrusion as a closed damage mesh',()=>{for(const shape of ['plate','bent','custom'] as const){const c=cloneExperiment(DEFAULT_EXPERIMENT);c.armor.shape=shape;const part=armorDamagePart(c.armor),target=armorDamageTarget(c.armor);expect(part.center).toEqual([0,0,0]);expect(part.indices.length).toBeGreaterThan(12);expect(meshMetrics(part.vertices,part.indices).volume).toBeGreaterThan(0);expect(target.parts[0].material.name).toBe(c.armor.materialName);}}
 );
 it('keeps the legacy rigid-only result when the switch is off',async()=>{const c=armorCase();c.armor.damageEnabled=false;const r=await simulate(c);expect(r.events.some(e=>e.pair==='aWeapon-bArmor')).toBe(true);expect(r.damage??[]).toHaveLength(0);expect(r.fragments??[]).toHaveLength(0);expect(r.frames.every(f=>f.assembly===undefined)).toBe(true);});
 it('records armor dent/fracture only when enabled and restores the result',async()=>{const c=armorCase();const r=await simulate(c);expect(r.events.some(e=>e.pair==='aWeapon-bArmor')).toBe(true);expect(r.damage?.some(d=>d.partId==='armor')).toBe(true);expect(r.frames.some(f=>f.assembly?.damage.armor)).toBe(true);expect(parseProject(JSON.stringify({config:c,result:r})).result?.damage?.[0].partId).toBe('armor');});
 it('also damages a護甲 mounted on the B robot without losing the mount setup',async()=>{const c=armorCase();c.armor.mount='robot';c.b.robot.speed=0;const r=await simulate(c);expect(r.events.some(e=>e.pair==='aWeapon-bArmor')).toBe(true);expect(r.damage?.some(d=>d.partId==='armor')).toBe(true);expect(r.frames[0].poses.bChassis).toBeDefined();});
 it('splits the generated armor mesh into positive-volume fragments',()=>{const part=armorDamagePart(DEFAULT_EXPERIMENT.armor),pieces=splitMesh(part.vertices,part.indices,[1,0,0]);expect(pieces).toHaveLength(2);expect(pieces.every(p=>meshMetrics(p.vertices,p.indices).volume>0)).toBe(true);});
},30000);
