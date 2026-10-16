import type { PartMaterial } from './types';

// Editable engineering scenario cards, not certified alloy or heat-treatment data.
export const PART_MATERIALS: Record<string,PartMaterial>={
  aluminum:{name:'铝合金 · 场景假设',density:2700,youngModulus:69e9,yieldStrength:240e6,ultimateStrength:290e6,fractureStrain:.12,fractureEnergy:18000,friction:.3,restitution:.15,source:'教学场景参数；请替换为实际牌号/热处理材料卡'},
  steel:{name:'钢 · 场景假设',density:7850,youngModulus:200e9,yieldStrength:450e6,ultimateStrength:650e6,fractureStrain:.15,fractureEnergy:50000,friction:.3,restitution:.15,source:'教学场景参数；不代表特定牌号/热处理'},
  titanium:{name:'钛合金 · 场景假设',density:4430,youngModulus:110e9,yieldStrength:830e6,ultimateStrength:900e6,fractureStrain:.1,fractureEnergy:30000,friction:.3,restitution:.15,source:'教学场景参数；不是经验证材料卡'},
  hdpe:{name:'HDPE · 场景假设',density:950,youngModulus:1e9,yieldStrength:25e6,ultimateStrength:30e6,fractureStrain:.7,fractureEnergy:8000,friction:.25,restitution:.1,source:'简化弹塑性场景；未建模粘弹性、温度和应变率'},
  brittle:{name:'脆性塑料 · 场景假设',density:1200,youngModulus:2.4e9,yieldStrength:35e6,ultimateStrength:45e6,fractureStrain:.025,fractureEnergy:1200,friction:.25,restitution:.1,source:'简化脆性场景；需要用实测强度/断裂能标定'},
};
export const defaultPartMaterial=():PartMaterial=>({...PART_MATERIALS.aluminum});
