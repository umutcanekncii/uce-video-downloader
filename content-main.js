// UCE - Video Downloader MAIN World Network Interceptor
// Runs in the MAIN execution world to access native fetch/XHR and React Fiber props.

(function() {
  if (window.__uce_interceptor_loaded) return;
  window.__uce_interceptor_loaded = true;

  console.log('UCE: Network interceptor initialized (MAIN world).');

  // ─── URL helpers ───────────────────────────────────────────────────────────

  function cleanUrlString(url) {
    if (!url || typeof url !== 'string') return url;
    let s = url.trim();
    // Decode literal \uXXXX sequences (common in serialised React state)
    s = s.replace(/\\u([0-9a-fA-F]{4})/g, (_, g) => String.fromCharCode(parseInt(g, 16)));
    // Remove backslash escaping (e.g. \/ in JSON)
    s = s.replace(/\\/g, '');
    // Decode HTML entities
    while (s.includes('&amp;')) s = s.replace(/&amp;/g, '&');
    s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return s;
  }

  function stripByteRangeParams(url) {
    if (!url || typeof url !== 'string') return url;
    let abs = cleanUrlString(url);
    if (abs.startsWith('//')) abs = window.location.protocol + abs;
    else if (!abs.includes('://') && !abs.startsWith('blob:') && !abs.startsWith('data:')) {
      try {
        abs = window.location.origin + (abs.startsWith('/') ? '' : '/') + abs;
      } catch (e) {
        const a = document.createElement('a'); a.href = abs; abs = a.href;
      }
    }
    const qi = abs.indexOf('?');
    if (qi === -1) return abs;
    const base = abs.slice(0, qi);
    const pairs = abs.slice(qi + 1).split('&').filter(p => {
      if (!p) return false;
      const k = p.split('=')[0];
      return k !== 'bytestart' && k !== 'byteend';
    });
    return pairs.length === 0 ? base : base + '?' + pairs.join('&');
  }

  function isAudioUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const l = url.toLowerCase();
    return (
      l.includes('mime=audio') || l.includes('mime=audio%2f') ||
      l.includes('/aud/') || l.includes('/audio/') ||
      l.includes('_a.mp4') || l.includes('/audio_')
    );
  }

  function isVideoUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (isAudioUrl(url)) return false;
    // IMPORTANT: Skip googlevideo.com/videoplayback — these are range-request
    // streaming chunks, not complete video files. YouTube is handled exclusively
    // via the youtubei/v1/player API response interception below.
    if (url.includes('googlevideo.com')) return false;
    const path = url.split('?')[0].split('#')[0].toLowerCase();
    if (['.mp4','.webm','.m3u8','.mpd','.ogg','.mov','.3gp','.ts'].some(e => path.endsWith(e))) return true;
    if (url.includes('instagram.com') && (url.includes('.mp4') || url.includes('&efg='))) return true;
    if (url.includes('cdninstagram.com') && url.includes('.mp4')) return true;
    if (url.includes('vimeocdn.com') && url.includes('.mp4')) return true;
    if ((url.includes('.m3u8') || url.includes('.mpd') || url.includes('/video/')) &&
        !['.js','.css','.html','.svg','.png'].some(e => path.endsWith(e))) return true;
    return false;
  }

  function isMetaVideoUrl(str) {
    if (!str || typeof str !== 'string') return false;
    if (isAudioUrl(str)) return false;
    const isCdn = str.includes('cdninstagram.com') || str.includes('fbcdn.net') || str.includes('instagram.com');
    if (!isCdn) return false;
    if (!str.startsWith('http://') && !str.startsWith('https://') && !str.startsWith('//')) return false;
    const l = str.toLowerCase();
    if (['.jpg','.jpeg','.png','.webp','.gif','.heic'].some(e => l.includes(e))) return false;
    return true;
  }

  function isHttpUrl(url) {
    if (!url || typeof url !== 'string') return false;
    return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//') ||
           (!url.includes('://') && !url.startsWith('blob:') && !url.startsWith('mediasource:') && !url.startsWith('data:'));
  }

  // ─── postMessage to ISOLATED world ─────────────────────────────────────────

  function reportVideo(detail) {
    window.postMessage({ source: 'uce-video-downloader-main', detail }, '*');
  }

  // ─── Save CDN URL on DOM element (cross-world bridge) ──────────────────────

  function saveDirectUrl(video, url) {
    if (!video || !url) return;
    const clean = stripByteRangeParams(url);
    if (!clean || !clean.startsWith('http')) return;
    if (isAudioUrl(clean)) return;
    // Only overwrite if it's a genuine CDN URL (longer/more specific wins)
    if (!video.dataset.uceDirectUrl || clean.length > video.dataset.uceDirectUrl.length) {
      video.dataset.uceDirectUrl = clean;
    }
  }

  // ─── React Fiber props extractor ───────────────────────────────────────────
  //
  // Strategy:
  //  1. Walk up to 15 DOM ancestor levels looking for a __reactFiber key.
  //  2. For each fiber node, inspect memoizedProps and pendingProps.
  //  3. FIRST pass: look specifically in well-known video URL keys and arrays.
  //  4. SECOND pass: limited-depth generic object traversal, skipping Fiber
  //     tree pointers and audio-related keys to prevent circular traversal.

  function getReactVideoUrl(el) {
    let node = el;
    for (let i = 0; i < 15 && node; i++) {
      const fiberKey = Object.keys(node).find(k =>
        k.startsWith('__reactFiber') || k.startsWith('__reactProps')
      );
      if (fiberKey) {
        const fiber = node[fiberKey];
        if (fiber) {
          const url = extractFromProps(fiber.memoizedProps) ||
                      extractFromProps(fiber.pendingProps) ||
                      extractFromProps(fiber.props);
          if (url) return url;
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  // Target keys that typically hold video CDN URLs
  const VIDEO_KEYS = [
    'videoUrl', 'video_url', 'src', 'url', 'base_url', 'baseUrl',
    'videoSrc', 'video_src', 'dashManifestUrl', 'hlsManifestUrl'
  ];
  const VIDEO_ARRAY_KEYS = [
    'video_versions', 'videoVersions', 'video_resources', 'videoResources',
    'video_qualities', 'qualities', 'streams', 'sources'
  ];

  function extractFromProps(props) {
    if (!props || typeof props !== 'object') return null;

    // 1. Direct string keys
    for (const key of VIDEO_KEYS) {
      const val = props[key];
      if (typeof val === 'string') {
        const c = cleanUrlString(val);
        if (isMetaVideoUrl(c)) return c;
      }
    }

    // 2. Array keys (video_versions etc.) — each element may have url/src
    for (const key of VIDEO_ARRAY_KEYS) {
      const arr = props[key];
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (typeof item === 'string') {
          const c = cleanUrlString(item);
          if (isMetaVideoUrl(c)) return c;
        }
        if (item && typeof item === 'object') {
          for (const uk of VIDEO_KEYS) {
            const v = item[uk];
            if (typeof v === 'string') {
              const c = cleanUrlString(v);
              if (isMetaVideoUrl(c)) return c;
            }
          }
        }
      }
    }

    // 3. Limited generic deep search (max depth 5)
    return deepSearch(props, 0);
  }

  const SKIP_KEYS = new Set([
    'sibling','child','return','alternate','stateNode','_owner','_store',
    'ref','key','type','mode','flags','lanes','dependencies','updateQueue',
    'memoizedState','_reactInternalFiber','_reactInternalInstance'
  ]);

  function deepSearch(obj, depth) {
    if (!obj || depth > 5 || typeof obj !== 'object') return null;
    for (const key of Object.keys(obj)) {
      const lk = key.toLowerCase();
      if (SKIP_KEYS.has(key)) continue;
      if (lk.includes('audio') || lk.includes('music') || lk.includes('sound')) continue;
      try {
        const val = obj[key];
        if (typeof val === 'string') {
          const c = cleanUrlString(val);
          if (isMetaVideoUrl(c)) return c;
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
          const found = deepSearch(val, depth + 1);
          if (found) return found;
        } else if (Array.isArray(val)) {
          for (const item of val) {
            if (typeof item === 'string') {
              const c = cleanUrlString(item);
              if (isMetaVideoUrl(c)) return c;
            } else if (item && typeof item === 'object') {
              const found = deepSearch(item, depth + 1);
              if (found) return found;
            }
          }
        }
      } catch (e) {}
    }
    return null;
  }

  // ─── Per-video scan ────────────────────────────────────────────────────────

  function scanVideo(video) {
    // 1. Direct src
    if (video.src && isHttpUrl(video.src) && !video.src.startsWith('blob:')) {
      saveDirectUrl(video, video.src);
      reportVideo({ type: 'generic', url: stripByteRangeParams(video.src) });
    }
    // 2. <source> children
    video.querySelectorAll('source').forEach(s => {
      if (s.src && isHttpUrl(s.src)) {
        saveDirectUrl(video, s.src);
        reportVideo({ type: 'generic', url: stripByteRangeParams(s.src) });
      }
    });
    // 3. React Fiber props (critical for Instagram reels with blob: src)
    try {
      const reactUrl = getReactVideoUrl(video);
      if (reactUrl && isHttpUrl(reactUrl)) {
        saveDirectUrl(video, reactUrl);
        reportVideo({ type: 'generic', url: stripByteRangeParams(reactUrl) });
      }
    } catch (e) {
      console.debug('UCE React probe error:', e);
    }
  }

  function scanAllVideos() {
    document.querySelectorAll('video').forEach(scanVideo);
  }

  // ─── Play event (capture phase) ────────────────────────────────────────────

  document.addEventListener('play', (e) => {
    if (e.target?.tagName === 'VIDEO') {
      scanVideo(e.target);
      // Re-scan after a short delay — Instagram sets data-uce-direct-url async
      setTimeout(() => scanVideo(e.target), 500);
      setTimeout(() => scanVideo(e.target), 1500);
    }
  }, true);

  // ─── Periodic scans ────────────────────────────────────────────────────────

  setTimeout(scanAllVideos, 300);
  setTimeout(scanAllVideos, 1000);
  setTimeout(scanAllVideos, 2500);
  setTimeout(scanAllVideos, 5000);
  setInterval(scanAllVideos, 3000);

  // ─── YouTube: scan ytInitialPlayerResponse (available on page load) ──────────
  // YouTube embeds the player API response directly in the page as a JS variable.
  // We read it once the page is ready and again after a short delay.

  function tryReadYtInitialData() {
    try {
      const ytData = window.ytInitialPlayerResponse;
      if (ytData && ytData.streamingData) {
        console.log('UCE: Found ytInitialPlayerResponse');
        reportVideo({ type: 'youtube', url: location.href, data: ytData });
        return true;
      }
    } catch (e) {}
    return false;
  }

  // Try immediately, then with increasing delays
  if (!tryReadYtInitialData()) {
    setTimeout(() => { if (!tryReadYtInitialData()) setTimeout(tryReadYtInitialData, 2000); }, 500);
  }

  // ─── Fetch interceptor ─────────────────────────────────────────────────────

  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    const req = args[0];
    let url = typeof req === 'string' ? req : (req?.url || '');
    const res = await origFetch.apply(this, args);
    try {
      if (url.includes('youtubei/v1/player')) {
        res.clone().json().then(d => reportVideo({ type: 'youtube', url, data: d })).catch(() => {});
      } else if (url.includes('player.vimeo.com/video') && url.includes('/config')) {
        res.clone().json().then(d => reportVideo({ type: 'vimeo', url, data: d })).catch(() => {});
      } else if (isVideoUrl(url)) {
        reportVideo({ type: 'generic', url: stripByteRangeParams(url) });
      }
    } catch (e) {}
    return res;
  };

  // ─── XHR interceptor ───────────────────────────────────────────────────────

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._uceUrl = url;
    return origOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener('load', function() {
      try {
        const url = this._uceUrl;
        if (!url) return;
        if (url.includes('youtubei/v1/player')) {
          try { reportVideo({ type: 'youtube', url, data: JSON.parse(this.responseText) }); } catch (e) {}
        } else if (url.includes('player.vimeo.com/video') && url.includes('/config')) {
          try { reportVideo({ type: 'vimeo', url, data: JSON.parse(this.responseText) }); } catch (e) {}
        } else if (isVideoUrl(url)) {
          reportVideo({ type: 'generic', url: stripByteRangeParams(url) });
        }
      } catch (e) {}
    });
    return origSend.apply(this, args);
  };

})();
