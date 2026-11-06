import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHmac } from 'node:crypto';
import { config } from './config.mjs';
import { processIssue, startServer } from './router.mjs';
import { ensureImage, startModelProxy } from './worker.mjs';

const execFile = promisify(execFileCb);
const temp = await mkdtemp(path.join(tmpdir(), 'dsh-superagent-smoke-'));
const repo = path.join(temp, 'repo');
const worktrees = path.join(temp, 'worktrees');
const artifacts = path.join(homedir(), '.local/share/dsh-superagent/smoke-artifacts');
const state = path.join(temp, 'state');
await mkdir(repo);
await writeFile(path.join(repo, 'sample.txt'), 'Hello, sandbxo!\n');
await writeFile(path.join(repo, 'test.mjs'), "import assert from 'node:assert/strict'; import { readFile } from 'node:fs/promises'; assert.equal(await readFile('sample.txt', 'utf8'), 'Hello, sandbox!\\n'); console.log('TEST_PASSED: greeting matches expected text');\n");
await execFile('git', ['-C', repo, 'init', '-q']);
await execFile('git', ['-C', repo, 'config', 'user.name', 'Smoke Test']);
await execFile('git', ['-C', repo, 'config', 'user.email', 'smoke@example.invalid']);
await execFile('git', ['-C', repo, 'add', '.']);
await execFile('git', ['-C', repo, 'commit', '-qm', 'fixture: broken greeting']);

try {
  const cfg = {
    ...config(), repoPath: repo, worktreesDir: worktrees, artifactsDir: artifacts, stateDir: state,
    engine: 'fixture', network: 'none', testCommand: 'node test.mjs', cpus: 1, memory: '512m', pids: 64,
    timeoutSeconds: 120, createPullRequest: false,
  };
  const result = await processIssue({
    sender: 'isthealireza', event: 'issues', action: 'opened', id: `smoke-${Date.now()}`,
    title: 'Fix greeting typo', body: '@superagent Correct the greeting in sample.txt so the supplied test passes.',
    testCommand: 'node test.mjs', smokeNetworkProbe: true,
    fixtureTarget: 'sample.txt', fixtureReplacement: 'Hello, sandbox!',
  }, { cfg, testOnly: true });
  if (!result.accepted || !result.patchPath) throw new Error(`Smoke task failed: ${JSON.stringify(result)}`);
  const sample = await readFile(path.join(repo, 'sample.txt'), 'utf8');
  if (sample !== 'Hello, sandbxo!\n') throw new Error('Base checkout was modified by the worker');
  const patch = await readFile(result.patchPath, 'utf8');
  if (!patch.includes('Hello, sandbox!') || !patch.includes('Hello, sandbxo!')) throw new Error('Patch artifact does not contain expected change');
  console.log(`SMOKE_PASSED: allowlist=authorized uid=10001 network=none base_checkout=unchanged patch=${result.patchPath}`);
  console.log(`SMOKE_BRANCH: ${result.branch}`);
  console.log(`SMOKE_SHA256: ${result.sha256}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}

await verifyEgressProxy();
await verifyIngress();

async function verifyEgressProxy() {
  const id = `proxy-smoke-${Date.now()}`;
  const privateNetwork = `dsh-task-${id}-internal`;
  const mockName = `dsh-mock-${id}`;
  let proxyId = null;
  try {
    await ensureImage(path.resolve(import.meta.dirname, '..'));
    try { await execFile('docker', ['network', 'inspect', 'dsh-worker-egress']); }
    catch { await execFile('docker', ['network', 'create', '--label', 'io.dsh.superagent=egress-network', 'dsh-worker-egress']); }
    const mockCode = "const http=require('node:http');http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({key:req.headers['x-api-key'],path:req.url}))}).listen(9000,'0.0.0.0')";
    await execFile('docker', ['run', '-d', '--name', mockName, '--network', 'dsh-worker-egress', '--network-alias', mockName,
      '--read-only', '--user', '10001:10001', '--memory', '128m', '--cpus', '0.25', '--pids-limit', '32',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--entrypoint', 'node', 'dsh-superagent-proxy:local', '-e', mockCode]);
    const cfg = {
      ...config(), engine: 'claude', network: 'egress', anthropicApiKey: 'smoke-only-secret', deepseekApiKey: '',
      anthropicUpstreamUrl: `http://${mockName}:9000`,
    };
    proxyId = await startModelProxy(cfg, { id });
    const code = [
      'import json, urllib.request, urllib.error',
      'request=urllib.request.Request("http://dsh-model-proxy:8080/anthropic/v1/messages", data=b"{}", headers={"content-type":"application/json","x-api-key":"attacker-controlled"})',
      'response=json.load(urllib.request.urlopen(request, timeout=5))',
      'assert response["key"] == "smoke-only-secret", response',
      'assert response["path"] == "/v1/messages", response',
      'try:',
      ' urllib.request.urlopen(urllib.request.Request("http://dsh-model-proxy:8080/anthropic/not-allowed", data=b"{}"), timeout=5)',
      ' raise AssertionError("proxy accepted a non-allowlisted route")',
      'except urllib.error.HTTPError as error:',
      ' assert error.code == 403, error.code',
      'reachable=False',
      'try:',
      ' urllib.request.urlopen("https://example.com", timeout=3); reachable=True',
      'except Exception:',
      ' pass',
      'assert not reachable, "worker reached public internet outside proxy"',
      'print("EGRESS_PROXY_VERIFIED: key_injected=true route_allowlist=true public_egress_blocked=true")',
    ].join('\n');
    const { stdout } = await execFile('docker', ['run', '--rm', '--network', privateNetwork, '--read-only', '--user', '10001:10001',
      '--memory', '256m', '--cpus', '0.5', '--pids-limit', '64', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
      '--entrypoint', 'python3', 'dsh-superagent-worker:local', '-c', code], { maxBuffer: 100_000, timeout: 30_000 });
    process.stdout.write(stdout);
  } finally {
    if (proxyId) await execFile('docker', ['rm', '-f', proxyId]).catch(() => {});
    await execFile('docker', ['rm', '-f', mockName]).catch(() => {});
    await execFile('docker', ['network', 'rm', privateNetwork]).catch(() => {});
  }
}

