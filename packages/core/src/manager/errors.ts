/** Errors the server manager raises; the admin API maps each one to an HTTP status. */

/** An unknown server, tool or secret (404). */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

/** The request cannot be done in the current state (409): server not ready, tool disabled… */
export class ConflictError extends Error {
  constructor(
    message: string,
    readonly code: string = 'conflict',
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

/** The request itself is invalid (400). */
export class InvalidRequestError extends Error {
  constructor(
    message: string,
    readonly problems: readonly string[] = [],
  ) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}
