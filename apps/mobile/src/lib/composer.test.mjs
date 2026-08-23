import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCompletion,
  commandParts,
  completionToken,
  composerContentFromSharedPayloads,
} from './composer-model.ts';
import { redirectSystemPath } from '../app/+native-intent.ts';

test('detects and replaces context completion tokens without flattening multiline text', () => {
  const text = 'Review this carefully\n@file:src/ma';
  const token = completionToken(text);

  assert.deepEqual(token, {
    kind: 'context',
    query: '@file:src/ma',
    start: 22,
    end: 34,
  });
  assert.equal(
    applyCompletion(text, token, '@file:src/main.ts'),
    'Review this carefully\n@file:src/main.ts ',
  );
});

test('keeps folder and reference-prefix completion ready for continued typing', () => {
  const token = completionToken('@');
  assert.equal(applyCompletion('@', token, '@folder:'), '@folder:');
  assert.equal(applyCompletion('@folder:s', completionToken('@folder:s'), '@folder:src/'), '@folder:src/');
});

test('slash commands retain command arguments including multiline context', () => {
  assert.deepEqual(commandParts('/github-pr-workflow create a draft PR'), {
    name: '/github-pr-workflow',
    argument: 'create a draft PR',
  });
  assert.deepEqual(commandParts('/plan first line\nsecond line'), {
    name: '/plan',
    argument: 'first line\nsecond line',
  });
  assert.equal(commandParts('ordinary prompt'), null);
});

test('maps native share-sheet text, URLs, and files into one composer draft', () => {
  assert.deepEqual(
    composerContentFromSharedPayloads([
      { shareType: 'text', value: '  Review this  ' },
      { shareType: 'url', value: 'https://example.com/docs' },
      {
        shareType: 'file',
        value: 'content://provider/report%20final.pdf',
        mimeType: 'application/pdf',
        contentUri: 'file:///cache/report%20final.pdf',
        contentSize: 128,
      },
    ]),
    {
      text: 'Review this\n@url:https://example.com/docs',
      attachments: [
        {
          uri: 'file:///cache/report%20final.pdf',
          name: 'report final.pdf',
          mimeType: 'application/pdf',
          size: 128,
        },
      ],
    },
  );
});

test('routes native share intents into the hydrated app without altering normal links', () => {
  assert.equal(
    redirectSystemPath({ path: 'brio://expo-sharing?payload=1', initial: true }),
    '/',
  );
  assert.equal(redirectSystemPath({ path: '/thread/session-1', initial: true }), '/thread/session-1');
  assert.equal(redirectSystemPath({ path: 'not a valid URL', initial: true }), '/');
});
