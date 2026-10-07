// The bounded reader of a supervisor stream (F-022 "Network": "size-bounded, minimal and
// fuzz-tested"). It never buffers more than one line of `lineBytes`, never accepts more than
// `totalBytes` or `frames`, decodes UTF-8 strictly and hands each JSON value to a closed parser.

export const FRAME_STREAM_ERRORS = ['line_too_long', 'stream_too_large', 'too_many_frames', 'invalid_utf8', 'malformed_json', 'invalid_frame', 'truncated'] as const;
export type FrameStreamErrorCode = (typeof FRAME_STREAM_ERRORS)[number];

export class FrameStreamError extends Error {
  constructor(readonly code: FrameStreamErrorCode) {
    super(`Supervisor stream refused: ${code}`);
    this.name = 'FrameStreamError';
  }
}

export interface FrameLimits { lineBytes: number; totalBytes: number; frames: number }
export const DEFAULT_FRAME_LIMITS: FrameLimits = { lineBytes: 64 * 1024, totalBytes: 1024 * 1024, frames: 256 };

const NEWLINE = 0x0a;

export class NdjsonReader<T> {
  private parts: Buffer[] = [];
  private lineLength = 0;
  private total = 0;
  private count = 0;
  private failed: FrameStreamError | null = null;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(private readonly parse: (value: unknown) => T | null, private readonly limits: FrameLimits = DEFAULT_FRAME_LIMITS) {}

  /** Frames completed by this chunk. After any error the reader stays failed. */
  push(chunk: Uint8Array): T[] {
    if (this.failed) throw this.failed;
    try {
      return this.consume(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    } catch (error) {
      this.failed = error instanceof FrameStreamError ? error : new FrameStreamError('invalid_frame');
      this.parts = [];
      throw this.failed;
    }
  }

  /** The stream ended: a partial last line is refused. */
  end(): void {
    if (this.failed) throw this.failed;
    if (this.lineLength > 0) {
      this.failed = new FrameStreamError('truncated');
      this.parts = [];
      throw this.failed;
    }
  }

  private consume(chunk: Buffer): T[] {
    this.total += chunk.length;
    if (this.total > this.limits.totalBytes) throw new FrameStreamError('stream_too_large');
    const frames: T[] = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline;
      this.lineLength += end - start;
      if (this.lineLength > this.limits.lineBytes) throw new FrameStreamError('line_too_long');
      if (end > start) this.parts.push(chunk.subarray(start, end));
      if (newline === -1) break;
      frames.push(this.line());
      start = newline + 1;
    }
    return frames;
  }

  private line(): T {
    const bytes = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.lineLength);
    this.parts = [];
    this.lineLength = 0;
    if (++this.count > this.limits.frames) throw new FrameStreamError('too_many_frames');
    let textValue: string;
    try { textValue = this.decoder.decode(bytes); } catch { throw new FrameStreamError('invalid_utf8'); }
    let value: unknown;
    try { value = JSON.parse(textValue); } catch { throw new FrameStreamError('malformed_json'); }
    const frame = this.parse(value);
    if (frame === null) throw new FrameStreamError('invalid_frame');
    return frame;
  }
}

/** One frame as a line of the stream. */
export const encodeFrame = (frame: unknown) => `${JSON.stringify(frame)}\n`;
