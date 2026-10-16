import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], test:{include:['src/**/*.test.{ts,tsx}']}, server: { host: '0.0.0.0', port: 5173, strictPort: true }, preview: { host: '0.0.0.0', port: 5173, strictPort: true }, build: { chunkSizeWarningLimit: 1800 } });
