import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = new Set();
const requestedApiPort = Number.parseInt(process.env.PORT ?? '8787', 10);
const requestedWebPort = Number.parseInt(process.env.VITE_PORT ?? '5173', 10);
let stopping = false;
let webStarted = false;

function canBind(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    // Match Node's default app.listen binding. Probing only IPv4 can miss a
    // listener bound to IPv6 localhost/wildcard that still blocks this bind.
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

async function availablePort(start) {
  for (let port = start; port <= 65535; port += 1) {
    if (await canBind(port)) return port;
  }
  throw new Error(`No free port is available starting at ${start}.`);
}

function stop(signal = 'SIGINT', exitCode = 0) {
  if (stopping) return;
  stopping = true;
  // Windows sends Ctrl+C to processes attached to this console. Sending a
  // second SIGINT can interrupt unrelated console processes, so let child
  // Node processes handle the original event there.
  if (process.platform !== 'win32') {
    for (const child of children) child.kill(signal);
  }

  const deadline = setTimeout(() => {
    for (const child of children) child.kill('SIGTERM');
    process.exit(exitCode);
  }, 3000);
  deadline.unref();
  Promise.all([...children].map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
  }))).then(() => {
    clearTimeout(deadline);
    process.exit(exitCode);
  });
}

function launch(name, args, cwd, env, onLine = () => {}) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['inherit', 'pipe', 'pipe'] });
  children.add(child);
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      console.log(`[${name}] ${line}`);
      onLine(line);
    });
  }
  child.once('error', (error) => {
    console.error(`[${name}] Could not start: ${error.message}`);
    stop('SIGTERM', 1);
  });
  return child;
}

function launchWeb(apiPort) {
  if (webStarted || stopping) return;
  webStarted = true;
  const child = launch(
    'web',
    [path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js')],
    path.join(projectRoot, 'web'),
    {
      ...process.env,
      VITE_PORT: String(Number.isInteger(requestedWebPort) ? requestedWebPort : 5173),
      VITE_API_TARGET: `http://localhost:${apiPort}`,
    },
    (line) => {
      if (line.includes('error when starting dev server')) stop('SIGTERM', 1);
    },
  );
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (stopping) return;
    const result = code ?? (signal ? 1 : 0);
    if (result !== 0) console.error(`[web] exited with code ${result}${signal ? ` (${signal})` : ''}.`);
    stop('SIGTERM', result);
  });
}

async function launchBackend(startPort) {
  if (stopping) return;
  const port = await availablePort(startPort);
  if (port !== startPort) console.log(`[dev] Port ${startPort} is busy; checking ${port}.`);

  let ready = false;
  let portConflict = false;
  const child = launch(
    'server',
    ['src/index.js'],
    path.join(projectRoot, 'server'),
    { ...process.env, PORT: String(port) },
    (line) => {
      if (line.includes('"msg":"port already in use"') || line.includes('EADDRINUSE')) {
        portConflict = true;
      }
      if (!ready && line.includes('"msg":"LearnSphere AI server listening"')) {
        ready = true;
        console.log(`[dev] Backend ready at http://localhost:${port}/`);
        launchWeb(port);
      }
    },
  );

  child.once('exit', (code, signal) => {
    children.delete(child);
    if (stopping) return;
    if (!ready && portConflict && port < 65535) {
      console.log(`[dev] Backend port ${port} became busy during startup; retrying.`);
      void launchBackend(port + 1);
      return;
    }
    const result = code ?? (signal ? 1 : 0);
    if (result !== 0) console.error(`[server] exited with code ${result}${signal ? ` (${signal})` : ''}.`);
    stop('SIGTERM', result);
  });
}

process.once('SIGINT', () => stop('SIGINT', 0));
process.once('SIGTERM', () => stop('SIGTERM', 0));

const firstApiPort = Number.isInteger(requestedApiPort) ? requestedApiPort : 8787;
console.log(`[dev] Starting backend from port ${firstApiPort}.`);
void launchBackend(firstApiPort).catch((error) => {
  console.error(`[dev] ${error.message}`);
  stop('SIGTERM', 1);
});
