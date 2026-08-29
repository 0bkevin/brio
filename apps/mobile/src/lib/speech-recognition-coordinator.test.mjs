import assert from 'node:assert/strict';
import test from 'node:test';

import { SpeechRecognitionCoordinator } from './speech-recognition-coordinator.ts';

class FakeSpeechDriver {
  listeners = new Map();
  state = 'inactive';
  aborts = 0;
  abortChangesState = true;
  stops = 0;

  abort() {
    this.aborts += 1;
    if (this.abortChangesState) this.state = 'inactive';
  }

  addListener(event, listener) {
    this.listeners.set(event, listener);
    return { remove() {} };
  }

  emit(event, payload = null) {
    this.listeners.get(event)?.(payload);
  }

  async getStateAsync() {
    return this.state;
  }

  start() {
    this.state = 'recognizing';
  }

  stop() {
    this.stops += 1;
    this.state = 'stopping';
  }
}

function sink(events, name) {
  return {
    onEnd: () => events.push(`${name}:end`),
    onError: () => events.push(`${name}:error`),
    onNoMatch: () => events.push(`${name}:nomatch`),
    onResult: () => events.push(`${name}:result`),
    onStart: () => events.push(`${name}:start`),
  };
}

test('serializes singleton recognition events to exactly one owner', () => {
  const driver = new FakeSpeechDriver();
  const coordinator = new SpeechRecognitionCoordinator(driver);
  const events = [];
  const first = Symbol('first');

  assert.equal(coordinator.claim(first, sink(events, 'first')), true);
  assert.equal(coordinator.claim(Symbol('second'), sink(events, 'second')), false);
  coordinator.start(first, {});
  driver.emit('start');
  driver.emit('result', { transcript: 'hello' });
  driver.emit('end');

  assert.deepEqual(events, ['first:start', 'first:result', 'first:end']);
  assert.equal(coordinator.claim(Symbol('second'), sink(events, 'second')), true);
});

test('does not allow a restart between an error and its trailing end event', () => {
  const driver = new FakeSpeechDriver();
  const coordinator = new SpeechRecognitionCoordinator(driver, 1000, 10);
  const events = [];
  const first = Symbol('first');

  coordinator.claim(first, sink(events, 'first'));
  coordinator.start(first, {});
  driver.emit('error', { error: 'network' });
  assert.equal(coordinator.claim(Symbol('second'), sink(events, 'second')), false);
  driver.emit('end');
  assert.deepEqual(events, ['first:error', 'first:end']);
});

test('force-aborts a recognizer that never finishes stopping', async () => {
  const driver = new FakeSpeechDriver();
  const coordinator = new SpeechRecognitionCoordinator(driver, 5, 5);
  const events = [];
  const owner = Symbol('owner');

  coordinator.claim(owner, sink(events, 'owner'));
  coordinator.start(owner, {});
  coordinator.stop(owner);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(driver.stops, 1);
  assert.equal(driver.aborts, 1);
  assert.deepEqual(events, ['owner:end']);
});

test('eventually releases a recognizer even when abort never changes native state', async () => {
  const driver = new FakeSpeechDriver();
  driver.abortChangesState = false;
  const coordinator = new SpeechRecognitionCoordinator(driver, 5, 5, 5);
  const events = [];
  const owner = Symbol('owner');

  coordinator.claim(owner, sink(events, 'owner'));
  coordinator.start(owner, {});
  coordinator.abort(owner);
  await new Promise((resolve) => setTimeout(resolve, 8));

  assert.equal(driver.state, 'recognizing');
  assert.deepEqual(events, ['owner:end']);
  assert.equal(coordinator.claim(Symbol('too-early'), sink(events, 'too-early')), false);
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.equal(coordinator.claim(Symbol('next'), sink(events, 'next')), true);
});

test('drains a delayed old end before allowing the next session', async () => {
  const driver = new FakeSpeechDriver();
  const coordinator = new SpeechRecognitionCoordinator(driver, 5, 5, 50);
  const events = [];
  const first = Symbol('first');
  const second = Symbol('second');

  coordinator.claim(first, sink(events, 'first'));
  coordinator.start(first, {});
  coordinator.abort(first);
  await new Promise((resolve) => setTimeout(resolve, 8));
  assert.equal(coordinator.claim(second, sink(events, 'second')), false);

  driver.emit('end');
  assert.equal(coordinator.claim(second, sink(events, 'second')), true);
  coordinator.start(second, {});
  driver.emit('result', { transcript: 'new' });

  assert.deepEqual(events, ['first:end', 'second:result']);
});
