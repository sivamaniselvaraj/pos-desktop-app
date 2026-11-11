import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Renderer lives in src/renderer. Output goes to dist/renderer.
// base './' is required so file:// loading works in the packaged app.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Without this the group would also pull in React (a dependency of
          // Recharts) and the start-up chunk would then load the whole group.
          includeDependenciesRecursively: false,
          groups: [
            {
              // Recharts and the libraries only it uses go in one "charts" chunk,
              // loaded with the Sales report and kept out of the page's own
              // chunk. React stays in the main chunk (the test leaves it out).
              name: 'charts',
              test: /node_modules[\\/](recharts|victory-vendor|d3-[a-z-]+|internmap|@reduxjs[\\/]toolkit|redux|react-redux|reselect|immer|es-toolkit|decimal\.js-light|eventemitter3|tiny-invariant|clsx|use-sync-external-store)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
