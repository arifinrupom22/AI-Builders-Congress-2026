import { fileURLToPath } from 'node:url';
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
/** API port the dev proxy talks to: mirrors the server's own validation. */
const configuredPort = Number(process.env.PORT);
const apiPort = Number.isInteger(configuredPort) && configuredPort >= 1 && configuredPort <= 65535 ? configuredPort : 8787;

export default defineConfig(({ command }) => {
  /**
   * The published bundle must always be a production bundle.
   *
   * `NODE_ENV` must therefore NOT be set in the root `.env`: Vite 8 reads that
   * file (see `envDir`), exports its `NODE_ENV` as `VITE_USER_NODE_ENV`, and
   * forces `process.env.NODE_ENV` back to `development` *after* this function
   * returns - so a production build silently emitted React's development build
   * (586 kB vendor chunk instead of 379 kB, plus slower rendering). The
   * assignment below cannot win against that, and pinning it with `define`
   * alone produced a production React with development JSX, which crashed with
   * `jsxDEV is not a function`. The template and the local `.env` therefore
   * leave `NODE_ENV` to the process environment (Render sets `production` for
   * the deploy; unset means Vite's production default for a build).
   *
   * Only affects builds - the dev server still runs with React's development
   * build and its warnings.
   */
  if (command === 'build') process.env.NODE_ENV = 'production';

  return {
    plugins: [react()],
    /**
     * Read `.env` from the repository root, which is where the server reads it
     * and where `.env.example` documents it. Vite defaults to `web/`, so the
     * `VITE_FIREBASE_*` web config described in the README was never seen and a
     * build silently shipped without Firebase. Only `VITE_`-prefixed values are
     * inlined, so the server-only keys stay out of the bundle.
     */
    envDir: fileURLToPath(new URL('..', import.meta.url)),
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
          // `PORT || 8787` is not enough: a shell (or a .env file loader) that
          // exports PORT=0 makes it truthy, so the proxy would target port 0 and
          // turn every request into a 502 while the API was healthy on 8787.
          // The API itself rejects 0 and falls back to 8787, so the proxy must
          // agree with it.
          target: process.env.VITE_API_TARGET || `http://localhost:${apiPort}`,
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
