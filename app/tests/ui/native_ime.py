"""Test-only native GTK Unicode composition on an isolated headed WebKit display.

XTEST sends keyboard input through GTK's real input method. This module never
dispatches a DOM event, inserts editor text, or changes collaboration transport.
Dependencies come from the existing digest-pinned Playwright UI image.
"""
from __future__ import annotations

import ctypes as C
from importlib.metadata import version
import os
import select
import shutil
import subprocess
import tempfile


class _WindowAttributes(C.Structure):
    _fields_ = [(name, kind) for name, kind in (
        ('x', C.c_int), ('y', C.c_int), ('width', C.c_int), ('height', C.c_int),
        ('border_width', C.c_int), ('depth', C.c_int), ('visual', C.c_void_p),
        ('root', C.c_ulong), ('window_class', C.c_int), ('bit_gravity', C.c_int),
        ('win_gravity', C.c_int), ('backing_store', C.c_int),
        ('backing_planes', C.c_ulong), ('backing_pixel', C.c_ulong),
        ('save_under', C.c_int), ('colormap', C.c_ulong), ('map_installed', C.c_int),
        ('map_state', C.c_int), ('all_event_masks', C.c_long),
        ('your_event_mask', C.c_long), ('do_not_propagate_mask', C.c_long),
        ('override_redirect', C.c_int), ('screen', C.c_void_p))]


