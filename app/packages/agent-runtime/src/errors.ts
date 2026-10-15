/** A 2xx answer that is not a usable response of its wire format (no usable usage, a broken tool call). */
export class MalformedResponseError extends Error {
  constructor(what: string) {
    super(`The provider response was malformed: ${what}`);
    this.name = 'MalformedResponseError';
  }
}
