import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
const env = { ...process.env };
// Some terminals set this for their own runtime. The app needs full Electron.
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.', ...process.argv.slice(2)], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit', env });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
