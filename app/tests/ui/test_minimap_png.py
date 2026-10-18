"""Stdlib instrument controls: exact samples/filters and malformed screenshot refusal."""
import struct
import unittest
import zlib

from minimap_png import compare_pngs, decode_png


def chunk(kind, data):
    return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))


def png(rows, method=0, *, header=None, inflated=None):
    header = header or struct.pack('>IIBBBBB',3,2,8,6,0,0,0)
    filtered = bytearray()
    previous = bytes(12)
    for row in rows:
        filtered.append(method)
        for x,value in enumerate(row):
            a=row[x-4] if x>=4 else 0
            b=previous[x]
            c=previous[x-4] if x>=4 else 0
            if method==4:
                p=a+b-c
                predictor=min((a,b,c),key=lambda v:abs(p-v))
            else:
                predictor=(0,a,b,(a+b)//2)[method] if method<4 else 0
            filtered.append((value-predictor)&255)
        previous=row
    data=zlib.compress(filtered if inflated is None else inflated)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',header)+chunk(b'IDAT',data)+chunk(b'IEND',b'')


class PNGObservation(unittest.TestCase):
    rows=(bytes([99,98,97,153,0,28,255,0,240,128,64,191]),bytes([7,255,42,106,161,160,159,149,99,100,101,176]))

    def test_all_five_row_filters_preserve_original_rgba_and_encoding_is_irrelevant(self):
        for method in range(5):
            with self.subTest(method=method):
                data=png(self.rows,method)
                decoded=decode_png(data)
                self.assertEqual((decoded.width,decoded.height,decoded.pixels),(3,2,b''.join(self.rows)))
                self.assertEqual(compare_pngs(data,png(self.rows))['differingPixels'],0)

    def test_malformed_unsupported_and_mismatched_pngs_fail_closed(self):
        good=png(self.rows)
        invalid=[good[:-1],good+b'trailing',good[:40]+bytes([good[40]^1])+good[41:],
                 png(self.rows,header=struct.pack('>IIBBBBB',3,2,8,2,0,0,0)),
                 png(self.rows,header=struct.pack('>IIBBBBB',3,2,8,6,0,0,1)),
                 png(self.rows,header=struct.pack('>IIBBBBB',5000,5000,8,6,0,0,0)),
                 png(self.rows,method=5),png(self.rows,inflated=b'\0'),png(self.rows,inflated=bytes(27))]
        for index,data in enumerate(invalid):
            with self.subTest(index=index),self.assertRaises((ValueError,zlib.error)):
                decode_png(data)
        profile=good[:-12]+chunk(b'gAMA',struct.pack('>I',45455))+good[-12:]
        with self.assertRaises(ValueError):
            compare_pngs(good,profile)
        wrong_size=png(self.rows,header=struct.pack('>IIBBBBB',2,3,8,6,0,0,0),inflated=bytes(27))
        with self.assertRaises(ValueError):
            compare_pngs(good,wrong_size)
