import { defineConfig } from 'vite';

// base './' — чтобы ассеты грузились на под-пути GitHub Pages (/3D-shooter-game/)
export default defineConfig({
  base: './',
  build: { target: 'es2020', outDir: 'dist' },
});
