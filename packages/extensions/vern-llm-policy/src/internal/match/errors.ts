/** A pattern that can never work. `compile` turns it into a config error. */
export class PatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatternError';
  }
}

/** Thrown when the call's labels are unknown, so `onError` decides the rule. */
export class LabelsUnknownError extends Error {
  constructor() {
    super('the labels are unknown');
    this.name = 'LabelsUnknownError';
  }
}
