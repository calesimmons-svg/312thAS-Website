/* DPW Hero service worker: works offline, always tries the network first for the app itself */
var CACHE='dpw-cache-1';
var LIBS=['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js','https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js','https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js','https://davidmegginson.github.io/ourairports-data/runways.csv'];
function pageKey(u){ u=new URL(u); return u.origin+u.pathname.replace(/index\.html$/,''); }
self.addEventListener('install',function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){
    return Promise.all([c.add(new Request('./',{cache:'reload'})).catch(function(){})].concat(LIBS.map(function(u){ return fetch(u).then(function(r){ if(r.ok) return c.put(u,r); }).catch(function(){}); })));
  }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate',function(e){
  e.waitUntil(caches.keys().then(function(ks){ return Promise.all(ks.filter(function(k){ return k!==CACHE; }).map(function(k){ return caches.delete(k); })); }).then(function(){ return self.clients.claim(); }));
});
function timeout(ms){ return new Promise(function(_,rej){ setTimeout(function(){ rej(new Error('timeout')); },ms); }); }
self.addEventListener('fetch',function(e){
  var req=e.request; if(req.method!=='GET') return;
  var url=new URL(req.url);
  if(req.mode==='navigate'&&url.origin===self.location.origin){
    // the app itself: network first (so updates always arrive), cached copy when offline or slow
    e.respondWith((async function(){
      var c=await caches.open(CACHE), key=pageKey(req.url);
      try{
        var r=await Promise.race([fetch(req),timeout(6000)]);
        if(r&&r.ok){ c.put(key,r.clone()); return r; }
        var hit=await c.match(key); return hit||r;
      }catch(err){
        var hit2=await c.match(key); if(hit2) return hit2;
        var any=await c.match(new URL('./',self.location.href).href); if(any) return any;
        return new Response('<h1>Offline</h1><p>Open DPW Hero once with a connection so it can be saved for offline use.</p>',{status:503,headers:{'Content-Type':'text/html'}});
      }
    })());
    return;
  }
  if(LIBS.indexOf(req.url)>-1){
    // libraries and runway data: cached copy right away, refreshed in the background
    e.respondWith(caches.open(CACHE).then(function(c){
      return c.match(req.url).then(function(hit){
        var net=fetch(req.url).then(function(r){ if(r.ok) c.put(req.url,r.clone()); return r; }).catch(function(){ return hit; });
        return hit||net;
      });
    }));
  }
});
