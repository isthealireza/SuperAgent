FROM node:24.22.2-bookworm-slim AS runner-deps
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates bash \
 && rm -rf /var/lib/apt/lists/*
RUN npm install --prefix /opt/claude --omit=dev @anthropic-ai/claude-code@2.1.318
RUN python3 -m venv /opt/dsh-venv \
 && /opt/dsh-venv/bin/pip install --no-cache-dir deepseek-harness-sdk==0.2.1rc2

FROM node:24.22.2-bookworm-slim AS worker
ENV DEBIAN_FRONTEND=noninteractive \
    PATH=/opt/claude/node_modules/.bin:/opt/dsh-venv/bin:$PATH \
    HOME=/home/agent \
    DSH_HOME=/home/agent/.dsh \
    PYTHONDONTWRITEBYTECODE=1 \
    npm_config_update_notifier=false \
    DISABLE_AUTOUPDATER=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 git ca-certificates bash \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid 10001 --create-home --shell /bin/bash agent \
 && mkdir -p /workspace /home/agent/.dsh \
 && chown -R 10001:10001 /workspace /home/agent
COPY --from=runner-deps /opt/claude /opt/claude
COPY --from=runner-deps /opt/dsh-venv /opt/dsh-venv
COPY worker/runner.mjs /opt/worker/runner.mjs
COPY worker/dsh_runner.py /opt/worker/dsh_runner.py
WORKDIR /workspace
USER 10001:10001
ENTRYPOINT ["node", "/opt/worker/runner.mjs"]
