import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

const execFile = promisify(execFileCb);
const imageName = 'dsh-superagent-worker:local';
const proxyImage = 'dsh-superagent-proxy:local';
const egressNetwork = 'dsh-worker-egress';

async function git(repo, args, options = {}) {
  const { stdout } = await execFile('git', ['-C', repo, ...args], { maxBuffer: 8 * 1024 * 1024, ...options });
  return stdout.trimEnd();
}

function slug(value) {
  const result = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return result || 'task';
}

function logProcess(command, args, { cwd, env, timeoutMs, onOutput }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      finish(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    const collect = chunk => {
      const text = chunk.toString();
      output = (output + text).slice(-2_000_000);
      onOutput?.(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', finish);
    child.once('close', code => code === 0 ? finish(null, output) : finish(new Error(`${command} exited ${code}\n${output.slice(-6000)}`)));
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    }
  });
}

export async function ensureImage(projectRoot) {
  for (const [image, args] of [
    [imageName, ['build', '--pull', '-t', imageName, projectRoot]],
    [proxyImage, ['build', '--pull', '-f', path.join(projectRoot, 'proxy.Dockerfile'), '-t', proxyImage, projectRoot]],
  ]) {
    try { await execFile('docker', ['image', 'inspect', image], { maxBuffer: 100_000 }); }
    catch {
      console.log(`IMAGE_BUILD_START: ${image}`);
      await logProcess('docker', args, { timeoutMs: 900_000, onOutput: chunk => process.stdout.write(chunk) });
      console.log(`IMAGE_BUILD_DONE: ${image}`);
    }
  }
}

async function ensureNetwork(name, internal = false, taskId = '') {
  try {
    const { stdout } = await execFile('docker', ['network', 'inspect', name], { maxBuffer: 100_000 });
    if (Boolean(JSON.parse(stdout)[0].Internal) !== internal) throw new Error(`Network ${name} has an unsafe isolation mode`);
  } catch (error) {
    if (error.message.includes('unsafe isolation mode')) throw error;
    const labels = taskId
      ? ['--label', 'io.dsh.superagent=internal-network', '--label', `io.dsh.task=${taskId}`]
      : ['--label', 'io.dsh.superagent=egress-network'];
    await execFile('docker', ['network', 'create', ...(internal ? ['--internal'] : []), ...labels, name], { maxBuffer: 100_000 });
  }
}

const taskNetwork = taskId => `dsh-task-${slug(taskId)}-internal`;

