// A classic worker is required by the Emscripten browser distribution.
self.onmessage=async({data})=>{
  try{
    self.postMessage({type:'progress',message:'正在加载本地 STEP 几何内核…'});
    importScripts(data.loaderUrl);
    const occt=await self.occtimportjs({locateFile:()=>data.wasmUrl});
    self.postMessage({type:'progress',message:'正在读取实体与装配层级，大文件可能需要一分钟…'});
    const result=occt.ReadStepFile(new Uint8Array(data.buffer),{linearUnit:'meter',linearDeflectionType:'absolute_value',linearDeflection:data.tolerance,angularDeflection:.35});
    if(!result.success)throw new Error('STEP 内核未能读取实体，请检查文件是否完整。');
    self.postMessage({type:'result',result});
  }catch(error){self.postMessage({type:'error',message:error instanceof Error?error.message:String(error)})}
};
