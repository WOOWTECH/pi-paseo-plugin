import test from 'node:test';
import assert from 'node:assert/strict';
import { providerReplyError } from '../src/provider-reply.mjs';

test('quota and expired login responses cannot be reported as successful chats', () => {
  assert.equal(providerReplyError("You've hit your weekly limit · resets Oct 14, 7am (UTC)"), 'PROVIDER_QUOTA_EXHAUSTED');
  assert.equal(providerReplyError('Authentication required. Please sign in.'), 'PROVIDER_AUTH_REQUIRED');
  assert.equal(providerReplyError('PI_PASEO_abcdef123456'), null);
  assert.equal(providerReplyError('Here is your requested code.'), null);
});

test('gateway billing, exhausted quota, and temporary rate limits are distinct', () => {
  assert.equal(providerReplyError('API Error: 402 {"error":{"message":"upstream provider declined request for billing reason"}}'), 'PROVIDER_BILLING_REQUIRED');
  assert.equal(providerReplyError('HTTP 429 {"error":{"code":"usage_limit_reached"}}'), 'PROVIDER_QUOTA_EXHAUSTED');
  assert.equal(providerReplyError('HTTP 429 {"error":{"code":"rate_limit_exceeded"}}'), 'PROVIDER_RATE_LIMITED');
  assert.equal(providerReplyError('API Error: 401 {"error":{"type":"invalid_api_key"}}'), 'PROVIDER_AUTH_REQUIRED');
  assert.equal(providerReplyError('There are 402 records and 429 entries.'), null);
});
