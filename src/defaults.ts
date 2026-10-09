import type { Experiment, WeaponConfig, RobotConfig, MaterialOption } from './types';
export const MATERIALS: MaterialOption[] = [
 { id:'steel',name:'钢 · 密度假设',density:7850,note:'仅用于质量计算；不是任何具体热处理牌号的强度材料卡。',source:'用户可改的教学密度假设' },
 { id:'aluminum',name:'铝合金 · 密度假设',density:2700,note:'不包含屈服、断裂或热处理性能。',source:'用户可改的教学密度假设' },
 { id:'titanium',name:'钛合金 · 密度假设',density:4430,note:'不包含强度数据；请用实际牌号和实测密度校正。',source:'用户可改的教学密度假设' },
 { id:'hdpe',name:'HDPE · 密度假设',density:950,note:'不同批次密度不同；没有粘弹性或破损模型。',source:'用户可改的教学密度假设' },
 { id:'custom',name:'自定义材料',density:7850,note:'名称是用户标签，密度不会自动补齐材料强度。',source:'用户输入' },
];
const weapon=(side:'A'|'B'):WeaponConfig=>({name:side==='A'?'双齿竖转':'环形竖转',materialId:'steel',materialName:'钢 · 密度假设',density:7850,shape:side==='A'?'tooth2':'ring',radius:0.075,innerRadius:0.028,length:.15,width:.03,thickness:.008,axisOffset:[0,0],profile:{outer:[[-.06,-.02],[.06,-.02],[.06,.02],[-.06,.02]],holes:[]},axis:'vertical',peakRpm:3000,spinupTime:2,elapsedSpinup:2,rpmMode:'ramp',initialRpm:3000,direction:side==='A'?-1:1,phaseDeg:side==='A'?20:70,driveEnabled:false});
const robot=():RobotConfig=>({mass:3,length:.22,width:.18,height:.075,maxSpeed:4,speed:1.2,weaponHeight:.13,overhang:.22});
export const DEFAULT_EXPERIMENT:Experiment={schemaVersion:1,name:'双齿竖转 × 倾斜护甲',mode:'weapon-armor',a:{weapon:weapon('A'),robot:robot()},b:{weapon:weapon('B'),robot:{...robot(),speed:0}},armor:{name:'倾斜平板',materialId:'steel',materialName:'钢 · 密度假设',density:7850,shape:'plate',length:.20,width:.22,thickness:.004,angleDeg:65,height:.105,mount:'fixed',profile:{outer:[[-.004,-.08],[.004,-.08],[.004,.08],[-.004,.08]],holes:[]}},settings:{duration:.65,step:1/6000,restitution:.15,friction:.3,groundFriction:.35,gap:.055,startDistance:.055,lateralOffset:0,aHeadingDeg:0,bHeadingDeg:0,gravity:9.81,seed:2026,randomPhase:false,forwardDriveTime:.65,allowWeaponChassisOverlap:false,allowArmorGroundOverlap:false,allowWeaponGroundContact:true}};
export const cloneExperiment=(e:Experiment):Experiment=>structuredClone(e);
/**
 * Fills in settings that were added after a project was saved.
 *
 * Both `parseProject` and the browser database validate field-by-field against
 * `DEFAULT_EXPERIMENT`, so a project written before a new switch existed would
 * otherwise be rejected as "类型或数值无效".
 */
export function normalizeExperiment(config: Experiment): Experiment {
  return { ...config, settings: { ...DEFAULT_EXPERIMENT.settings, ...(config?.settings ?? {}) } };
}
export const SHAPE_LABELS={disk:'实心圆盘',ring:'带孔圆盘 / 圆环',bar:'矩形转杆',tooth2:'双齿盘',tooth1:'单齿盘',custom:'自定义轮廓'};
