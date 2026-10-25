import loaderUrl from 'occt-import-js/dist/occt-import-js.js?url';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import workerSource from './step-worker.js?raw';
import { convertOcct, type OcctResult } from '../assembly/mesh';
import type { AssemblyTarget } from '../assembly/types';

export const MAX_STEP_BYTES=120*1024*1024;
export interface StepOptions {tolerance:number;onProgress?:(message:string)=>void;signal?:AbortSignal}
export function importStepRaw(file:File,options:StepOptions):Promise<OcctResult>{
  return new Promise(async(resolve,reject)=>{
    if(file.size>MAX_STEP_BYTES){reject(new Error('STEP 文件超过 120 MB，请先精简装配。'));return;}
    let worker:Worker|undefined,blobUrl:string|undefined,settled=false;
    const finish=(error?:unknown,value?:OcctResult)=>{if(settled)return;settled=true;worker?.terminate();if(blobUrl)URL.revokeObjectURL(blobUrl);options.signal?.removeEventListener('abort',abort);error?reject(error):resolve(value!)};
    const abort=()=>finish(new Error('已取消 STEP 导入。'));
    options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted){abort();return;}
    try{
      const buffer=await file.arrayBuffer();if(settled)return;
      blobUrl=URL.createObjectURL(new Blob([workerSource],{type:'text/javascript'}));worker=new Worker(blobUrl);
      worker.onmessage=({data})=>{if(data.type==='progress')options.onProgress?.(data.message);else if(data.type==='error')finish(new Error(data.message));else if(data.type==='result')finish(undefined,data.result as OcctResult)};
      worker.onerror=e=>finish(new Error(e.message||'STEP 几何内核启动失败。'));
      worker.postMessage({buffer,loaderUrl:new URL(loaderUrl,location.href).href,wasmUrl:new URL(wasmUrl,location.href).href,tolerance:options.tolerance},[buffer]);
    }catch(error){finish(error)}
  });
}
export async function importStep(file:File,options:StepOptions&{upAxis:'y'|'z'|'auto'}):Promise<AssemblyTarget>{
 const raw=await importStepRaw(file,options);options.onProgress?.('正在整理零件、尺寸与体积…');return convertOcct(raw,file.name,options.upAxis,options.tolerance);
}
