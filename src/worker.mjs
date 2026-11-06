import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { publishSuccessfulTask } from './github.mjs';

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

function containerArgs(cfg, task, worktree, privateNetwork, sessionStateDir) {
  // The official DSH native addon loader materializes its N-API module in /tmp
  // before dlopen, so only DSH needs an executable bounded temp mount.
  const tempMountOptions = cfg.engine === 'dsh'
    ? 'rw,exec,nosuid,nodev,size=256m,uid=10001,gid=10001'
    : 'rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001';
  const args = [
    'run', '--name', `dsh-worker-${task.id}`,
    '--label', 'io.dsh.superagent=worker', '--label', `io.dsh.task=${task.id}`,
    '--read-only', '--user', '10001:10001',
    '--workdir', '/workspace', '--mount', `type=bind,src=${worktree},dst=/workspace`,
    '--tmpfs', `/tmp:${tempMountOptions}`,
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
    '--env', 'DEEPSEEK_BASE_URL=http://dsh-model-proxy:8080/deepseek/anthropic',
    '--env', 'ANTHROPIC_BASE_URL=http://dsh-model-proxy:8080/anthropic',
    '--env', `FIXTURE_TARGET=${task.fixtureTarget ?? ''}`,
    '--env', `FIXTURE_REPLACEMENT=${task.fixtureReplacement ?? ''}`,
    '--env', `SMOKE_NETWORK_PROBE=${task.smokeNetworkProbe ? 'true' : 'false'}`,
  ];
  if (cfg.engine === 'dsh') {
    args.push('--mount', `type=bind,src=${sessionStateDir},dst=/home/agent/.dsh`);
    args.push('--env', `DSH_SESSION_ID=${task.sessionId}`);
  }
  if (cfg.engine === 'claude') args.push('--env', 'ANTHROPIC_API_KEY=dsh-router-proxy');
  if (cfg.engine === 'dsh') args.push('--env', 'DEEPSEEK_API_KEY=dsh-router-proxy');
  args.push(imageName);
  return args;
}

async function setWorktreeOwner(worktree, uid, { privateFiles = false } = {}) {
  const args = [
    'run', '--rm', '--network', 'none', '--read-only', '--user', '0:0', '--memory', '256m', '--cpus', '0.25', '--pids-limit', '32',
    '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--security-opt', 'no-new-privileges=true',
    ...(privateFiles || uid === 0 ? ['--cap-add', 'DAC_OVERRIDE'] : []),
    '--mount', `type=bind,src=${worktree},dst=/workspace`,
    '--entrypoint', 'chown', imageName, '-R', `${uid}:${uid}`, '/workspace',
  ];
  await execFile('docker', args, { maxBuffer: 100_000, timeout: 120_000 });
}

async function pushBranch(cfg, repo, branch) {
  if (!cfg.githubToken) throw new Error('GITHUB_TOKEN is required for the router-side branch push');
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
}

