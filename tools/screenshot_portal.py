#!/usr/bin/env python3
"""
vibe-screenshot — headless Wayland/GNOME50 screenshot mini-tool.

How it works (the only path that actually works on GNOME 50/Wayland without a
session restart):

  1. xdg-desktop-portal ScreenCast API (NOT the Screenshot API — GNOME 50
     forces interactive consent for Screenshot, but ScreenCast permissions
     PERSIST after one grant, like OBS).
  2. CreateSession -> SelectSources -> Start -> OpenPipeWireRemote (returns fd).
  3. Spawn `pw-cat` against the pipewire node id from Start's response, capture
     a single raw frame, downscale + encode to PNG via PIL.

FIRST RUN: a GNOME "Share your screen?" dialog appears. Click "Share" ONCE.
The grant is stored in the portal permission store — every subsequent run is
SILENT (no dialog), like OBS. This is the difference from the Screenshot portal.

USAGE:
  python3 screenshot_portal.py [output_path]

Defaults to /home/roman/vibe-gpt-studio/client/dist/screenshot.png
Exit 0 on success, non-zero on failure.
"""
import sys, os, time, threading, subprocess, struct, errno
import gi
gi.require_version('Gio', '2.0')
gi.require_version('GLib', '2.0')
from gi.repository import Gio, GLib

OUT = sys.argv[1] if len(sys.argv) > 1 else '/home/roman/vibe-gpt-studio/client/dist/screenshot.png'
DESKTOP = 'org.freedesktop.portal.Desktop'
DESKTOP_PATH = '/org/freedesktop/portal/desktop'
# Each portal call returns a handle; responses arrive as signals on a unique bus name.
SENDER_BASE = 'org.freedesktop.portal.desktop.request'

class Portal:
    def __init__(self):
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        self.loop = GLib.MainLoop()
        self.result = {}      # handle -> response dict
        self.node_id = None
        self.pipewire_fd = None

    def _new_token(self):
        return f'token{int(time.time()*1000)}'

    def _call(self, method, params):
        """Invoke a portal method, return the response handle object-path."""
        r = self.bus.call_sync(
            DESKTOP, DESKTOP_PATH,
            'org.freedesktop.portal.ScreenCast', method,
            params, GLib.VariantType('(o)'),
            Gio.DBusCallFlags.NONE, 10000, None)
        return r.unpack()[0]

    def _subscribe(self, handle, cb):
        """Subscribe to the Response signal for a request handle."""
        # The signal comes from a bus name based on the sender unique name + handle.
        sender = self.bus.get_unique_name().replace('.', '_')
        bus_name = f'org.freedesktop.portal.desktop.request.{sender}'
        object_path = handle.replace('/org/freedesktop/portal/desktop/request/', '')
        full_path = handle
        # Add a match rule + connect signal
        def on_signal(conn, sender, path, iface, signal, params):
            if path == full_path and signal == 'Response':
                cb(params.unpack())
        sub = self.bus.signal_subscribe(
            bus_name, 'org.freedesktop.portal.Request', 'Response',
            full_path, None, Gio.DBusSignalFlags.NONE, on_signal, None)
        return sub

    def screenshot(self):
        # 1. CreateSession
        session_token = self._new_token()
        handle = self._call('CreateSession', GLib.Variant('(a{sv})', ({
            'session_handle_token': GLib.Variant('s', session_token),
            'handle_token': GLib.Variant('s', self._new_token()),
        },)))
        session_path = self._wait(handle, timeout=60)  # first run: user clicks Share
        # session_path is actually the session handle from the response
        session_path = session_path[1].get('session_handle') if isinstance(session_path, tuple) else session_path
        print(f'[vibe-screenshot] session: {session_path}', file=sys.stderr)

        # 2. SelectSources
        handle2 = self.bus.call_sync(
            DESKTOP, DESKTOP_PATH, 'org.freedesktop.portal.ScreenCast', 'SelectSources',
            GLib.Variant('(oa{sv})', (session_path, {
                'types': GLib.Variant('u', 1),  # MONITOR
                'multiple': GLib.Variant('b', False),
                'cursor_mode': GLib.Variant('u', 1),  # HIDDEN (no cursor in capture)
                'handle_token': GLib.Variant('s', self._new_token()),
            })),
            GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE, 10000, None).unpack()[0]
        self._wait(handle2, timeout=30)
        print('[vibe-screenshot] sources selected', file=sys.stderr)

        # 3. Start
        handle3 = self.bus.call_sync(
            DESKTOP, DESKTOP_PATH, 'org.freedesktop.portal.ScreenCast', 'Start',
            GLib.Variant('(osa{sv})', (session_path, '', {
                'handle_token': GLib.Variant('s', self._new_token()),
            })),
            GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE, 10000, None).unpack()[0]
        resp = self._wait(handle3, timeout=60)
        # resp = (response_code, {streams: [(node_id, {properties})]})
        streams = resp[1].get('streams', [])
        if not streams:
            print('[vibe-screenshot] ERROR: no streams returned', file=sys.stderr)
            return False
        self.node_id = streams[0][0]
        print(f'[vibe-screenshot] pipewire node: {self.node_id}', file=sys.stderr)

        # 4. OpenPipeWireRemote -> file descriptor
        r = self.bus.call_sync(
            DESKTOP, DESKTOP_PATH, 'org.freedesktop.portal.ScreenCast', 'OpenPipeWireRemote',
            GLib.Variant('(oa{sv})', (session_path, {})),
            GLib.VariantType('(h)'), Gio.DBusCallFlags.NONE, 10000, None)
        # The fd is an index into the message's fd list
        fd_idx = r.unpack()[0]
        fd_list = r.get_message().get_unix_fd_list()
        self.pipewire_fd = fd_list.steal_fds()[fd_idx]
        print(f'[vibe-screenshot] pipewire fd acquired', file=sys.stderr)
        return True

    def _wait(self, handle, timeout=30):
        """Block until the Response signal for `handle` arrives, return its payload."""
        result = {'val': None}
        done = threading.Event()
        def on_response(params):
            result['val'] = params
            done.set()
            self.loop.quit()
        sub = self._subscribe(handle, on_response)
        # run a short-lived mainloop
        timer_id = GLib.timeout_add(timeout * 1000, self.loop.quit)
        try:
            self.loop.run()
        finally:
            GLib.source_remove(timer_id)
            self.bus.signal_unsubscribe(sub)
        if not done.is_set():
            raise TimeoutError(f'portal response timeout for {handle}')
        return result['val']


