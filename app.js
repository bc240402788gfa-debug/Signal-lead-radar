(function(){
  "use strict";

  var map = null, centerMarker = null, leadMarkers = [];
  var currentController = null;
  var lastLeads = [];
  var lastMeta = null;

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, function(s){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s];
    });
  }

  function normalizeUrl(u){
    if(/^https?:\/\//i.test(u)) return u;
    return 'https://' + u;
  }

  function tierOf(score){ return score>=75?'hot': score>=50?'warm':'cool'; }
  function tierColorHex(score){ return score>=75?'#E8A33D': score>=50?'#B98431':'#5C6B78'; }

  function renderChips(){
    var row = document.getElementById('chipRow');
    row.innerHTML = '';
    SECTORS.forEach(function(s){
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip' + (s.defaultOn ? ' active' : '');
      btn.textContent = s.label;
      btn.dataset.sector = s.id;
      btn.setAttribute('aria-pressed', s.defaultOn ? 'true' : 'false');
      btn.addEventListener('click', function(){
        btn.classList.toggle('active');
        btn.setAttribute('aria-pressed', btn.classList.contains('active') ? 'true' : 'false');
      });
      row.appendChild(btn);
    });
  }

  function activeCategoryIds(){
    var ids = new Set();
    document.querySelectorAll('.chip.active').forEach(function(el){
      ids.add(el.dataset.sector);
    });
    return ids;
  }

  function buildOverpassQuery(lat, lon, radiusM, activeIds){
    var tagRows = TAGMAP.filter(function(t){ return activeIds.has(t[2]); });
    var clauses = tagRows.map(function(t){
      var brandFilter = t[3] ? '["brand"]' : '';
      return '  node["' + t[0] + '"="' + t[1] + '"]' + brandFilter + '(around:' + radiusM + ',' + lat + ',' + lon + ');\n' +
             '  way["' + t[0] + '"="' + t[1] + '"]' + brandFilter + '(around:' + radiusM + ',' + lat + ',' + lon + ');';
    }).join('\n');
    return '[out:json][timeout:40];\n(\n' + clauses + '\n);\nout center 900;';
  }

  async function geocode(query, signal){
    var url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query);
    var resp = await fetch(url, { signal: signal });
    if(!resp.ok) throw new Error('geocode-failed');
    var data = await resp.json();
    if(!data.length) return null;
    return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), label: data[0].display_name };
  }

  async function fetchOverpass(query, signal){
    var resp = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: signal
    });
    if(!resp.ok) throw new Error('overpass-status-' + resp.status);
    var data = await resp.json();
    if(data.remark){
      var remarkErr = new Error('overpass-remark');
      remarkErr.remark = data.remark;
      throw remarkErr;
    }
    return data.elements || [];
  }

  function processElements(elements){
    var map = new Map();
    for(var i=0;i<elements.length;i++){
      var el = elements[i];
      var tags = el.tags || {};
      var cat = null;
      for(var t=0;t<TAGMAP.length;t++){
        if(tags[TAGMAP[t][0]] === TAGMAP[t][1]){
          var sid = TAGMAP[t][2];
          for(var s=0;s<SECTORS.length;s++){ if(SECTORS[s].id === sid){ cat = SECTORS[s]; break; } }
          break;
        }
      }
      if(!cat) continue;
      var name = tags.name || tags['name:en'] || tags.brand;
      if(!name) continue;
      var keyId = el.type + '/' + el.id;
      if(map.has(keyId)) continue;
      var lat = el.type === 'node' ? el.lat : (el.center ? el.center.lat : null);
      var lon = el.type === 'node' ? el.lon : (el.center ? el.center.lon : null);
      if(lat == null || lon == null) continue;
      var website = tags.website || tags['contact:website'] || null;
      var phone = tags.phone || tags['contact:phone'] || null;
      var addrParts = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']].filter(Boolean);
      var address = addrParts.length ? addrParts.join(' ') : null;
      var score = cat.base;
      if(tags.brand) score += 8;
      if(website) score += 12;
      if(phone) score += 6;
      if(tags['addr:street']) score += 4;
      score = Math.max(0, Math.min(100, score));
      map.set(keyId, { id: keyId, name: name, category: cat.label, why: cat.why, lat: lat, lon: lon, website: website, phone: phone, address: address, score: score });
    }
    return Array.from(map.values()).sort(function(a,b){
      if(b.score !== a.score) return b.score - a.score;
      var aw = a.website ? 1 : 0, bw = b.website ? 1 : 0;
      if(bw !== aw) return bw - aw;
      return a.name.localeCompare(b.name);
    });
  }

  function ensureMap(lat, lon){
    if(typeof L === 'undefined') return;
    var el = document.getElementById('map');
    el.style.display = 'block';
    if(!map){
      map = L.map(el).setView([lat, lon], 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(map);
    } else {
      map.setView([lat, lon], 12);
      map.invalidateSize();
    }
    if(centerMarker) map.removeLayer(centerMarker);
    centerMarker = L.circleMarker([lat, lon], { radius: 8, color: '#E8EDF2', weight: 2, fillColor: '#0F1720', fillOpacity: 1 }).addTo(map);
  }

  function renderMarkers(leads){
    if(typeof L === 'undefined' || !map) return;
    leadMarkers.forEach(function(m){ map.removeLayer(m); });
    leadMarkers = leads.map(function(l){
      var color = tierColorHex(l.score);
      var marker = L.circleMarker([l.lat, l.lon], { radius: 6, color: color, weight: 1, fillColor: color, fillOpacity: 0.85 }).addTo(map);
      marker.bindPopup('<strong>' + escapeHtml(l.name) + '</strong><br>' + escapeHtml(l.category) + ' · score ' + l.score);
      return marker;
    });
  }

  function renderResults(leads, meta){
    var list = document.getElementById('results');
    list.innerHTML = '';
    if(!leads.length){
      list.innerHTML = '<div class="empty-state">NO SIGNAL — 0 matches within ' + meta.radiusKm + 'km of ' + escapeHtml(meta.label) + '. Try a larger radius or more categories.</div>';
      return;
    }
    var top = leads.slice(0, 60);
    top.forEach(function(l, i){
      var bars = Math.max(1, Math.min(5, Math.ceil(l.score / 20)));
      var tier = tierOf(l.score);
      var row = document.createElement('div');
      row.className = 'lead-row';
      var barsHtml = [1,2,3,4,5].map(function(n){ return '<i class="' + (n<=bars?'on':'') + '"></i>'; }).join('');
      var phoneHtml = l.phone ? '<a href="tel:' + escapeHtml(l.phone.replace(/[^\d+]/g,'')) + '">' + escapeHtml(l.phone) + '</a>' : '';
      var siteHtml = l.website ? '<a href="' + escapeHtml(normalizeUrl(l.website)) + '" target="_blank" rel="noopener">Website</a>' : '';
      var addrHtml = l.address ? '<div class="lead-addr">' + escapeHtml(l.address) + '</div>' : '';
      row.innerHTML =
        '<div class="lead-rank">' +
          '<span class="rank-num">' + (i+1) + '</span>' +
          '<span class="signal-bars tier-' + tier + '">' + barsHtml + '</span>' +
        '</div>' +
        '<div class="lead-main">' +
          '<div class="lead-name">' + escapeHtml(l.name) + '<span class="lead-cat">' + escapeHtml(l.category) + '</span></div>' +
          addrHtml +
          '<div class="lead-why">' + escapeHtml(l.why) + '</div>' +
        '</div>' +
        '<div class="lead-contact">' +
          '<span class="lead-score tier-' + tier + '">' + l.score + '</span>' +
          phoneHtml + siteHtml +
        '</div>';
      list.appendChild(row);
    });
  }

  function csvEscape(v){
    var s = String(v == null ? '' : v);
    if(/[",\r\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
    return s;
  }

  function slug(s){
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'').slice(0,40) || 'export';
  }

  function exportCsv(leads, meta){
    var header = ['Rank','Name','Category','Score','Address','Phone','Website','Why'];
    var rows = leads.map(function(l, i){ return [i+1, l.name, l.category, l.score, l.address || '', l.phone || '', l.website || '', l.why]; });
    var csv = [header].concat(rows).map(function(r){ return r.map(csvEscape).join(','); }).join('\r\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'leads-' + slug(meta.label) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function setLoading(isLoading){
    var btn = document.getElementById('scanBtn');
    btn.disabled = isLoading;
    btn.textContent = isLoading ? 'Scanning…' : 'Scan';
    document.getElementById('locationInput').disabled = isLoading;
  }

  function showStatus(msg, kind){
    document.getElementById('statusText').textContent = msg;
    document.getElementById('statusLine').classList.toggle('error', kind === 'error');
  }

  async function runScan(){
    var locInput = document.getElementById('locationInput').value.trim();
    if(!locInput){ showStatus('Enter a location first.', 'error'); return; }
    var activeIds = activeCategoryIds();
    if(activeIds.size === 0){ showStatus('Select at least one category.', 'error'); return; }

    if(currentController) currentController.abort();
    var controller = new AbortController();
    currentController = controller;
    var timedOut = false;
    var timeoutId = setTimeout(function(){ timedOut = true; controller.abort(); }, 55000);

    setLoading(true);
    showStatus('Scanning ' + locInput + '…', 'ok');

    try {
      var geo = await geocode(locInput, controller.signal);
      if(!geo){
        showStatus('LOCATION NOT FOUND — try a nearby city or add a country name.', 'error');
        return;
      }
      var radiusKm = parseInt(document.getElementById('radiusSelect').value, 10);
      var query = buildOverpassQuery(geo.lat, geo.lon, radiusKm * 1000, activeIds);
      var elements = await fetchOverpass(query, controller.signal);
      var leads = processElements(elements);
      lastLeads = leads;
      lastMeta = { label: geo.label, radiusKm: radiusKm };
      ensureMap(geo.lat, geo.lon);
      renderMarkers(leads.slice(0, 60));
      renderResults(leads, lastMeta);
      showStatus(leads.length + ' match' + (leads.length === 1 ? '' : 'es') + ' · within ' + radiusKm + 'km of ' + geo.label, leads.length ? 'ok' : 'error');
      document.getElementById('exportBtn').disabled = leads.length === 0;
    } catch(err){
      if(err && err.name === 'AbortError'){
        if(timedOut) showStatus('TIMED OUT — try a smaller radius or fewer categories.', 'error');
        return;
      }
      if(err && err.message === 'overpass-remark'){
        console.error('Overpass remark:', err.remark);
        showStatus('QUERY TOO LARGE — Overpass could not finish that search. Try a smaller radius or fewer categories.', 'error');
        return;
      }
      showStatus('CONNECTION FAILED — could not reach OpenStreetMap services. Check your connection, or open the downloaded file directly in a browser if this preview blocks outside requests.', 'error');
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  }

  renderChips();
  document.getElementById('scanBtn').addEventListener('click', runScan);
  document.getElementById('locationInput').addEventListener('keydown', function(e){
    if(e.key === 'Enter'){ e.preventDefault(); runScan(); }
  });
  document.getElementById('exportBtn').addEventListener('click', function(){
    if(lastLeads.length) exportCsv(lastLeads, lastMeta);
  });
})();