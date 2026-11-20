import { crc32, deflateRawSync, deflateSync } from 'node:zlib';

// Files for the tests of reading the text of files (C-63, #1382): well-formed ones, and the hostile ones the worker must survive.

/** A PDF with one page for each string, in Helvetica (so no font program is embedded and PDF.js reads the text layer as it is). */
export function pdfBytes(pages: string[]): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const first = 2;
  const pagesId = first + pages.length * 2;
  const kids: number[] = [];
  pages.forEach((text, index) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${first + index * 2} 0 R /Resources << /Font << /F1 1 0 R >> >> >>`);
    kids.push(first + index * 2 + 1);
  });
  add(`<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] >>`);
  add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  return assemble(objects, objects.length);
}

function assemble(objects: string[], root: number): Buffer {
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => { offsets.push(out.length); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${root} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A page tree nested `depth` levels deep, each node the only kid of the next: a recursion a parser must bound. */
export function pdfNested(depth: number): Buffer {
  const objects: string[] = [];
  for (let level = 1; level <= depth; level++) objects.push(`<< /Type /Pages /Count 1 /Kids [${level + 1} 0 R] ${level > 1 ? `/Parent ${level - 1} 0 R` : ''} >>`);
  objects.push(`<< /Type /Page /Parent ${depth} 0 R /MediaBox [0 0 612 792] >>`);
  objects.push('<< /Type /Catalog /Pages 1 0 R >>');
  return assemble(objects, objects.length);
}

/** An array nested `depth` levels deep inside an object: a parser that recurses runs out of stack. */
export function pdfDeepArray(depth: number): Buffer {
  const objects = [`${'['.repeat(depth)}${']'.repeat(depth)}`, '<< /Type /Pages /Count 0 /Kids [] >>', '<< /Type /Catalog /Pages 2 0 R /Extra 1 0 R >>'];
  return assemble(objects, 3);
}

/** A page tree whose node is its own kid. */
export function pdfCycle(): Buffer {
  return assemble(['<< /Type /Pages /Count 1 /Kids [1 0 R] >>', '<< /Type /Catalog /Pages 1 0 R >>'], 2);
}

export interface ZipEntry { name: string; data: Buffer; method?: 0 | 8; declared?: number }

/** A ZIP of these entries. `declared` lies about the uncompressed size, as a zip bomb does. */
export function zipBytes(entries: ZipEntry[], options: { entryCount?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const method = entry.method ?? 8;
    const body = method === 8 ? deflateRawSync(entry.data) : entry.data;
    const name = Buffer.from(entry.name, 'latin1');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(entry.data), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(entry.declared ?? entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc32(entry.data), 16); header.writeUInt32LE(body.length, 20); header.writeUInt32LE(entry.declared ?? entry.data.length, 24);
    header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    directory.push(header, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(options.entryCount ?? entries.length, 8); end.writeUInt16LE(options.entryCount ?? entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A DOCX: paragraphs, and optionally a table of rows of cells, and a text box that Word stores twice. */
export function docxBytes(paragraphs: string[], extra: { table?: string[][]; textBox?: string } = {}): Buffer {
  const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
  const table = extra.table ? `<w:tbl>${extra.table.map((row) => `<w:tr>${row.map((cell) => `<w:tc>${para(cell)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>` : '';
  const box = extra.textBox ? `<mc:AlternateContent><mc:Choice Requires="wps"><w:r><w:t>${escapeXml(extra.textBox)}</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>${escapeXml(extra.textBox)}</w:t></w:r></mc:Fallback></mc:AlternateContent>` : '';
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body>${paragraphs.map(para).join('')}${table}${box}</w:body></w:document>`;
  return zipBytes([{ name: '[Content_Types].xml', data: Buffer.from('<Types/>') }, { name: 'word/document.xml', data: Buffer.from(xml) }]);
}

/** One page of an image-only PDF (C-69): a picture of RGB or grey pixels (Flate), or a JPEG (DCT), drawn over the whole page, and no text. */
export type PicturePage = { kind: 'rgb' | 'grey'; width: number; height: number } | { kind: 'jpeg'; bytes: Buffer; width: number; height: number; grey?: boolean };
/**
 * A PDF whose pages are pictures only (#1557: what macOS's "Quartz PDFContext" makes of an exported map, a scan): no font, no text. A Flate
 * picture is a pattern of bands, so a scaled-down copy can be checked by its colours: RGB pictures have a red left half and a blue right one.
 */
export function pdfOfPictures(pages: PicturePage[]): Buffer {
  const parts: Buffer[] = [];
  const objects: Buffer[] = [];
  const add = (body: Buffer | string) => { objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body); return objects.length; };
  const stream = (dictionary: string, bytes: Buffer) => Buffer.concat([Buffer.from(`${dictionary.replace(/>>$/, `/Length ${bytes.length} >>`)}\nstream\n`, 'latin1'), bytes, Buffer.from('\nendstream', 'latin1')]);
  const kids: number[] = [];
  const pagesId = pages.length * 3 + 1;
  for (const page of pages) {
    let image: number;
    if (page.kind === 'jpeg') image = add(stream(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /${page.grey ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode >>`, page.bytes));
    else {
      const channels = page.kind === 'rgb' ? 3 : 1;
      const raw = Buffer.alloc(page.width * page.height * channels);
      for (let y = 0; y < page.height; y++) for (let x = 0; x < page.width; x++) {
        const at = (y * page.width + x) * channels;
        if (channels === 3) { raw[at] = x < page.width / 2 ? 220 : 20; raw[at + 1] = 30; raw[at + 2] = x < page.width / 2 ? 20 : 220; }
        else raw[at] = y < page.height / 2 ? 0 : 255;
      }
      image = add(stream(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /${page.kind === 'rgb' ? 'DeviceRGB' : 'DeviceGray'} /BitsPerComponent 8 /Filter /FlateDecode >>`, deflateSync(raw)));
    }
    const content = `q ${page.width} 0 0 ${page.height} 0 0 cm /Im1 Do Q`;
    const contents = add(stream('<< >>', Buffer.from(content, 'latin1')));
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /XObject << /Im1 ${image} 0 R >> >> /Contents ${contents} 0 R >>`));
  }
  add(`<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] >>`);
  const root = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  parts.push(Buffer.from('%PDF-1.4\n', 'latin1'));
  const offsets: number[] = [];
  let at = parts[0]!.length;
  objects.forEach((body, index) => {
    const object = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    offsets.push(at); parts.push(object); at += object.length;
  });
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
    + `trailer\n<< /Size ${objects.length + 1} /Root ${root} 0 R >>\nstartxref\n${at}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
