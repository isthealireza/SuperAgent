import test from 'node:test';
import assert from 'node:assert/strict';
import { publishSuccessfulTask, registerGitHubWebhook } from '../src/github.mjs';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

test('verified task pushes, opens a PR, and updates one structured issue status comment', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/repos/isthealireza/SuperAgent')) return jsonResponse({ default_branch: 'main' });
    if (String(url).includes('/pulls?')) return jsonResponse([]);
    if (String(url).endsWith('/pulls')) return jsonResponse({ html_url: 'https://github.com/isthealireza/SuperAgent/pull/19', number: 19 });
    if (String(url).includes('/issues/42/comments?')) return jsonResponse([{ id: 8, body: '<!-- dsh-superagent:issue-42 --> previous status' }]);
    if (String(url).endsWith('/issues/comments/8')) return jsonResponse({ html_url: 'https://github.com/isthealireza/SuperAgent/issues/42#issuecomment-8' });
    throw new Error(`Unexpected GitHub request ${url}`);
  };
  let pushed;
  const result = await publishSuccessfulTask({
    createPullRequest: true, githubOwner: 'isthealireza', githubRepo: 'SuperAgent', githubToken: 'test-token',
  }, {
    issueNumber: 42, title: 'Fix typo', prompt: 'Correct the typo after reproducing it.',
  }, { branch: 'agent/task-42-1234', changedFiles: ['sample.txt'] }, {
    fetchImpl,
    pushBranch: async branch => { pushed = branch; },
  });

  assert.equal(pushed, 'agent/task-42-1234');
  assert.equal(result.prUrl, 'https://github.com/isthealireza/SuperAgent/pull/19');
  assert.equal(result.commentUrl, 'https://github.com/isthealireza/SuperAgent/issues/42#issuecomment-8');
  assert.equal(calls.find(call => call.method === 'POST' && call.url.endsWith('/pulls')).body.base, 'main');
  assert.equal(calls.find(call => call.method === 'POST' && call.url.endsWith('/pulls')).body.draft, false);
  const update = calls.find(call => call.method === 'PATCH');
  assert.match(update.body.body, /Closes #42|ready for review/);
  assert.match(update.body.body, /sample\.txt/);
  assert.ok(!calls.some(call => call.method === 'POST' && call.url.includes('/issues/42/comments')));
});

test('successful local tasks do not contact GitHub when PR publishing is disabled', async () => {
  let pushed = false;
  const result = await publishSuccessfulTask({ createPullRequest: false }, {}, {}, {
    pushBranch: async () => { pushed = true; },
    fetchImpl: async () => { throw new Error('GitHub should not be called'); },
  });
  assert.equal(result, null);
  assert.equal(pushed, false);
});

test('webhook registration binds the stable HTTPS endpoint and subscribes only to issue events', async () => {
  const calls = [];
  let currentHook = null;
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/hooks?per_page=100')) return jsonResponse(currentHook ? [currentHook] : []);
    if (String(url).endsWith('/hooks') && init.method === 'POST') {
      currentHook = { id: 77, name: 'web', config: init.body ? JSON.parse(init.body).config : {} };
      return jsonResponse(currentHook, 201);
    }
    if (String(url).endsWith('/hooks/77') && init.method === 'GET') return jsonResponse(currentHook);
    if (String(url).endsWith('/hooks/77') && init.method === 'PATCH') {
      currentHook = { ...currentHook, config: JSON.parse(init.body).config };
      return jsonResponse(currentHook);
    }
    throw new Error(`Unexpected GitHub request ${url}`);
  };
  const cfg = {
    githubToken: 'test-token', githubOwner: 'isthealireza', githubRepo: 'SuperAgent',
    webhookSecret: 'test-secret', publicWebhookUrl: 'https://agent.example.com/github/webhook',
  };
  const result = await registerGitHubWebhook(cfg, { fetchImpl });
  assert.equal(result.id, 77);
  assert.deepEqual(result.events, ['issues', 'issue_comment']);
  const create = calls.find(call => call.method === 'POST');
  assert.equal(create.body.config.secret, 'test-secret');
  assert.equal(create.body.config.insecure_ssl, '0');
  assert.equal(create.body.active, true);
});

test('webhook registration rejects non-HTTPS public endpoints before contacting GitHub', async () => {
  let called = false;
  await assert.rejects(registerGitHubWebhook({
    githubToken: 'test-token', githubOwner: 'owner', githubRepo: 'repo',
    webhookSecret: 'secret', publicWebhookUrl: 'http://agent.example.com/github/webhook',
  }, { fetchImpl: async () => { called = true; } }), /HTTPS URL/);
  assert.equal(called, false);
});
