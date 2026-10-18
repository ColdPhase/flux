"""Fail-closed decoding of original Playwright RGBA PNG bytes, without Canvas alpha conversion."""
import struct
import zlib
from dataclasses import dataclass


@dataclass(frozen=True)
class RGBA:
    width: int
    height: int
    pixels: bytes
    profile: tuple


def decode_png(raw):
    if raw[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError('Not PNG')
    pos, header, ended, data, profile = 8, None, False, bytearray(), []
    idat_closed = False
    while pos < len(raw):
        if pos + 12 > len(raw):
            raise ValueError('Truncated PNG chunk')
        size = struct.unpack_from('>I', raw, pos)[0]
        kind = raw[pos+4:pos+8]
        if any(not (65 <= value <= 90 or 97 <= value <= 122) for value in kind) or kind[2] & 32:
            raise ValueError('Invalid PNG chunk type')
        stop = pos + 12 + size
        if stop > len(raw):
            raise ValueError('Truncated PNG payload')
        payload = raw[pos+8:pos+8+size]
        crc = struct.unpack_from('>I', raw, pos+8+size)[0]
        if zlib.crc32(kind + payload) != crc:
            raise ValueError('PNG CRC mismatch')
        if data and kind != b'IDAT':
            idat_closed = True
        if header is None and kind != b'IHDR':
            raise ValueError('PNG header must be first')
        if kind == b'IHDR':
            if header is not None or size != 13:
                raise ValueError('Invalid PNG header')
            header = struct.unpack('>IIBBBBB', payload)
            w, h, depth, color, compression, filtering, interlace = header
            if not w or not h or (depth, color, compression, filtering, interlace) != (8, 6, 0, 0, 0):
                raise ValueError('Only non-interlaced 8-bit RGBA PNG is supported')
            if (w*4+1)*h > 16*1024*1024:
                raise ValueError('PNG exceeds bounded minimap observation')
        elif kind == b'IDAT':
            if idat_closed:
                raise ValueError('Non-contiguous PNG IDAT')
            data.extend(payload)
        elif kind == b'IEND':
            if size or stop != len(raw) or not data:
                raise ValueError('Invalid PNG end')
            ended = True
        elif kind in (b'tRNS', b'acTL', b'fcTL', b'fdAT') or not kind[0] & 32:
            raise ValueError('Unsupported PNG format/chunk')
        elif kind in (b'cHRM', b'gAMA', b'iCCP', b'sRGB', b'cICP'):
            profile.append((kind, payload))
        pos = stop
    if not ended or header is None:
        raise ValueError('Incomplete PNG')
    expected = (w*4+1)*h
    inflater = zlib.decompressobj()
    rows = inflater.decompress(data, expected+1)
    if len(rows) != expected or not inflater.eof or inflater.unused_data or inflater.unconsumed_tail:
        raise ValueError('Invalid PNG inflated length/stream')
    stride, prior, pixels = w*4, bytearray(w*4), bytearray()
    for y in range(h):
        start = y*(stride+1)
        method = rows[start]
        if method > 4:
            raise ValueError('Unknown PNG row filter')
        row = bytearray(rows[start+1:start+1+stride])
        for x in range(stride):
            a = row[x-4] if x >= 4 else 0
            b = prior[x]
            c = prior[x-4] if x >= 4 else 0
            if method == 1:
                predictor = a
            elif method == 2:
                predictor = b
            elif method == 3:
                predictor = (a+b)//2
            elif method == 4:
                p = a+b-c
                distances = (abs(p-a), abs(p-b), abs(p-c))
                predictor = (a, b, c)[distances.index(min(distances))]
            else:
                predictor = 0
            row[x] = (row[x]+predictor) & 255
        pixels.extend(row)
        prior = row
    return RGBA(w, h, bytes(pixels), tuple(profile))


def compare_pngs(actual, reference):
    a, b = decode_png(actual), decode_png(reference)
    if (a.width, a.height, a.profile) != (b.width, b.height, b.profile):
        raise ValueError('PNG dimensions/color profiles differ')
    alpha_error, ink, color_error, differing = 0, 0, 0, 0
    for i in range(0, len(a.pixels), 4):
        p, q = a.pixels[i:i+4], b.pixels[i:i+4]
        alpha_error += abs(p[3]-q[3])
        ink += q[3]
        differing += p != q
        if p[3] > 100 and q[3] > 100:
            color_error = max(color_error, *(abs(p[c]-q[c]) for c in range(3)))
    return {'relativeAlphaError':alpha_error/max(1,ink), 'colorError':color_error,
            'ink':ink, 'pixels':[a.width,a.height], 'differingPixels':differing,
            'alphaAbsoluteSum':alpha_error, 'method':'original-PNG-stdlib-RGBA'}
