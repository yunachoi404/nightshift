import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import type { EngineHandle, EngineOptions } from './types.js';

let engine: EngineHandle | undefined;
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await engine?.stop();
  process.exit(0);
}
process.parentPort.on('message', event => {
  if (event.data?.type === 'stop') void stop();
});
process.on('SIGTERM', () => void stop());

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Port allocation failed');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function main(): Promise<void> {
try {
  const options = JSON.parse(process.argv[2] ?? '{}') as Omit<EngineOptions, 'port'> & { entry: string; preferredPort?: number };
  const entry = await import(pathToFileURL(options.entry).href) as {
    startEngine(options: EngineOptions): Promise<EngineHandle>;
  };
  // Retry the small bind race between probing a port and handing it to the engine.
  for (let attempt = 0; attempt < 5; attempt++) {
    try { engine = await entry.startEngine({ ...options, log: () => {}, port: attempt === 0 && options.preferredPort ? options.preferredPort : await freePort() }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt === 4) throw error;
    }
  }
  if (!engine) throw new Error('Engine did not start');
  const address = new URL(engine.url);
  if (address.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) throw new Error('Engine must bind loopback HTTP');
  process.parentPort.postMessage({ type: 'ready', url: address.origin });
} catch {
  // Engine errors can contain request headers or paths. Do not relay raw exceptions.
  process.parentPort.postMessage({ type: 'failed' });
  process.exit(1);
}

}
void main();
