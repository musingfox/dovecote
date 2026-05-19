export class ScopeError extends Error {
  public requiredScope: string;

  constructor(requiredScope: string) {
    super(`Missing scope: ${requiredScope}`);
    this.name = "ScopeError";
    this.requiredScope = requiredScope;
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class UpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}
