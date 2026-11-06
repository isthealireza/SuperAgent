import { createServer } from 'node:http';
import { Readable } from 'node:stream';

const port = Number(process.env.PORT ?? 8080);
const claudeKey = process.env.ANTHROPIC_API_KEY ?? '';
const deepseekKey = process.env.DEEPSEEK_API_KEY ?? '';
const claudeBase = new URL(process.env.ANTHROPIC_UPSTREAM_URL ?? 'https://api.anthropic.com');
const deepseekBase = new URL(process.env.DEEPSEEK_UPSTREAM_URL ?? 'https://api.deepseek.com');

if (!['https:', 'http:'].includes(claudeBase.protocol) || !['https:', 'http:'].includes(deepseekBase.protocol)) {
  throw new Error('Model upstreams must use HTTP or HTTPS');
}

function targetUrl(base, suffix, search) {
  const target = new URL(base);
  target.pathname = `${target.pathname.replace(/\/$/, '')}${suffix}`;
  target.search = search;
  return target;
}

async function readBody(req, maximum = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok\n');
    return;
  }
  let upstream;
  let key;
  let api = '';
  const path = new URL(req.url ?? '/', 'http://proxy.local').pathname;
  if (req.method === 'POST' && path.startsWith('/anthropic/')) {
    const suffix = path.slice('/anthropic'.length);
    if (!['/v1/messages', '/v1/messages/count_tokens'].includes(suffix)) {
      res.writeHead(403).end('endpoint_not_allowed');
      return;
    }
    upstream = targetUrl(claudeBase, suffix, new URL(req.url, 'http://proxy.local').search);
    key = claudeKey;
    api = 'anthropic';
  } else if (req.method === 'POST' && path.startsWith('/deepseek/')) {
    const suffix = path.slice('/deepseek'.length);
    if (!['/chat/completions', '/v1/chat/completions', '/anthropic/v1/messages'].includes(suffix)) {
      res.writeHead(403).end('endpoint_not_allowed');
      return;
    }
    upstream = targetUrl(deepseekBase, suffix, new URL(req.url, 'http://proxy.local').search);
    key = deepseekKey;
    api = 'deepseek';
  } else {
    res.writeHead(404).end('not_found');
    return;
  }
  if (!key) {
    res.writeHead(503).end(`${api}_credential_unavailable`);
    return;
  }
  try {
    const body = await readBody(req);
    const headers = new Headers();
    if (req.headers['content-type']) headers.set('content-type', req.headers['content-type']);
    if (api === 'anthropic') {
      for (const name of ['anthropic-version', 'anthropic-beta']) if (req.headers[name]) headers.set(name, req.headers[name]);
      headers.set('x-api-key', key);
    } else {
      headers.set('authorization', `Bearer ${key}`);
    }
    const response = await fetch(upstream, { method: 'POST', headers, body, signal: AbortSignal.timeout(900_000) });
    const responseHeaders = {};
    for (const name of ['content-type', 'cache-control', 'x-request-id', 'retry-after']) {
      const value = response.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    res.writeHead(response.status, responseHeaders);
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
    console.log(`MODEL_PROXY api=${api} status=${response.status}`);
  } catch (error) {
    if (!res.headersSent) res.writeHead(error.message === 'body_too_large' ? 413 : 502);
    res.end(error.message === 'body_too_large' ? 'body_too_large' : 'upstream_unavailable');
    console.error(`MODEL_PROXY_ERROR api=${api} reason=${error.message === 'body_too_large' ? 'body_too_large' : 'upstream_failure'}`);
  }
});

server.listen(port, '0.0.0.0', () => console.log(`EGRESS_PROXY_READY port=${port}`));