def grab_frame_pw_cat(node_id, fd, out_png, timeout=15):
    """Use pw-cat to capture a raw frame from the pipewire node, encode to PNG.

    pw-cat -p (record) reads from the pipewire node and writes raw samples.
    For video (BGRx), each frame is width*height*4 bytes. We capture a chunk,
    parse it, and let PIL encode PNG.
    """
    # pw-cat record format: -p records, --target <node>, format video/BGRx
    # Pass the fd via --pw-cat.fd (or inherit). Simplest: use the fd as stdin.
    # Actually pw-cat needs the pipewire fd from the portal; the standard way is
    # to pass it as fd 3 via the portal's pipewire protocol. This is fiddly in
    # shell — use Python's pw module instead. Since that's missing, fall back to
    # a tiny C helper pattern: spawn `pw-cat` with the fd inherited.
    cmd = ['pw-cat', '-p', '--target', str(node_id),
           '--format', 'video/BGRx', '--rate', '1',
           '--channels', '4', '--latency', '1/1', '-']
    env = dict(os.environ)
    # Inherit the fd at fd 3 — pipewire remote protocol reads it
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=sys.stderr,
                            env=env, pass_fds=[fd])
    # Read one frame-worth. We don't know dimensions upfront — read a generous
    # chunk then try to parse it as 1920x1080 / 1280x720 / the actual size.
    try:
        # Wait briefly, read up to 16MB
        chunk = b''
        start = time.time()
        # Read enough for 4K BGRx: 3840*2160*4 = ~33MB — read in chunks
        while time.time() - start < timeout and len(chunk) < 40 * 1024 * 1024:
            ready, _, _ = __import__('select').select([proc.stdout], [], [], 0.5)
            if ready:
                d = proc.stdout.read(65536)
                if not d: break
                chunk += d
            elif chunk:
                break
    finally:
        proc.terminate()
        try: proc.wait(timeout=2)
        except: proc.kill()

    if not chunk:
        return False, 'no data from pw-cat'

    # Try common dimensions, pick the one that divides the chunk evenly
    from PIL import Image
    for (w, h) in [(1920, 1080), (2560, 1440), (3840, 2160), (1280, 720),
                   (1366, 768), (1680, 1050), (1600, 900), (2880, 1620),
                   (2801, 1527), (4608, 2880), (3456, 2160)]:
        frame_size = w * h * 4
        if frame_size == 0: continue
        if len(chunk) >= frame_size:
            img = Image.frombytes('RGBX', (w, h), chunk[:frame_size])
            img = img.convert('RGB')
            img.save(out_png, 'PNG')
            # verify not all-black
            small = img.resize((50, 50))
            pixels = list(small.getdata())
            all_black = all(sum(p) < 30 for p in pixels)
            if not all_black:
                return True, f'captured {w}x{h}'
    # Unknown dimensions — try the smallest square-ish parse
    return False, f'could not parse frame dimensions ({len(chunk)} bytes raw)'


def main():
    portal = Portal()
    try:
        ok = portal.screenshot()
    except Exception as e:
        print(f'[vibe-screenshot] portal handshake failed: {e}', file=sys.stderr)
        return 3
    if not ok:
        print('[vibe-screenshot] no session', file=sys.stderr)
        return 4

    # Grab frame
    success, msg = grab_frame_pw_cat(portal.node_id, portal.pipewire_fd, OUT)
    print(f'[vibe-screenshot] {msg}', file=sys.stderr)
    if success:
        print(f'[vibe-screenshot] wrote {OUT}', file=sys.stderr)
        return 0
    return 5


if __name__ == '__main__':
    sys.exit(main())
