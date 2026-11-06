import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { gate, verifySignature } from '../src/security.mjs';

const allowlist = new Set(['isthealireza']);
const base = { sender: 'isthealireza', event: 'issues', action: 'opened', body: '@superagent fix the failing test', mention: '@superagent', allowlist };

test('authorized, mentioned coding issue passes the zero-token gate', () => {
  assert.deepEqual(gate(base), { ok: true });
});

test('unauthorized sender is rejected before triage', () => {
  assert.equal(gate({ ...base, sender: 'stranger' }).reason, 'sender_not_allowed');
});

test('unsupported event and missing mention are rejected', () => {
  assert.equal(gate({ ...base, event: 'push' }).reason, 'event_not_supported');
  assert.equal(gate({ ...base, body: 'please fix the failing test' }).reason, 'missing_trigger_mention');
});

test('webhook signature verification is constant-time and rejects malformed values', () => {
  const payload = Buffer.from('{"action":"opened"}');
  const signature = `sha256=${createHmac('sha256', 'secret').update(payload).digest('hex')}`;
  assert.equal(verifySignature('secret', signature, payload), true);
  assert.equal(verifySignature('other', signature, payload), false);
  assert.equal(verifySignature('secret', 'sha1=bad', payload), false);
});
