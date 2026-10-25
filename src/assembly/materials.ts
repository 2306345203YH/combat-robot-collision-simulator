import type { PartMaterial } from './types';
import type { ArmorConfig } from '../types';

export const PRINTED_REFERENCE_NOTE='15% 填充均质化参考：ρ=ρ实心×0.15，E=E实心×0.15²，强度按0.15^1.5折减；忽略外壳/顶底层、纹路、方向和应变率。不是15%试样实测；断裂应变/断裂能为场景假设，需校准。实际成品请用称重质量÷CAD体积修正密度。';
export const PRINTED_SOURCES={pla:'https://prusament.com/wp-content/uploads/2022/10/PLA_Prusament_TDS_2021_10_EN.pdf',petg:'https://prusament.com/wp-content/uploads/2022/10/PETG_Prusament_TDS_2021_10_EN.pdf'};

// Editable engineering scenario cards, not certified alloy or heat-treatment data.
export const PART_MATERIALS: Record<string,PartMaterial>={
  pla15:{name:'PLA · 15% 填充参考',density:1240*.15,youngModulus:2.3e9*.15**2,yieldStrength:51e6*.15**1.5,ultimateStrength:65e6*.15**1.5,fractureStrain:.03,fractureEnergy:300,friction:.3,restitution:.1,source:`${PRINTED_SOURCES.pla}；厂家100%试样仅提供密度/E/屈服基线；极限强度65 MPa、断裂应变和断裂能及折减律为场景假设。${PRINTED_REFERENCE_NOTE}`},
  petg15:{name:'PETG · 15% 填充参考',density:1270*.15,youngModulus:1.5e9*.15**2,yieldStrength:47e6*.15**1.5,ultimateStrength:55e6*.15**1.5,fractureStrain:.08,fractureEnergy:800,friction:.3,restitution:.1,source:`${PRINTED_SOURCES.petg}；厂家100%试样仅提供密度/E/屈服基线；极限强度55 MPa、断裂应变和断裂能及折减律为场景假设。${PRINTED_REFERENCE_NOTE}`},
  aluminum:{name:'铝合金 · 场景假设',density:2700,youngModulus:69e9,yieldStrength:240e6,ultimateStrength:290e6,fractureStrain:.12,fractureEnergy:18000,friction:.3,restitution:.15,source:'教学场景参数；请替换为实际牌号/热处理材料卡'},
  steel:{name:'钢 · 场景假设',density:7850,youngModulus:200e9,yieldStrength:450e6,ultimateStrength:650e6,fractureStrain:.15,fractureEnergy:50000,friction:.3,restitution:.15,source:'教学场景参数；不代表特定牌号/热处理'},
  titanium:{name:'钛合金 · 场景假设',density:4430,youngModulus:110e9,yieldStrength:830e6,ultimateStrength:900e6,fractureStrain:.1,fractureEnergy:30000,friction:.3,restitution:.15,source:'教学场景参数；不是经验证材料卡'},
  hdpe:{name:'HDPE · 场景假设',density:950,youngModulus:1e9,yieldStrength:25e6,ultimateStrength:30e6,fractureStrain:.7,fractureEnergy:8000,friction:.25,restitution:.1,source:'简化弹塑性场景；未建模粘弹性、温度和应变率'},
  brittle:{name:'脆性塑料 · 场景假设',density:1200,youngModulus:2.4e9,yieldStrength:35e6,ultimateStrength:45e6,fractureStrain:.025,fractureEnergy:1200,friction:.25,restitution:.1,source:'简化脆性场景；需要用实测强度/断裂能标定'},
};
export const defaultPartMaterial=():PartMaterial=>({...PART_MATERIALS.aluminum});
export function armorMaterial(a:ArmorConfig):PartMaterial{
 return {...(a.material??PART_MATERIALS[a.materialId]??PART_MATERIALS.steel),name:a.materialName,density:a.density};
}
export function validatePartMaterial(m:PartMaterial):string[]{
 const errors:string[]=[];
 if(typeof m.name!=='string'||typeof m.source!=='string')errors.push('材料名称与参数来源无效。');
 for(const key of ['density','youngModulus','yieldStrength','ultimateStrength','fractureStrain','fractureEnergy'] as const)if(!Number.isFinite(m[key])||m[key]<=0)errors.push(`${key} 必须为正有限值。`);
 if(m.ultimateStrength<m.yieldStrength)errors.push('极限强度不能低于屈服强度。');
 for(const key of ['friction','restitution'] as const)if(!Number.isFinite(m[key])||m[key]<0||(key==='restitution'&&m[key]>1))errors.push('材料摩擦/恢复系数无效。');
 return errors;
}
