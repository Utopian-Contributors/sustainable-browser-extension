# Debugging Instructions for Sustainable Browser Extension

## Prerequisites
1. Download dependencies first:
   ```bash
   yarn download-deps
   ```

## Testing Method: Use Web Store Build (Recommended)

The development builds don't include all the necessary data. **Always test with the web store build** which is fully packaged.

### Build Web Store Package
```bash
yarn build-webstore
```
This creates: `dist/sustainable-browser-extension-v1.0.0.zip`

### Install in Chrome
1. Go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. **Extract the ZIP file first**, then select the extracted folder
5. The extension should load without errors

### Install in Firefox
1. Go to `about:debugging`
2. Click "This Firefox"
3. Click "Load Temporary Add-on"
4. Select the `manifest.json` file from the **extracted ZIP folder**

## Debugging Steps

### 1. Check Extension Loading
- **Chrome**: Extension should appear in `chrome://extensions/` without errors
- **Firefox**: Extension should appear in `about:debugging` and not be greyed out

### 2. Check Background Script
- **Chrome**: Right-click extension → "Inspect popup" → Console tab
- **Firefox**: Browser Console (Ctrl+Shift+J) should show initialization logs

### 3. Check Network Interception
1. Open DevTools → Network tab
2. Visit test page or site with CDN requests
3. Look for:
   - Original requests to `https://esm.sh/...`
   - Redirected requests to `chrome-extension://...` or `moz-extension://...`

### 4. Check Extension Popup
Click the extension icon to see:
- "X dependencies cached" (should be > 0 after first build)
- "X requests intercepted" (should increase when visiting sites)
- "X bandwidth saved" (should show savings)

## Expected Results

### After Web Store Build:
- Dependencies folder should contain 27+ files
- Extension popup should show "27 dependencies cached" immediately
- When visiting sites with CDN requests, "requests intercepted" should increase

### Network Tab Should Show:
- Original request: `https://esm.sh/react@18.2.0` → Status: 200 (redirect)
- Actual response from: `chrome-extension://[id]/dependencies/react@[version].js`

## Troubleshooting

### Chrome: "Service worker registration failed"
- Make sure you extracted the ZIP file completely
- Check Console for specific errors
- Verify `background.js` exists in the folder

### Firefox: Extension greyed out
- Use the web store build (not development build)
- Check Browser Console for JavaScript errors
- Verify `manifest.json` has correct permissions

### No interceptions happening:
- Verify dependencies were downloaded (`yarn download-deps`)
- Check if the websites actually use the CDNs in our mappings
- Look at Network tab to see if requests are being made to esm.sh

## Development vs Production

- **Development builds** (`yarn build-cross-browser`): May miss dependencies, incomplete data
- **Production builds** (`yarn build-webstore`): Complete package with all data needed
- **Always test production builds** for accurate results