import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.mjs';

const cfg = config();
const projectRoot = path.resolve(import.meta.dirname, '..');
const jobFile = id => path.join(cfg.stateDir, `mcp-job-${id}.json`);

function repositoryName(value, owner) {
  const input = String(value ?? '').trim();
  const match = input.match(/^(?:https:\/\/github\.com\/)?([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!match) throw new Error('Use a GitHub repository as owner/name or https://github.com/owner/name.');
  const [, requestedOwner, name] = match;
  if (requestedOwner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`Only repositories owned by ${owner} are enabled for this Harness connection.`);
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name) || name === '.' || name === '..') {
    throw new Error('The repository name contains unsupported characters.');
  }
  return { owner, name };
}

async function saveJob(id, value) {
  await mkdir(cfg.stateDir, { recursive: true, mode: 0o700 });
  const target = jobFile(id);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await (await import('node:fs/promises')).rename(temporary, target);
}

function taskResult(job, task) {
  if (!task) return { ...job };
  return {
    ...job,
    workerStatus: task.status,
    branch: task.result?.branch ?? null,
    pullRequest: task.result?.prUrl ?? null,
    autoMerge: task.result?.autoMerge ?? null,
    changedFiles: task.result?.changedFiles ?? [],
    error: task.error ?? job.error ?? null,
  };
}

function createServer() {
  const server = new McpServer({ name: 'deepseek-super-agent', version: '1.0.0' });

  server.registerTool('status', {
    description: 'Check whether the local Super Agent Router is healthy and report its configured DSH engine and repository owner. Does not start a task.',
    inputSchema: z.object({}),
  }, async () => {
    let health = false;
    try {
      const response = await fetch(`http://${cfg.host}:${cfg.port}/health`, { signal: AbortSignal.timeout(2500) });
      health = response.ok && (await response.json()).ok === true;
    } catch { /* The status response reports an unavailable router without exposing local errors. */ }
    return { content: [{ type: 'text', text: JSON.stringify({ healthy: health, engine: cfg.engine, owner: cfg.githubOwner, configuredRepository: `${cfg.githubOwner}/${cfg.githubRepo}`, createPullRequest: cfg.createPullRequest, autoMerge: cfg.autoMerge }) }] };
  });

  server.registerTool('start_task', {
    description: 'Delegate a coding task to DeepSeek Super Agent. It clones a repository owned by the configured GitHub account, runs the isolated DSH worker and trusted validation command, then publishes a branch and Pull Request. Use only when the user asks to delegate repository work to Super Agent. Return the task ID so status can be checked later.',
    inputSchema: z.object({
      repository: z.string().min(3).max(240).describe('GitHub repository as owner/name or a GitHub URL. Only the configured account owner is allowed.'),
      title: z.string().min(1).max(180).describe('Short task title.'),
      task: z.string().min(1).max(12000).describe('Requested code change, acceptance criteria, and constraints.'),
    }),
  }, async ({ repository, title, task }) => {
    if (!cfg.githubToken || !cfg.createPullRequest) {
      return { isError: true, content: [{ type: 'text', text: 'Super Agent publishing is not configured. Set the Router GitHub token and CREATE_PULL_REQUEST=true.' }] };
    }
    let repo;
    try { repo = repositoryName(repository, cfg.githubOwner); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    const id = randomUUID().replaceAll('-', '').slice(0, 24);
    const job = { id, repository: `${repo.owner}/${repo.name}`, title, status: 'queued', createdAt: new Date().toISOString() };
    await saveJob(id, job);
    const child = spawn(process.execPath, [path.join(projectRoot, 'src/mcp-task.mjs')], {
      cwd: projectRoot,
      env: {
        ...process.env,
        SUPERAGENT_MCP_JOB_ID: id,
        SUPERAGENT_MCP_REPOSITORY: `${repo.owner}/${repo.name}`,
        SUPERAGENT_MCP_TITLE: title,
        SUPERAGENT_MCP_TASK: task,
      },
      stdio: 'ignore',
      detached: true,
    });
    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
    } catch (error) {
      await saveJob(id, { ...job, status: 'failed', error: `Could not start the task process: ${error.message}` });
      return { isError: true, content: [{ type: 'text', text: 'The local Super Agent task process could not be started.' }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ taskId: id, status: 'queued', repository: job.repository, message: 'The task continues in the background. Use get_task_status with this taskId to check progress.' }) }] };
  });

  server.registerTool('get_task_status', {
    description: 'Read the saved progress and final Pull Request link for a Super Agent task started from this Harness profile.',
    inputSchema: z.object({ taskId: z.string().regex(/^[a-f0-9]{24}$/i) }),
  }, async ({ taskId }) => {
    let job;
    try { job = JSON.parse(await readFile(jobFile(taskId), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { isError: true, content: [{ type: 'text', text: 'No Super Agent task exists with that taskId.' }] };
      throw error;
    }
    let task = null;
    try { task = JSON.parse(await readFile(path.join(cfg.stateDir, `mcp-${taskId}.json`), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { content: [{ type: 'text', text: JSON.stringify(taskResult(job, task)) }] };
  });

  return server;
}

const server = createServer();
await server.connect(new StdioServerTransport());
console.error('DeepSeek Super Agent MCP server ready on stdio.');
