/* Service worker for the Regional Medical Equipment Platform.
   Purpose: make the app installable, and let it start quickly (or at least open) with poor signal.
   Deliberate rules:
   - Only GET requests are ever touched.
   - Nothing from Supabase (data, sign-in, file storage, live updates) is ever cached or answered
     here. Those requests go straight to the network, so data is always live.
   - The app's own files are fetched from the network FIRST, so a new deployment reaches everyone
     the next time they open the app online. The saved copy is only a fallback (offline, or if the
     host is briefly failing).
   - Bump CACHE_VERSION if you ever change this file's strategy.
   Emergency removal: see DEPLOYMENT.md, section 12 ("Removing the service worker"). */
const CACHE_VERSION = 'v1';
const CACHE = 'ceu-shell-' + CACHE_VERSION;
const SHELL = ['./', 'index.html', 'core.js', 'views.js', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png'];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', function(event){
  event.waitUntil(
    caches.open(CACHE)
      // one missing file must never block the install
      .then(function(cache){ return Promise.all(SHELL.map(function(u){ return cache.add(u).catch(function(){ return null; }); })); })
      .then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event){
  event.waitUntil(
    caches.keys()
      .then(function(keys){ return Promise.all(keys.filter(function(k){ return k.indexOf('ceu-shell-') === 0 && k !== CACHE; }).map(function(k){ return caches.delete(k); })); })
      .then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event){
  var req = event.request;
  if(req.method !== 'GET') return;
  var url = new URL(req.url);
  if(url.origin === self.location.origin){
    event.respondWith(networkFirst(req));
  } else if(CDN_HOSTS.indexOf(url.hostname) !== -1){
    event.respondWith(staleWhileRevalidate(req));
  }
  // anything else (Supabase API, auth, storage, realtime) is left alone
});

function networkFirst(req){
  return caches.open(CACHE).then(function(cache){
    return fetch(req).then(function(res){
      if(res.ok){ cache.put(req, res.clone()); return res; }
      if(res.status >= 500){
        return cache.match(req).then(function(cached){ return cached || res; });
      }
      return res; // 4xx (e.g. a file that no longer exists) is passed through honestly
    }).catch(function(err){
      return cache.match(req, { ignoreSearch: true }).then(function(cached){
        if(cached) return cached;
        if(req.mode === 'navigate'){
          return cache.match('index.html').then(function(shell){ if(shell) return shell; throw err; });
        }
        throw err;
      });
    });
  });
}

function staleWhileRevalidate(req){
  return caches.open(CACHE).then(function(cache){
    return cache.match(req).then(function(cached){
      var network = fetch(req).then(function(res){
        if(res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(function(){ return null; });
      if(cached) return cached;
      return network.then(function(res){ return res || Response.error(); });
    });
  });
}
