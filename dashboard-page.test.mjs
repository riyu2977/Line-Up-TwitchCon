import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardPage } from './dashboard-page.mjs';

test('dashboard uses real application controls, state bindings, and responsive game layout', () => {
  for (const id of [
    'match-display', 'timer-display', 'state', 'broadcaster-label', 'canvas',
    'messages', 'host-controls-toggle', 'host-start', 'host-end-round',
    'host-next', 'host-new-match', 'host-guess-form', 'player-count',
    'host-disconnect', 'host-role-link', 'host-notice',
  ]) assert.match(dashboardPage, new RegExp(`id="${id}"`));
  assert.match(dashboardPage, /@media\(max-width:900px\)/);
  assert.match(dashboardPage, /@media\(max-width:560px\)/);
  assert.match(dashboardPage, /gameState\.lines/);
  assert.match(dashboardPage, /hostAction\('\/api\/host\/start'\)/);
  assert.match(dashboardPage, /hostAction\('\/api\/host\/guess'/);
  assert.match(dashboardPage, /hostEndRound\.hidden=false/);
  assert.match(dashboardPage, /hostGuessForm\.hidden=false/);
  assert.match(dashboardPage, /class="mascot-pair"/);
  assert.match(dashboardPage, /grid-template-columns:minmax\(138px,1\.08fr\) minmax\(380px,3\.9fr\)/);
  assert.doesNotMatch(dashboardPage, /viewer123|AREYOU_07|AAW045|02:47|Players<strong>20/);
});

test('embedded dashboard script parses as JavaScript', () => {
  const script = dashboardPage.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
});
