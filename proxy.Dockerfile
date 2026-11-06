FROM node:24.22.2-bookworm-slim
ENV NODE_ENV=production
RUN groupadd --gid 10001 agentproxy \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin agentproxy \
 && mkdir -p /opt/proxy \
 && chown -R 10001:10001 /opt/proxy
COPY --chown=10001:10001 worker/egress-proxy.mjs /opt/proxy/server.mjs
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=2s --timeout=2s --start-period=2s --retries=10 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/opt/proxy/server.mjs"]
