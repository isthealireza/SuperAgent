import path from 'node:path';
import os from 'node:os';

const integer = (name, fallback, min = 1, max = 100000) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return value;
};

export function config() {
  const repoPath = path.resolve(process.env.REPO_PATH ?? process.cwd());
  const base = path.join(os.homedir(), '.local/share/dsh-superagent');
  const engine = process.env.WORKER_ENGINE ?? 'claude';
  const network = process.env.WORKER_NETWORK ?? 'egress';
  if (!['claude', 'dsh', 'fixture'].includes(engine)) throw new Error('WORKER_ENGINE must be claude, dsh, or fixture');
  if (engine === 'fixture' && process.env.NODE_ENV !== 'test') throw new Error('WORKER_ENGINE=fixture is restricted to NODE_ENV=test');
  if (!['none', 'egress'].includes(network)) throw new Error('WORKER_NETWORK must be none or egress');
  if (engine !== 'fixture' && network === 'none') throw new Error('Remote model runners need WORKER_NETWORK=egress; fixture runs remain network-isolated');
  const cpus = Number(process.env.WORKER_CPUS ?? '2');
  if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 64) throw new Error('WORKER_CPUS must be greater than 0 and no more than 64');
  const memory = process.env.WORKER_MEMORY ?? '2g';
  if (!/^[1-9][0-9]*[kmg]$/i.test(memory)) throw new Error('WORKER_MEMORY must look like 512m or 2g');
  return {
    host: process.env.HOST ?? '127.0.0.1',
    port: integer('PORT', 3088, 1, 65535),
    webhookSecret: process.env.WEBHOOK_SECRET ?? '',
    allowedSenders: new Set((process.env.ALLOWED_SENDERS ?? 'isthealireza').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)),
    triggerMention: (process.env.TRIGGER_MENTION ?? '@superagent').toLowerCase(),
    repoPath,
    worktreesDir: path.resolve(process.env.WORKTREES_DIR ?? path.join(base, 'worktrees')),
    stateDir: path.resolve(process.env.STATE_DIR ?? path.join(base, 'state')),
    artifactsDir: path.resolve(process.env.ARTIFACTS_DIR ?? path.join(base, 'artifacts')),
    maxQueue: integer('MAX_QUEUE', 20),
    ratePerMinute: integer('MAX_PER_SENDER_PER_MINUTE', 3),
    triageBaseUrl: (process.env.TRIAGE_BASE_URL ?? 'https://api.deepseek.com').replace(/\/$/, ''),
    triageModel: process.env.TRIAGE_MODEL ?? 'deepseek-flash',
    triageApiKey: process.env.TRIAGE_API_KEY || process.env.DEEPSEEK_API_KEY || '',
    engine,
    network,
    testCommand: process.env.WORKER_TEST_COMMAND ?? 'npm test',
    cpus,
    memory,
    pids: integer('WORKER_PIDS', 256),
    timeoutSeconds: integer('WORKER_TIMEOUT_SECONDS', 1800, 10, 86400),
    maxTurns: integer('WORKER_MAX_TURNS', 30, 1, 200),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? '',
    anthropicUpstreamUrl: process.env.ANTHROPIC_UPSTREAM_URL ?? 'https://api.anthropic.com',
    deepseekUpstreamUrl: process.env.DEEPSEEK_UPSTREAM_URL ?? 'https://api.deepseek.com',
    dshModel: process.env.DSH_MODEL ?? 'deepseek-flash',
    githubToken: process.env.GITHUB_TOKEN ?? '',
    githubOwner: process.env.GITHUB_OWNER ?? 'isthealireza',
    githubRepo: process.env.GITHUB_REPO ?? 'SuperAgent',
    createPullRequest: process.env.CREATE_PULL_REQUEST === 'true',
  };
}
