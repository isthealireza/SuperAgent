import { spawn } from 'node:child_process';

const engine = process.env.WORKER_ENGINE ?? 'claude';
const prompt = process.env.WORKER_PROMPT;
if (!prompt) throw new Error('WORKER_PROMPT is required');
console.log(`WORKER_IDENTITY uid=${process.getuid?.() ?? 'unknown'} gid=${process.getgid?.() ?? 'unknown'}`);

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: '/workspace', env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; process.stderr.write(chunk); });
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`)));
  });
}

async function validate() {
  const command = process.env.WORKER_TEST_COMMAND?.trim();
  if (!command) {
    console.log('VALIDATION_SKIPPED: WORKER_TEST_COMMAND is empty');
    return;
  }
  console.log(`VALIDATION_START: ${command}`);
  await run('/bin/bash', ['-lc', command]);
  console.log('VALIDATION_PASSED');
}

async function reproduce() {
  const command = process.env.WORKER_TEST_COMMAND?.trim();
  if (!command) return;
  console.log(`REPRODUCE_START: ${command}`);
  try {
    await run('/bin/bash', ['-lc', command]);
    console.log('REPRODUCE_RESULT: baseline already passes');
  } catch (error) {
    console.log(`REPRODUCE_RESULT: baseline failure captured (${String(error.message).slice(0, 400)})`);
  }
}

await reproduce();

if (engine === 'fixture') {
  const target = process.env.FIXTURE_TARGET ?? 'sample.txt';
  const replacement = process.env.FIXTURE_REPLACEMENT ?? 'Hello, sandbox!';
  const { stdout } = await run('python3', ['-c',
    'from pathlib import Path; import os; p=Path(os.environ["FIXTURE_TARGET"]); p.write_text(os.environ["FIXTURE_REPLACEMENT"]+"\\n"); print("FIXTURE_PATCHED:", p)',
  ], { ...process.env, FIXTURE_TARGET: target, FIXTURE_REPLACEMENT: replacement });
  void stdout;
  if (process.env.SMOKE_NETWORK_PROBE === 'true') {
    let reachable = false;
    try { await run('python3', ['-c', 'import urllib.request; urllib.request.urlopen("https://example.com", timeout=3)']); reachable = true; }
    catch { /* An offline worker should not resolve or connect to the public network. */ }
    if (reachable) throw new Error('Network isolation check unexpectedly reached the public internet');
    console.log('NETWORK_ISOLATION_CONFIRMED: outbound connection blocked');
  }
} else if (engine === 'claude') {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required for WORKER_ENGINE=claude');
  await run('claude', ['-p', '--dangerously-skip-permissions', '--output-format', 'json', '--max-turns', process.env.WORKER_MAX_TURNS ?? '30', prompt]);
} else if (engine === 'dsh') {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY is required for WORKER_ENGINE=dsh');
  await run('python3', ['/opt/worker/dsh_runner.py', '--workspace', '/workspace', '--dsh-home', '/home/agent/.dsh', '--model', process.env.DSH_MODEL ?? 'deepseek-flash', prompt]);
} else {
  throw new Error(`Unsupported WORKER_ENGINE: ${engine}`);
}

await validate();