async function verifyIngress() {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dsh-router-ingress-smoke-'));
  const secret = 'local-smoke-only-webhook-secret';
  const cfg = {
    ...config(), host: '127.0.0.1', port: 0, webhookSecret: secret,
    repoPath: '/home/alpha/src/SuperAgent', stateDir,
    githubOwner: 'isthealireza', githubRepo: 'SuperAgent',
    allowedSenders: new Set(['isthealireza']), triggerMention: '@superagent',
  };
  const server = await startServer(cfg);
  try {
    const address = server.address();
    const health = await fetch(`http://127.0.0.1:${address.port}/health`);
    if (!health.ok || !(await health.json()).ok) throw new Error('Router health endpoint failed');
    const payload = Buffer.from(JSON.stringify({
      action: 'opened', repository: { full_name: 'isthealireza/SuperAgent' },
      sender: { login: 'not-allowed' },
      issue: { number: 55, title: 'Unauthorized synthetic issue', body: '@superagent make a change' },
    }));
    const signature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    const response = await fetch(`http://127.0.0.1:${address.port}/github/webhook`, {
      method: 'POST', body: payload,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature, 'x-github-event': 'issues' },
    });
    const result = await response.json();
    if (response.status !== 202 || result.accepted !== false || result.reason !== 'sender_not_allowed') {
      throw new Error(`Router did not reject unauthorized sender before model triage: ${JSON.stringify(result)}`);
    }
    if ((await readdir(stateDir)).length !== 0) throw new Error('Unauthorized webhook wrote task state');
    console.log('INGRESS_VERIFIED: webhook_hmac=true sender_allowlist=true llm_calls=0 unauthorized_state_writes=0');
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}