export async function runWorker(cfg, task, { projectRoot }) {
  await ensureImage(projectRoot);
  const id = slug(task.id);
  const privateNetwork = taskNetwork(id);
  const issuePart = Number.isSafeInteger(task.issueNumber) ? task.issueNumber : id;
  const branch = task.ticketBranch ?? `agent/task-${issuePart}-${Date.now()}`;
  const worktree = path.join(cfg.worktreesDir, id);
  const sessionStateDir = path.join(cfg.sessionStateDir, slug(task.ticketId ?? id));
  await mkdir(cfg.worktreesDir, { recursive: true });
  await mkdir(cfg.artifactsDir, { recursive: true });
  if (cfg.engine === 'dsh') await mkdir(sessionStateDir, { recursive: true, mode: 0o700 });
  const repo = path.resolve(cfg.repoPath);
  const dirty = await git(repo, ['status', '--porcelain']);
  if (dirty) throw new Error('Repository checkout has uncommitted changes; refusing to create a worker worktree');
  const existingBranch = await git(repo, ['branch', '--list', '--format=%(refname:short)', branch]);
  await git(repo, existingBranch ? ['worktree', 'add', worktree, branch] : ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
  const gitPointer = await readFile(path.join(worktree, '.git'));
  let ownerShifted = false;
  let sessionOwnerShifted = false;
  let proxyId = null;
  try {
    proxyId = await startModelProxy(cfg, task);
    ownerShifted = true;
    await setWorktreeOwner(worktree, 10001);
    if (cfg.engine === 'dsh') {
      sessionOwnerShifted = true;
      await setWorktreeOwner(sessionStateDir, 10001, { privateFiles: true });
    }
    const args = containerArgs(cfg, task, worktree, privateNetwork, sessionStateDir);
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
    if (sessionOwnerShifted) {
      await setWorktreeOwner(sessionStateDir, 0, { privateFiles: true });
      sessionOwnerShifted = false;
    }
    const { stdout: inspectJson } = await execFile('docker', ['inspect', `dsh-worker-${id}`], { maxBuffer: 200_000 });
    const inspect = JSON.parse(inspectJson)[0];
    const bindMounts = inspect.Mounts.filter(mount => mount.Type === 'bind');
    const hardening = inspect.HostConfig;
    const expectedNetwork = cfg.network === 'none' ? 'none' : privateNetwork;
    if (inspect.Config.User !== '10001:10001' || !hardening.ReadonlyRootfs || hardening.PidsLimit !== cfg.pids
      || hardening.Memory <= 0 || hardening.NanoCpus <= 0 || !hardening.CapDrop.includes('ALL')
      || !hardening.SecurityOpt.includes('no-new-privileges=true') || hardening.NetworkMode !== expectedNetwork
      || bindMounts.length !== (cfg.engine === 'dsh' ? 2 : 1)
      || !bindMounts.some(mount => path.resolve(mount.Source) === path.resolve(worktree) && mount.Destination === '/workspace')
      || (cfg.engine === 'dsh' && !bindMounts.some(mount => path.resolve(mount.Source) === path.resolve(sessionStateDir) && mount.Destination === '/home/agent/.dsh'))) {
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
    const commitDetails = slug(task.title).replaceAll('-', ' ');
    const commitTitle = `fix(agent): ${commitDetails.slice(0, 72 - 'fix(agent):  [skip ci]'.length)} [skip ci]`;
    await git(worktree, ['-c', 'user.name=DeepSeek Super Agent', '-c', 'user.email=superagent@users.noreply.github.com', 'commit', '-m', commitTitle]);
    const patch = await git(worktree, ['show', '--format=', '--binary', 'HEAD']);
    if (!patch) throw new Error('Committed change produced an empty patch');
    const patchPath = path.join(cfg.artifactsDir, `${id}.patch`);
    await writeFile(patchPath, patch, { mode: 0o600 });
    const digest = createHash('sha256').update(patch).digest('hex');
    const publication = await publishSuccessfulTask(cfg, { ...task }, {
      branch, patchPath, sha256: digest, changedFiles: changes.split('\n'),
    }, { pushBranch: branchToPush => pushBranch(cfg, repo, branchToPush) });
    return { branch, patchPath, sha256: digest, changedFiles: changes.split('\n'), prUrl: publication?.prUrl ?? null, commentUrl: publication?.commentUrl ?? null };
  } finally {
    if (ownerShifted) await setWorktreeOwner(worktree, 0).catch(() => {});
    if (sessionOwnerShifted) await setWorktreeOwner(sessionStateDir, 0, { privateFiles: true }).catch(() => {});
    await execFile('docker', ['rm', '-f', `dsh-worker-${id}`], { maxBuffer: 100_000 }).catch(() => {});
    if (proxyId) await execFile('docker', ['rm', '-f', proxyId], { maxBuffer: 100_000 }).catch(() => {});
    if (cfg.network !== 'none') await execFile('docker', ['network', 'rm', privateNetwork], { maxBuffer: 100_000 }).catch(() => {});
    await execFile('git', ['-C', repo, 'worktree', 'remove', '--force', worktree], { maxBuffer: 100_000 }).catch(() => {});
  }
}
