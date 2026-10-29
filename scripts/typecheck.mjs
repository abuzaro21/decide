// Shell-independent typecheck of server/tests and UI (npm script shells differ: cmd, sh, PowerShell 5.1).
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
for (const args of [['--noEmit'], ['-p', 'ui', '--noEmit']]) {
  const r = spawnSync(process.execPath, [tsc, ...args], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
