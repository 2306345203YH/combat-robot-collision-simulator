import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExperimentId } from './storage';

describe('experiment IDs on deployed origins',()=>{
    afterEach(()=>vi.unstubAllGlobals());
    it('uses the browser UUID API when available',()=>{
        const id='78e953d8-c3fc-45d7-b7d2-fbd301cc6a62';
        vi.stubGlobal('crypto',{randomUUID:()=>id});
        expect(createExperimentId()).toBe(id);
    });
    it('creates distinct valid UUIDs when LAN HTTP has no randomUUID',()=>{
        const getRandomValues=globalThis.crypto.getRandomValues.bind(globalThis.crypto);
        vi.stubGlobal('crypto',{getRandomValues});
        const ids=Array.from({length:100},()=>createExperimentId());
        expect(new Set(ids).size).toBe(100);
        for(const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
});
