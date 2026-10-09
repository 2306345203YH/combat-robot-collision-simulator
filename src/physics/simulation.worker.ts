/// <reference lib="webworker" />
import type { Experiment } from '../types';
import { simulate } from './simulation';

type WorkerMessage = { type: 'run'; config: Experiment };

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  if (!event.data || event.data.type !== 'run') return;
  try {
    const result = await simulate(event.data.config, (progress) => self.postMessage({ type: 'progress', progress }));
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : '物理计算失败。' });
  }
};
