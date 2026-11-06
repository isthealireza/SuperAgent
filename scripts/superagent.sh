#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command="${1:-status}"
case "$command" in
  start)
    systemctl --user start docker.service
    ready=0
    for _ in {1..30}; do
      if docker info >/dev/null 2>&1; then ready=1; break; fi
      sleep 2
    done
    (( ready == 1 )) || { echo 'Docker did not become ready.' >&2; exit 1; }
    systemctl --user start dsh-superagent.service
    if /usr/local/bin/node --env-file-if-exists=.env -e "const u = process.env.PUBLIC_WEBHOOK_URL || ''; process.exit(process.env.CLOUDFLARED_TUNNEL_TOKEN && process.env.GITHUB_TOKEN && u.startsWith('https://') && !u.includes('your-stable-hostname') ? 0 : 1)"; then
      [[ -x /home/alpha/.local/bin/cloudflared ]] || { echo 'Install cloudflared before enabling the named tunnel.' >&2; exit 1; }
      systemctl --user enable --now dsh-superagent-tunnel.service
    else
      echo 'Router is running. Public GitHub ingress awaits the named tunnel and GitHub settings in .env.'
    fi
    ready=0
    for _ in {1..30}; do
      if curl -fsS http://127.0.0.1:3088/health >/dev/null; then ready=1; break; fi
      sleep 1
    done
    (( ready == 1 )) || { echo 'Router did not become healthy.' >&2; exit 1; }
    curl -fsS http://127.0.0.1:3088/health
    ;;
  status)
    systemctl --user --no-pager --full status docker.service dsh-superagent.service dsh-superagent-tunnel.service || true
    curl -fsS http://127.0.0.1:3088/health || true
    ;;
  stop)
    systemctl --user stop dsh-superagent-tunnel.service dsh-superagent.service
    ;;
  restart)
    "$0" stop
    "$0" start
    ;;
  logs)
    journalctl --user -u dsh-superagent.service -u dsh-superagent-tunnel.service -f
    ;;
  *)
    echo "Usage: $0 {start|status|stop|restart|logs}" >&2
    exit 2
    ;;
esac
