import type { Experiment, SimulationResult } from './types';
import { DEFAULT_EXPERIMENT, normalizeExperiment } from './defaults';
export function downloadBlob(name:string,content:Blob|string,type='application/json'){const blob=typeof content==='string'?new Blob([content],{type}):content;const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000)}
export function exportProject(config:Experiment,result:SimulationResult|null){downloadBlob(`${config.name||'碰撞实验'}.json`,JSON.stringify({format:'robot-collision-lab',version:1,config,result},null,2))}
export function exportCSV(result:SimulationResult){const fields=['time','rpmA','rpmB','speedA','speedB','rotationalA','rotationalB','kinetic','potential','driveWork','impulse'] as const;const headers=['时间_s','A转速_rpm','B转速_rpm','A速度_m_s','B速度_m_s','A旋转能_J','B旋转能_J','总动能_J','重力势能_J','驱动做功_J','累计冲量_N_s'];const lines=result.frames.map(f=>fields.map(k=>f[k].toPrecision(10)).join(','));downloadBlob(`${result.config.name}-曲线.csv`,'\uFEFF'+[headers.join(','),...lines].join('\n'),'text/csv;charset=utf-8')}
const esc=(s:unknown)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function exportReport(result:SimulationResult,screenshot?:string){const c=result.config,s=result.summary;const title=esc(c.name);const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title} · 实验报告</title><style>body{max-width:980px;margin:48px auto;font:16px/1.8 system-ui;color:#1c303a;padding:0 24px}h1{font-size:30px}small{color:#65727a}table{border-collapse:collapse;width:100%;margin:24px 0}td,th{border:1px solid #dce2e5;padding:10px;text-align:left}pre{white-space:pre-wrap;word-break:break-all;background:#f3f5f6;padding:20px;font-size:12px}img{max-width:100%}.note{border-left:4px solid #a0ca87;padding:12px;background:#f3f8ef}@media print{body{margin:10mm}pre{font-size:9px}}</style><h1>${title}</h1><small>${esc(result.createdAt)} · ${esc(result.engine)} · L1 刚体模型</small><p class="note">本报告显示刚体碰撞响应，未计算材料塑性变形、应力场、裂纹或断裂。几何、密度、摩擦及恢复系数均来自下方输入快照与假设。</p>${screenshot?`<img alt="碰撞场景" src="${screenshot}">`:''}<h2>结果摘要</h2><table><tr><th>初始总机械能</th><td>${s.initialEnergy.toFixed(4)} J</td><th>最终总机械能</th><td>${s.finalEnergy.toFixed(4)} J</td></tr><tr><th>驱动做功</th><td>${s.driveWork.toFixed(4)} J</td><th>未恢复机械能</th><td>${s.dissipated.toFixed(4)} J</td></tr><tr><th>武器目标接触总冲量</th><td>${s.totalImpulse.toFixed(5)} N·s</td><th>最大轴心约束偏移</th><td>${(s.maxJointError*1000).toFixed(4)} mm</td></tr><tr><th>物理步长</th><td>${s.actualStep.toExponential(4)} s</td><th>求解状态</th><td>${s.status==='ok'?'通过基础数值检查':'需要复核'}</td></tr></table><h2>接触事件</h2><table><tr><th>时刻 / s</th><th>对象</th><th>冲量 / N·s</th><th>A 碰前 → 碰后 / rpm</th></tr>${result.events.map(e=>`<tr><td>${e.time.toFixed(6)}</td><td>${esc(e.pair)}</td><td>${e.impulse.toFixed(6)}</td><td>${e.rpmBeforeA.toFixed(1)} → ${e.rpmAfterA.toFixed(1)}</td></tr>`).join('')}</table><h2>假设与诊断</h2><ul><li>车体为均匀刚体，地面为摩擦接触近似。</li><li>倾角以地面为基准；恢复与摩擦系数是接触对的假设。</li><li>质量与惯量来自可编辑几何和密度；材料名称不代表完整强度数据。</li><li>碰撞引擎使用 CCD 与子步；数值检查不等于实物验证。</li>${s.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul><h2>输入快照（内部 SI 单位）</h2><pre>${esc(JSON.stringify(c,(key,value)=>key==='dataUrl'?'[图像保存在工程文件]':value,2))}</pre><p>基础公式：ω=2πN/60；E=Iω²/2；vP=vC+ω×r；J=∫Fdt。报告与工程文件绑定同一次运行，可使用浏览器打印为 PDF。</p></html>`;downloadBlob(`${c.name}-实验报告.html`,html,'text/html;charset=utf-8')}
export function parseProject(text:string):{config:Experiment;result:SimulationResult|null}{
 const obj=JSON.parse(text);const raw=obj.config??obj;
 if(raw?.schemaVersion!==1||!['weapon-armor','weapon-weapon'].includes(raw.mode))throw new Error('不是有效的第一版碰撞实验工程。');
 // Older files predate some switches; fill them from defaults before the
 // field-by-field type check so they still import.
 const c=normalizeExperiment(raw);
 function check(template:unknown,value:unknown,path:string):void {
  if(Array.isArray(template)){if(!Array.isArray(value))throw new Error(`工程字段 ${path} 必须为数组。`);return}
  if(template&&typeof template==='object'){if(!value||typeof value!=='object')throw new Error(`工程缺少 ${path} 配置。`);for(const [k,t] of Object.entries(template))check(t,(value as Record<string,unknown>)[k],path+'.'+k);return}
  if(typeof value!==typeof template||(typeof value==='number'&&!Number.isFinite(value)))throw new Error(`工程字段 ${path} 类型或数值无效。`);
 }
 check(DEFAULT_EXPERIMENT,c,'config');
 for(const owner of [c.a.weapon,c.b.weapon,c.armor]) {
  if(!Array.isArray(owner.profile.outer)||!Array.isArray(owner.profile.holes))throw new Error('轮廓格式无效。');
  const rings=[owner.profile.outer,...owner.profile.holes];let count=0;
  for(const ring of rings){if(!Array.isArray(ring))throw new Error('孔洞格式无效。');count+=ring.length;for(const p of ring)if(!Array.isArray(p)||p.length!==2||p.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw new Error('轮廓点无效。');}
  if(count>1024)throw new Error('轮廓超过 1024 个顶点，请先简化。');
  if(owner.drawing&&(!/^data:image\/(png|jpeg);base64,/.test(owner.drawing.dataUrl)||!(owner.drawing.scale>0)))throw new Error('背景图格式或标定比例无效。');
 }
 let result:SimulationResult|null=null;const r=obj.result;
 if(r&&Array.isArray(r.frames)&&r.frames.length>0&&r.frames.length<=10000&&Array.isArray(r.events)&&r.events.length<=10000&&r.summary&&JSON.stringify(r.config)===JSON.stringify(c)){
  const frameKeys=['time','rpmA','rpmB','speedA','speedB','rotationalA','rotationalB','kinetic','potential','driveWork','impulse'];
  const validFrames=r.frames.every((f:any,i:number)=>frameKeys.every(k=>typeof f[k]==='number'&&Number.isFinite(f[k]))&&f.time>=0&&(i===0||f.time>=r.frames[i-1].time)&&f.poses&&Object.values(f.poses).every((p:any)=>Array.isArray(p.position)&&p.position.length===3&&Array.isArray(p.rotation)&&p.rotation.length===4&&[...p.position,...p.rotation].every(Number.isFinite)));
  const validEvents=r.events.every((e:any)=>['time','impulse','rpmBeforeA','rpmAfterA','rpmBeforeB','rpmAfterB'].every(k=>typeof e[k]==='number'&&Number.isFinite(e[k]))&&typeof e.pair==='string'&&Array.isArray(e.point)&&e.point.length===3&&Array.isArray(e.normal)&&e.normal.length===3&&[...e.point,...e.normal].every(Number.isFinite));
  const validSummary=['initialEnergy','finalEnergy','driveWork','dissipated','totalImpulse','maxJointError','elapsedMs','steps','actualStep','energyGain'].every(k=>typeof r.summary[k]==='number'&&Number.isFinite(r.summary[k]))&&Array.isArray(r.summary.warnings)&&r.summary.warnings.every((s:any)=>typeof s==='string')&&['ok','review'].includes(r.summary.status);
  if(validFrames&&validEvents&&validSummary&&typeof r.engine==='string'&&typeof r.createdAt==='string')result=r;
 }
 return {config:c,result};
}
