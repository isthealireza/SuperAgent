const apiRoot = 'https://api.github.com';
const markerFor = issueNumber => `<!-- dsh-superagent:issue-${issueNumber} -->`;

async function request(fetchImpl, token, route, { method = 'GET', body } = {}) {
  const response = await fetchImpl(`${apiRoot}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`GitHub API ${method} ${route} returned ${response.status}: ${result.message ?? 'unknown error'}`);
  return result;
}

async function findStatusComment(fetchImpl, token, owner, repo, issueNumber) {
  for (let page = 1; page <= 10; page += 1) {
    const comments = await request(fetchImpl, token,
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`);
    const match = comments.find(comment => String(comment.body ?? '').includes(markerFor(issueNumber)));
    if (match) return match;
    if (comments.length < 100) return null;
  }
  throw new Error(`GitHub issue #${issueNumber} has too many comments to safely find the existing Super Agent status`);
}

async function enableAutoMerge(fetchImpl, token, pullRequestId) {
  if (!pullRequestId) throw new Error('GitHub did not return a pull request node id for auto-merge');
  const response = await fetchImpl(`${apiRoot}/graphql`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({
      query: 'mutation EnableAgentAutoMerge($pullRequestId: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }) { pullRequest { autoMergeRequest { enabledAt mergeMethod } } } }',
      variables: { pullRequestId },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.errors?.length) {
    throw new Error(`GitHub auto-merge request failed: ${result.errors?.[0]?.message ?? `HTTP ${response.status}`}`);
  }
  const request = result.data?.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest;
  if (!request?.enabledAt) throw new Error('GitHub did not confirm that auto-merge was enabled');
  return { enabled: true, enabledAt: request.enabledAt, mergeMethod: request.mergeMethod };
}

/** Push a verified branch, open/reuse its PR, and upsert one status comment. */
export async function publishSuccessfulTask(cfg, task, result, { fetchImpl = fetch, pushBranch } = {}) {
  if (!cfg.createPullRequest) return null;
  if (!cfg.githubToken || !cfg.githubOwner || !cfg.githubRepo) {
    throw new Error('CREATE_PULL_REQUEST requires GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO');
  }
  if (typeof pushBranch !== 'function') throw new Error('A router-side branch push function is required');

  const { githubOwner: owner, githubRepo: repo, githubToken: token } = cfg;
  const root = `/repos/${owner}/${repo}`;
  const repository = await request(fetchImpl, token, root);
  if (!repository.default_branch) throw new Error('GitHub repository response did not contain default_branch');

  await pushBranch(result.branch);

  const head = `${owner}:${result.branch}`;
  const existing = await request(fetchImpl, token, `${root}/pulls?${new URLSearchParams({ head, state: 'open', per_page: '100' })}`);
  let pr = existing[0];
  if (!pr) {
    const issueLink = Number.isSafeInteger(task.issueNumber) ? `\n\nCloses #${task.issueNumber}.` : '';
    pr = await request(fetchImpl, token, `${root}/pulls`, {
      method: 'POST',
      body: {
        title: `Fix: ${task.title}`.slice(0, 240),
        head: result.branch,
        base: repository.default_branch,
        body: `${task.prompt}\n\nValidation passed in the isolated Worker. ${cfg.autoMerge ? 'GitHub auto-merge was requested and will proceed only when repository rules allow it.' : 'Human review is required; auto-merge is disabled.'}${issueLink}`,
        draft: false,
      },
    });
  }

  const autoMerge = cfg.autoMerge ? await enableAutoMerge(fetchImpl, token, pr.node_id) : { enabled: false };

  let commentUrl = null;
  if (Number.isSafeInteger(task.issueNumber)) {
    const marker = markerFor(task.issueNumber);
    const files = (result.changedFiles ?? []).map(file => `- \`${file}\``).join('\n') || '- No file summary available';
    const comment = [
      '### DeepSeek Super Agent: ready for review',
      '',
      `- Pull request: ${pr.html_url}`,
      `- Branch: \`${result.branch}\``,
      '- Reproduction: confirmed before the fix',
      '- Validation: passed in the isolated Worker',
      cfg.autoMerge
        ? '- Auto-merge: requested after worker validation; GitHub will merge when repository rules allow it'
        : '- Auto-merge: disabled; human review is required',
      '',
      'Changed files:',
      files,
      '',
      marker,
    ].join('\n');
    const current = await findStatusComment(fetchImpl, token, owner, repo, task.issueNumber);
    const saved = current
      ? await request(fetchImpl, token, `/repos/${owner}/${repo}/issues/comments/${current.id}`, { method: 'PATCH', body: { body: comment } })
      : await request(fetchImpl, token, `${root}/issues/${task.issueNumber}/comments`, { method: 'POST', body: { body: comment } });
    commentUrl = saved.html_url ?? null;
  }
  return { prUrl: pr.html_url, commentUrl, autoMerge };
}

export async function registerGitHubWebhook(cfg, { fetchImpl = fetch, stateFile } = {}) {
  if (!cfg.githubToken || !cfg.githubOwner || !cfg.githubRepo || !cfg.webhookSecret || !cfg.publicWebhookUrl) {
    throw new Error('Webhook setup requires GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, WEBHOOK_SECRET, and PUBLIC_WEBHOOK_URL');
  }
  const target = new URL(cfg.publicWebhookUrl);
  if (target.protocol !== 'https:' || !target.pathname.endsWith('/github/webhook')) {
    throw new Error('PUBLIC_WEBHOOK_URL must be an HTTPS URL ending in /github/webhook');
  }
  const { githubOwner: owner, githubRepo: repo, githubToken: token } = cfg;
  const root = `/repos/${owner}/${repo}`;
  let hookId = null;
  if (stateFile) {
    const { readFile } = await import('node:fs/promises');
    hookId = await readFile(stateFile, 'utf8').catch(() => null);
    hookId = hookId?.trim() || null;
  }
  let hook = null;
  if (hookId) {
    try { hook = await request(fetchImpl, token, `${root}/hooks/${encodeURIComponent(hookId)}`); }
    catch (error) { if (!String(error.message).includes('returned 404')) throw error; }
  }
  const payload = {
    name: 'web', active: true, events: ['issues', 'issue_comment'],
    config: { url: target.toString(), content_type: 'json', secret: cfg.webhookSecret, insecure_ssl: '0' },
  };
  if (hook) {
    hook = await request(fetchImpl, token, `${root}/hooks/${encodeURIComponent(hookId)}`, { method: 'PATCH', body: payload });
  } else {
    const hooks = await request(fetchImpl, token, `${root}/hooks?per_page=100`);
    hook = hooks.find(item => item.name === 'web' && item.config?.url === target.toString());
    hook = hook
      ? await request(fetchImpl, token, `${root}/hooks/${hook.id}`, { method: 'PATCH', body: payload })
      : await request(fetchImpl, token, `${root}/hooks`, { method: 'POST', body: payload });
  }
  if (!hook?.id) throw new Error('GitHub webhook API did not return a hook id');
  if (stateFile) {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
    await writeFile(stateFile, `${hook.id}\n`, { mode: 0o600 });
  }
  return { id: hook.id, url: target.toString(), events: payload.events };
}
