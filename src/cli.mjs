import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { processIssue, startServer } from './router.mjs';

function options(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!key.startsWith('--')) continue;
    values[key.slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  }
  return values;
}

const [command, ...args] = process.argv.slice(2);
if (command === 'start') {
  await startServer();
} else if (command === 'trigger') {
  const opts = options(args);
  const input = {
    sender: String(opts.sender ?? ''),
    event: String(opts.event ?? 'issues'),
    action: String(opts.action ?? 'opened'),
    issueNumber: Number.isSafeInteger(Number(opts['issue-number'])) ? Number(opts['issue-number']) : null,
    id: String(opts.id ?? randomUUID()),
    title: String(opts.title ?? 'Manual request'),
    body: String(opts.body ?? ''),
  };
  const result = await processIssue(input);
  console.log(JSON.stringify(result, null, 2));
  if (!result.accepted) process.exitCode = 2;
} else {
  console.log('Usage: npm start | npm run trigger -- --sender isthealireza --event issues --action opened --title "..." --body "..."');
  process.exitCode = command ? 2 : 0;
}
