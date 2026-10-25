import type { ArmorConfig,Experiment,Vec3 } from '../types';
import type { AssemblyPart,AssemblyTarget } from '../assembly/types';
import { armorMaterial } from '../assembly/materials';
import { meshBounds } from '../assembly/mesh';
import { getArmorProfile,armorMassProperties,triangulateProfile } from './geometry';

/** Closed extrusion of exactly the same profile used by legacy armor colliders. */
export function armorDamagePart(armor:ArmorConfig):AssemblyPart{
 const profile=getArmorProfile(armor),tri=triangulateProfile(profile),count=tri.vertices.length/2,vertices:number[]=[],indices:number[]=[];
 for(const z of [-armor.width/2,armor.width/2])for(let i=0;i<count;i++)vertices.push(tri.vertices[i*2],tri.vertices[i*2+1],z);
 for(let i=0;i<tri.indices.length;i+=3){let [a,b,c]=tri.indices.slice(i,i+3);const cross=(tri.vertices[b*2]-tri.vertices[a*2])*(tri.vertices[c*2+1]-tri.vertices[a*2+1])-(tri.vertices[b*2+1]-tri.vertices[a*2+1])*(tri.vertices[c*2]-tri.vertices[a*2]);if(cross<0)[b,c]=[c,b];indices.push(a,c,b,a+count,b+count,c+count);}
 let offset=0;
 for(const [ringIndex,ring] of [profile.outer,...profile.holes].entries()){
  const signed=ring.reduce((n,p,i)=>n+p[0]*ring[(i+1)%ring.length][1]-ring[(i+1)%ring.length][0]*p[1],0);
  for(let j=0;j<ring.length;j++){let a=offset+j,b=offset+(j+1)%ring.length;if((signed>0)!==(ringIndex===0))[a,b]=[b,a];indices.push(a,b,b+count,a,b+count,a+count);}offset+=ring.length;
 }
 const bounds=meshBounds(vertices),props=armorMassProperties(armor),local=vertices;
 // For custom profiles `thickness` may be an old template value. Derive the
 // effective section thickness from area / maximum section dimension instead.
 const thickness=armor.shape==='custom'?props.area/Math.max(bounds.size[0],bounds.size[1]):armor.thickness;
 const perimeter=[profile.outer,...profile.holes].reduce((n,ring)=>n+ring.reduce((s,p,i)=>s+Math.hypot(p[0]-ring[(i+1)%ring.length][0],p[1]-ring[(i+1)%ring.length][1]),0),0);
 return {id:'armor',name:armor.name||'目标护甲',path:'普通护甲',vertices:local,indices,center:[0,0,0],size:bounds.size,volume:props.volume,area:2*props.area+perimeter*armor.width,color:[.8,.56,.37],material:armorMaterial(armor),enabled:true,thickness:Math.max(1e-6,thickness),jointStrength:Number.MAX_VALUE,damageEnabled:true};
}
export function armorDamageTarget(armor:ArmorConfig):AssemblyTarget{
 const part=armorDamagePart(armor);return {filename:'普通护甲（剖面挤出）',parts:[part],size:part.size,upAxis:'y',mount:armor.mount==='fixed'?'fixed':'free',speed:0,heightOffset:0,damageEnabled:true,meshTolerance:0,warnings:[]};
}
export function damageTargetFor(config:Experiment):AssemblyTarget|undefined{
 return config.mode==='weapon-assembly'?config.assembly:config.mode==='weapon-armor'&&config.armor.damageEnabled?armorDamageTarget(config.armor):undefined;
}
