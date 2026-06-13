// UCE - Video Downloader ISOLATED World Content Script
// Handles DOM monitoring, player overlays, UI rendering, and bridging to the background service worker.

(function() {
  if (window.__uce_isolated_loaded) return;
  window.__uce_isolated_loaded = true;

  console.log('UCE: Isolated content script initialized.');

  // ─── Safe chrome.runtime wrapper ───────────────────────────────────────────
  // Prevents "Extension context invalidated" crashes when extension is reloaded
  function safeSendMessage(msg, callback) {
    try {
      if (!chrome || !chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) return; // Silently swallow
        if (callback) callback(response);
      });
    } catch (e) {} // Context invalidated — silently swallow
  }

  // ─── URL helpers ────────────────────────────────────────────────────────────

  function cleanUrlString(url) {
    if (!url || typeof url !== 'string') return url;
    let clean = url.trim();
    clean = clean.replace(/\\u([0-9a-fA-F]{4})/g, (_, grp) => String.fromCharCode(parseInt(grp, 16)));
    clean = clean.replace(/\\/g, '');
    while (clean.includes('&amp;')) clean = clean.replace(/&amp;/g, '&');
    clean = clean.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return clean;
  }

  function isAudioUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    return lower.includes('mime=audio') || lower.includes('mime=audio%2f') ||
           lower.includes('/aud/') || lower.includes('/audio/') ||
           lower.includes('_a.mp4') || lower.includes('/audio_');
  }

  function stripByteRangeParams(url) {
    if (!url || typeof url !== 'string') return url;
    let abs = cleanUrlString(url);
    if (abs.startsWith('//')) {
      abs = window.location.protocol + abs;
    } else if (!abs.includes('://') && !abs.startsWith('blob:') && !abs.startsWith('data:')) {
      try {
        abs = window.location.origin + (abs.startsWith('/') ? '' : '/') + abs;
      } catch (e) { const a = document.createElement('a'); a.href = abs; abs = a.href; }
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

  function getCleanVideoKey(url) {
    if (!url || typeof url !== 'string') return '';
    const clean = stripByteRangeParams(url);
    if (clean.startsWith('blob:')) {
      if (location.host.includes('youtube.com')) return 'youtube_active';
      if (location.host.includes('vimeo.com')) return 'vimeo_active';
      return 'blob_active';
    }
    try {
      const u = new URL(clean);
      if (u.hostname.includes('googlevideo.com')) return 'youtube_active';
      return u.origin + u.pathname;
    } catch (e) {
      return clean.split('?')[0].split('#')[0];
    }
  }

  // ─── State (globals intentionally kept — these drive UI positioning) ────────

  let detectedVideosMap = {};
  let activeVideoElement = null;
  let activePlayerContainer = null;
  let uiButton = null;
  let uiDropdown = null;
  let lastUrl = location.href;

  // ─── Route-change cleanup ───────────────────────────────────────────────────

  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      detectedVideosMap = {};
      activeVideoElement = null;
      activePlayerContainer = null;
      removeFloatingUI();
      safeSendMessage({ action: 'register_videos', videos: [] });
    }
  }, 1000);

  // ─── Badge sync ─────────────────────────────────────────────────────────────

  function syncWithBackground() {
    const keys = Object.keys(detectedVideosMap).filter(
      k => k !== 'youtube_active' && k !== 'vimeo_active' && k !== 'blob_active'
    );
    let total = keys.length;
    if (detectedVideosMap['youtube_active']?.length > 0) total++;
    if (detectedVideosMap['vimeo_active']?.length > 0) total++;
    safeSendMessage({ action: 'register_videos', videos: new Array(total).fill({}) });
  }

  // ─── Video store ────────────────────────────────────────────────────────────

  function addDetectedVideo(video) {
    if (!video.url) return;
    video.url = stripByteRangeParams(video.url);
    if (video.url.startsWith('blob:') || video.url.startsWith('mediasource:') || video.url.startsWith('data:')) return;
    if (isAudioUrl(video.url)) return;

    const key = getCleanVideoKey(video.url);
    if (!key) return;

    detectedVideosMap[key] = detectedVideosMap[key] || [];
    const exists = detectedVideosMap[key].some(v => v.url === video.url && v.quality === video.quality);
    if (!exists) {
      detectedVideosMap[key].push(video);
      syncWithBackground();
      updateDropdownContent(); // refresh open dropdown if any
    }
  }

  // ─── MAIN world → ISOLATED via postMessage ──────────────────────────────────

  window.addEventListener('message', (event) => {
    if (event.data?.source !== 'uce-video-downloader-main') return;
    const detail = event.data.detail;
    if (!detail) return;
    if (detail.type === 'youtube') handleYouTubeData(detail.data);
    else if (detail.type === 'vimeo') handleVimeoData(detail.data);
    else if (detail.type === 'generic') handleGenericUrl(detail.url);
  });

  // ─── Platform parsers ───────────────────────────────────────────────────────

  function handleYouTubeData(data) {
    if (!data?.streamingData) return;
    const title = data.videoDetails?.title || document.title;

    const getMimeExt = (f) => {
      if (!f?.mimeType) return 'MP4';
      const clean = f.mimeType.split(';')[0];
      const ext = clean.includes('/') ? clean.split('/')[1] : clean;
      return (ext || 'MP4').toUpperCase();
    };

    let found = false;

    // 1. Try streamingData.formats (multiplexed audio+video, up to 720p, direct URL)
    (data.streamingData.formats || []).forEach(format => {
      if (format.url && !format.signatureCipher && !format.cipher) {
        const size = format.contentLength
          ? (parseInt(format.contentLength) / 1048576).toFixed(1) + ' MB' : null;
        addDetectedVideo({
          url: format.url, title,
          quality: format.qualityLabel || (format.height ? `${format.height}p` : 'SD'),
          format: getMimeExt(format), size,
          source: 'YouTube', audioOnly: false, videoOnly: false
        });
        found = true;
      }
    });

    // 2. Fallback: try adaptiveFormats — pick video-only streams with direct URLs
    //    (these require a separate audio track but at least provide a working download URL)
    if (!found) {
      (data.streamingData.adaptiveFormats || []).forEach(format => {
        if (!format.url || format.signatureCipher || format.cipher) return;
        const mimeType = format.mimeType || '';
        const isVideo = mimeType.startsWith('video/') && !mimeType.includes('audio');
        if (!isVideo) return;
        const size = format.contentLength
          ? (parseInt(format.contentLength) / 1048576).toFixed(1) + ' MB' : null;
        addDetectedVideo({
          url: format.url, title,
          quality: format.qualityLabel || (format.height ? `${format.height}p` : 'HD'),
          format: getMimeExt(format), size,
          source: 'YouTube', audioOnly: false, videoOnly: true
        });
        found = true;
      });
    }

    if (found) console.log('UCE: YouTube streams detected from player API');
    else console.log('UCE: YouTube player data found but all URLs are cipher-protected (signed streams)');
  }

  function handleVimeoData(data) {
    if (!data?.request?.files) return;
    const title = data.video?.title || document.title;
    const files = data.request.files;
    (files.progressive || []).forEach(file => {
      if (file.url) {
        addDetectedVideo({
          url: file.url, title,
          quality: file.quality || `${file.height}p`,
          format: 'MP4', size: null,
          source: 'Vimeo', audioOnly: false, videoOnly: false
        });
      }
    });
    if (files.hls?.default?.url) {
      addDetectedVideo({
        url: files.hls.default.url, title,
        quality: 'Auto (HLS)', format: 'M3U8', size: null,
        source: 'Vimeo', audioOnly: false, videoOnly: false
      });
    }
  }

  function handleGenericUrl(url) {
    if (!url) return;

    // YouTube CDN stream segments are NOT downloadable as complete files.
    // YouTube is handled exclusively via the player API (ytInitialPlayerResponse / youtubei/v1/player).
    if (url.includes('googlevideo.com')) return;

    let title = document.title;
    try {
      const parts = url.split('?')[0].split('/');
      const last = parts[parts.length - 1];
      if (last && last.includes('.')) title = last.split('.')[0];
    } catch (e) {}

    let format = 'MP4';
    const cleanPath = url.split('?')[0].toLowerCase();
    if (cleanPath.endsWith('.webm')) format = 'WEBM';
    else if (cleanPath.endsWith('.m3u8')) format = 'M3U8';
    else if (cleanPath.endsWith('.mpd')) format = 'MPD';
    else if (cleanPath.endsWith('.ogg')) format = 'OGG';

    let quality = 'Detected';
    let source = 'Webpage';
    if (location.host.includes('instagram.com')) {
      source = 'Instagram'; quality = 'HD'; title = document.title;
    } else {
      const m = url.match(/(1080p|720p|480p|360p|240p)/i);
      if (m) quality = m[0];
    }

    addDetectedVideo({ url, title, quality, format, size: null, source, audioOnly: false, videoOnly: false });
  }

  // ─── DOM scanner ────────────────────────────────────────────────────────────

  function inspectVideoSource(video) {
    // Read data-uce-direct-url written by MAIN world (cross-world DOM bridge)
    const directUrl = video.dataset.uceDirectUrl;
    if (directUrl && !directUrl.startsWith('blob:') && !directUrl.startsWith('mediasource:')) {
      handleGenericUrl(directUrl);
    }
    if (video.src && !video.src.startsWith('blob:') && !video.src.startsWith('mediasource:')) {
      handleGenericUrl(video.src);
    }
    video.querySelectorAll('source').forEach(s => {
      if (s.src && !s.src.startsWith('blob:')) handleGenericUrl(s.src);
    });
  }

  function scanDOMForVideos() {
    document.querySelectorAll('video').forEach(video => {
      inspectVideoSource(video);
      if (!video.dataset.uceHooked) {
        video.dataset.uceHooked = 'true';
        video.addEventListener('play',    () => onVideoPlay(video));
        video.addEventListener('playing', () => onVideoPlay(video));
        video.addEventListener('timeupdate', () => {
          if (!video.paused) positionFloatingButton(video);
        });
        if (!video.paused) onVideoPlay(video);
      }
    });
  }

  scanDOMForVideos();

  // MutationObserver for dynamically added videos (Instagram feed)
  const domObserver = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.tagName === 'VIDEO' || (node.querySelector && node.querySelector('video'))) {
          shouldScan = true; break;
        }
      }
      if (shouldScan) break;
    }
    if (shouldScan) scanDOMForVideos();
  });
  domObserver.observe(document.body, { childList: true, subtree: true });

  // Capture-phase play listener
  document.addEventListener('play', (event) => {
    if (event.target?.tagName === 'VIDEO') {
      inspectVideoSource(event.target);
      onVideoPlay(event.target);
    }
  }, true);

  // Periodic scans — catches late-loading Instagram direct-page videos
  setTimeout(scanDOMForVideos, 800);
  setTimeout(scanDOMForVideos, 2000);
  setTimeout(scanDOMForVideos, 4000);

  // ─── Player container ───────────────────────────────────────────────────────

  function getPlayerContainer(video) {
    // YouTube
    const ytPlayer = video.closest('#movie_player') || video.closest('.html5-video-player');
    if (ytPlayer) return ytPlayer;

    // Vimeo
    const vimeoPlayer = video.closest('.vp-video-wrapper') || video.closest('.player');
    if (vimeoPlayer) return vimeoPlayer;

    // Instagram — article covers feed posts; padding-bottom covers reel/post pages
    const instaContainer = video.closest('div[style*="padding-bottom"]') ||
                           video.closest('article') ||
                           video.parentElement;
    if (instaContainer) return instaContainer;

    // Generic fallback: nearest parent sized at least as large as the video
    let current = video.parentElement;
    while (current && current !== document.body) {
      const rect  = current.getBoundingClientRect();
      const vRect = video.getBoundingClientRect();
      if (rect.width >= vRect.width - 10 && rect.height >= vRect.height - 10) return current;
      current = current.parentElement;
    }
    return video.parentElement || document.body;
  }

  // ─── onVideoPlay ────────────────────────────────────────────────────────────

  function onVideoPlay(video) {
    activeVideoElement = video;
    const container = getPlayerContainer(video);
    activePlayerContainer = container;

    createFloatingButton(video);
    inspectVideoSource(video);
  }

  // ─── Floating button ─────────────────────────────────────────────────────────
  // Appended to document.body with position:fixed so Instagram's click-capturing
  // overlays (play/pause, swipe handlers) can NEVER intercept our button clicks.

  function createFloatingButton(video) {
    // Reuse existing button already bound to this video element
    if (video.__uceBtn && video.__uceBtn.isConnected) {
      uiButton = video.__uceBtn;
      uiButton.style.display = 'flex';
      uiButton.videoElement = video;
      positionFloatingButton(video);
      return;
    }

    const btn = document.createElement('div');
    btn.className = 'uce-vd-floating-btn';
    btn.setAttribute('title', 'UCE Video Downloader');
    btn.innerHTML = `
      <div class="uce-vd-logo-circle">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
      </div>
      <span class="uce-vd-badge-dot"></span>
    `;

    btn.videoElement = video;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      const targetVideo = btn.videoElement || activeVideoElement;
      toggleDropdown(targetVideo, btn, activePlayerContainer);
    });

    // Attach to body — completely outside Instagram's DOM hierarchy
    document.body.appendChild(btn);
    video.__uceBtn = btn;
    uiButton = btn;
    positionFloatingButton(video);
  }

  // Position using fixed viewport coordinates derived from the video's bounding rect
  function positionFloatingButton(video) {
    const btn = (video && video.__uceBtn) || uiButton;
    if (!btn) return;
    const vRect = video.getBoundingClientRect();
    // Place button 12px from the top-right corner of the video, 60px from right edge
    // (leaves room for Instagram's own mute/settings icons which sit at the far right)
    const top  = vRect.top  + window.scrollY + 12;
    const left = vRect.right - 60 - 44; // 60px buffer + 44px button width
    btn.style.position = 'fixed';
    btn.style.top  = `${vRect.top + 12}px`;
    btn.style.left = `${Math.max(4, vRect.right - 60 - 44)}px`;
    btn.style.right = 'auto';
  }

  // Reposition all active buttons on scroll / resize
  function repositionAllButtons() {
    document.querySelectorAll('video').forEach(video => {
      if (video.__uceBtn && video.__uceBtn.isConnected && !video.paused) {
        positionFloatingButton(video);
      }
    });
  }
  window.addEventListener('scroll', repositionAllButtons, { passive: true });
  window.addEventListener('resize', repositionAllButtons, { passive: true });

  // ─── Dropdown toggle ─────────────────────────────────────────────────────────

  function toggleDropdown(video, btn, container) {
    if (uiDropdown) {
      removeDropdown();
    } else {
      createDropdown(video, btn, container);
    }
  }

  function createDropdown(video, btn, container) {
    const activeBtn = btn || uiButton;
    const activeContainer = container || activePlayerContainer;
    if (!activeBtn || !activeContainer) return;

    activeVideoElement = video; // lock to clicked video

    uiDropdown = document.createElement('div');
    uiDropdown.className = 'uce-vd-dropdown';

    const header = document.createElement('div');
    header.className = 'uce-vd-dropdown-header';
    header.innerHTML = `
      <div class="uce-vd-dropdown-title">
        <span class="uce-vd-brand">UCE</span> Video Downloader
      </div>
      <div class="uce-vd-status">
        <span class="uce-vd-status-dot"></span>
        <span id="uce-count-text">0 videos</span>
      </div>
    `;
    uiDropdown.appendChild(header);

    const list = document.createElement('div');
    list.className = 'uce-vd-list';
    list.id = 'uce-videos-list';
    uiDropdown.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'uce-vd-dropdown-footer';
    footer.innerHTML = `<div class="uce-vd-footer-desc">Compatible with MP4, WEBM, M3U8 formats.</div>`;
    uiDropdown.appendChild(footer);

    // Append to body to avoid overflow:hidden clipping from parent containers
    const mountTarget = document.fullscreenElement || document.body;
    mountTarget.appendChild(uiDropdown);

    // Position using fixed coordinates relative to button
    const btnRect = activeBtn.getBoundingClientRect();
    uiDropdown.style.position = 'fixed';
    uiDropdown.style.top  = `${btnRect.bottom + 8}px`;
    uiDropdown.style.left = `${Math.max(4, btnRect.right - 320)}px`;
    uiDropdown.style.right = 'auto';

    uiDropdown.addEventListener('click', e => e.stopPropagation());

    updateDropdownContent(video);

    // Dismiss on click outside or scroll
    const initialScroll = window.scrollY;
    const onScroll = () => {
      if (Math.abs(window.scrollY - initialScroll) > 10) removeDropdown();
    };
    setTimeout(() => {
      document.addEventListener('click', dismissDropdown);
      window.addEventListener('scroll', onScroll, { passive: true });
      uiDropdown._scrollHandler = onScroll;
    }, 10);
  }

  function dismissDropdown(e) {
    if (uiDropdown && !uiDropdown.contains(e.target) && !e.target.closest('.uce-vd-floating-btn')) {
      removeDropdown();
    }
  }

  function removeDropdown() {
    if (uiDropdown) {
      if (uiDropdown._scrollHandler) {
        window.removeEventListener('scroll', uiDropdown._scrollHandler);
      }
      uiDropdown.remove();
      uiDropdown = null;
      document.removeEventListener('click', dismissDropdown);
    }
  }

  // ─── Quality filter ─────────────────────────────────────────────────────────

  function filterHighestQuality(videos) {
    if (!videos?.length) return [];
    const combined = videos.filter(v => !v.audioOnly && !v.videoOnly);
    const pool = combined.length > 0 ? combined : videos;
    const score = (v) => {
      const q = v.quality || '';
      if (q.includes('2160') || q.includes('4K') || q.includes('4k')) return 2160;
      if (q.includes('1440') || q.includes('2K')) return 1440;
      if (q.includes('1080')) return 1080;
      if (q.includes('720'))  return 720;
      if (q.includes('480'))  return 480;
      if (q.includes('360'))  return 360;
      if (q.includes('240'))  return 240;
      if (q.includes('144'))  return 144;
      const m = q.match(/(\d+)/); if (m) return parseInt(m[1]);
      if (q.includes('HD') || q.includes('Direct')) return 720;
      if (q.includes('SD')) return 360;
      return 0;
    };
    pool.sort((a, b) => score(b) - score(a));
    return [pool[0]];
  }

  // ─── Dropdown content ────────────────────────────────────────────────────────

  function updateDropdownContent(video) {
    if (!uiDropdown) return;
    const listEl  = uiDropdown.querySelector('#uce-videos-list');
    const countEl = uiDropdown.querySelector('#uce-count-text');
    if (!listEl) return;

    listEl.innerHTML = '';

    const targetVideo = video || activeVideoElement;
    let currentSrc = '';
    let activeKey = '';
    if (targetVideo) {
      currentSrc = stripByteRangeParams(
        targetVideo.dataset.uceDirectUrl || targetVideo.currentSrc || targetVideo.src || ''
      );
      activeKey = getCleanVideoKey(currentSrc);
    }

    let videosToShow = (activeKey && detectedVideosMap[activeKey])
      ? [...detectedVideosMap[activeKey]] : [];

    // Fallback: use the current src directly if nothing matched in the map
    if (
      videosToShow.length === 0 && currentSrc &&
      !currentSrc.startsWith('blob:') && !currentSrc.startsWith('mediasource:') &&
      !currentSrc.startsWith('data:') && !isAudioUrl(currentSrc)
    ) {
      let fmt = 'MP4';
      if (currentSrc.includes('.m3u8')) fmt = 'M3U8';
      else if (currentSrc.includes('.mpd')) fmt = 'MPD';
      videosToShow.push({
        url: currentSrc, title: document.title,
        quality: 'Direct Stream', format: fmt, size: null,
        source: location.host.includes('instagram.com') ? 'Instagram' : 'Webpage',
        audioOnly: false, videoOnly: false
      });
    }

    videosToShow = filterHighestQuality(videosToShow);
    if (countEl) countEl.innerText = `${videosToShow.length} detected`;

    if (videosToShow.length === 0) {
      listEl.innerHTML = `
        <div class="uce-vd-empty-state">
          <div class="uce-vd-spinner"></div>
          <p>Analyzing video source…</p>
          <span>Play the video to trigger detector.</span>
        </div>
      `;
      if (window.__uce_analysis_timeout) clearTimeout(window.__uce_analysis_timeout);

      const isYT = location.host.includes('youtube.com');
      window.__uce_analysis_timeout = setTimeout(() => {
        if (uiDropdown && listEl.innerHTML.includes('Analyzing')) {
          if (isYT) {
            listEl.innerHTML = `
              <div class="uce-vd-empty-state">
                <p>YouTube stream not detected</p>
                <span>YouTube’s player API may use encrypted/signed URLs on this video. Try refreshing the page and clicking the button again.</span>
              </div>
            `;
          } else {
            listEl.innerHTML = `
              <div class="uce-vd-empty-state">
                <p>Source detection timed out</p>
                <span>Please ensure the video is playing and try again.</span>
              </div>
            `;
          }
          if (countEl) countEl.innerText = '0 detected';
        }
      }, 2500);
      return;
    }

    if (window.__uce_analysis_timeout) {
      clearTimeout(window.__uce_analysis_timeout);
      window.__uce_analysis_timeout = null;
    }

    // YouTube warning: streams may be IP-bound and fail to download
    const isYouTubeSource = videosToShow.some(v => v.source === 'YouTube');
    if (isYouTubeSource) {
      const warn = document.createElement('div');
      warn.style.cssText = 'padding:8px 16px;font-size:10px;color:#ffaa44;border-bottom:1px solid rgba(255,255,255,0.06);line-height:1.4;';
      warn.textContent = '⚠️ YouTube streams are session-locked. If download fails (31B file), use Copy Link and open in a new tab, or try yt-dlp.';
      listEl.appendChild(warn);
    }

    videosToShow.forEach((vid) => {
      const item = document.createElement('div');
      item.className = 'uce-vd-item';

      let badgeClass = 'uce-vd-badge-default';
      if (vid.audioOnly) badgeClass = 'uce-vd-badge-audio';
      else if (vid.videoOnly) badgeClass = 'uce-vd-badge-video-only';
      else if (vid.format === 'M3U8') badgeClass = 'uce-vd-badge-m3u8';
      else if (vid.quality.includes('1080') || vid.quality.includes('4K')) badgeClass = 'uce-vd-badge-hd';

      const displayTitle = (vid.title && vid.title !== 'Document') ? vid.title : 'Video';

      item.innerHTML = `
        <div class="uce-vd-item-info">
          <div class="uce-vd-item-title" title="${displayTitle}">${displayTitle}</div>
          <div class="uce-vd-meta-row">
            <span class="uce-vd-badge ${badgeClass}">${vid.format}</span>
            <span class="uce-vd-quality-text">${vid.quality}</span>
            ${vid.size ? `<span class="uce-vd-size">${vid.size}</span>` : ''}
          </div>
        </div>
        <div class="uce-vd-actions">
          <button class="uce-vd-btn-action uce-vd-btn-copy" title="Copy Stream Link">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </button>
          <button class="uce-vd-btn-action uce-vd-btn-dl" title="Download">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
          </button>
        </div>
      `;

      item.querySelector('.uce-vd-btn-copy').addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(vid.url).then(() => showNotification('Link copied!')).catch(() => {});
      });

      item.querySelector('.uce-vd-btn-dl').addEventListener('click', (e) => {
        e.stopPropagation();
        let ext = vid.format.toLowerCase();
        if (ext === 'audio') ext = 'mp3';
        else if (ext === 'video only') ext = 'mp4';
        else if (ext === 'hls stream' || ext === 'm3u8') ext = 'm3u8';
        else if (!['mp4','webm','mpd','ogg','mov'].includes(ext)) ext = 'mp4';

        const filename = `video.${ext}`;

        if (vid.source === 'YouTube') {
          downloadViaFetch(vid.url, filename);
        } else {
          safeSendMessage({
            action: 'download_video',
            url: vid.url,
            filename,
            source: vid.source
          }, (response) => {
            if (response?.success) {
              showNotification('Download started!');
            } else {
              const err = response?.error || 'Unknown error';
              console.error('UCE download error:', err);
              showNotification(`Failed: ${err}`);
            }
          });
        }
      });

      listEl.appendChild(item);
    });
  }

  // ─── YouTube-safe download ─────────────────────────────────────────────────
  // YouTube CDN URLs require cookies + specific headers that chrome.downloads
  // doesn't send. We route through background.js (which has full host_permissions
  // and can make authenticated fetch requests) to download the video data,
  // then we receive it as a blob URL to trigger Save As.

  function downloadViaFetch(url, filename) {
    showProgressNotification('Preparing download…', 0);

    // Ask background to fetch the video and return an ArrayBuffer
    safeSendMessage({
      action: 'fetch_and_download',
      url,
      filename
    }, (response) => {
      hideProgressNotification();

      if (response?.success && response.arrayBuffer) {
        try {
          const blob = new Blob([response.arrayBuffer], { type: 'video/mp4' });
          const blobUrl = URL.createObjectURL(blob);
          
          const downloadName = response.filename || filename;
          const a = document.createElement('a');
          a.href = blobUrl;
          a.download = downloadName;
          document.body.appendChild(a);
          a.click();
          a.remove();
          
          setTimeout(() => {
            URL.revokeObjectURL(blobUrl);
          }, 60000);

          showNotification('Download started!');
        } catch (err) {
          console.error('Failed to save fetched YouTube video:', err);
          showNotification('YouTube download failed');
        }
      } else {
        console.error('UCE YouTube download error:', response?.error);
        showNotification('YouTube download failed — use "Copy Link" instead');
      }
    });
  }

  // ─── Toast notification ──────────────────────────────────────────────────────

  let activeProgressToast = null;

  function showProgressNotification(text, percent) {
    if (!activeProgressToast) {
      activeProgressToast = document.createElement('div');
      activeProgressToast.className = 'uce-vd-toast';
      // Inline styles to convert generic toast to progress layout
      activeProgressToast.style.position = 'fixed';
      activeProgressToast.style.bottom = '32px';
      activeProgressToast.style.left = '50%';
      activeProgressToast.style.transform = 'translateX(-50%) translateY(20px)';
      activeProgressToast.style.display = 'flex';
      activeProgressToast.style.flexDirection = 'column';
      activeProgressToast.style.alignItems = 'center';
      activeProgressToast.style.gap = '6px';
      activeProgressToast.style.padding = '12px 20px';
      activeProgressToast.style.borderRadius = '16px';
      activeProgressToast.style.pointerEvents = 'none';
      activeProgressToast.style.whiteSpace = 'nowrap';
      activeProgressToast.style.transition = 'all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
      document.body.appendChild(activeProgressToast);
      setTimeout(() => {
        activeProgressToast.style.opacity = '1';
        activeProgressToast.style.transform = 'translateX(-50%) translateY(0)';
      }, 10);
    }

    activeProgressToast.innerHTML = `
      <div style="font-weight: 600; font-size: 13px; color: #fff;">${text}</div>
      <div style="width: 180px; height: 6px; background: rgba(255,255,255,0.2); border-radius: 3px; overflow: hidden; position: relative;">
        <div style="width: ${percent}%; height: 100%; background: linear-gradient(135deg, #FF3366 0%, #FF9933 100%); transition: width 0.1s ease; border-radius: 3px;"></div>
      </div>
      <div style="font-size: 11px; color: rgba(255,255,255,0.7); font-weight: 500;">${percent}%</div>
    `;
  }

  function hideProgressNotification() {
    if (activeProgressToast) {
      const toast = activeProgressToast;
      activeProgressToast = null;
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(-50%) translateY(20px)';
      setTimeout(() => toast.remove(), 300);
    }
  }

  function showNotification(text) {
    const toast = document.createElement('div');
    toast.className = 'uce-vd-toast';
    toast.innerText = text;
    // Use fixed positioning for toast too since button is now body-level
    toast.style.position = 'fixed';
    toast.style.bottom = '32px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(-50%) translateY(0)';
    }, 10);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }

  // Listen for progress updates from the background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'download_progress_update') {
      showProgressNotification(`Downloading YouTube Video…`, message.percent);
      sendResponse({ status: 'ok' });
    }
  });




  // ─── Remove floating UI ──────────────────────────────────────────────────────

  function removeFloatingUI() {
    // Remove all body-level UCE buttons (one per playing video)
    document.querySelectorAll('.uce-vd-floating-btn').forEach(b => b.remove());
    document.querySelectorAll('video').forEach(v => { v.__uceBtn = null; });
    uiButton = null;
    removeDropdown();
  }

  // ─── Fullscreen support ──────────────────────────────────────────────────────

  // Button is position:fixed on body — fullscreen just needs a reposition
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement && activeVideoElement) {
      setTimeout(() => positionFloatingButton(activeVideoElement), 100);
    }
  });

})();
