import type { Experiment, SimulationResult } from './types';
import { normalizeExperiment } from './defaults';
export interface SavedExperiment { id:string;name:string;updatedAt:string;config:Experiment;result:SimulationResult|null }
// randomUUID is limited to secure contexts; LAN HTTP still supports getRandomValues.
export function createExperimentId():string {
    if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
    const bytes=globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6]=(bytes[6]&0x0f)|0x40;
    bytes[8]=(bytes[8]&0x3f)|0x80;
    const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function database(){return new Promise<IDBDatabase>((resolve,reject)=>{const req=indexedDB.open('robot-collision-lab',1);req.onupgradeneeded=()=>req.result.createObjectStore('experiments',{keyPath:'id'});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
export async function saveExperiment(item:SavedExperiment){const db=await database();return new Promise<void>((resolve,reject)=>{const tx=db.transaction('experiments','readwrite');tx.objectStore('experiments').put(item);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>{db.close();reject(tx.error)}})}
export async function loadExperiments(){const db=await database();return new Promise<SavedExperiment[]>((resolve,reject)=>{const req=db.transaction('experiments').objectStore('experiments').getAll();req.onsuccess=()=>{db.close();resolve((req.result as SavedExperiment[]).map(item=>({...item,config:normalizeExperiment(item.config)})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)))};req.onerror=()=>{db.close();reject(req.error)}})}
export async function removeExperiment(id:string){const db=await database();return new Promise<void>((resolve,reject)=>{const tx=db.transaction('experiments','readwrite');tx.objectStore('experiments').delete(id);tx.oncomplete=()=>{db.close();resolve()};tx.onerror=()=>{db.close();reject(tx.error)}})}
