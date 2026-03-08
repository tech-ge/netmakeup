/* ============================================================
   TechGeo Network — Offline Helper
   Include this on every page AFTER your page scripts.
   Registers the service worker, shows/hides the offline
   banner, and patches fetch() to queue POST requests
   when offline via Background Sync.
   ============================================================ */

(function() {
  'use strict';

  /* ── 1. Register Service Worker ── */
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
      navigator.serviceWorker.register('/sw.js', { scope: '/' })
        .then(function(reg) {
          console.log('[TechGeo] Service Worker registered. Scope:', reg.scope);
        })
        .catch(function(err) {
          console.warn('[TechGeo] Service Worker registration failed:', err);
        });
    });

    /* Listen for messages from SW (e.g. sync success) */
    navigator.serviceWorker.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'SYNC_SUCCESS') {
        showToast('Your offline action has been synced.', 'success');
        /* Reload data if we're on dashboard */
        if (typeof loadDashboard === 'function') loadDashboard();
      }
    });
  }

  /* ── 2. Offline / Online Banner ── */
  var banner = null;

  function createBanner() {
    if (banner) return;
    banner = document.createElement('div');
    banner.id = 'offlineBanner';
    banner.style.cssText = [
      'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
      'background:#b45309', 'color:#fff',
      'text-align:center', 'font-size:.85rem', 'font-weight:600',
      'padding:.55rem 1rem', 'transition:transform .3s ease',
      'transform:translateY(-100%)',
      "font-family:'DM Sans',sans-serif",
      'display:flex', 'align-items:center', 'justify-content:center', 'gap:.5rem'
    ].join(';');
    document.body.insertBefore(banner, document.body.firstChild);
  }

  function showOffline() {
    createBanner();
    banner.innerHTML = '&#9888;&#65039; You are offline — cached data is shown. Changes will sync when reconnected.';
    banner.style.background = '#b45309';
    /* nudge sticky header down */
    var header = document.querySelector('.topbar, .dash-header, header');
    if (header) header.style.top = banner.offsetHeight + 'px';
    requestAnimationFrame(function() { banner.style.transform = 'translateY(0)'; });
  }

  function showOnline() {
    if (!banner) return;
    banner.innerHTML = '&#9989; Back online!';
    banner.style.background = '#16a34a';
    setTimeout(function() {
      banner.style.transform = 'translateY(-100%)';
      var header = document.querySelector('.topbar, .dash-header, header');
      if (header) header.style.top = '';
    }, 2500);
  }

  function updateOnlineStatus() {
    if (!navigator.onLine) { showOffline(); }
    else { showOnline(); }
  }

  window.addEventListener('online',  updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);

  /* Check immediately on page load */
  document.addEventListener('DOMContentLoaded', function() {
    if (!navigator.onLine) showOffline();
  });

  /* ── 3. Queue POST/PUT requests when offline ── */
  /* Patch apiFetch if it exists on the page, or set up global queue */
  window._techgeoOfflineQueue = window._techgeoOfflineQueue || [];

  window.queueOfflineRequest = async function(url, options) {
    try {
      var db  = await openQueueDB();
      var tx  = db.transaction('requests', 'readwrite');
      var req = {
        url:     url,
        method:  options.method || 'POST',
        headers: options.headers || {},
        body:    options.body   || null,
        ts:      Date.now()
      };
      tx.objectStore('requests').add(req);
      showToast('No connection — your action has been saved and will sync automatically.', 'warn');

      /* Register background sync if supported */
      if ('serviceWorker' in navigator && 'SyncManager' in window) {
        var reg = await navigator.serviceWorker.ready;
        await reg.sync.register('techgeo-sync-queue');
      }
    } catch(e) {
      console.warn('[TechGeo] Could not queue offline request:', e);
    }
  };

  function openQueueDB() {
    return new Promise(function(resolve, reject) {
      var req = indexedDB.open('techgeo-queue', 1);
      req.onupgradeneeded = function(e) {
        e.target.result.createObjectStore('requests', { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = function(e) { resolve(e.target.result); };
      req.onerror   = function(e) { reject(e.target.error); };
    });
  }

  /* ── 4. Toast helper (safe — won't crash if page has its own) ── */
  function showToast(msg, type) {
    /* Use the page's own toast if available */
    if (typeof toast === 'function') { toast(msg, type !== 'warn' && type !== 'error'); return; }
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = [
      'position:fixed', 'bottom:1.25rem', 'left:50%',
      'transform:translateX(-50%)', 'z-index:9998',
      'background:' + (type === 'success' ? '#16a34a' : type === 'warn' ? '#b45309' : '#1d4ed8'),
      'color:#fff', 'border-radius:.5rem', 'padding:.6rem 1.25rem',
      'font-size:.83rem', 'font-weight:600', 'box-shadow:0 4px 16px rgba(0,0,0,.2)',
      "font-family:'DM Sans',sans-serif", 'max-width:90vw', 'text-align:center'
    ].join(';');
    document.body.appendChild(el);
    setTimeout(function() { el.remove(); }, 3500);
  }

  /* Expose for use in page scripts */
  window._tgShowToast = showToast;

})();
