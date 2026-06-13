UCE - Video Downloader

A modern Manifest V3 browser extension built to seamlessly detect, isolate, and download high-quality Instagram Reels and videos directly from the feed or single tabs.

Features
* **Smart Detection:** Automatically intercepts network streams to capture the highest resolution available.
* **Stream Isolation:** Prevents duplicate entries or bulk hoarding during endless scrolling on Instagram feed.
* **Modern UI:** Glassmorphic overlay buttons injected directly into the active DOM video container.
* **Cross-Browser:** Compatible with all Chromium-based browsers (Chrome, Edge, Opera).

Technical Highlights
* **Manifest V3 Architecture:** Built utilizing secure background service workers.
* **Double-World Injection:** Uses `MAIN` world context for interception and bridges seamlessly with `ISOLATED` world for safe DOM manipulation.
* **Safe URL Parsing:** Leverages native `URLSearchParams` object to clean byte-range chunk parameters without corrupting original CDN signatures.

Installation Guide

1. **Download the Project:** Click on the green `<> Code` button above and select **Download ZIP**, then extract it to a folder on your computer.
2. **Open Extensions Page:** Open your Chromium browser and navigate to:
   * Chrome: `chrome://extensions`
   * Edge: `edge://extensions`
   * Opera: `opera://extensions`
3. **Enable Developer Mode:** Toggle the **Developer mode** switch in the top-right corner to **ON**.
4. **Load the Extension:** Click on **Load unpacked** (Paketlenmemiş öğe yükle) in the top-left corner and select the extracted folder.

Now, simply open Instagram, play any video, and use the glassmorphic download action button!
