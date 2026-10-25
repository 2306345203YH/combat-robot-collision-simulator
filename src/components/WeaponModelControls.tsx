import { useEffect,useRef,useState } from 'react';
import { Upload,X } from 'lucide-react';
import type { WeaponConfig } from '../types';
import { importWeaponModel } from '../importers/weaponModel';
import { NumberField,SelectField } from './ParameterPanel';

export default function WeaponModelControls({side,weapon,onChange}:{side:'A'|'B';weapon:WeaponConfig;onChange:(patch:Partial<WeaponConfig>)=>void}){
 const [unit,setUnit]=useState<'mm'|'cm'|'m'|'inch'>('mm'),[spinAxis,setSpinAxis]=useState<'x'|'y'|'z'>('z'),[busy,setBusy]=useState(false),[progress,setProgress]=useState(''),[error,setError]=useState('');
 const input=useRef<HTMLInputElement>(null),controller=useRef<AbortController|null>(null),latestChange=useRef(onChange);latestChange.current=onChange;
 useEffect(()=>()=>controller.current?.abort(),[]);
 const model=weapon.shape==='mesh'?weapon.model:undefined;
 async function load(file:File){const job=new AbortController();controller.current?.abort();controller.current=job;setError('');setBusy(true);setProgress('准备导入模型…');
  try{const imported=await importWeaponModel(file,{unit:model?.format==='stl'?model.sourceUnit:unit,spinAxis:model?.spinAxis??spinAxis,signal:job.signal,onProgress:setProgress});if(job.signal.aborted)return;latestChange.current({shape:'mesh',model:imported,name:file.name,axisOffset:[0,0],drawing:undefined});setProgress('实体导入完成，几何已锁定。');}
  catch(e){if(!job.signal.aborted)setError((e as Error).message)}finally{if(controller.current===job){setBusy(false);controller.current=null;}}
 }
 return <div className="weapon-model-card">
  <p className="section-kicker">STEP / STL 实体武器</p>
  {!model&&<div className="field-pair"><SelectField label="STL 文件单位" value={unit} onChange={v=>setUnit(v as typeof unit)}><option value="mm">毫米 mm</option><option value="cm">厘米 cm</option><option value="m">米 m</option><option value="inch">英寸 inch</option></SelectField><SelectField label="模型中的旋转轴" value={spinAxis} onChange={v=>setSpinAxis(v as typeof spinAxis)}><option value="z">源 Z 轴</option><option value="y">源 Y 轴</option><option value="x">源 X 轴</option></SelectField></div>}
  <input ref={input} type="file" hidden aria-label={`${side}方实体武器文件`} accept=".step,.stp,.stl" onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void load(f)}}/>
  <button type="button" className="button" disabled={busy} onClick={()=>input.current?.click()}><Upload size={14}/>{model?'替换 STEP / STL 模型':'导入 STEP 单零件 / STL'}</button>
  {busy&&<button type="button" className="text-button" onClick={()=>{controller.current?.abort();setProgress('已取消导入，保留原武器。')}}><X size={14}/>取消模型导入</button>}
  <p className="field-note" role="status" aria-live="polite">{busy?progress:model?`${model.filename} · ${model.indices.length/3} 三角面`:'STEP 使用文件内单位；STL 无单位，导入前请核对。上限 120 MB。'}</p>
  {error&&<p className="model-import-error" role="alert">{error}</p>}
  {model&&<>
   <p className="field-note">源模型尺寸 {model.size.map(v=>(v*1000).toFixed(2)).join(' × ')} mm。外形、尺寸和厚度锁定；仅转轴与材料可编辑，转速与整车参数仍用于设置碰撞工况。</p>
   <SelectField label="实体武器旋转轴" value={model.spinAxis} onChange={v=>onChange({model:{...model,spinAxis:v as typeof model.spinAxis}})}><option value="z">源 Z 轴</option><option value="y">源 Y 轴</option><option value="x">源 X 轴</option></SelectField>
   <p className="field-note">下方轴心坐标以源模型包围盒中心为原点，沿源 X/Y/Z 方向，单位 mm。轴向改变后会自动对准场景旋转轴。</p>
   <div className="field-pair">{(['X','Y','Z'] as const).map((axis,k)=><NumberField key={axis} label={`模型轴心 ${axis}`} value={model.axisPoint[k]} onChange={v=>onChange({model:{...model,axisPoint:model.axisPoint.map((n,j)=>j===k?v:n) as [number,number,number]}})} scale={1000} unit="mm" step={.1}/>)}</div>
   <button className="text-button" onClick={()=>onChange({model:{...model,axisPoint:[0,0,0]}})}>轴心回到模型中心</button>
   <details className="advanced"><summary>导入与接触假设</summary>{model.warnings.map(w=><p className="field-note" key={w}>{w}</p>)}<p className="field-note">下次 STL 替换按 {model.format==='stl'?model.sourceUnit:unit} 单位导入；需更改导入单位时先切回轮廓武器。</p></details>
   <button type="button" className="text-button" onClick={()=>onChange({shape:'disk',model:undefined})}>切回轮廓武器</button>
  </>}
 </div>;
}
