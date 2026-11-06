import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.mjs';
import { gate, verifySignature } from './security.mjs';
import { triage } from './triage.mjs';
import { ensureImage, runWorker } from './worker.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const execFile = promisify(execFileCb);
const rates = new Map();
const queue = [];
let draining = false;

async function persist(cfg, task) {
  await mkdir(cfg.stateDir, { recursive: true });
  await writeFile(path.join(cfg.stateDir, `${task.id}.json`), `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
}

async function findTicket(cfg, issueNumber) {
  if (!Number.isSafeInteger(issueNumber)) return null;
  try { return JSON.parse(await readFile(path.join(cfg.stateDir, `ticket-${issueNumber}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function createTicket(cfg, issueNumber, taskId) {
  const createdAt = Date.now();
  const ticket = {
    id: Number.isSafeInteger(issueNumber) ? `issue-${issueNumber}-${createdAt}` : taskId,
    issueNumber: Number.isSafeInteger(issueNumber) ? issueNumber : null,
    branch: Number.isSafeInteger(issueNumber) ? `agent/task-${issueNumber}-${createdAt}` : null,
    sessionId: Number.isSafeInteger(issueNumber) ? `dsh-issue-${issueNumber}` : `dsh-${taskId}`,
    createdAt: new Date(createdAt).toISOString(),
    status: 'active',
  };
  if (Number.isSafeInteger(issueNumber)) {
    await writeFile(path.join(cfg.stateDir, `ticket-${issueNumber}.json`), `${JSON.stringify(ticket, null, 2)}\n`, { mode: 0o600 });
  }
  return ticket;
}

function rateAllowed(cfg, sender) {
  const now = Date.now();
  const values = (rates.get(sender) ?? []).filter(time => now - time < 60_000);
  if (values.length >= cfg.ratePerMinute) return false;
  values.push(now);
  rates.set(sender, values);
  return true;
}

export async function processIssue(input, { cfg = config(), testOnly = false, skipRateLimit = false } = {}) {
  const result = gate({ ...input, allowlist: cfg.allowedSenders, mention: cfg.triggerMention });
  if (!result.ok) return { accepted: false, reason: result.reason };
  if (!testOnly && !skipRateLimit && !rateAllowed(cfg, String(input.sender).toLowerCase())) return { accepted: false, reason: 'rate_limited' };
  const id = String(input.id || randomUUID()).replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 64);
  const existingPath = path.join(cfg.stateDir, `${id}.json`);
  try {
    const previous = JSON.parse(await readFile(existingPath, 'utf8'));
    return { accepted: true, duplicate: true, id, status: previous.status, result: previous.result };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const task = { id, status: 'triaging', sender: input.sender, issueNumber: Number.isSafeInteger(input.issueNumber) ? input.issueNumber : null, title: String(input.title).slice(0, 200), createdAt: new Date().toISOString() };
  await persist(cfg, task);
  try {
    const existingTicket = !testOnly && input.event === 'issue_comment' ? await findTicket(cfg, task.issueNumber) : null;
    const decision = testOnly
      ? { actionable: true, task: input.body }
      : existingTicket
        ? { actionable: true, task: `Continue the existing issue work using the same branch and Harness session. Treat this comment as follow-up context: ${input.body}` }
      : await triage(cfg, { title: input.title, body: input.body });
    if (!decision.actionable) {
      task.status = 'ignored';
      task.reason = 'triage_not_actionable';
      await persist(cfg, task);
      return { accepted: true, actionable: false, id };
    }
    task.status = 'running';
    task.prompt = decision.task;
    const ticket = existingTicket ?? await createTicket(cfg, task.issueNumber, id);
    task.ticketId = ticket.id;
    await persist(cfg, task);
    const result = await runWorker(cfg, {
      id,
      title: input.title,
      issueNumber: task.issueNumber,
      ticketId: ticket.id,
      ticketBranch: ticket.branch,
      sessionId: ticket.sessionId,
      prompt: `${decision.task}\n\nConstraints: reproduce the issue before editing; work only in /workspace; preserve existing interfaces; do not add credentials, push, merge, or edit files outside the requested fix. Run the configured validation command before finishing.`,
      testCommand: testOnly ? input.testCommand : cfg.testCommand,
      fixtureTarget: input.fixtureTarget,
      fixtureReplacement: input.fixtureReplacement,
      smokeNetworkProbe: testOnly && input.smokeNetworkProbe === true,
    }, { projectRoot });
    task.status = 'ready_for_review';
    task.result = result;
    ticket.lastTaskId = id;
    ticket.updatedAt = new Date().toISOString();
    ticket.lastResult = { branch: result.branch, prUrl: result.prUrl, changedFiles: result.changedFiles };
    if (task.issueNumber !== null) {
      await writeFile(path.join(cfg.stateDir, `ticket-${task.issueNumber}.json`), `${JSON.stringify(ticket, null, 2)}\n`, { mode: 0o600 });
    }
    await persist(cfg, task);
    return { accepted: true, actionable: true, id, ...result };
  } catch (error) {
    task.status = 'failed';
    task.error = String(error.message).slice(0, 3000);
    await persist(cfg, task);
    throw error;
  }
}

function enqueue(input, cfg) {
  if (queue.length >= cfg.maxQueue) return false;
  queue.push({ input, cfg });
  if (!draining) {
    draining = true;
    void (async () => {
      while (queue.length) {
        const next = queue.shift();
        try { await processIssue(next.input, { cfg: next.cfg, skipRateLimit: true }); }
        catch (error) { console.error(`TASK_FAILED id=${next.input.id} error=${error.message}`); }
      }
      draining = false;
    })();
  }
  return true;
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('payload_too_large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startServer(cfg = config(), { enqueueTask = enqueue } = {}) {
  if (!cfg.webhookSecret) throw new Error('WEBHOOK_SECRET must be configured before starting webhook ingress');
  if (cfg.createPullRequest && !cfg.githubToken) throw new Error('GITHUB_TOKEN must be configured when CREATE_PULL_REQUEST=true');
  await mkdir(cfg.stateDir, { recursive: true });
  const { stdout: origin } = await execFile('git', ['-C', cfg.repoPath, 'remote', 'get-url', 'origin'], { maxBuffer: 100_000 });
  const remoteRepo = origin.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i)?.[1]?.toLowerCase();
  if (remoteRepo !== `${cfg.githubOwner}/${cfg.githubRepo}`.toLowerCase()) {
    throw new Error(`Configured repository ${cfg.githubOwner}/${cfg.githubRepo} does not match local origin`);
  }
  await recoverInterruptedTasks(cfg);
  await ensureImage(projectRoot);
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}\n');
      return;
    }
    if (req.method !== 'POST' || req.url !== '/github/webhook') {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readBody(req);
      if (!verifySignature(cfg.webhookSecret, req.headers['x-hub-signature-256'], body)) {
        res.writeHead(401).end('{"error":"invalid_signature"}\n');
        return;
      }
      const event = String(req.headers['x-github-event'] ?? '');
      const payload = JSON.parse(body.toString('utf8'));
      if (String(payload.repository?.full_name ?? '').toLowerCase() !== `${cfg.githubOwner}/${cfg.githubRepo}`.toLowerCase()) {
        res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":false,"reason":"wrong_repository"}\n');
        return;
      }
      const issue = payload.issue ?? payload;
      const sender = payload.sender?.login ?? '';
      const action = payload.action ?? '';
      if (event === 'issue_comment' && issue.pull_request) {
        res.writeHead(202, { 'content-type': 'application/json' }).end('{"accepted":false,"reason":"pull_request_comments_not_supported"}\n');
        return;
      }
      const gateResult = gate({ sender, event, action, body: payload.comment?.body ?? issue.body ?? '', mention: cfg.triggerMention, allowlist: cfg.allowedSenders });
      if (!gateResult.ok) {
        res.writeHead(202, { 'content-type': 'application/json' }).end(`${JSON.stringify({ accepted: false, reason: gateResult.reason })}\n`);
        return;
      }
      if (!rateAllowed(cfg, sender.toLowerCase())) {
        res.writeHead(429).end('{"accepted":false,"reason":"rate_limited"}\n');
        return;
      }
      const eventId = payload.comment?.id ?? issue.updated_at ?? randomUUID();
      const input = { sender, event, action, body: payload.comment?.body ?? issue.body ?? '', title: issue.title ?? 'GitHub request', issueNumber: Number.isSafeInteger(issue.number) ? issue.number : null, id: `gh-${issue.number ?? 'event'}-${eventId}` };
      if (queue.length >= cfg.maxQueue) {
        res.writeHead(429).end('{"accepted":false,"reason":"queue_full"}\n');
        return;
      }
      res.writeHead(202, { 'content-type': 'application/json' }).end(`${JSON.stringify({ accepted: true, id: input.id })}\n`);
      if (!enqueueTask(input, cfg)) console.error(`QUEUE_REJECTED id=${input.id}`);
    } catch (error) {
      const status = error.message === 'payload_too_large' ? 413 : 400;
      res.writeHead(status, { 'content-type': 'application/json' }).end(`${JSON.stringify({ error: error.message })}\n`);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, () => {
      server.off('error', reject);
      const address = server.address();
      console.log(`ROUTER_READY http://${cfg.host}:${typeof address === 'object' ? address.port : cfg.port}/github/webhook`);
      resolve();
    });
  });
  return server;
}

