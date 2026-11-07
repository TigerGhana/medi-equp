// pwa.js -- makes the platform an installable app and keeps it fresh on phones.
// Loaded by one <script src="pwa.js"></script> line in index.html. All of this is optional polish:
// each step checks the browser supports it, and nothing here can stop the platform itself running.
(function(){
  'use strict';

  var ua = navigator.userAgent || '';
  var isSamsungBrowser = /SamsungBrowser/i.test(ua);
  var isStandalone = !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone);

  function whenReady(fn){
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  // Adds a button to the sidebar, just above "Sign out". Returns it, or null if the sidebar is missing.
  function addSidebarButton(id, html, onClick){
    var anchor = document.getElementById('btnSignOut');
    if(!anchor || !anchor.parentNode) return null;
    var b = document.createElement('button');
    b.type = 'button';
    b.id = id;
    b.className = 'btn-signout';
    b.style.marginBottom = '8px';
    b.innerHTML = html;
    b.addEventListener('click', onClick);
    anchor.parentNode.insertBefore(b, anchor);
    return b;
  }

  // 1. Service worker: what makes the app installable and quick to start.
  if('serviceWorker' in navigator){
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('sw.js').catch(function(err){ console.warn('Service worker not registered:', err); });
    });
  }

  // 2a. Samsung Internet builds its own installable wrapper using an outdated Android setting, which
  //     Google Play Protect blocks ("Unsafe app blocked"). Nothing in the manifest can change that, so
  //     Samsung Internet users get a button that reopens this page in Chrome, where installing works.
  if(isSamsungBrowser && !isStandalone){
    whenReady(function(){
      addSidebarButton('btnInstallChrome', '<i class="fa-brands fa-chrome"></i>&nbsp; Install: open in Chrome', function(){
        var loc = window.location;
        loc.href = 'intent://' + loc.host + loc.pathname + loc.search +
          '#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=' +
          encodeURIComponent(loc.href.split('#')[0]) + ';end';
      });
    });
  }

  // 2b. "Install app" button (Chrome on Android, and Chrome/Edge on a computer).
  //     iPhones have no install prompt: people use Share > Add to Home Screen (see the Help Guide).
  var deferredPrompt = null, installBtn = null;
  function showInstallButton(){
    if(!installBtn){
      installBtn = addSidebarButton('btnInstallApp', '<i class="fa-solid fa-download"></i>&nbsp; Install app', function(){
        if(!deferredPrompt) return;
        var p = deferredPrompt; deferredPrompt = null;
        installBtn.style.display = 'none';
        p.prompt();
      });
      if(!installBtn) return;
    }
    installBtn.style.display = 'block';
  }
  window.addEventListener('beforeinstallprompt', function(e){
    e.preventDefault();
    if(isSamsungBrowser) return; // see 2a: Samsung Internet's installer is the one that gets blocked
    deferredPrompt = e;
    whenReady(showInstallButton);
  });
  window.addEventListener('appinstalled', function(){
    deferredPrompt = null;
    if(installBtn) installBtn.style.display = 'none';
  });

  // 3. Phones suspend a backgrounded app, which can drop its live connection and miss updates.
  //    When the app comes back to the foreground after a minute or more, reload the data once.
  var hiddenAt = 0;
  document.addEventListener('visibilitychange', function(){
    if(document.visibilityState === 'hidden'){ hiddenAt = Date.now(); return; }
    var app = window.APP;
    if(!hiddenAt || Date.now() - hiddenAt < 60000) return;
    if(!app || !app.STATE || !app.STATE.loaded || typeof app.loadAllData !== 'function') return;
    hiddenAt = 0;
    var ready = (app.sb && app.sb.auth) ? app.sb.auth.getSession() : Promise.resolve(); // refreshes an expired sign-in first
    ready.then(function(){ return app.loadAllData(); })
         .then(function(){ if(typeof app.route === 'function') app.route(); })
         .catch(function(){ /* offline or still waking up: keep what is on screen */ });
  });
})();
