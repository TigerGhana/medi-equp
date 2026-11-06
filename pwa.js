// pwa.js -- makes the platform an installable app and keeps it fresh on phones.
// Loaded by one <script src="pwa.js"></script> line in index.html. All of this is optional polish:
// each step checks the browser supports it, and nothing here can stop the platform itself running.
(function(){
  'use strict';

  function whenReady(fn){
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  // 1. Service worker: what makes the app installable and quick to start.
  if('serviceWorker' in navigator){
    window.addEventListener('load', function(){
      navigator.serviceWorker.register('sw.js').catch(function(err){ console.warn('Service worker not registered:', err); });
    });
  }

  // 2. "Install app" button in the sidebar (Android, and Chrome/Edge on a computer).
  //    iPhones have no install prompt: people use Share > Add to Home Screen (see the Help Guide).
  var deferredPrompt = null, installBtn = null;
  function showInstallButton(){
    var anchor = document.getElementById('btnSignOut');
    if(!anchor || !anchor.parentNode) return;
    if(!installBtn){
      installBtn = document.createElement('button');
      installBtn.type = 'button';
      installBtn.id = 'btnInstallApp';
      installBtn.className = 'btn-signout';
      installBtn.style.marginBottom = '8px';
      installBtn.innerHTML = '<i class="fa-solid fa-download"></i>&nbsp; Install app';
      installBtn.addEventListener('click', function(){
        if(!deferredPrompt) return;
        var p = deferredPrompt; deferredPrompt = null;
        installBtn.style.display = 'none';
        p.prompt();
      });
      anchor.parentNode.insertBefore(installBtn, anchor);
    }
    installBtn.style.display = 'block';
  }
  window.addEventListener('beforeinstallprompt', function(e){
    e.preventDefault();
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