async function recoverInterruptedTasks(cfg) {
  const files = await readdir(cfg.stateDir).catch(() => []);
  for (const file of files.filter(name => name.endsWith('.json'))) {
    const filePath = path.join(cfg.stateDir, file);
    try {
      const task = JSON.parse(await readFile(filePath, 'utf8'));
      if (['triaging', 'running'].includes(task.status)) {
        task.status = 'interrupted';
        task.recoveredAt = new Date().toISOString();
        await writeFile(filePath, `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
      }
    } catch (error) {
      console.error(`STATE_RECOVERY_SKIPPED file=${file} error=${error.message}`);
    }
  }
  const { stdout } = await execFile('docker', ['ps', '-aq', '--filter', 'label=io.dsh.superagent=worker'], { maxBuffer: 100_000 });
  for (const id of stdout.trim().split('\n').filter(Boolean)) {
    await execFile('docker', ['rm', '-f', id], { maxBuffer: 100_000 }).catch(() => {});
  }
  const { stdout: proxyIds } = await execFile('docker', ['ps', '-aq', '--filter', 'label=io.dsh.superagent=proxy'], { maxBuffer: 100_000 });
  for (const id of proxyIds.trim().split('\n').filter(Boolean)) {
    await execFile('docker', ['rm', '-f', id], { maxBuffer: 100_000 }).catch(() => {});
  }
  const { stdout: networks } = await execFile('docker', ['network', 'ls', '-q', '--filter', 'label=io.dsh.superagent=internal-network'], { maxBuffer: 100_000 });
  for (const network of networks.trim().split('\n').filter(Boolean)) {
    await execFile('docker', ['network', 'rm', network], { maxBuffer: 100_000 }).catch(() => {});
  }
}
