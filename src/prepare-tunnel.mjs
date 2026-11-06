import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { config } from './config.mjs';

const cfg = config();
const token = process.env.CLOUDFLARED_TUNNEL_TOKEN;
if (!token || !cfg.githubToken || !cfg.publicWebhookUrl) {
  throw new Error('Named tunnel startup requires CLOUDFLARED_TUNNEL_TOKEN, GITHUB_TOKEN, and PUBLIC_WEBHOOK_URL');
}
const publicUrl = new URL(cfg.publicWebhookUrl);
if (publicUrl.protocol !== 'https:' || publicUrl.hostname.endsWith('.example') || !publicUrl.pathname.endsWith('/github/webhook')) {
  throw new Error('Set PUBLIC_WEBHOOK_URL to the real Cloudflare hostname ending in /github/webhook');
}
const tokenPath = `${cfg.stateDir}/cloudflare-tunnel-token`;
await mkdir(cfg.stateDir, { recursive: true, mode: 0o700 });
await writeFile(tokenPath, `${token.trim()}\n`, { mode: 0o600 });
await chmod(tokenPath, 0o600);
console.log('CLOUDFLARE_TUNNEL_TOKEN_READY: protected_file=true');
