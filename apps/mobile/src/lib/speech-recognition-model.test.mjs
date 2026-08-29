import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendSpeechTranscript,
  mergeSpeechSegment,
  normalizeSpeechRecognitionLocale,
  speechRecognitionErrorMessage,
} from './speech-recognition-model.ts';

test('adds dictated text to an existing draft without changing its content', () => {
  assert.equal(appendSpeechTranscript('', '  draft a reply  '), 'draft a reply');
  assert.equal(appendSpeechTranscript('Please', '  draft a reply  '), 'Please draft a reply');
  assert.equal(appendSpeechTranscript('Please\n', 'draft a reply'), 'Please\ndraft a reply');
});

test('combines sequential final recognition segments', () => {
  assert.equal(mergeSpeechSegment('', 'hello there'), 'hello there');
  assert.equal(mergeSpeechSegment('hello there', 'how are you'), 'hello there how are you');
  assert.equal(mergeSpeechSegment('hello', 'hello there'), 'hello there');
});

test('turns recognition failures into useful composer messages', () => {
  assert.equal(speechRecognitionErrorMessage('aborted'), '');
  assert.match(speechRecognitionErrorMessage('not-allowed'), /device settings/);
  assert.match(speechRecognitionErrorMessage('no-speech'), /didn't hear/);
});

test('normalizes system locales and keeps dictated drafts within composer limits', () => {
  assert.equal(normalizeSpeechRecognitionLocale('es_VE'), 'es-VE');
  assert.equal(normalizeSpeechRecognitionLocale('en-US-u-ca-gregory'), 'en-US');
  assert.equal(appendSpeechTranscript('a'.repeat(19_999), 'hello').length, 20_000);
});
