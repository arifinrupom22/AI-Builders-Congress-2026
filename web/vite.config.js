import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * LearnSphere AI — frontend dev/build config.
 *
 * IMPORTANT: only `/api` is proxied to the Express backend. Proxying `/` would
 * hand the dev server's own module and asset requests to the backend, so the
 * page would render the API's 404/HTML instead of the app (and a 502 whenever
 * the backend is not running).
 */
export default defineConfig(({ command }) => {
  /**
   * The published bundle is always a production bundle, but a hosting
   * environment can export `NODE_ENV=development` and Vite honours it: the
   * Netlify build did, and `vite build` then emitted React's *development*
   * build - measured at 425.72 kB for the vendor chunk against 218.81 kB for
   * the same code built for production, plus slower rendering at runtime.
   * Pinning it here rather than in the host's settings keeps `npm run build`
   * correct on any machine, and only affects builds - the dev server still runs
   * with React's development build and its warnings.
   */
  if (command === 'build') process.env.NODE_ENV = 'production';

  return {
    plugins: [react()],
    build: {
      sourcemap: true,
      rollupOptions: {
        output: {
          // Split the framework out of the app code so a first visit does not
          // download everything in one chunk.
          manualChunks(id) {
            if (id.includes('node_modules')) return 'vendor';
            return undefined;
          },
        },
      },
    },
    server: {
      port: Number(process.env.VITE_PORT) || 5173,
      strictPort: false,
      // Bind every interface instead of only the first address `localhost`
      // resolves to. Node resolves `localhost` to ::1 first on Windows, so the
      // default leaves http://127.0.0.1:5173 refused - which breaks any tool or
      // bookmark that spells the loopback address out. `host: true` makes
      // localhost, 127.0.0.1 and [::1] all answer.
      //
      // Trade-off: the dev server is then reachable from the local network. The
      // Express API already binds 0.0.0.0, and its CORS guard refuses non-loopback
      // browser origins, so this does not add a new API surface. Set
      // VITE_HOST=127.0.0.1 to restrict it to IPv4 loopback again.
      host: process.env.VITE_HOST === '127.0.0.1' ? '127.0.0.1' : true,
      proxy: {
        '/api': {
          target: process.env.VITE_API_TARGET || `http://localhost:${process.env.PORT || 8787}`,
          changeOrigin: false,
        },
      },
    },
    preview: {
      port: 4173,
      strictPort: true,
    },
  };
});
