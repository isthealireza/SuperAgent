import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(secret, signature, body) {
  if (!secret || !signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export function gate({ sender, event, action, body, mention, allowlist }) {
  const name = String(sender ?? '').toLowerCase();
  if (!allowlist.has(name)) return { ok: false, reason: 'sender_not_allowed' };
  const supported = (event === 'issues' && ['opened', 'reopened'].includes(action))
    || (event === 'issue_comment' && action === 'created');
  if (!supported) return { ok: false, reason: 'event_not_supported' };
  if (!String(body).toLowerCase().includes(mention)) return { ok: false, reason: 'missing_trigger_mention' };
  if (String(body ?? '').trim().length < 8) return { ok: false, reason: 'empty_request' };
  return { ok: true };
}
