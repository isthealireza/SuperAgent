import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';
import { processIssue } from './router.mjs';

const execFile = promisify(execFileCallback);
const cfg = config();
const id = process.env.SUPERAGENT_MCP_JOB_ID;
const repository = process.env.SUPERAGENT_MCP_REPOSITORY ?? '';
const title = process.env.SUPERAGENT_MCP_TITLE ?? 'Harness task';
const taskText = process.env.SUPERAGENT_MCP_TASK ?? '';
const jobPath = path.join(cfg.stateDir, `mcp-job-${id}.json`);
const taskPath = path.join(cfg.stateDir, `mcp-${id}.json`);

if (!/^[a-f0-9]{24}$/i.test(id ?? '') || !taskText || taskText.length > 12_000) {
  throw new Error('Invalid Super Agent MCP task envelope');
}

async function saveJob(status, fields = {}) {
  const current = JSON.parse(await readFile(jobPath, 'utf8'));
  const temporary = `${jobPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ ...current, ...fields, status, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, jobPath);
}

function gitAuthEnv() {
  if (!cfg.githubToken) throw new Error('GitHub token is not configured in the Router.');
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${cfg.githubToken}`).toString('base64')}`,
  };
}

async function git(repoPath, args, env = process.env) {
  const { stdout } = await execFile('git', ['-C', repoPath, ...args], { env, maxBuffer: 4 * 1024 * 1024, timeout: 120_000 });
  return stdout.trimEnd();
}

function parseRepo(fullName) {
  const match = fullName.match(/^([^/]+)\/([A-Za-z0-9_.-]{1,100})$/);
  if (!match || match[1].toLowerCase() !== cfg.githubOwner.toLowerCase() || match[2] === '.' || match[2] === '..') {
    throw new Error(`Only repositories owned by ${cfg.githubOwner} are allowed.`);
  }
  return { owner: cfg.githubOwner, name: match[2] };
}

async function acquireLock(lockPath) {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3600; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(path.join(lockPath, 'owner'), `${process.pid}\n`, { mode: 0o600 });
      return async () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const ownerPid = Number(await readFile(path.join(lockPath, 'owner'), 'utf8').catch(() => '0'));
      if (ownerPid && ownerPid !== process.pid) {
        try { process.kill(ownerPid, 0); }
        catch (probeError) {
          if (probeError.code === 'ESRCH') await rm(lockPath, { recursive: true, force: true });
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw new Error('Timed out waiting for another task using this repository to finish.');
}

async function prepareRepository() {
  const repo = parseRepo(repository);
  const authEnv = gitAuthEnv();
  const root = path.resolve(cfg.repositoriesDir);
  const repoPath = path.resolve(root, repo.name);
  if (!repoPath.startsWith(`${root}${path.sep}`)) throw new Error('Repository path escaped the configured repository store.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const unlock = await acquireLock(path.join(root, '.locks', `${repo.name.toLowerCase()}.lock`));
  try {
    const origin = `https://github.com/${repo.owner}/${repo.name}.git`;
    let exists = false;
    try { exists = (await stat(path.join(repoPath, '.git'))).isDirectory(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!exists) {
      try { await stat(repoPath); throw new Error('A non-Git path already occupies this repository name. Refusing to overwrite it.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await saveJob('cloning_repository', { repository: `${repo.owner}/${repo.name}` });
      await execFile('git', ['clone', '--', origin, repoPath], { env: authEnv, maxBuffer: 2 * 1024 * 1024, timeout: 900_000 });
    }
    const currentOrigin = (await git(repoPath, ['remote', 'get-url', 'origin'])).replace(/\.git$/i, '').toLowerCase();
    if (currentOrigin !== origin.replace(/\.git$/i, '').toLowerCase()) throw new Error('The saved clone origin does not match the requested GitHub repository.');
    if (await git(repoPath, ['status', '--porcelain'])) throw new Error('The Super Agent repository clone has local changes; refusing to overwrite them.');
    await git(repoPath, ['fetch', '--prune', 'origin'], authEnv);
    let defaultRef = await git(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).catch(() => '');
    if (!defaultRef) {
      await git(repoPath, ['remote', 'set-head', 'origin', '--auto'], authEnv);
      defaultRef = await git(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
    }
    if (!defaultRef.startsWith('refs/remotes/origin/')) throw new Error('GitHub did not provide a default branch for this repository.');
    const baseRef = defaultRef.replace(/^refs\/remotes\//, '');
    await git(repoPath, ['switch', '--detach', baseRef]);
    await git(repoPath, ['reset', '--hard', baseRef]);
    return { repoPath, owner: repo.owner, name: repo.name };
  } finally {
    await unlock();
  }
}

try {
  await saveJob('preparing_repository');
  const repo = await prepareRepository();
  await saveJob('running_worker', { repository: `${repo.owner}/${repo.name}` });
  const taskCfg = { ...cfg, repoPath: repo.repoPath, githubOwner: repo.owner, githubRepo: repo.name };
  const result = await processIssue({
    sender: cfg.githubOwner,
    event: 'issues',
    action: 'opened',
    issueNumber: null,
    id: `mcp-${id}`,
    title: title.slice(0, 200),
    body: `${cfg.triggerMention}\n\n${taskText}`,
  }, { cfg: taskCfg });
  const finalStatus = result.accepted && result.actionable ? 'ready_for_review' : result.accepted ? 'ignored' : 'failed';
  await saveJob(finalStatus, { result, completedAt: new Date().toISOString() });
} catch (error) {
  await saveJob('failed', { error: String(error.message).slice(0, 2500), completedAt: new Date().toISOString() }).catch(() => {});
  console.error(`MCP_TASK_FAILED id=${id} error=${error.message}`);
  process.exitCode = 1;
}
