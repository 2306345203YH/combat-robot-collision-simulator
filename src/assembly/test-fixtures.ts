import type { OcctResult } from './mesh';
export const cubeVertices=[-.01,-.01,-.01,.01,-.01,-.01,.01,.01,-.01,-.01,.01,-.01,-.01,-.01,.01,.01,-.01,.01,.01,.01,.01,-.01,.01,.01];
export const cubeIndices=[0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5];
export function cubeOcct():OcctResult{return {success:true,root:{name:'机器人',meshes:[],children:[{name:'底盘',meshes:[0],children:[]}]},meshes:[{name:'侧板',attributes:{position:{array:[...cubeVertices]}},index:{array:[...cubeIndices]}}]}}
