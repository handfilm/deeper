/* ============================================================
   RAWX MOTION LAB — DESKTOP ENGINE
   Drive structure expected:
     ROOT FOLDER
       └─ Category folder      (becomes a top tab, e.g. "Signature")
            └─ Tag folder      (becomes a tag chip, e.g. "Back Studies")
                 └─ image/video files

   Everything is fetched lazily: categories at boot, tags when a
   category is opened, files (paginated) when a tag is opened.
   Nothing is ever fetched recursively up front — this is built to
   survive very large libraries (tens of thousands of files).
============================================================ */
(function () {
  'use strict';

  /* ---------------- Config ---------------- */
  // Point this at the ROOT folder that CONTAINS your category folders
  // (not a folder of files directly). Share it "Anyone with the link".
  var CONFIG = {
    driveRootFolderId: '1fqRMXH-KqfMUJ8s8W-3FLdRtvOd7YV5X',
    driveApiKey: 'AIzaSyCqU3qT5SaRYTZev6ZfChJvApRDGDzv88Y',
    pageSize: 60
  };

  var FOLDER_MIME = 'application/vnd.google-apps.folder';
  var DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

  /* ---------------- Small utils ---------------- */
  function titleFromName(name) {
    return name.replace(/\.[a-z0-9]+$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  function uid() { return 'w' + (++uid.n); }
  uid.n = 0;
  function qs(sel, root) { return (root || document).querySelector(sel); }
  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function formatDuration(sec) {
    sec = Math.round(sec);
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function setBootStatus(text) {
    var e = document.getElementById('boot-status');
    if (e) e.textContent = text;
  }
  function showToast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  /* ---------------- Drive fetch layer (lazy + cached) ---------------- */
  var Drive = {
    categories: null,          // [{id,name}] | null (not fetched yet)
    categoriesPromise: null,
    tags: {},                  // catId -> [{id,name}] | undefined
    tagsPromise: {},           // catId -> Promise
    filePages: {}              // tagId -> { items: [], nextPageToken, done, loading, error }
  };

  function driveList(parentId, foldersOnly, pageToken) {
    var mimeClause = foldersOnly
      ? " and mimeType='" + FOLDER_MIME + "'"
      : " and mimeType!='" + FOLDER_MIME + "'";
    var q = encodeURIComponent("'" + parentId + "' in parents and trashed=false" + mimeClause);
    var fields = foldersOnly
      ? 'nextPageToken,files(id,name)'
      : 'nextPageToken,files(id,name,mimeType,thumbnailLink)';
    var url = DRIVE_FILES_URL + '?q=' + q +
      '&key=' + CONFIG.driveApiKey +
      '&fields=' + encodeURIComponent(fields) +
      '&pageSize=' + (foldersOnly ? 1000 : CONFIG.pageSize) +
      (foldersOnly ? '&orderBy=name' : '&orderBy=name') +
      (pageToken ? '&pageToken=' + pageToken : '');
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('Drive API error ' + r.status);
      return r.json();
    });
  }

  function getCategories() {
    if (Drive.categories) return Promise.resolve(Drive.categories);
    if (Drive.categoriesPromise) return Drive.categoriesPromise;
    Drive.categoriesPromise = driveList(CONFIG.driveRootFolderId, true).then(function (data) {
      Drive.categories = (data.files || []).map(function (f) { return { id: f.id, name: f.name, title: titleFromName(f.name) }; });
      return Drive.categories;
    }).catch(function (err) {
      Drive.categories = [];
      throw err;
    });
    return Drive.categoriesPromise;
  }

  function getTags(catId) {
    if (Drive.tags[catId]) return Promise.resolve(Drive.tags[catId]);
    if (Drive.tagsPromise[catId]) return Drive.tagsPromise[catId];
    Drive.tagsPromise[catId] = driveList(catId, true).then(function (data) {
      var tags = (data.files || []).map(function (f) { return { id: f.id, name: f.name, title: titleFromName(f.name) }; });
      Drive.tags[catId] = tags;
      return tags;
    });
    return Drive.tagsPromise[catId];
  }

  function parseDriveFile(file) {
    var isVideo = !!(file.mimeType && file.mimeType.indexOf('video/') === 0);
    return {
      id: file.id,
      title: titleFromName(file.name),
      isVideo: isVideo,
      src: 'https://drive.google.com/thumbnail?id=' + file.id + '&sz=w800',
      poster: file.thumbnailLink ? file.thumbnailLink.replace(/=s\d+$/, '=s1200')
        : 'https://drive.google.com/thumbnail?id=' + file.id + '&sz=w1200',
      full: 'https://drive.google.com/thumbnail?id=' + file.id + '&sz=w2000',
      streamSrc: isVideo ? DRIVE_FILES_URL + '/' + file.id + '?alt=media&key=' + CONFIG.driveApiKey : null
    };
  }

  // Fetches the NEXT page for a tag folder, appends to cache, returns the page items.
  function fetchNextPage(tagId) {
    var cache = Drive.filePages[tagId];
    if (!cache) cache = Drive.filePages[tagId] = { items: [], nextPageToken: undefined, done: false, loading: false };
    if (cache.loading || cache.done) return Promise.resolve(cache);
    cache.loading = true;
    return driveList(tagId, false, cache.nextPageToken).then(function (data) {
      var items = (data.files || []).map(parseDriveFile);
      cache.items = cache.items.concat(items);
      cache.nextPageToken = data.nextPageToken || null;
      cache.done = !cache.nextPageToken;
      cache.loading = false;
      return cache;
    }).catch(function (err) {
      cache.loading = false;
      cache.error = err;
      throw err;
    });
  }

  /* ---------------- Pin persistence (global, shared across windows) ---------------- */
  var pinned = loadPinned();
  function loadPinned() {
    try { return JSON.parse(localStorage.getItem('rawx_pinned') || '[]'); } catch (e) { return []; }
  }
  function savePinned() {
    try { localStorage.setItem('rawx_pinned', JSON.stringify(pinned)); } catch (e) {}
  }
  function isPinned(item) { return pinned.some(function (p) { return p.id === item.id; }); }
  function togglePin(item, ctx) {
    var idx = pinned.findIndex(function (p) { return p.id === item.id; });
    if (idx === -1) pinned.push({ id: item.id, title: item.title, src: item.src, isVideo: item.isVideo, cat: ctx && ctx.catName, tag: ctx && ctx.tagName });
    else pinned.splice(idx, 1);
    savePinned();
    renderPinCounts();
  }
  function renderPinCounts() {
    var a = document.getElementById('stat-pinned'); if (a) a.textContent = pinned.length;
    var b = document.getElementById('taskbar-board-count'); if (b) b.textContent = pinned.length;
  }

  /* ================================================================
     WINDOW MANAGER
     Each window is a floating, draggable, resizable panel that shows
     either a tag-picker (category level) or an asset gallery (tag
     level). Multiple windows / multiple categories can be open at once.
  ================================================================ */
  var WM = {
    windows: {},      // id -> window state object
    zTop: 10,
    desktop: null
  };

  function spawnWindow(cat) {
    // Reuse an existing window for this category if one's already open.
    var existing = Object.keys(WM.windows).map(function (k) { return WM.windows[k]; })
      .find(function (w) { return w.catId === cat.id; });
    if (existing) { focusWindow(existing.id); restoreWindow(existing.id); return existing; }

    var id = uid();
    var count = Object.keys(WM.windows).length;
    var w = {
      id: id,
      catId: cat.id,
      catName: cat.title,
      tagId: null,
      tagName: null,
      x: 60 + (count % 6) * 34,
      y: 50 + (count % 6) * 28,
      width: 860,
      height: 560,
      minimized: false,
      maximized: false,
      search: '',
      sort: 'default',
      gridSize: loadGridSizePref(),
      showLabels: loadLabelsPref(),
      speed: loadSpeedPref(),
      visibleCount: 30,
      shuffleSeed: {}
    };
    WM.windows[id] = w;
    buildWindowDOM(w);
    focusWindow(id);
    renderWindowBody(w);
    renderTaskbar();
    return w;
  }

  function closeWindow(id) {
    var w = WM.windows[id];
    if (!w) return;
    if (w.observer) w.observer.disconnect();
    if (w.scrollObserver) w.scrollObserver.disconnect();
    if (w.revealObserver) w.revealObserver.disconnect();
    if (w.dom) w.dom.remove();
    delete WM.windows[id];
    renderTaskbar();
  }

  function focusWindow(id) {
    var w = WM.windows[id];
    if (!w) return;
    WM.zTop += 1;
    w.dom.style.zIndex = WM.zTop;
    qsa('.win').forEach(function (d) { d.classList.remove('win-focused'); });
    w.dom.classList.add('win-focused');
    WM.activeId = id;
    renderTaskbar();
  }

  function minimizeWindow(id) {
    var w = WM.windows[id];
    if (!w) return;
    w.minimized = true;
    w.dom.classList.add('win-minimized');
    renderTaskbar();
  }
  function restoreWindow(id) {
    var w = WM.windows[id];
    if (!w) return;
    w.minimized = false;
    w.dom.classList.remove('win-minimized');
    focusWindow(id);
  }
  function toggleMaximize(id) {
    var w = WM.windows[id];
    if (!w) return;
    w.maximized = !w.maximized;
    w.dom.classList.toggle('win-maximized', w.maximized);
    focusWindow(id);
  }

  /* ---------------- Window DOM shell ---------------- */
  function buildWindowDOM(w) {
    var d = el('div', 'win');
    d.style.left = w.x + 'px';
    d.style.top = w.y + 'px';
    d.style.width = w.width + 'px';
    d.style.height = w.height + 'px';
    d.dataset.id = w.id;

    d.innerHTML =
      '<div class="win-titlebar">' +
        '<span class="win-crumb"></span>' +
        '<div class="win-controls">' +
          '<button class="win-btn win-min" title="Minimize">\u2013</button>' +
          '<button class="win-btn win-max" title="Maximize">\u25a1</button>' +
          '<button class="win-btn win-close" title="Close">\u2715</button>' +
        '</div>' +
      '</div>' +
      '<div class="win-body"></div>' +
      '<div class="win-resize"></div>';

    WM.desktop.appendChild(d);
    w.dom = d;

    d.addEventListener('mousedown', function () { focusWindow(w.id); });
    qs('.win-close', d).addEventListener('click', function (e) { e.stopPropagation(); closeWindow(w.id); });
    qs('.win-min', d).addEventListener('click', function (e) { e.stopPropagation(); minimizeWindow(w.id); });
    qs('.win-max', d).addEventListener('click', function (e) { e.stopPropagation(); toggleMaximize(w.id); });

    makeDraggable(d, qs('.win-titlebar', d), w);
    makeResizable(d, qs('.win-resize', d), w);
  }

  function makeDraggable(d, handle, w) {
    var dragging = false, sx, sy, ox, oy;
    handle.addEventListener('mousedown', function (e) {
      if (w.maximized || e.target.closest('.win-controls')) return;
      dragging = true; sx = e.clientX; sy = e.clientY; ox = w.x; oy = w.y;
      focusWindow(w.id);
      e.preventDefault();
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      w.x = Math.max(0, ox + (e.clientX - sx));
      w.y = Math.max(0, oy + (e.clientY - sy));
      d.style.left = w.x + 'px';
      d.style.top = w.y + 'px';
    });
    window.addEventListener('mouseup', function () { dragging = false; });
    // touch
    handle.addEventListener('touchstart', function (e) {
      if (w.maximized) return;
      var t = e.touches[0];
      dragging = true; sx = t.clientX; sy = t.clientY; ox = w.x; oy = w.y;
      focusWindow(w.id);
    }, { passive: true });
    window.addEventListener('touchmove', function (e) {
      if (!dragging) return;
      var t = e.touches[0];
      w.x = Math.max(0, ox + (t.clientX - sx));
      w.y = Math.max(0, oy + (t.clientY - sy));
      d.style.left = w.x + 'px';
      d.style.top = w.y + 'px';
    }, { passive: true });
    window.addEventListener('touchend', function () { dragging = false; });
  }

  function makeResizable(d, handle, w) {
    var resizing = false, sx, sy, ow, oh;
    handle.addEventListener('mousedown', function (e) {
      if (w.maximized) return;
      resizing = true; sx = e.clientX; sy = e.clientY; ow = w.width; oh = w.height;
      focusWindow(w.id);
      e.preventDefault(); e.stopPropagation();
    });
    window.addEventListener('mousemove', function (e) {
      if (!resizing) return;
      w.width = Math.max(360, ow + (e.clientX - sx));
      w.height = Math.max(280, oh + (e.clientY - sy));
      d.style.width = w.width + 'px';
      d.style.height = w.height + 'px';
    });
    window.addEventListener('mouseup', function () { resizing = false; });
  }

  /* ---------------- Window content: crumb + body ---------------- */
  function updateCrumb(w) {
    var crumb = qs('.win-crumb', w.dom);
    var parts = ['<span class="crumb-cat">' + w.catName + '</span>'];
    if (w.tagName) parts.push('<span class="crumb-sep">/</span><span class="crumb-tag">' + w.tagName + '</span>');
    crumb.innerHTML = parts.join('');
  }

  function renderWindowBody(w) {
    updateCrumb(w);
    var body = qs('.win-body', w.dom);
    if (w.observer) { w.observer.disconnect(); w.observer = null; }
    if (w.scrollObserver) { w.scrollObserver.disconnect(); w.scrollObserver = null; }
    if (w.revealObserver) { w.revealObserver.disconnect(); w.revealObserver = null; }

    if (!w.tagId) {
      renderTagPicker(w, body);
    } else {
      renderGallery(w, body);
    }
  }

  function renderTagPicker(w, body) {
    body.innerHTML = '<div class="tagpicker-loading">READING TAGS\u2026</div>';
    getTags(w.catId).then(function (tags) {
      if (!WM.windows[w.id]) return; // window closed meanwhile
      if (!tags.length) {
        body.innerHTML = '<div class="tagpicker-empty">NO TAG SUBFOLDERS FOUND IN "' + w.catName.toUpperCase() + '"</div>';
        return;
      }
      var wrap = el('div', 'tagpicker');
      wrap.innerHTML = '<div class="tagpicker-hint">SELECT A TAG TO OPEN ITS GALLERY</div>';
      var grid = el('div', 'tagpicker-grid');
      tags.forEach(function (t) {
        var card = el('div', 'tag-card', '<span class="tag-card-name">' + t.title + '</span><span class="tag-card-go">\u2192</span>');
        card.addEventListener('click', function () {
          w.tagId = t.id;
          w.tagName = t.title;
          w.visibleCount = 30;
          renderWindowBody(w);
        });
        grid.appendChild(card);
      });
      wrap.appendChild(grid);
      body.innerHTML = '';
      body.appendChild(wrap);
    }).catch(function () {
      body.innerHTML = '<div class="tagpicker-empty">FAILED TO READ TAGS \u2014 CHECK FOLDER SHARING / API KEY</div>';
    });
  }

  function renderGallery(w, body) {
    body.innerHTML =
      '<div class="win-toolbar">' +
        '<button class="win-back" title="Back to tags">\u2190 TAGS</button>' +
        '<input type="search" class="win-search" placeholder="SEARCH" autocomplete="off" value="' + escapeAttr(w.search) + '">' +
        '<select class="win-sort">' +
          '<option value="default">SORT: DEFAULT</option>' +
          '<option value="az">SORT: A\u2013Z</option>' +
          '<option value="za">SORT: Z\u2013A</option>' +
          '<option value="shuffle">SORT: SHUFFLE</option>' +
        '</select>' +
        '<div class="win-size-toggle">' +
          '<button data-size="s">S</button><button data-size="m">M</button><button data-size="l">L</button>' +
        '</div>' +
        '<button class="win-chip-btn win-labels-btn' + (w.showLabels ? ' active' : '') + '" title="Show names on thumbnails">ⓘ INFO</button>' +
        '<button class="win-chip-btn win-speed-btn" title="Cycle preview playback speed">\u26a1 ' + w.speed + '\u00d7</button>' +
      '</div>' +
      '<div class="win-count">\u2014</div>' +
      '<div class="win-grid grid-size-' + w.gridSize + (w.showLabels ? ' labels-on' : '') + '"></div>' +
      '<div class="win-loadmore" hidden>LOAD MORE</div>' +
      '<div class="win-end" hidden>END OF GALLERY</div>';

    qs('.win-back', body).addEventListener('click', function () {
      w.tagId = null; w.tagName = null;
      renderWindowBody(w);
    });
    qs('.win-search', body).addEventListener('input', function (e) {
      w.search = e.target.value; w.visibleCount = 30; paintGrid(w);
    });
    qs('.win-sort', body).value = w.sort;
    qs('.win-sort', body).addEventListener('change', function (e) {
      w.sort = e.target.value;
      if (w.sort === 'shuffle') reshuffle(w);
      paintGrid(w);
    });
    qsa('.win-size-toggle button', body).forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.size === w.gridSize);
      btn.addEventListener('click', function () {
        w.gridSize = btn.dataset.size;
        saveGridSizePref(w.gridSize);
        qs('.win-grid', body).className = 'win-grid grid-size-' + w.gridSize;
        qsa('.win-size-toggle button', body).forEach(function (b) { b.classList.toggle('active', b === btn); });
      });
    });
    qs('.win-loadmore', body).addEventListener('click', function () {
      loadMoreForWindow(w);
    });

    qs('.win-labels-btn', body).addEventListener('click', function () {
      w.showLabels = !w.showLabels;
      saveLabelsPref(w.showLabels);
      this.classList.toggle('active', w.showLabels);
      qs('.win-grid', body).classList.toggle('labels-on', w.showLabels);
    });
    qs('.win-speed-btn', body).addEventListener('click', function () {
      w.speed = nextSpeed(w.speed);
      saveSpeedPref(w.speed);
      this.textContent = '\u26a1 ' + w.speed + '\u00d7';
      qsa('.win-grid video', body).forEach(function (v) { v.playbackRate = w.speed; });
    });

    ensurePageThenPaint(w);
  }

  function reshuffle(w) {
    var cache = Drive.filePages[w.tagId];
    if (!cache) return;
    w.shuffleSeed = {};
    cache.items.forEach(function (it) { w.shuffleSeed[it.id] = Math.random(); });
  }

  function ensurePageThenPaint(w) {
    var body = qs('.win-body', w.dom);
    var cache = Drive.filePages[w.tagId];
    if (!cache || (!cache.items.length && !cache.done)) {
      var countEl = qs('.win-count', body);
      if (countEl) countEl.textContent = 'READING FILES\u2026';
      fetchNextPage(w.tagId).then(function () { if (WM.windows[w.id]) paintGrid(w); })
        .catch(function () { if (countEl) countEl.textContent = 'FAILED TO LOAD FILES'; });
    } else {
      paintGrid(w);
    }
  }

  function computeFiltered(w) {
    var cache = Drive.filePages[w.tagId];
    var list = cache ? cache.items.slice() : [];
    var q = w.search.trim().toLowerCase();
    if (q) list = list.filter(function (p) { return p.title.toLowerCase().indexOf(q) !== -1; });
    if (w.sort === 'az') list.sort(function (a, b) { return a.title.localeCompare(b.title); });
    else if (w.sort === 'za') list.sort(function (a, b) { return b.title.localeCompare(a.title); });
    else if (w.sort === 'shuffle') list.sort(function (a, b) { return (w.shuffleSeed[a.id] || 0) - (w.shuffleSeed[b.id] || 0); });
    return list;
  }

  function paintGrid(w) {
    var body = qs('.win-body', w.dom);
    if (!body) return;
    var grid = qs('.win-grid', body);
    var countEl = qs('.win-count', body);
    var loadMoreBtn = qs('.win-loadmore', body);
    var endEl = qs('.win-end', body);
    var cache = Drive.filePages[w.tagId] || { items: [], done: false };

    w.filtered = computeFiltered(w);
    countEl.textContent = w.filtered.length + ' asset' + (w.filtered.length === 1 ? '' : 's') +
      (cache.done ? '' : ' (more loading as you scroll)');

    grid.innerHTML = '';
    if (!w.filtered.length) {
      grid.innerHTML = '<div class="win-empty">NO MATCHES' + (cache.done ? '' : ' YET \u2014 KEEP SCROLLING, MORE ARE LOADING') + '</div>';
      loadMoreBtn.hidden = true; endEl.hidden = true;
      return;
    }

    var visible = w.filtered.slice(0, w.visibleCount);
    var frag = document.createDocumentFragment();
    visible.forEach(function (p) { frag.appendChild(buildCard(p, w)); });
    grid.appendChild(frag);

    var canShowMoreLocally = w.visibleCount < w.filtered.length;
    var canFetchMoreRemote = !cache.done;
    loadMoreBtn.hidden = !(canShowMoreLocally || canFetchMoreRemote);
    endEl.hidden = !(cache.done && w.visibleCount >= w.filtered.length && w.filtered.length > 0);

    setupWindowScrollObservers(w);
  }

  function loadMoreForWindow(w) {
    var cache = Drive.filePages[w.tagId];
    if (w.visibleCount < w.filtered.length) {
      w.visibleCount += 30;
      paintGrid(w);
      return;
    }
    if (cache && !cache.done && !cache.loading) {
      fetchNextPage(w.tagId).then(function () {
        w.visibleCount += 30;
        if (WM.windows[w.id]) paintGrid(w);
      });
    }
  }

  function buildCard(p, w) {
    var card = el('div', 'asset-card');
    card.dataset.id = p.id;
    var media;
    if (p.isVideo) {
      media = '<video class="asset-card-video" src="' + p.streamSrc + '" poster="' + p.poster + '" muted loop playsinline preload="metadata" data-autoplay="1"></video>' +
        '<span class="asset-card-play">\u25b6</span>' +
        '<span class="asset-card-duration" hidden>0:00</span>' +
        '<div class="asset-card-progress"><span></span></div>';
    } else {
      media = '<img src="' + p.src + '" alt="' + escapeAttr(p.title) + '" loading="lazy">';
    }
    card.innerHTML = media +
      '<div class="asset-card-label"><span>' + escapeHtml(p.title) + '</span><span class="asset-card-kind">' + escapeHtml(w.tagName || '') + '</span></div>' +
      '<button class="asset-card-pin' + (isPinned(p) ? ' pinned' : '') + '" title="Pin">' + (isPinned(p) ? '\u2713' : '+') + '</button>';

    if (p.isVideo) {
      var v = qs('video', card);
      var durEl = qs('.asset-card-duration', card);
      var bar = qs('.asset-card-progress span', card);
      v.playbackRate = w.speed || 1;
      v.addEventListener('loadedmetadata', function () {
        if (isFinite(v.duration)) { durEl.hidden = false; durEl.textContent = formatDuration(v.duration); }
      });
      v.addEventListener('timeupdate', function () { if (v.duration) bar.style.width = (v.currentTime / v.duration * 100) + '%'; });
      card.addEventListener('mouseenter', function () { v.playbackRate = w.speed || 1; v.play().catch(function () {}); });
      card.addEventListener('mouseleave', function () { v.pause(); });
      card.addEventListener('mousemove', function (e) {
        if (!v.duration) return;
        var rect = card.getBoundingClientRect();
        var pct = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
        v.currentTime = pct * v.duration;
      });
    }

    // Touch: mouseenter/mousemove never fire on touch devices, so replicate
    // the hover-preview (scale + name reveal + scrub) with real touch events.
    var touchScrubbing = false;
    card.addEventListener('touchstart', function (e) {
      card.classList.add('card-active');
      if (p.isVideo) { var vid = qs('video', card); if (vid) { vid.playbackRate = w.speed || 1; vid.play().catch(function () {}); } }
      touchScrubbing = true;
    }, { passive: true });
    card.addEventListener('touchmove', function (e) {
      if (!touchScrubbing || !p.isVideo) return;
      var vid = qs('video', card);
      if (!vid || !vid.duration) return;
      var t = e.touches[0];
      var rect = card.getBoundingClientRect();
      var pct = Math.min(Math.max((t.clientX - rect.left) / rect.width, 0), 1);
      vid.currentTime = pct * vid.duration;
    }, { passive: true });
    card.addEventListener('touchend', function () {
      touchScrubbing = false;
      setTimeout(function () { card.classList.remove('card-active'); }, 900);
    });

    qs('.asset-card-pin', card).addEventListener('click', function (e) {
      e.stopPropagation();
      togglePin(p, w);
      this.classList.toggle('pinned');
      this.textContent = isPinned(p) ? '\u2713' : '+';
    });
    card.addEventListener('click', function () { openLightbox(w, p.id); });
    return card;
  }

  function setupWindowScrollObservers(w) {
    var body = qs('.win-body', w.dom);
    if (w.scrollObserver) { w.scrollObserver.disconnect(); w.scrollObserver = null; }
    var sentinel = qs('.win-loadmore', body);
    if (sentinel && !sentinel.hidden && typeof IntersectionObserver !== 'undefined') {
      w.scrollObserver = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) loadMoreForWindow(w);
      }, { root: body, rootMargin: '300px 0px' });
      w.scrollObserver.observe(sentinel);
    }

    if (w.observer) { w.observer.disconnect(); w.observer = null; }
    var videos = qsa('.win-grid video[data-autoplay="1"]', body);
    if (videos.length && typeof IntersectionObserver !== 'undefined') {
      w.observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) { entry.target.playbackRate = w.speed || 1; entry.target.play().catch(function () {}); }
          else entry.target.pause();
        });
      }, { root: body, rootMargin: '150px 0px', threshold: 0.15 });
      videos.forEach(function (v) { w.observer.observe(v); });
    }

    // Reveal-in animation for every card (image or video) as it scrolls
    // into view — the mobile substitute for a mouse-hover preview.
    if (w.revealObserver) { w.revealObserver.disconnect(); w.revealObserver = null; }
    var cards = qsa('.win-grid .asset-card', body);
    if (cards.length && typeof IntersectionObserver !== 'undefined') {
      w.revealObserver = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) { entry.target.classList.add('card-in-view'); w.revealObserver.unobserve(entry.target); }
        });
      }, { root: body, rootMargin: '80px 0px', threshold: 0.05 });
      cards.forEach(function (c) { w.revealObserver.observe(c); });
    } else {
      cards.forEach(function (c) { c.classList.add('card-in-view'); });
    }
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function escapeAttr(s) { return escapeHtml(s); }

  /* ---------------- Grid size / labels / speed preferences ---------------- */
  function loadGridSizePref() { try { return localStorage.getItem('rawx_grid_size') || 'm'; } catch (e) { return 'm'; } }
  function saveGridSizePref(size) { try { localStorage.setItem('rawx_grid_size', size); } catch (e) {} }

  // Names are OFF by default everywhere — nobody asked to see them.
  function loadLabelsPref() { try { return localStorage.getItem('rawx_labels_on') === '1'; } catch (e) { return false; } }
  function saveLabelsPref(on) { try { localStorage.setItem('rawx_labels_on', on ? '1' : '0'); } catch (e) {} }

  // Fast speed view — cycles hover/autoplay preview playback rate.
  var SPEED_STEPS = [1, 1.5, 2, 3];
  function loadSpeedPref() {
    try { var v = parseFloat(localStorage.getItem('rawx_speed')); return SPEED_STEPS.indexOf(v) !== -1 ? v : 1; }
    catch (e) { return 1; }
  }
  function saveSpeedPref(v) { try { localStorage.setItem('rawx_speed', String(v)); } catch (e) {} }
  function nextSpeed(v) { var i = SPEED_STEPS.indexOf(v); return SPEED_STEPS[(i + 1) % SPEED_STEPS.length]; }

  /* ---------------- Taskbar ---------------- */
  function renderTaskbar() {
    var bar = document.getElementById('taskbar-windows');
    bar.innerHTML = '';
    Object.keys(WM.windows).forEach(function (id) {
      var w = WM.windows[id];
      var btn = el('button', 'taskbar-win-btn' + (WM.activeId === id && !w.minimized ? ' active' : ''));
      btn.textContent = w.catName + (w.tagName ? ' / ' + w.tagName : '');
      btn.addEventListener('click', function () {
        if (w.minimized) restoreWindow(id); else if (WM.activeId === id) minimizeWindow(id); else focusWindow(id);
      });
      bar.appendChild(btn);
    });
  }

  function buildCategoryTabs(categories) {
    var wrap = document.getElementById('cat-tabs');
    wrap.innerHTML = '';
    categories.forEach(function (cat) {
      var btn = el('button', 'cat-tab', escapeHtml(cat.title));
      btn.addEventListener('click', function () { spawnWindow(cat); });
      wrap.appendChild(btn);
    });
  }

  function buildLauncherMenu(categories) {
    var menu = document.getElementById('launcher-menu');
    menu.innerHTML = '';
    categories.forEach(function (cat) {
      var item = el('button', 'launcher-item', escapeHtml(cat.title));
      item.addEventListener('click', function () {
        spawnWindow(cat);
        menu.classList.remove('open');
      });
      menu.appendChild(item);
    });
  }

  /* ---------------- Lightbox (global, shared) ---------------- */
  var ZOOM_MAX = 6, ZOOM_MIN = 1;
  var lb = { win: null, index: -1, zoom: 1, panX: 0, panY: 0, dragging: false, dragSX: 0, dragSY: 0, dragOX: 0, dragOY: 0, autoOn: false, autoTimer: null };

  function stopAuto() {
    lb.autoOn = false;
    if (lb.autoTimer) clearTimeout(lb.autoTimer);
    lb.autoTimer = null;
    var btn = document.getElementById('lb-auto-btn');
    if (btn) { btn.classList.remove('active'); btn.textContent = '\u25b6 AUTO'; }
  }
  function scheduleAuto() {
    if (!lb.autoOn) return;
    if (lb.autoTimer) clearTimeout(lb.autoTimer);
    lb.autoTimer = setTimeout(function () { lbStep(1); }, 4200);
  }
  function toggleAuto() {
    lb.autoOn = !lb.autoOn;
    var btn = document.getElementById('lb-auto-btn');
    if (btn) { btn.classList.toggle('active', lb.autoOn); btn.textContent = lb.autoOn ? '\u25a0 AUTO' : '\u25b6 AUTO'; }
    if (lb.autoOn) scheduleAuto(); else stopAuto();
  }

  function openLightbox(w, fileId) {
    lb.win = w;
    lb.index = w.filtered.findIndex(function (p) { return p.id === fileId; });
    if (lb.index === -1) return;
    renderLightbox();
    document.getElementById('lightbox').classList.add('open');
    document.getElementById('lightbox').setAttribute('aria-hidden', 'false');
  }

  function resetZoom() { lb.zoom = 1; lb.panX = 0; lb.panY = 0; applyZoomTransform(); }

  function applyZoomTransform() {
    var media = qs('#lb-media img, #lb-media video');
    if (!media) return;
    media.style.transform = 'translate(' + lb.panX + 'px,' + lb.panY + 'px) scale(' + lb.zoom + ')';
    media.classList.toggle('lb-zoomed', lb.zoom > 1);
    var hint = document.getElementById('lb-zoom-hint');
    if (hint) hint.textContent = lb.zoom > 1 ? Math.round(lb.zoom * 100) + '%' : '';
  }

  function setZoom(next) {
    next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    if (next === 1) { resetZoom(); return; }
    lb.zoom = next;
    var maxPan = 400 * (lb.zoom - 1);
    lb.panX = Math.max(-maxPan, Math.min(maxPan, lb.panX));
    lb.panY = Math.max(-maxPan, Math.min(maxPan, lb.panY));
    applyZoomTransform();
  }

  // Z key cycles: fit -> 2x -> 4x -> fit
  function toggleZoomKey() {
    if (lb.zoom < 1.9) setZoom(2);
    else if (lb.zoom < 3.9) setZoom(4);
    else resetZoom();
  }

  function renderLightbox() {
    var w = lb.win;
    var p = w.filtered[lb.index];
    if (!p) return;
    var stage = document.getElementById('lb-media');

    if (p.isVideo) {
      stage.innerHTML = '<video id="lb-video" src="' + p.streamSrc + '" poster="' + p.poster + '" controls autoplay loop playsinline></video>';
    } else {
      stage.innerHTML = '<img src="' + p.full + '" alt="' + escapeAttr(p.title) + '">';
    }
    resetZoom();

    document.getElementById('lb-title').textContent = p.title.toUpperCase() + ' \u2014 ' + (lb.index + 1) + ' / ' + w.filtered.length;
    document.getElementById('lb-character').textContent = p.title;
    document.getElementById('lb-pillar').textContent = w.catName + (w.tagName ? ' / ' + w.tagName : '');
    document.getElementById('lb-set-count').textContent = w.filtered.length + ' assets';
    var pinBtn = document.getElementById('lb-pin-btn');
    pinBtn.classList.toggle('pinned', isPinned(p));
    pinBtn.textContent = isPinned(p) ? 'PINNED' : 'PIN';
  }

  function closeLightbox() {
    stopAuto();
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
    document.getElementById('lightbox').classList.remove('open');
    document.getElementById('lightbox').setAttribute('aria-hidden', 'true');
    document.getElementById('lb-media').innerHTML = '';
    lb.win = null; lb.index = -1;
  }

  function lbStep(dir) {
    if (!lb.win || !lb.win.filtered.length) return;
    lb.index = (lb.index + dir + lb.win.filtered.length) % lb.win.filtered.length;
    renderLightbox();
    scheduleAuto();
  }

  function lbTogglePlay() {
    var v = document.getElementById('lb-video');
    if (!v) return;
    if (v.paused) v.play().catch(function () {}); else v.pause();
  }

  // F: force-fullscreen the whole lightbox frame (works for image or video
  // alike), and CSS strips chrome down to just media + prev/next while active.
  function toggleForceFullscreen() {
    var frame = document.getElementById('lb-frame');
    if (!document.fullscreenElement) {
      var req = frame.requestFullscreen || frame.webkitRequestFullscreen;
      if (req) req.call(frame).catch(function () {});
    } else {
      document.exitFullscreen().catch(function () {});
    }
  }

  ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (evt) {
    document.addEventListener(evt, function () {
      var isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      document.getElementById('lightbox').classList.toggle('lb-fullscreen-mode', isFs);
      var v = document.getElementById('lb-video');
      if (v) v.play().catch(function () {});
    });
  });

  /* ---------------- Board / Inquiry modal ---------------- */
  function renderBoard() {
    var thumbs = document.getElementById('board-thumbs');
    var emptyEl = document.getElementById('modal-body-empty');
    thumbs.innerHTML = '';
    emptyEl.hidden = pinned.length > 0;
    pinned.forEach(function (p) {
      var thumb = el('div', 'board-thumb');
      thumb.innerHTML = (p.isVideo ? '<img src="' + p.src + '" alt="' + escapeAttr(p.title) + '">' : '<img src="' + p.src + '" alt="' + escapeAttr(p.title) + '">') +
        '<button title="Remove">\u2715</button>';
      qs('button', thumb).addEventListener('click', function () {
        togglePin(p);
        renderBoard();
      });
      thumbs.appendChild(thumb);
    });
  }
  function openBoard() { renderBoard(); document.getElementById('board-modal-overlay').classList.add('open'); }
  function closeBoard() { document.getElementById('board-modal-overlay').classList.remove('open'); }

  /* ---------------- Global events ---------------- */
  function bindGlobalEvents() {
    document.getElementById('lb-close').addEventListener('click', closeLightbox);
    document.getElementById('lb-prev').addEventListener('click', function () { lbStep(-1); });
    document.getElementById('lb-next').addEventListener('click', function () { lbStep(1); });
    document.getElementById('lb-pin-btn').addEventListener('click', function () {
      if (!lb.win) return;
      togglePin(lb.win.filtered[lb.index], lb.win);
      renderLightbox();
    });
    document.getElementById('lightbox').addEventListener('click', function (e) { if (e.target.id === 'lightbox') closeLightbox(); });
    document.getElementById('lb-fullscreen-btn').addEventListener('click', toggleForceFullscreen);
    document.getElementById('lb-auto-btn').addEventListener('click', toggleAuto);

    // ---- Mobile tap dock: every command gets a real button, no keyboard needed ----
    document.getElementById('lb-dock-prev').addEventListener('click', function () { lbStep(-1); });
    document.getElementById('lb-dock-next').addEventListener('click', function () { lbStep(1); });
    document.getElementById('lb-dock-zoomin').addEventListener('click', function () { setZoom(lb.zoom + 1); });
    document.getElementById('lb-dock-zoomout').addEventListener('click', function () { lb.zoom - 1 <= 1 ? resetZoom() : setZoom(lb.zoom - 1); });
    document.getElementById('lb-dock-fullscreen').addEventListener('click', toggleForceFullscreen);

    // ---- Zoom: wheel to zoom in/out around the cursor, drag to pan while zoomed ----
    var stage = document.getElementById('lb-media');
    stage.addEventListener('wheel', function (e) {
      var media = qs('#lb-media img, #lb-media video');
      if (!media) return;
      e.preventDefault();
      var delta = e.deltaY < 0 ? 0.5 : -0.5;
      setZoom(lb.zoom + delta);
    }, { passive: false });

    stage.addEventListener('mousedown', function (e) {
      if (lb.zoom <= 1 || e.target.tagName === 'BUTTON') return;
      lb.dragging = true;
      lb.dragSX = e.clientX; lb.dragSY = e.clientY;
      lb.dragOX = lb.panX; lb.dragOY = lb.panY;
      stage.classList.add('lb-panning');
    });
    window.addEventListener('mousemove', function (e) {
      if (!lb.dragging) return;
      lb.panX = lb.dragOX + (e.clientX - lb.dragSX);
      lb.panY = lb.dragOY + (e.clientY - lb.dragSY);
      applyZoomTransform();
    });
    window.addEventListener('mouseup', function () { lb.dragging = false; stage.classList.remove('lb-panning'); });
    stage.addEventListener('dblclick', function () { toggleZoomKey(); });

    // ---- Touch: pinch-to-zoom, single-finger swipe nav / swipe-down-to-close, double-tap zoom ----
    var touch = { mode: null, startDist: 0, startZoom: 1, sx: 0, sy: 0, panOX: 0, panOY: 0, lastTap: 0 };
    function touchDist(t0, t1) { return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY); }

    stage.addEventListener('touchstart', function (e) {
      if (e.touches.length === 2) {
        touch.mode = 'pinch';
        touch.startDist = touchDist(e.touches[0], e.touches[1]);
        touch.startZoom = lb.zoom;
      } else if (e.touches.length === 1) {
        var now = Date.now();
        if (now - touch.lastTap < 300) { toggleZoomKey(); touch.mode = null; touch.lastTap = 0; return; }
        touch.lastTap = now;
        touch.mode = lb.zoom > 1 ? 'pan' : 'swipe';
        touch.sx = e.touches[0].clientX; touch.sy = e.touches[0].clientY;
        touch.panOX = lb.panX; touch.panOY = lb.panY;
      }
    }, { passive: true });

    stage.addEventListener('touchmove', function (e) {
      if (touch.mode === 'pinch' && e.touches.length === 2) {
        e.preventDefault();
        var dist = touchDist(e.touches[0], e.touches[1]);
        setZoom(touch.startZoom * (dist / touch.startDist));
      } else if (touch.mode === 'pan' && e.touches.length === 1) {
        e.preventDefault();
        lb.panX = touch.panOX + (e.touches[0].clientX - touch.sx);
        lb.panY = touch.panOY + (e.touches[0].clientY - touch.sy);
        applyZoomTransform();
      }
      // 'swipe' mode: let the finger move freely, decide the gesture on touchend
    }, { passive: false });

    stage.addEventListener('touchend', function (e) {
      if (touch.mode === 'swipe' && e.changedTouches.length === 1) {
        var dx = e.changedTouches[0].clientX - touch.sx;
        var dy = e.changedTouches[0].clientY - touch.sy;
        if (Math.abs(dy) > 80 && Math.abs(dy) > Math.abs(dx)) { closeLightbox(); }
        else if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) { lbStep(dx < 0 ? 1 : -1); }
      }
      touch.mode = null;
    });

    document.getElementById('taskbar-board-btn').addEventListener('click', openBoard);
    document.getElementById('board-modal-close').addEventListener('click', closeBoard);
    document.getElementById('board-modal-overlay').addEventListener('click', function (e) { if (e.target.id === 'board-modal-overlay') closeBoard(); });

    document.getElementById('inquiry-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var company = document.getElementById('inq-company').value;
      var email = document.getElementById('inq-email').value;
      var notes = document.getElementById('inq-notes').value;
      var refList = pinned.map(function (p) { return p.title + ' (' + (p.cat || '') + (p.tag ? '/' + p.tag : '') + ')'; }).join(', ') || 'None pinned';
      var subject = encodeURIComponent('B2B Inquiry \u2014 ' + company);
      var body = encodeURIComponent('Company: ' + company + '\nEmail: ' + email + '\nNotes: ' + notes + '\nReferenced assets: ' + refList);
      window.location.href = 'mailto:hello@handfilm.com?subject=' + subject + '&body=' + body;
      showToast('INQUIRY DRAFTED \u2014 CHECK YOUR MAIL CLIENT');
      closeBoard();
      e.target.reset();
    });

    document.getElementById('launcher-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      document.getElementById('launcher-menu').classList.toggle('open');
    });
    document.addEventListener('click', function () { document.getElementById('launcher-menu').classList.remove('open'); });

    document.addEventListener('keydown', function (e) {
      var typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
      if (document.getElementById('lightbox').classList.contains('open')) {
        // Escape always closes (and drops fullscreen with it, see closeLightbox)
        if (e.key === 'Escape') { closeLightbox(); return; }
        // N / P / arrows — navigate
        if (e.key === 'n' || e.key === 'N' || e.key === 'ArrowRight') { lbStep(1); return; }
        if (e.key === 'p' || e.key === 'P' || e.key === 'ArrowLeft') { lbStep(-1); return; }
        // Z — cycle zoom (fit -> 2x -> 4x -> fit)
        if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); toggleZoomKey(); return; }
        // F — force fullscreen in/out (image or video, minimal-chrome mode)
        if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleForceFullscreen(); return; }
        // Tab — pause/resume the current video, without shifting page focus
        if (e.key === 'Tab') { e.preventDefault(); lbTogglePlay(); return; }
        return;
      }
      if (typing) return;
      if (e.key === 'Escape' && WM.activeId) minimizeWindow(WM.activeId);
    });
  }

  /* ---------------- Boot ---------------- */
  document.addEventListener('DOMContentLoaded', function () {
    WM.desktop = document.getElementById('desktop');
    var bar = document.getElementById('boot-bar-fill');
    bar.style.width = '30%';
    bindGlobalEvents();
    renderPinCounts();

    setBootStatus('READING CATEGORY FOLDERS\u2026');
    getCategories().then(function (categories) {
      bar.style.width = '100%';
      document.getElementById('status-text').textContent = 'LIVE';
      document.getElementById('stat-total').textContent = categories.length + ' CATEGORIES';

      if (!categories.length) {
        setBootStatus('NO CATEGORY FOLDERS FOUND \u2014 CHECK driveRootFolderId');
      } else {
        buildCategoryTabs(categories);
        buildLauncherMenu(categories);
        spawnWindow(categories[0]);
      }

      setTimeout(function () { document.getElementById('boot').classList.add('hidden'); }, 350);
    }).catch(function (err) {
      console.error(err);
      setBootStatus('DRIVE FETCH FAILED \u2014 CHECK API KEY / FOLDER SHARING');
      bar.style.width = '100%';
      setTimeout(function () { document.getElementById('boot').classList.add('hidden'); }, 800);
    });
  });
})();
