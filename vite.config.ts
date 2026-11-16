import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file build: dist/index.html contains everything, works from file://
export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile()],
  build: {
    target: 'es2020',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4000,
  },
  server: { host: '127.0.0.1' },
  // `default` reporter 在非交互终端下不退出（本机实测 600s 仍在等待），
  // CI 与本地都必须能拿到退出码，因此固定为 basic。
  test: {
    reporters: ['basic'],
    include: ['tests/**/*.test.ts'],
  },
});
