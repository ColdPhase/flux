import { createHash } from 'node:crypto';
import { Readable, pipeline } from 'node:stream';
import { createGzip } from 'node:zlib';

/**
 * A minimal POSIX ustar writer for the export bundle (issue #123): regular files only, one
 * top-level directory, fixed owner and a fixed modification time, so the same export gives the
 * same bytes. Any `tar` reads it (`tar -xzf bundle.tar.gz`).
 */
export interface BundleFile {
  path: string;
  content: Buffer;
}

function octal(value: number, width: number) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function header(path: string, size: number, mtime: number) {
  const block = Buffer.alloc(512, 0);
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = path.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(path.slice(cut + 1)) > 100) throw new Error(`Bundle path too long: ${path}`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  block.write(name, 0, 100, 'utf8');
  block.write(octal(0o644, 8), 100, 'ascii');
  block.write(octal(0, 8), 108, 'ascii');
  block.write(octal(0, 8), 116, 'ascii');
  block.write(octal(size, 12), 124, 'ascii');
  block.write(octal(mtime, 12), 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write('0', 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  block.write('flux', 265, 'ascii');
  block.write('flux', 297, 'ascii');
  block.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

/** A `.tar.gz` stream with backpressure; only the current file is retained. */
export function tarGzip(root: string, files: Iterable<BundleFile> | AsyncIterable<BundleFile>, modified: Date, signal?: AbortSignal): Readable {
  const mtime = Math.floor(modified.getTime() / 1000);
  async function* blocks() {
    for await (const file of files) {
      signal?.throwIfAborted();
      yield header(`${root}/${file.path}`, file.content.length, mtime);
      yield file.content;
      const padding = (512 - (file.content.length % 512)) % 512;
      if (padding) yield Buffer.alloc(padding, 0);
    }
    yield Buffer.alloc(1024, 0);
  }
  const archive = Readable.from(blocks(), { objectMode: false, highWaterMark: 64 * 1024, signal });
  const compressed = createGzip({ level: 9 });
  // pipeline propagates consumer disconnects and storage errors to both streams.
  pipeline(archive, compressed, () => { /* the consumer receives the stream error */ });
  return compressed;
}

export function sha256(content: Buffer) {
  return createHash('sha256').update(content).digest('hex');
}
