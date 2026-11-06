# DeepSeek Super Agent Router

Single-repository GitHub issue router with disposable, rootless-Docker workers. The Router performs signature and sender checks before any model request. Each accepted task gets a new local branch/worktree, is mounted alone into a non-root worker, runs a reproduction and configured validation command, and is returned as a local patch. An optional Router-only GitHub token can publish a draft PR. The worker has no Git metadata, GitHub token, Docker socket, SSH keys, host home, parent repository mount, or merge capability.

## Architecture

```text
GitHub webhook / CLI
        │ HMAC + sender + event + mention gates (zero tokens)
        ▼
Persistent Node Router ── cheap DeepSeek-compatible triage
        │ local branch/worktree; one bounded task at a time
        ▼
Rootless Docker worker (UID:GID 10001:10001)
  read-only image · one worktree bind · CPU/RAM/PID caps
  network none (offline fixture) or internal network with a narrow egress proxy
        │ test log + host-validated commit + patch artifact
        ▼
Human review (optional draft PR; never auto-merged)
```

Runners: `claude` invokes Claude Code non-interactively; `dsh` uses the official DeepSeek Harness Python SDK with the explicit `sdk-minimal` profile; `fixture` is only for offline integration verification. Provider keys remain in the Router-side proxy; the coding worker receives only a placeholder key and never sees provider credentials. The triage key and optional GitHub token remain Router-only. The validation command is administrator configuration, never selected from issue text or model output.

## Prerequisites and install

The reference setup uses Ubuntu WSL with systemd and rootless Docker Engine. The Docker daemon is a user service and the worker itself runs as UID 10001. From Ubuntu WSL:

```bash
cd /home/alpha/src/SuperAgent
cp .env.example .env
chmod 600 .env
# Edit .env and set WEBHOOK_SECRET, API credentials, repo path, and runner.
npm run check
npm test
```

Install the persistent user service:

```bash
mkdir -p ~/.config/systemd/user ~/.local/share/dsh-superagent
cp deploy/dsh-superagent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dsh-superagent.service
systemctl --user status dsh-superagent.service
```

The Router binds to `127.0.0.1` by default. To receive GitHub webhooks, expose that endpoint through a TLS-terminating reverse proxy or tunnel and set the same random secret in GitHub and `.env`. Do not expose the Router without HTTPS and webhook signature validation.

### Windows startup

The service runs in Ubuntu WSL but is managed from Windows. To keep WSL running after the first PowerShell command exits, copy the included hidden launcher into the current Windows user's Startup folder:

```powershell
$startup = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
Copy-Item '\\wsl.localhost\Ubuntu\home\alpha\src\SuperAgent\deploy\keep-wsl-alive.vbs' (Join-Path $startup 'DeepSeekSuperAgent.vbs')
```

At the next Windows sign-in, it starts Ubuntu WSL hidden; the enabled Docker and Router user services start with it. Health is available from Windows at `http://localhost:3088/health`.

## Configuration

| Variable | Purpose |
| --- | --- |
| `HOST`, `PORT` | Router bind address; defaults to loopback and 3088. |
| `WEBHOOK_SECRET` | Required GitHub HMAC secret. |
| `ALLOWED_SENDERS` | Comma-separated GitHub login allowlist; default `isthealireza`. |
| `TRIGGER_MENTION` | Required mention for issue and comment events; default `@superagent`. |
| `REPO_PATH` | Existing clean local clone used for task worktrees. |
| `WORKTREES_DIR`, `STATE_DIR`, `ARTIFACTS_DIR` | Router-owned task state and patch locations. |
| `MAX_QUEUE`, `MAX_PER_SENDER_PER_MINUTE` | Bounded serial queue and per-sender burst limit. |
| `TRIAGE_BASE_URL`, `TRIAGE_MODEL`, `TRIAGE_API_KEY` | OpenAI-compatible triage endpoint; called only after all hard gates. `DEEPSEEK_API_KEY` is the fallback triage key. |
| `WORKER_ENGINE` | `claude`, `dsh`, or test-only `fixture`. |
| `ANTHROPIC_API_KEY` | Claude worker credential; only passed to a Claude worker. |
| `DEEPSEEK_API_KEY`, `DSH_MODEL` | DeepSeek Harness worker configuration. |
| `ANTHROPIC_UPSTREAM_URL`, `DEEPSEEK_UPSTREAM_URL` | Router-side proxy destinations; set a trusted local-compatible endpoint here when needed. |
| `WORKER_NETWORK` | `egress` routes model calls through the internal allowlisted proxy; `none` is offline-only. |
| `WORKER_TEST_COMMAND` | Trusted project validation command; never derived from webhook content. |
| `WORKER_CPUS`, `WORKER_MEMORY`, `WORKER_PIDS`, `WORKER_TIMEOUT_SECONDS`, `WORKER_MAX_TURNS` | Resource and execution limits. |
| `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`, `CREATE_PULL_REQUEST` | Optional Router-only draft PR publishing. No merge is attempted. |

See `.env.example` for the complete template. The sample values are not credentials and must be replaced.

## Use

```bash
# Build image (also built automatically if missing on first start)
docker build -t dsh-superagent-worker:local .

# Start/inspect/stop the persistent router
systemctl --user start dsh-superagent.service
systemctl --user status dsh-superagent.service
journalctl --user -u dsh-superagent.service -f
systemctl --user stop dsh-superagent.service

# Authorized manual trigger; issue must contain @superagent
npm run trigger -- --sender isthealireza --event issues --action opened \
  --title "Fix a regression" --body "@superagent Reproduce and fix the failing test."

# Offline end-to-end synthetic task plus egress proxy check
npm run smoke
```

Health check: `curl http://127.0.0.1:3088/health`. A successful run leaves a review patch in `ARTIFACTS_DIR` and a task JSON record in `STATE_DIR`. The task branch stays local unless draft PR publishing is explicitly enabled. Stop the router with `systemctl --user stop dsh-superagent.service`; stop Docker with `systemctl --user stop docker.service`.

## Security and operating notes

- Docker daemon is rootless in WSL; worker process is separately non-root (`10001:10001`).
- Rootless UID mapping is handled by a resource-limited helper with only `CHOWN`, scoped to the one task worktree; it restores host ownership before the Router inspects or commits changes.
- Worker root filesystem is read-only. It receives one writable bind mount: its task worktree. `/tmp` and the container's private home are bounded tmpfs mounts.
- Remote model credentials stay in a Router-created proxy sidecar, not the coding worker. The worker joins an internal-only network; the proxy alone joins the outbound network and accepts only Claude Messages or DeepSeek Chat Completions paths, injecting the selected provider key.
- Default seccomp remains enabled; all Linux capabilities are dropped; `no-new-privileges`, CPU/RAM/PID limits, timeout, and bounded queue are enforced.
- Offline smoke uses `--network none`. Remote model calls use the egress proxy. The proxy destination is operator-configured; for a local model endpoint, it must be reachable from the WSL Docker network and must be treated as a trusted endpoint.
- GitHub credentials stay in the Router process; workers cannot push. Draft PR creation is Router-side and human review remains mandatory. Auto-merge is not implemented.
- Docker's WSL rootless daemon reports that cgroup I/O weighting/throughput limits are unavailable on this host. CPU, memory, and PID controls are verified separately.
- On router restart, in-flight task records are marked `interrupted`; only containers carrying this product's Docker label are stopped and removed. Other Docker data is left alone.
