import {describe,it,expect} from 'vitest';
import { PART_MATERIALS } from './materials';
import { MATERIALS } from '../defaults';
import { convertOcct,assemblyMass } from './mesh';
import { cubeOcct } from './test-fixtures';
import { accumulateDamage } from './damage';
describe('15% infill engineering reference presets',()=>{
 it('uses the same explicit effective density on the outline and assembly paths',()=>{
  for(const [id,solid]of [['pla15',1240],['petg15',1270]] as const){const preset=PART_MATERIALS[id];expect(preset.density).toBe(solid*.15);expect(MATERIALS.find(m=>m.id===id)?.density).toBe(preset.density);expect(preset.source).toContain('不是15%试样实测');
   const a=convertOcct(cubeOcct(),'cube.step');a.parts[0].material={...preset};expect(assemblyMass(a)).toBeCloseTo(.02**3*solid*.15,12);}
 });
 it('allows PLA and PETG cards to affect damage, and preserves independent copies',()=>{
  const p=convertOcct(cubeOcct(),'cube.step').parts[0];p.thickness=.002;p.jointStrength=1e6;
  const hit=(id:string)=>{p.material={...PART_MATERIALS[id]};return accumulateDamage(p,undefined,.03,.1,0,[-.01,0,0],[1,0,0],.005,.1)};
  const pla=hit('pla15'),petg=hit('petg15');expect(pla.damage).toBeGreaterThan(petg.damage);p.material.density=999;expect(PART_MATERIALS.petg15.density).toBe(190.5);
 });
});
