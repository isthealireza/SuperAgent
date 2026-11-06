import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { registerGitHubWebhook } from './github.mjs';

const cfg = config();
const stateFile = path.join(cfg.stateDir, 'github-webhook-id');
const healthUrl = new URL('/health', cfg.publicWebhookUrl);
let ready = false;
for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
    if (response.ok) { ready = true; break; }
  } catch {}
  await new Promise(resolve => setTimeout(resolve, 2_000));
}
if (!ready) throw new Error('The public webhook URL did not reach the router health endpoint');
await mkdir(cfg.stateDir, { recursive: true, mode: 0o700 });
const result = await registerGitHubWebhook(cfg, { stateFile });
console.log(`GITHUB_WEBHOOK_REGISTERED id=${result.id} url=${result.url} events=${result.events.join(',')}`);
