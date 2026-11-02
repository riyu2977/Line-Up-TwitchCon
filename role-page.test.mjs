import test from 'node:test';
import assert from 'node:assert/strict';
import { renderRolePage, rolePageStatus } from './role-page.mjs';

test('role page is responsive, accessible, and reveals data only after a draw request', () => {
  const html = renderRolePage('safe_token-123');
  assert.match(html, /Role Assignment/);
  assert.match(html, /Get My Role/);
  assert.match(html, /\/api\/role\/safe_token-123\/status/);
  assert.match(html, /setInterval\(syncRound,1200\)/);
  assert.match(html, /role="status"/);
  assert.match(html, /@media\(max-width:520px\)/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /fetch\('\/api\/role\/safe_token-123\/draw'/);
  assert.match(html, /Get My Role/);
  assert.match(html, /Each click draws one role from the shared pool/);
  assert.match(html, /Draw Another Role/);
  assert.match(html, /This click consumed one role from the shared pool/);
  assert.match(html, /poolExhausted/);
  assert.doesNotMatch(html.split('<script>')[0], /targetWord|Saboteur|Builder/);
  assert.match(html, /does not verify Twitch identity/);
  assert.throws(() => renderRolePage('<script>'), /Invalid role link token/);
});

test('embedded role-page script parses as JavaScript', () => {
  const script = renderRolePage('safe_token-123').match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});

test('role page status exposes only the phase and round identity for stale-view refresh', () => {
  const status = rolePageStatus({ phase: 'active', matchNumber: 4, roundNumber: 2, targetWord: 'secret', roles: ['builder'] });
  assert.deepEqual(status, { phase: 'active', matchNumber: 4, roundNumber: 2 });
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.equal(JSON.stringify(status).includes('builder'), false);
});
