// Vibe GPT Studio Screenshot Helper — GNOME Shell extension.
// Runs INSIDE the compositor process with full access to Shell.Screenshot,
// bypassing the xdg-desktop-portal interactive-consent gate (GNOME 50 locks
// down the org.gnome.Shell.Screenshot DBus path with AccessDenied for external
// callers, but extensions can use it directly).
//
// Exposes a DBus method on the session bus at:
//   dest: org.gnome.Shell.Extensions.ScreenshotHelper
//   path: /org/gnome/Shell/Extensions/ScreenshotHelper
//   method: Capture(in s filename) -> (b success, s filename_used, s error)

const { GLib, Gio, Shell, Meta } = imports.gi;

const SCHEMA = `
<node>
  <interface name="org.gnome.Shell.Extensions.ScreenshotHelper">
    <method name="Capture">
      <arg type="s" name="filename" direction="in"/>
      <arg type="b" name="success" direction="out"/>
      <arg type="s" name="filename_used" direction="out"/>
      <arg type="s" name="error" direction="out"/>
    </method>
    <method name="Ping">
      <arg type="s" name="pong" direction="out"/>
    </method>
  </interface>
</node>
`;

class Extension {
    enable() {
        this._screenshot = new Shell.Screenshot();
        // Export the DBus interface so external callers (the Node backend) can
        // invoke Capture() synchronously.
        this._dbus = Gio.DBusExportedObject.wrapJSObject(SCHEMA, this);
        this._dbus.export(Gio.DBus.session, '/org/gnome/Shell/Extensions/ScreenshotHelper');
        // Also claim the well-known name so clients can find it.
        Gio.DBus.session.own_name('org.gnome.Shell.Extensions.ScreenshotHelper',
            Gio.BusNameOwnerFlags.NONE, null, null);
        log('[VibeScreenshotHelper] enabled, DBus exported');
    }

    disable() {
        if (this._dbus) {
            this._dbus.unexport();
            this._dbus = null;
        }
        this._screenshot = null;
    }

    // DBus method: capture the whole screen to `filename`.
    Capture(filename) {
        try {
            // Shell.Screenshot.screenshot_stage (GNOME 50+) reads the stage
            // compositor directly — no portal, no consent dialog, no X11.
            // Signature: screenshot_stage(filename, callback) on GNOME 40+, or
            // screenshot(include_cursor, flash, filename, callback) on older.
            const path = filename || GLib.build_filenamev([
                GLib.get_home_dir(), 'Pictures', 'Screenshots',
                'vibe_capture_' + Date.now() + '.png'
            ]);
            // Ensure parent dir exists
            const dir = GLib.path_get_dirname(path);
            GLib.mkdir_with_parents(dir, 0o755);

            // GNOME 50: Shell.Screenshot has screenshot_stage / screenshot_window
            // and the older screenshot(). Use whichever exists; both bypass the
            // portal because they run with shell privileges.
            return new Promise((resolve) => {
                let resolved = false;
                const done = (success, used, err) => {
                    if (resolved) return; resolved = true;
                    resolve([success, used || path, err || '']);
                };
                try {
                    if (typeof this._screenshot.screenshot_stage === 'function') {
                        // GNOME 40+: screenshot_stage(filename, callback)
                        this._screenshot.screenshot_stage(path, (o, result) => {
                            try { this._screenshot.screenshot_stage_finish(result); done(true, path, ''); }
                            catch (e) { done(false, path, 'screenshot_stage_finish: ' + e.message); }
                        });
                    } else {
                        // older API: screenshot(include_cursor, flash, filename, callback)
                        this._screenshot.screenshot(false, false, path, (o, result) => {
                            try { this._screenshot.screenshot_finish(result); done(true, path, ''); }
                            catch (e) { done(false, path, 'screenshot_finish: ' + e.message); }
                        });
                    }
                    // Timeout fallback: if no callback within 5s, fail loudly
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 5000, () => {
                        done(false, path, 'capture timeout (5s)');
                        return GLib.SOURCE_REMOVE;
                    });
                } catch (e) {
                    done(false, path, 'exception: ' + e.message);
                }
            });
        } catch (e) {
            return [false, filename || '', 'exception: ' + e.message];
        }
    }

    Ping() {
        return 'pong';
    }
}

function init() { return new Extension(); }
