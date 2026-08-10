#!/usr/bin/env bash
# Install the Vibe GPT Studio Screenshot Helper GNOME Shell extension.
#
# This extension enables FULLY HEADLESS, non-interactive screenshots on
# GNOME 49+ / Wayland, where the xdg-desktop-portal Screenshot API was
# locked down to require interactive consent (and X11 tools produce black
# frames). The extension runs inside the compositor process and calls
# Shell.Screenshot directly — no dialog, no portal, no consent click.
#
# Usage:
#   ./install.sh            # install to ~/.local/share/gnome-shell/extensions
#   ./install.sh --system   # install system-wide (needs sudo)
#
# After install: log out and back in ONCE (or restart GNOME Shell on X11
# via Alt+F2 → 'r'). GNOME 50/Wayland does not pick up new extensions
# mid-session. After the restart, the take_screenshot tool will use the
# extension automatically (no further action needed).
set -euo pipefail

EXT_UUID="screenshot_helper@vibe-gpt-studio"
SRC_DIR="$(cd "$(dirname "$0")/screenshot_helper@vibe-gpt-studio" && pwd)"

if [[ "${1:-}" == "--system" ]]; then
  DEST="/usr/share/gnome-shell/extensions"
  if [[ $EUID -ne 0 ]]; then echo "Run --system with sudo"; exit 1; fi
else
  DEST="${HOME}/.local/share/gnome-shell/extensions"
  mkdir -p "$DEST"
fi

echo "Installing $EXT_UUID to $DEST ..."
mkdir -p "$DEST/$EXT_UUID"
cp "$SRC_DIR/extension.js" "$SRC_DIR/metadata.json" "$DEST/$EXT_UUID/"
echo "Installed."

# Enable via gsettings (list of enabled extensions)
python3 - "$EXT_UUID" <<'PY'
import subprocess, sys, ast
uuid = sys.argv[1]
key = 'enabled-extensions'
cur = subprocess.run(['gsettings', 'get', 'org.gnome.shell', key],
                     capture_output=True, text=True).stdout.strip()
try: exts = ast.literal_eval(cur)
except Exception: exts = []
if uuid not in exts:
    exts.append(uuid)
subprocess.run(['gsettings', 'set', 'org.gnome.shell', key, str(exts).replace("'", '"')])
print(f"Enabled: {exts}")
PY

echo ""
echo "Done. IMPORTANT: log out and back in once (GNOME 50/Wayland cannot reload"
echo "extensions without a session restart). After re-login, headless screenshots"
echo "will work via the extension — no consent dialog, no black frames."
echo ""
echo "Verify after re-login:"
echo "  gdbus call --session --dest org.gnome.Shell.Extensions.ScreenshotHelper \\"
echo "    --object-path /org/gnome/Shell/Extensions/ScreenshotHelper \\"
echo "    --method org.gnome.Shell.Extensions.ScreenshotHelper.Ping"
echo "  # should return: ('pong',)"
