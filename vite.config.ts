import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { localCollectorPlugin } from './server/http-plugin';

export default defineConfig({
  plugins: [react(), localCollectorPlugin()],
  build: { target: 'es2022' },
  server: { watch: { ignored: ['**/.local/**', '**/public/data/live-heat.json*'] } },
});
