// UCE - Video Downloader Service Worker

// Keep track of detected videos per tab
const tabVideos = {};

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  // Helper: safely call sendResponse (context may be invalidated by reload)
  function safeRespond(data) {
    try { sendResponse(data); } catch (e) {}
  }

  if (message.action === 'register_videos') {
    if (tabId) {
      tabVideos[tabId] = message.videos || [];
      updateBadge(tabId);
    }
    safeRespond({ status: 'success' });
    return false;
  }

  if (message.action === 'download_video') {
    const { url, filename } = message;

    if (!url || !url.startsWith('http')) {
      safeRespond({ success: false, error: 'Invalid or missing URL' });
      return false;
    }

    chrome.storage.local.get(['videoCounter'], (result) => {
      let counter = (result.videoCounter) || 1;

      let ext = 'mp4';
      if (filename && filename.includes('.')) {
        ext = filename.split('.').pop().toLowerCase();
      } else {
        const urlPath = url.split('?')[0].split('#')[0].toLowerCase();
        if (urlPath.endsWith('.webm')) ext = 'webm';
        else if (urlPath.endsWith('.m3u8')) ext = 'm3u8';
        else if (urlPath.endsWith('.mpd'))  ext = 'mpd';
      }
      if (ext === 'video only' || ext === 'audio') ext = 'mp4';
      if (ext === 'hls stream') ext = 'm3u8';

      const cleanFilename = `Video_${counter}.${ext}`;
      chrome.storage.local.set({ videoCounter: counter + 1 });

      console.log(`UCE: downloading ${cleanFilename} from ${url.substring(0, 80)}...`);

      try {
        chrome.downloads.download(
          { url, filename: cleanFilename, saveAs: true, conflictAction: 'uniquify' },
          (downloadId) => {
            if (chrome.runtime.lastError) {
              console.error('UCE download error:', chrome.runtime.lastError.message);
              safeRespond({ success: false, error: chrome.runtime.lastError.message });
            } else {
              console.log(`UCE: download started, id=${downloadId}`);
              safeRespond({ success: true, downloadId });
            }
          }
        );
      } catch (err) {
        console.error('UCE download exception:', err.message);
        safeRespond({ success: false, error: err.message });
      }
    });

    return true; // Keep channel open for async response
  }
});

// Update extension badge text
function updateBadge(tabId) {
  const videos = tabVideos[tabId] || [];
  const count = videos.length;
  
  if (count > 0) {
    chrome.action.setBadgeText({
      text: count.toString(),
      tabId: tabId
    });
    chrome.action.setBadgeBackgroundColor({
      color: '#FF3366', // Pink/Red matching the design system
      tabId: tabId
    });
  } else {
    chrome.action.setBadgeText({
      text: '',
      tabId: tabId
    });
  }
}

// Clean up state when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabVideos[tabId];
});

// Initialize or reset counter when Chrome starts up or the extension is installed/reloaded
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.set({ videoCounter: 1 });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ videoCounter: 1 });
});
