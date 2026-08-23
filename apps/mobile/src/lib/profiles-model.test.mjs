import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_PROFILE_NAME,
  buildBrioDeepLink,
  environmentId,
  environmentKey,
  isNamedProfile,
  parseBrioDeepLink,
  profileName,
  profilePathPrefix,
  profileScope,
  profileSetupCommand,
  resolveBrioDeepLink,
  scopedPath,
} from './profiles-model.ts';
import { threadMatchesScope } from '../state/chat-thread-model.ts';

const relayConnection = {
  id: 'agent_123',
  agentId: 'agent_123',
  name: 'Hermes',
  mode: 'brio_hosted',
  transport: 'relay',
  status: 'online',
  capabilities: {},
  url: 'https://relay.example.com',
  token: '',
};

test('environment identity is stable and prefers the relay agent id', () => {
  assert.equal(environmentId(relayConnection), 'agent_123');
  assert.equal(environmentId({ ...relayConnection, agentId: undefined }), 'agent_123');
  assert.equal(environmentId(null), '');
});

test('environment key keeps the legacy connectionKey format', () => {
  assert.equal(
    environmentKey(relayConnection),
    'relay:https://relay.example.com:agent_123',
  );
});

test('profile names normalize and default to the stock Hermes home', () => {
  assert.equal(profileName(undefined), DEFAULT_PROFILE_NAME);
  assert.equal(profileName(''), DEFAULT_PROFILE_NAME);
  assert.equal(profileName('  coder '), 'coder');
});

test('named profiles produce a /p/<name>/ prefix; default stays unprefixed', () => {
  assert.equal(profilePathPrefix('default'), '');
  assert.equal(profilePathPrefix(undefined), '');
  assert.equal(profilePathPrefix('coder'), '/p/coder');
  // Special characters are encoded so a hostile name cannot escape the
  // prefix segment.
  assert.equal(profilePathPrefix('a b'), '/p/a%20b');
});

test('scoped paths never mix profiles', () => {
  assert.equal(scopedPath('/api/sessions', 'default'), '/api/sessions');
  assert.equal(scopedPath('/api/sessions?limit=5', undefined), '/api/sessions?limit=5');
  assert.equal(scopedPath('/api/sessions', 'research'), '/p/research/api/sessions');
});

test('profile scope differs per environment AND per profile', () => {
  const base = profileScope(relayConnection, 'coder');
  assert.equal(base, 'relay:https://relay.example.com:agent_123::coder');
  assert.equal(
    profileScope(relayConnection, 'writer') === base,
    false,
    'two profiles of one environment must never share a scope',
  );
  assert.notEqual(
    profileScope({ ...relayConnection, agentId: 'other' }, 'coder'),
    base,
    'the same profile on another environment must never share a scope',
  );
});

test('isNamedProfile distinguishes real profiles from the stock home', () => {
  assert.equal(isNamedProfile('default'), false);
  assert.equal(isNamedProfile(null), false);
  assert.equal(isNamedProfile('coder'), true);
});

test('deep links round-trip the full (environment, profile, session) identity', () => {
  const link = buildBrioDeepLink({
    environmentId: 'agent_123',
    profile: 'research',
    sessionId: 'sess_42',
  });
  assert.equal(link.includes('agent=agent_123'), true);
  assert.ok(link.includes('profile=research'));
  assert.ok(link.includes('session=sess_42'));

  const parsed = parseBrioDeepLink(link);
  assert.deepEqual(parsed, {
    environmentId: 'agent_123',
    profile: 'research',
    sessionId: 'sess_42',
  });

  const minimal = parseBrioDeepLink(buildBrioDeepLink({ environmentId: 'agent_123' }));
  assert.deepEqual(minimal, { environmentId: 'agent_123' });
});

test('deep link parsing rejects foreign URLs and missing agents', () => {
  assert.equal(parseBrioDeepLink('https://evil.example/brio://chat'), null);
  assert.equal(parseBrioDeepLink('brio://other?agent=agent_123'), null);
  assert.equal(parseBrioDeepLink('brio://chat?profile=coder'), null);
  assert.equal(parseBrioDeepLink('not a url'), null);
});

function makeThread(overrides) {
  return {
    id: overrides.id ?? 'thread_1',
    connectionKey: 'relay:https://relay.example.com:agent_123',
    title: 't',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    ...overrides,
  };
}

test('thread scoping isolates threads per profile with legacy fallback', () => {
  const legacy = makeThread({ id: 'legacy' });
  const coder = makeThread({ id: 'c', profile: 'coder' });
  const writer = makeThread({ id: 'w', profile: 'writer' });

  // Legacy rows (no stored profile) belong to the default profile so an
  // upgrade never strands existing conversations.
  assert.equal(threadMatchesScope(legacy, environmentKey(relayConnection), undefined), true);
  assert.equal(threadMatchesScope(legacy, environmentKey(relayConnection), 'default'), true);
  assert.equal(threadMatchesScope(legacy, environmentKey(relayConnection), 'coder'), false);

  assert.equal(threadMatchesScope(coder, environmentKey(relayConnection), 'coder'), true);
  // Negative isolation checks: no cross-profile leakage.
  assert.equal(threadMatchesScope(coder, environmentKey(relayConnection), 'writer'), false);
  assert.equal(threadMatchesScope(writer, environmentKey(relayConnection), 'default'), false);
  assert.equal(threadMatchesScope(coder, 'relay:https://relay.example.com:other', 'coder'), false);
});

test('setup commands follow the per-profile alias convention', () => {
  assert.equal(profileSetupCommand('default'), 'hermes setup --portal');
  assert.equal(profileSetupCommand('coder'), 'hermes -p coder setup --portal');
});

test('deep links survive URL-encoded profiles and omit empty sessions', () => {
  const link = buildBrioDeepLink({ environmentId: 'agent_x', profile: 'research bot' });
  assert.ok(link.includes('profile=research+bot') || link.includes('profile=research%20bot'));
  const parsed = parseBrioDeepLink(link);
  assert.equal(parsed.profile, 'research bot');
  assert.equal(parsed.sessionId, undefined);

  const dropped = parseBrioDeepLink('brio://chat?agent=&profile=coder');
  assert.equal(dropped, null);
});

test('deep link identity matches only the exact environment', () => {
  const parsed = parseBrioDeepLink(buildBrioDeepLink({ environmentId: 'agent_123', profile: 'coder' }));
  const otherEnvironment = { ...relayConnection, agentId: 'agent_2', id: 'agent_2' };
  assert.equal(environmentId(relayConnection) === parsed.environmentId, true);
  assert.equal(environmentId(otherEnvironment) === parsed.environmentId, false);

  // Exercise the resolver used by ChatWorkspace, including the exact profile
  // and session identity returned to the importer.
  assert.deepEqual(
    resolveBrioDeepLink(parsed, environmentId(relayConnection), [
      { name: 'default' },
      { name: 'coder' },
    ]),
    { environmentId: 'agent_123', profile: 'coder' },
  );
  assert.equal(resolveBrioDeepLink(parsed, 'agent_2', [{ name: 'coder' }]), null);
  assert.equal(resolveBrioDeepLink(parsed, 'agent_123', [{ name: 'writer' }]), null);

  const withSession = parseBrioDeepLink(
    buildBrioDeepLink({ environmentId: 'agent_123', profile: 'coder', sessionId: 'sess_7' }),
  );
  assert.deepEqual(
    resolveBrioDeepLink(withSession, 'agent_123', [{ name: 'coder' }]),
    { environmentId: 'agent_123', profile: 'coder', sessionId: 'sess_7' },
  );
});