export async function startModelProxy(cfg, task) {
  if (cfg.network === 'none') return null;
  const usesClaude = cfg.engine === 'claude';
  const usesDeepseek = cfg.engine === 'dsh';
  if (usesClaude && !cfg.anthropicApiKey) throw new Error('ANTHROPIC_API_KEY is required for WORKER_ENGINE=claude');
  if (usesDeepseek && !cfg.deepseekApiKey) throw new Error('DEEPSEEK_API_KEY is required for WORKER_ENGINE=dsh');
  const privateNetwork = taskNetwork(task.id);
  await ensureNetwork(privateNetwork, true, task.id);
  await ensureNetwork(egressNetwork, false);
  const name = `dsh-proxy-${slug(task.id)}`;
  const args = [
    'run', '-d', '--name', name, '--network', privateNetwork, '--network-alias', 'dsh-model-proxy',
    '--label', 'io.dsh.superagent=proxy', '--label', `io.dsh.task=${task.id}`,
    '--read-only', '--user', '10001:10001', '--memory', '256m', '--cpus', '0.5', '--pids-limit', '64',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=32m,uid=10001,gid=10001',
    '--env', 'ANTHROPIC_API_KEY', '--env', 'DEEPSEEK_API_KEY',
    '--env', `ANTHROPIC_UPSTREAM_URL=${cfg.anthropicUpstreamUrl}`,
    '--env', `DEEPSEEK_UPSTREAM_URL=${cfg.deepseekUpstreamUrl}`,
    proxyImage,
  ];
  const proxyEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_HOST: process.env.DOCKER_HOST,
    ANTHROPIC_API_KEY: usesClaude ? cfg.anthropicApiKey : '',
    DEEPSEEK_API_KEY: usesDeepseek ? cfg.deepseekApiKey : '',
  };
  const { stdout } = await execFile('docker', args, { env: proxyEnv, maxBuffer: 100_000, timeout: 60_000 });
  const containerId = stdout.trim();
  try {
    await execFile('docker', ['network', 'connect', egressNetwork, containerId], { maxBuffer: 100_000, timeout: 30_000 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const { stdout: health } = await execFile('docker', ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', containerId], { maxBuffer: 100_000 });
      if (health.trim() === 'healthy') {
        const { stdout: inspectJson } = await execFile('docker', ['inspect', containerId], { maxBuffer: 200_000 });
        const inspect = JSON.parse(inspectJson)[0];
        const host = inspect.HostConfig;
        const networks = Object.keys(inspect.NetworkSettings.Networks).sort();
        if (inspect.Config.User !== '10001:10001' || !host.ReadonlyRootfs || host.Memory !== 268435456
          || host.NanoCpus !== 500000000 || host.PidsLimit !== 64 || !host.CapDrop.includes('ALL')
          || !host.SecurityOpt.includes('no-new-privileges=true')
          || networks.join(',') !== [egressNetwork, privateNetwork].sort().join(',')
          || inspect.Mounts.some(mount => mount.Type === 'bind')) {
          throw new Error('Model egress proxy failed its isolation and resource inspection');
        }
        console.log(`MODEL_PROXY_READY: container=${name} key_scope=${usesClaude ? 'anthropic' : 'deepseek'} egress=allowlisted-upstream`);
        return containerId;
      }
      if (health.trim() === 'unhealthy') throw new Error('Model egress proxy health check failed');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Timed out waiting for model egress proxy health check');
  } catch (error) {
    await execFile('docker', ['rm', '-f', containerId], { maxBuffer: 100_000 }).catch(() => {});
    throw error;
  }
}

function containerArgs(cfg, task, worktree, privateNetwork) {
  const args = [
    'run', '--name', `dsh-worker-${task.id}`,
    '--label', 'io.dsh.superagent=worker', '--label', `io.dsh.task=${task.id}`,
    '--read-only', '--user', '10001:10001',
    '--workdir', '/workspace', '--mount', `type=bind,src=${worktree},dst=/workspace`,
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001',
    '--tmpfs', '/home/agent:rw,noexec,nosuid,nodev,size=512m,uid=10001,gid=10001',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--memory', cfg.memory, '--cpus', String(cfg.cpus), '--pids-limit', String(cfg.pids),
    '--ulimit', 'nofile=1024:1024', '--ulimit', 'nproc=256:256',
    '--network', cfg.network === 'none' ? 'none' : privateNetwork,
    '--env', `WORKER_ENGINE=${cfg.engine}`,
    '--env', `WORKER_PROMPT=${task.prompt}`,
    '--env', `WORKER_TEST_COMMAND=${task.testCommand || cfg.testCommand}`,
    '--env', `WORKER_MAX_TURNS=${cfg.maxTurns}`,
    '--env', `DSH_MODEL=${cfg.dshModel}`,
    '--env', 'DEEPSEEK_BASE_URL=http://dsh-model-proxy:8080/deepseek',
    '--env', 'ANTHROPIC_BASE_URL=http://dsh-model-proxy:8080/anthropic',
    '--env', `FIXTURE_TARGET=${task.fixtureTarget ?? ''}`,
    '--env', `FIXTURE_REPLACEMENT=${task.fixtureReplacement ?? ''}`,
    '--env', `SMOKE_NETWORK_PROBE=${task.smokeNetworkProbe ? 'true' : 'false'}`,
  ];
  if (cfg.engine === 'claude') args.push('--env', 'ANTHROPIC_API_KEY=dsh-router-proxy');
  if (cfg.engine === 'dsh') args.push('--env', 'DEEPSEEK_API_KEY=dsh-router-proxy');
  args.push(imageName);
  return args;
}

async function setWorktreeOwner(worktree, uid) {
  const args = [
    'run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--memory', '256m', '--cpus', '0.25', '--pids-limit', '32',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges=true',
    '--mount', `type=bind,src=${worktree},dst=/workspace`,
    '--entrypoint', 'chown', imageName, '-R', `${uid}:${uid}`, '/workspace',
  ];
  await execFile('docker', args, { maxBuffer: 100_000, timeout: 120_000 });
}

async function createPullRequest(cfg, branch, title, body) {
  if (!cfg.createPullRequest) return null;
  if (!cfg.githubToken || !cfg.githubOwner || !cfg.githubRepo) throw new Error('CREATE_PULL_REQUEST requires GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO');
  const remote = await git(cfg.repoPath, ['remote', 'get-url', 'origin']);
  if (!remote.startsWith('https://github.com/')) throw new Error('PR publishing is restricted to an https://github.com/ origin');
  const encoded = Buffer.from(`x-access-token:${cfg.githubToken}`).toString('base64');
  const pushEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encoded}`,
  };
  await execFile('git', ['-C', cfg.repoPath, 'push', 'origin', `${branch}:${branch}`], { env: pushEnv, timeout: 120_000 });
  const base = (await git(cfg.repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => 'origin/main')).replace(/^origin\//, '');
  const response = await fetch(`https://api.github.com/repos/${cfg.githubOwner}/${cfg.githubRepo}/pulls`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.githubToken}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
    body: JSON.stringify({ title, head: branch, base, body, draft: true }),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`GitHub PR API returned ${response.status}: ${result.message ?? 'unknown error'}`);
  return result.html_url;
}

