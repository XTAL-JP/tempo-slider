# Privacy Policy — TEMPO Slider

_Last updated: 2026-06-20_

## Summary

TEMPO Slider does **not** collect, transmit, or store any personal data.
The extension processes audio entirely **locally in your browser**.

## What the extension does

- Modifies the playback rate and pitch of audio playing on supported sites (Bandcamp, Beatport, Traxsource, and any sites you add yourself).
- Stores your local panel position and added-site list in your browser using `chrome.storage.local`. This data never leaves your device.
- Removes Content-Security-Policy headers from supported sites so the bundled pitch-shifting library (Rubber Band, via Emscripten) can run inside the page's AudioContext.
- Adds CORS headers to audio CDN responses for supported sites so the extension can route audio through its DSP pipeline.

## What the extension does NOT do

- No analytics, telemetry, or tracking.
- No remote API calls.
- No reading of user content, account information, or messages.
- No advertising.
- No selling or sharing of data.

## Permissions explained

| Permission | Why |
|---|---|
| `activeTab` | Get the current tab's URL when you click "+ Add this site" |
| `storage` | Save your panel position and the list of sites you've added |
| `scripting` | Inject content scripts into custom sites you add at runtime |
| `declarativeNetRequest`, `declarativeNetRequestWithHostAccess` | Add CORS and remove CSP headers for supported sites (locally, in your browser) |
| `host_permissions` (bandcamp / bcbits / beatport / traxsource / akamaized) | Inject the player UI and DSP into the built-in supported sites |
| `optional_host_permissions` (`https://*/*`) | Reserved for sites you explicitly add via the popup. Not granted by default |

## Open source

This extension's source code is published at https://github.com/XTAL-JP/tempo-slider under GPL-2.0.

## Contact

For privacy-related questions, open an issue on the GitHub repository.
