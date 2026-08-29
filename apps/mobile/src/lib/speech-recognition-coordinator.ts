export type SpeechRecognitionEventMap<ResultEvent, ErrorEvent> = {
  start: null;
  result: ResultEvent;
  nomatch: null;
  error: ErrorEvent;
  end: null;
};

export type SpeechRecognitionDriver<Options, ResultEvent, ErrorEvent> = {
  abort: () => void;
  addListener: <Event extends keyof SpeechRecognitionEventMap<ResultEvent, ErrorEvent>>(
    event: Event,
    listener: (payload: SpeechRecognitionEventMap<ResultEvent, ErrorEvent>[Event]) => void,
  ) => { remove: () => void };
  getStateAsync: () => Promise<string>;
  start: (options: Options) => void;
  stop: () => void;
};

export type SpeechRecognitionSink<ResultEvent, ErrorEvent> = {
  onEnd: () => void;
  onError: (event: ErrorEvent) => void;
  onNoMatch: () => void;
  onResult: (event: ResultEvent) => void;
  onStart: () => void;
};

type ActiveSession<ResultEvent, ErrorEvent> = {
  id: symbol;
  sink: SpeechRecognitionSink<ResultEvent, ErrorEvent>;
  started: boolean;
};

export class SpeechRecognitionCoordinator<Options, ResultEvent, ErrorEvent> {
  private active: ActiveSession<ResultEvent, ErrorEvent> | null = null;
  private draining = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private readonly abortGraceMs: number;
  private readonly drainQuietMs: number;
  private readonly driver: SpeechRecognitionDriver<Options, ResultEvent, ErrorEvent>;
  private readonly stopTimeoutMs: number;

  constructor(
    driver: SpeechRecognitionDriver<Options, ResultEvent, ErrorEvent>,
    stopTimeoutMs = 5000,
    abortGraceMs = 750,
    drainQuietMs = 1000,
  ) {
    this.driver = driver;
    this.stopTimeoutMs = stopTimeoutMs;
    this.abortGraceMs = abortGraceMs;
    this.drainQuietMs = drainQuietMs;
    driver.addListener('start', () => {
      if (this.consumeDrainingEvent()) return;
      this.active?.sink.onStart();
    });
    driver.addListener('result', (event) => {
      if (this.consumeDrainingEvent()) return;
      this.active?.sink.onResult(event);
    });
    driver.addListener('nomatch', () => {
      if (this.consumeDrainingEvent()) return;
      this.active?.sink.onNoMatch();
    });
    driver.addListener('error', (event) => {
      if (this.consumeDrainingEvent()) return;
      const session = this.active;
      if (!session) return;
      session.sink.onError(event);
      this.armStopWatchdog(session);
    });
    driver.addListener('end', () => {
      if (this.draining) {
        this.endDrain();
        return;
      }
      this.finish(this.active);
    });
  }

  claim(id: symbol, sink: SpeechRecognitionSink<ResultEvent, ErrorEvent>) {
    if (this.active || this.draining) return false;
    this.active = { id, sink, started: false };
    return true;
  }

  isOwner(id: symbol) {
    return this.active?.id === id;
  }

  start(id: symbol, options: Options) {
    const session = this.session(id);
    if (!session) return false;
    session.started = true;
    try {
      this.driver.start(options);
      return true;
    } catch (error) {
      session.started = false;
      this.finish(session);
      throw error;
    }
  }

  releaseBeforeStart(id: symbol) {
    const session = this.session(id);
    if (session && !session.started) this.finish(session);
  }

  stop(id: symbol) {
    const session = this.session(id);
    if (!session) return;
    if (!session.started) {
      this.finish(session);
      return;
    }
    this.driver.stop();
    this.armStopWatchdog(session);
  }

  abort(id: symbol) {
    const session = this.session(id);
    if (!session) return;
    if (!session.started) {
      this.finish(session);
      return;
    }
    this.driver.abort();
    if (this.active === session) this.armAbortFallback(session);
  }

  private session(id: symbol) {
    return this.active?.id === id ? this.active : null;
  }

  private armStopWatchdog(session: ActiveSession<ResultEvent, ErrorEvent>) {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      if (this.active !== session) return;
      this.driver.abort();
      if (this.active === session) this.armAbortFallback(session);
    }, this.stopTimeoutMs);
  }

  private armAbortFallback(session: ActiveSession<ResultEvent, ErrorEvent>) {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      if (this.active !== session) return;
      // Native recognizers occasionally remain in a stale `stopping` state forever.
      // Release our owner regardless, then drain untagged native events before a new
      // session can claim the singleton.
      this.beginDrain(session);
    }, this.abortGraceMs);
  }

  private beginDrain(session: ActiveSession<ResultEvent, ErrorEvent>) {
    if (this.active !== session) return;
    this.clearWatchdog();
    this.active = null;
    this.draining = true;
    session.sink.onEnd();
    this.armDrainQuietTimer();
  }

  private consumeDrainingEvent() {
    if (!this.draining) return false;
    this.armDrainQuietTimer();
    return true;
  }

  private armDrainQuietTimer() {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => this.endDrain(), this.drainQuietMs);
  }

  private endDrain() {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.draining = false;
  }

  private finish(session: ActiveSession<ResultEvent, ErrorEvent> | null) {
    if (!session || this.active !== session) return;
    this.clearWatchdog();
    this.active = null;
    session.sink.onEnd();
  }

  private clearWatchdog() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}