class NativeImeDisplay:
    """Own one local X server; only its uniquely titled writer can receive input."""

    def __init__(self):
        self.process = None
        self.display = None
        self.log = tempfile.TemporaryFile()
        self.window = None
        try:
            if version('playwright') != '1.62.0' or not shutil.which('Xvfb'):
                raise RuntimeError('FLUX_NATIVE_IME_UNSUPPORTED: pinned Playwright/Xvfb is unavailable')
            self.x = C.CDLL('libX11.so.6')
            self.xt = C.CDLL('libXtst.so.6')
            self._bind()
            read_fd, write_fd = os.pipe()
            try:
                self.process = subprocess.Popen(
                    ['Xvfb', '-displayfd', str(write_fd), '-screen', '0', '1440x900x24', '-nolisten', 'tcp', '-ac'],
                    pass_fds=(write_fd,), stdout=self.log, stderr=self.log)
            finally:
                os.close(write_fd)
            try:
                if not select.select([read_fd], [], [], 10)[0]:
                    raise RuntimeError('FLUX_NATIVE_IME_UNSUPPORTED: isolated Xvfb did not become ready')
                number = os.read(read_fd, 32).strip()
            finally:
                os.close(read_fd)
            if not number.isdigit():
                raise RuntimeError('FLUX_NATIVE_IME_UNSUPPORTED: invalid isolated display')
            self.name = ':' + number.decode('ascii')
            self.display = self.x.XOpenDisplay(self.name.encode())
            if not self.display:
                raise RuntimeError('FLUX_NATIVE_IME_UNSUPPORTED: cannot connect to isolated display')
            values = [C.c_int() for _ in range(4)]
            if not self.xt.XTestQueryExtension(self.display, *(C.byref(v) for v in values)):
                raise RuntimeError('FLUX_NATIVE_IME_UNSUPPORTED: isolated display lacks XTEST')
            self.root = self.x.XDefaultRootWindow(self.display)
        except BaseException:
            self.close()
            raise

    @property
    def environment(self):
        return {**os.environ, 'DISPLAY': self.name, 'GDK_BACKEND': 'x11',
                'GTK_IM_MODULE': 'gtk-im-context-simple'}

    def _bind(self):
        ptr, window = C.c_void_p, C.c_ulong
        signatures = {
            'XOpenDisplay': ([C.c_char_p], ptr), 'XCloseDisplay': ([ptr], C.c_int),
            'XDefaultRootWindow': ([ptr], window),
            'XQueryTree': ([ptr, window, C.POINTER(window), C.POINTER(window),
                            C.POINTER(C.POINTER(window)), C.POINTER(C.c_uint)], C.c_int),
            'XGetWindowAttributes': ([ptr, window, C.POINTER(_WindowAttributes)], C.c_int),
            'XFetchName': ([ptr, window, C.POINTER(ptr)], C.c_int),
            'XInternAtom': ([ptr, C.c_char_p, C.c_int], window),
            'XGetWindowProperty': ([ptr, window, window, C.c_long, C.c_long, C.c_int, window,
                                    C.POINTER(window), C.POINTER(C.c_int), C.POINTER(C.c_ulong),
                                    C.POINTER(C.c_ulong), C.POINTER(ptr)], C.c_int),
            'XFree': ([ptr], C.c_int), 'XRaiseWindow': ([ptr, window], C.c_int),
            'XSetInputFocus': ([ptr, window, C.c_int, C.c_ulong], C.c_int),
            'XGetInputFocus': ([ptr, C.POINTER(window), C.POINTER(C.c_int)], C.c_int),
            'XStringToKeysym': ([C.c_char_p], C.c_ulong),
            'XKeysymToKeycode': ([ptr, C.c_ulong], C.c_ubyte),
            'XSync': ([ptr, C.c_int], C.c_int),
        }
        for name, (args, result) in signatures.items():
            method = getattr(self.x, name)
            method.argtypes, method.restype = args, result
        self.xt.XTestQueryExtension.argtypes = [ptr] + [C.POINTER(C.c_int)] * 4
        self.xt.XTestQueryExtension.restype = C.c_int
        self.xt.XTestFakeKeyEvent.argtypes = [ptr, C.c_uint, C.c_int, C.c_ulong]
        self.xt.XTestFakeKeyEvent.restype = C.c_int

    def _children(self, parent):
        root, previous = C.c_ulong(), C.c_ulong()
        children, count = C.POINTER(C.c_ulong)(), C.c_uint()
        if not self.x.XQueryTree(self.display, parent, C.byref(root), C.byref(previous),
                                 C.byref(children), C.byref(count)):
            return []
        try:
            return list(children[:count.value])
        finally:
            if children:
                self.x.XFree(children)

    def _titles(self, window):
        titles, name = [], C.c_void_p()
        if self.x.XFetchName(self.display, window, C.byref(name)) and name:
            try:
                titles.append(C.string_at(name).decode('utf-8', 'replace'))
            finally:
                self.x.XFree(name)
        atom = self.x.XInternAtom(self.display, b'_NET_WM_NAME', 1)
        if atom:
            kind, fmt, count, remaining, data = C.c_ulong(), C.c_int(), C.c_ulong(), C.c_ulong(), C.c_void_p()
            result = self.x.XGetWindowProperty(self.display, window, atom, 0, 256, 0, 0,
                C.byref(kind), C.byref(fmt), C.byref(count), C.byref(remaining), C.byref(data))
            try:
                if result == 0 and fmt.value == 8 and data and remaining.value == 0:
                    titles.append(C.string_at(data, count.value).decode('utf-8', 'replace'))
            finally:
                if data:
                    self.x.XFree(data)
        return titles

    def focus_writer(self, marker):
        if not marker.startswith('Flux native IME ') or len(marker) > 80:
            raise RuntimeError('FLUX_NATIVE_IME_UNSUPPORTED: an explicit unique writer marker is required')
        candidates = []
        for window in self._children(self.root):
            attributes = _WindowAttributes()
            if self.x.XGetWindowAttributes(self.display, window, C.byref(attributes)) \
                    and attributes.map_state == 2 and any(marker in title for title in self._titles(window)):
                candidates.append(window)
        if len(candidates) != 1:
            raise RuntimeError(f'FLUX_NATIVE_IME_UNSUPPORTED: expected one mapped native writer, found {len(candidates)}')
        self.window = candidates[0]
        self.x.XRaiseWindow(self.display, self.window)
        self.x.XSetInputFocus(self.display, self.window, 2, 0)
        self.x.XSync(self.display, 0)
        self._require_focus()

    def _require_focus(self):
        focused, revert = C.c_ulong(), C.c_int()
        self.x.XGetInputFocus(self.display, C.byref(focused), C.byref(revert))
        if self.window is None or focused.value != self.window:
            raise RuntimeError('FLUX_NATIVE_IME_UNSUPPORTED: native keyboard focus left the identified writer')

    def key(self, name):
        self.chord(name)

    def chord(self, *names):
        self._require_focus()
        if not names or any(name not in {'Control_L', 'Shift_L', 'u', 'Return', *'0123456789abcdef'} for name in names):
            raise RuntimeError('FLUX_NATIVE_IME_UNSUPPORTED: only Unicode-composition keys are admitted')
        codes = [self.x.XKeysymToKeycode(self.display, self.x.XStringToKeysym(name.encode())) for name in names]
        if not all(codes):
            raise RuntimeError('FLUX_NATIVE_IME_UNSUPPORTED: native key is absent from the isolated keymap')
        pressed = []
        try:
            for code in codes:
                if not self.xt.XTestFakeKeyEvent(self.display, code, 1, 0):
                    raise RuntimeError('FLUX_NATIVE_IME_UNSUPPORTED: native key press failed')
                pressed.append(code)
        finally:
            for code in reversed(pressed):
                self.xt.XTestFakeKeyEvent(self.display, code, 0, 0)
            self.x.XSync(self.display, 0)

    def close(self):
        if self.display:
            self.x.XCloseDisplay(self.display)
            self.display = None
        if self.process:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
            self.process = None
        if self.log:
            self.log.close()
            self.log = None
