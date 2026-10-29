// Process entry point. A new runId per boot: data from a previous run is never served (ephemeral-host semantics).
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server.ts';
import { EVALUATOR_VERSION } from './world.ts';

const dbPath = process.env.DECIDE_DB ?? join(fileURLToPath(new URL('../data/', import.meta.url)), 'decide.db');
mkdirSync(dirname(dbPath), { recursive: true });
const app = createApp({ dbPath });
const port = Number(process.env.PORT ?? 3000);
app.server.listen(port, () => console.log(`DECIDE listening on :${port} run=${app.runId} evaluator=${EVALUATOR_VERSION}`));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { app.server.close(); app.close(); process.exit(0); });
