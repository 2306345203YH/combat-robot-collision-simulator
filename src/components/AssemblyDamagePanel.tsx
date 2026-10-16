import type { Experiment,Frame,SimulationResult } from '../types';
import { downloadBlob } from '../exports';
const labels={elastic:'弹性响应',dented:'凹陷估算',fractured:'材料断裂估算',detached:'连接脱落估算'};
export default function AssemblyDamagePanel({config,frame,result,onSeek}:{config:Experiment;frame?:Frame;result:SimulationResult|null;onSeek:(t:number)=>void}){
  if(config.mode!=='weapon-assembly')return null;
  const current=Object.values(frame?.assembly?.damage??{}),parts=new Map(config.assembly?.parts.map(p=>[p.id,p])??[]);
  const csv=()=>{
    const q=(v:unknown)=>'"'+String(v).replaceAll('"','""')+'"';
    const header=['部件','材料','状态','接触耗散能_J','塑性功_J','局部应力估算_MPa','凹陷深度_mm','断裂指标','时刻_s'];
    const rows=(result?.damage??[]).map(d=>{const p=parts.get(d.partId);return [p?.name,p?.material.name,labels[d.kind],d.energy,d.plasticWork,d.peakStress/1e6,d.dentDepth*1000,d.damage,d.time].map(q).join(',')});
    downloadBlob('装配部件损伤估算.csv','\uFEFF'+[header.map(q).join(','),...rows].join('\n'),'text/csv;charset=utf-8');
  };
  return <section className="assembly-damage-results" aria-label="装配部件损伤估算"><div className="panel-heading"><div><h3>部件材料与可能破损</h3><p className="field-note">与回放同步 · 局部能量模型 · 未经实测标定</p></div><button className="button" disabled={!result?.damage?.length} onClick={csv}>导出逐件损伤 CSV</button></div><p className="field-note">接触耗散功 W ≈ ½J(u前 + u后)；弹性容量 Uᵧ = σᵧ²V/(2E)；塑性凹陷 δ ≈ W塑/(σ流A)。当塑性功达到延性耗能与断裂能预算时，用简化平面裁切真实网格并释放碎片。达到连接失效冲量时整件脱落。两者都不是精确裂纹路径预测。</p>
    {current.length?<div className="table-scroll"><table><thead><tr><th>部件 / 材料</th><th>当前响应</th><th>接触耗散能</th><th>局部应力估算</th><th>凹陷估算</th><th>断裂指标</th><th>时刻</th></tr></thead><tbody>{current.map(d=><tr key={d.partId} className="clickable" onClick={()=>onSeek(d.time)}><td>{parts.get(d.partId)?.name??d.partId}<small style={{display:'block'}}>{parts.get(d.partId)?.material.name}</small></td><td><span className="damage-badge">{labels[d.kind]}</span></td><td>{d.energy.toFixed(4)} J</td><td>{(d.peakStress/1e6).toFixed(2)} MPa</td><td>{(d.dentDepth*1000).toFixed(3)} mm</td><td>{(d.damage*100).toFixed(1)}%</td><td>{d.time.toFixed(4)} s</td></tr>)}</tbody></table></div>:<p className="field-note">{result?'当前回放时刻尚无启用损伤估算的部件接触。':'先导入车体、核对逐件材料与连接参数，然后开始碰撞。'}关闭损伤时仅计算装配刚体响应。</p>}
    <p className="warning-note">网格凹陷用于呈现上述局部估算；未断裂部件的接触仍使用凸包近似，不能精确模拟凹坑咬合。断裂后的碎片和脱落部件进入独立刚体接触。未模拟螺纹、真实连接刚度、应变率与内部应力场。</p></section>;
}
