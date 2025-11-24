# Disable Auto-Opening Browser in Cursor IDE

If Cursor IDE keeps automatically opening a browser tab when you run `npm run dev`, this is Cursor's port forwarding feature detecting your dev server. Here are solutions:

## ⚠️ CRITICAL: Cursor Settings UI (MUST DO THIS)

Cursor's port forwarding feature overrides workspace settings. You **MUST** disable it in Cursor's UI:

1. **Open Cursor Settings:**
   - Press `Cmd+,` (Mac) or `Ctrl+,` (Windows/Linux)
   - Or: Cursor → Settings → Settings

2. **Disable Port Forwarding:**
   - Search for: `remote.ports.autoForward`
   - Set it to: **`false`** (unchecked)
   
3. **Disable Port Preview:**
   - Search for: `remote.ports.previewInBrowser`
   - Set it to: **`false`** (unchecked)

4. **Set Auto Forward Action:**
   - Search for: `remote.ports.autoForwardAction`
   - Set it to: **`never`**

5. **Restart Cursor IDE** after making these changes

## Already Configured (May Not Work Without UI Changes)

The project has workspace settings that should help:
- `.vscode/settings.json` - VS Code/Cursor workspace settings
- `.cursor/settings.json` - Cursor-specific settings

**However, Cursor's global settings often override workspace settings for port forwarding.**

## Changes Made to Help

1. **Updated `package.json` script:**
   - Added `BROWSER=none` environment variable
   - Added `--no-open` flag to vite command
   - Now runs: `BROWSER=none vite --no-open`

2. **Changed port from 3000 to 5174:**
   - Cursor may have port 3000 in its auto-detect list
   - New port: `http://127.0.0.1:5174`

3. **Updated `vite.config.js`:**
   - `open: false` (already had this)
   - `host: '127.0.0.1'` (instead of localhost)
   - Port changed to 5174

## Manual Browser Access

After running `npm run dev`, manually open:
- `http://127.0.0.1:5174` (note the new port)
- The terminal will show the exact URL

## If Still Opening

1. **Check Cursor Extensions** - Some extensions might auto-open browsers
2. **Close the preview tab manually** - Right-click the tab → "Close"
3. **Use external terminal** - Run `npm run dev` in Terminal.app (not Cursor's integrated terminal)
4. **Check for port forwarding notifications** - If Cursor shows a notification about port forwarding, click "Ignore" or "Don't Show Again"

## Why This Happens

Cursor IDE has a feature that automatically detects when development servers start on common ports (3000, 5173, 8080, etc.) and opens a preview tab. This is separate from Vite's `open` option. The workspace settings help, but Cursor's global user settings often take precedence.


