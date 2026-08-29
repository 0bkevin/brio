import {
  ExpoSpeechRecognitionModule,
  type ExpoSpeechRecognitionErrorEvent,
  type ExpoSpeechRecognitionOptions,
  type ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition';

import {
  SpeechRecognitionCoordinator,
  type SpeechRecognitionDriver,
  type SpeechRecognitionSink,
} from '@/lib/speech-recognition-coordinator';

type BrioSpeechDriver = SpeechRecognitionDriver<
  ExpoSpeechRecognitionOptions,
  ExpoSpeechRecognitionResultEvent,
  ExpoSpeechRecognitionErrorEvent
>;

const coordinator = new SpeechRecognitionCoordinator<
  ExpoSpeechRecognitionOptions,
  ExpoSpeechRecognitionResultEvent,
  ExpoSpeechRecognitionErrorEvent
>(ExpoSpeechRecognitionModule as unknown as BrioSpeechDriver);

export type BrioSpeechRecognitionSink = SpeechRecognitionSink<
  ExpoSpeechRecognitionResultEvent,
  ExpoSpeechRecognitionErrorEvent
>;

export function claimSpeechRecognition(id: symbol, sink: BrioSpeechRecognitionSink) {
  return coordinator.claim(id, sink);
}

export function startSpeechRecognition(id: symbol, options: ExpoSpeechRecognitionOptions) {
  return coordinator.start(id, options);
}

export function stopSpeechRecognition(id: symbol) {
  coordinator.stop(id);
}

export function abortSpeechRecognition(id: symbol) {
  coordinator.abort(id);
}

export function releaseSpeechRecognitionBeforeStart(id: symbol) {
  coordinator.releaseBeforeStart(id);
}

export function ownsSpeechRecognition(id: symbol) {
  return coordinator.isOwner(id);
}

export function isSpeechRecognitionAvailable() {
  return ExpoSpeechRecognitionModule.isRecognitionAvailable();
}

export function requestSpeechRecognitionPermissions() {
  return ExpoSpeechRecognitionModule.requestPermissionsAsync();
}
