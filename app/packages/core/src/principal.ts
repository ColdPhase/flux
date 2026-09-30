// Kept free of persistence imports so use cases behind ports (push, sketches) can name it.

/**
 * The authenticated actor of a request, job or tool call. Entry points establish it
 * (session cookie, later OAuth token or job owner) and pass it to domain methods.
 */
export interface Principal {
  id: string;
  kind: 'fixture' | 'human' | 'agent';
}