export async function runWorker(cfg, task, { projectRoot }) {
  await ensureImage(projectRoot);
  const id = slug(task.id);
  const privateNetwork = taskNetwork(id);
  const branch = `agent/task-${id}`;
  const worktree = path.join(cfg.worktreesDir, id);
  await mkdir(cfg.worktreesDir, { recursive: true });
  await mkdir(cfg.artifactsDir, { recursive: true });
  const repo = path.resolve(cfg.repoPath);
  const dirty = await git(repo, ['status', '--porcelain']);
  if (dirty) throw new Error('Repository checkout has uncommitted changes; refusing to create a worker worktree');
  await git(repo, ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
  const gitPointer = await readFile(path.join(worktree, '.git'));
  let ownerShifted = false;
  let proxyId = null;
  try {
    proxyId = await startModelProxy(cfg, task);
    ownerShifted = true;
    await setWorktreeOwner(worktree, 10001);
    const args = containerArgs(cfg, task, worktree, privateNetwork);
    const childEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DOCKER_HOST: process.env.DOCKER_HOST,
    };
    console.log(`WORKER_START: id=${id} uid=10001 engine=${cfg.engine} network=${cfg.network}`);
    await logProcess('docker', args, {
      timeoutMs: cfg.timeoutSeconds * 1000,
      env: childEnv,
      onOutput: chunk => process.stdout.write(chunk),
    });
    await setWorktreeOwner(worktree, 0);
    ownerShifted = false;
    const { stdout: inspectJson } = await execFile('docker', ['inspect', `dsh-worker-${id}`], { maxBuffer: 200_000 });
    const inspect = JSON.parse(inspectJson)[0];
    const bindMounts = inspect.Mounts.filter(mount => mount.Type === 'bind');
    const hardening = inspect.HostConfig;
    const expectedNetwork = cfg.network === 'none' ? 'none' : privateNetwork;
    if (inspect.Config.User !== '10001:10001' || !hardening.ReadonlyRootfs || hardening.PidsLimit !== cfg.pids
      || hardening.Memory <= 0 || hardening.NanoCpus <= 0 || !hardening.CapDrop.includes('ALL')
      || !hardening.SecurityOpt.includes('no-new-privileges=true') || hardening.NetworkMode !== expectedNetwork
      || bindMounts.length !== 1 || path.resolve(bindMounts[0].Source) !== path.resolve(worktree)
      || bindMounts[0].Destination !== '/workspace') {
      throw new Error('Worker container failed the isolation and resource policy inspection');
    }
    console.log(`SANDBOX_VERIFIED: uid=${inspect.Config.User} network=${hardening.NetworkMode} memory=${hardening.Memory} nanoCpus=${hardening.NanoCpus} pids=${hardening.PidsLimit} bindMounts=${bindMounts.length} readonlyRoot=${hardening.ReadonlyRootfs}`);
    const pointerAfter = await readFile(path.join(worktree, '.git'));
    if (!pointerAfter.equals(gitPointer)) throw new Error('Worker modified the protected Git worktree pointer');
    await git(worktree, ['add', '-A']);
    const staged = await git(worktree, ['diff', '--cached', '--check']);
    void staged;
    const changes = await git(worktree, ['diff', '--cached', '--name-only']);
    if (!changes) throw new Error('Worker completed without producing a tracked patch');
    const commitTitle = `agent(task): ${slug(task.title).replaceAll('-', ' ')}`.slice(0, 72);
    await git(worktree, ['-c', 'user.name=DeepSeek Super Agent', '-c', 'user.email=superagent@users.noreply.github.com', 'commit', '-m', commitTitle]);
    const patch = await git(worktree, ['show', '--format=', '--binary', 'HEAD']);
    if (!patch) throw new Error('Committed change produced an empty patch');
    const patchPath = path.join(cfg.artifactsDir, `${id}.patch`);
    await writeFile(patchPath, patch, { mode: 0o600 });
    const digest = createHash('sha256').update(patch).digest('hex');
    const prUrl = await createPullRequest(cfg, branch, task.title, `${task.prompt}\n\nAutomated checks passed in an isolated worker. Human review required; no auto-merge was requested.`);
    return { branch, patchPath, sha256: digest, changedFiles: changes.split('\n'), prUrl };
  } finally {
    if (ownerShifted) await setWorktreeOwner(worktree, 0).catch(() => {});
    await execFile('docker', ['rm', '-f', `dsh-worker-${id}`], { maxBuffer: 100_000 }).catch(() => {});
    if (proxyId) await execFile('docker', ['rm', '-f', proxyId], { maxBuffer: 100_000 }).catch(() => {});
    if (cfg.network !== 'none') await execFile('docker', ['network', 'rm', privateNetwork], { maxBuffer: 100_000 }).catch(() => {});
    await execFile('git', ['-C', repo, 'worktree', 'remove', '--force', worktree], { maxBuffer: 100_000 }).catch(() => {});
  }
}
