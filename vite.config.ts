import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { localCollectorPlugin } from './server/http-plugin';
import { publicAssetsPlugin } from './tools/publicAssets';

export default defineConfig(({ command }) => ({
  plugins: [react(), localCollectorPlugin(), publicAssetsPlugin()],
  publicDir: command === 'build' ? false : 'public',
  build: { target: 'es2022' },
  server: { watch: { ignored: ['**/.local/**', '**/public/data/live-heat.json*'] } },
}));
