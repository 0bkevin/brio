export type SpeechRecognitionError =
  | 'aborted'
  | 'audio-capture'
  | 'interrupted'
  | 'bad-grammar'
  | 'language-not-supported'
  | 'network'
  | 'no-speech'
  | 'not-allowed'
  | 'service-not-allowed'
  | 'busy'
  | 'client'
  | 'speech-timeout'
  | 'unknown';

const MAX_COMPOSER_LENGTH = 20_000;

export function appendSpeechTranscript(draft: string, transcript: string) {
  const spoken = transcript.trim();
  if (!spoken) return draft;
  if (!draft) return spoken.slice(0, MAX_COMPOSER_LENGTH);
  if (/\s$/.test(draft)) return `${draft}${spoken}`.slice(0, MAX_COMPOSER_LENGTH);
  return `${draft} ${spoken}`.slice(0, MAX_COMPOSER_LENGTH);
}

export function mergeSpeechSegment(committed: string, segment: string) {
  const spoken = segment.trim();
  if (!spoken) return committed.trim();
  const previous = committed.trim();
  if (!previous) return spoken;
  if (spoken.startsWith(previous)) return spoken;
  return `${previous} ${spoken}`;
}

export function speechRecognitionErrorMessage(error: SpeechRecognitionError) {
  if (error === 'aborted') return '';
  if (error === 'not-allowed') {
    return 'Microphone and speech recognition access are required. Enable them in device settings.';
  }
  if (error === 'no-speech' || error === 'speech-timeout') {
    return "I didn't hear any speech. Tap the mic and try again.";
  }
  if (error === 'audio-capture') return "Brio couldn't access the microphone.";
  if (error === 'network') return 'Speech recognition could not reach the system transcription service.';
  if (error === 'language-not-supported') return 'Speech recognition is not available for this device language.';
  if (error === 'service-not-allowed') return 'Speech recognition is not available on this device.';
  if (error === 'busy') return 'Speech recognition is busy. Wait a moment and try again.';
  if (error === 'interrupted') return 'Dictation was interrupted.';
  return 'Could not transcribe that audio. Tap the mic and try again.';
}

export function normalizeSpeechRecognitionLocale(locale: string) {
  const normalized = locale.trim().replaceAll('_', '-');
  if (!normalized) return 'en-US';
  try {
    return new Intl.Locale(normalized).baseName;
  } catch {
    return normalized.split('-u-')[0] || 'en-US';
  }
}
