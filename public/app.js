// --- Simple API wrapper (goes through our Express proxy to avoid CORS) ---
async function robustJsonFetch(url) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return text; }   // handle JSON sent as text
}

const API = {
  stations: () => robustJsonFetch('/api/stations'),
  history: (id) => robustJsonFetch(`/api/historical_weather?station=${encodeURIComponent(id)}`),
};


// --- 20/min token bucket so we never exceed the documented API limit ---
const Rate = (() => {
  let tokens = 20;
  let last = Date.now();
  const queue = [];

  function tick() {
    const now = Date.now();
    if (now - last >= 60000) {
      tokens = 20;
      last = now;
    }
    while (tokens > 0 && queue.length) {
      tokens--;
      queue.shift()();
    }
  }
  setInterval(tick, 200);

  const wrap = (fn) => (...args) =>
    new Promise((resolve, reject) => {
      queue.push(async () => {
        try { resolve(await fn(...args)); } catch (e) { reject(e); }
      });
    });

  return { stations: wrap(API.stations), history: wrap(API.history) };
})();

// --- Utilities ---
const q = (s) => document.querySelector(s);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const toISO = (t) => new Date(t - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const fmt = (x) => (isNum(x) ? x : '—');

// Accept many response shapes; YOUR API returns { points: [...] }
function extractRows(resp) {
  if (Array.isArray(resp)) return resp;
  if (!resp || typeof resp !== 'object') return [];
  // include 'points' (your sample had this)
  const keys = ['points', 'observations', 'history', 'data', 'results', 'records', 'items'];
  for (const k of keys) {
    if (Array.isArray(resp[k])) return resp[k];
  }
  const firstArr = Object.values(resp).find((v) => Array.isArray(v));
  return Array.isArray(firstArr) ? firstArr : [];
}

function parseTS(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return new Date(v);
  if (typeof v === 'string') {
    // Handle "YYYY-MM-DD HH:mm" (space separator) as UTC
    const m = v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::\d{2})?$/);
    if (m) return new Date(`${m[1]}T${m[2]}:00Z`);
    // Fallback to built-in parser
    const t = Date.parse(v);
    if (Number.isFinite(t)) return new Date(t);
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? new Date(t) : new Date(NaN);
}

// Try to coerce “unknown” payloads into a consistent shape and skip corrupted rows
function coerce(row) {
  if (!row || typeof row !== 'object') return null;

  // time key (your sample uses "timestamp")
  const tKey = Object.keys(row).find((k) => /time|ts|timestamp|obs_time|date/i.test(k));
  const t = tKey ? parseTS(row[tKey]) : null;

  if (!t || isNaN(+t)) return null;

  const low = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]));
  const pick = (names) => names.find((k) => k in low && isNum(low[k]));

  const temp = low[pick(['temp', 'temperature', 'tmpf', 'air_temp'])];
  const precip = low[pick(['precip', 'precipitation', 'p01i', 'rain'])];
  const pressure = low[pick(['pressure', 'mslp', 'altimeter'])];
  const humidity = low[pick(['humidity', 'relh', 'rh'])];
  const dewpoint = low[pick(['dewpoint', 'dwpt'])];

  // wind speed: direct or computed from components
  let wind = low[pick(['wind_speed', 'wspd', 'windspd', 'windspeed'])];
  if (!isNum(wind)) {
    const wx = low['wind_x'];
    const wy = low['wind_y'];
    if (isNum(wx) && isNum(wy)) wind = Math.sqrt(wx * wx + wy * wy);
  }

  const gust = low[pick(['wind_gust', 'wgust', 'gust'])];

  return { time: t, temp, wind, gust, precip, pressure, humidity, dewpoint };
}

function label(m) {
  return (
    {
      temp: 'Temperature',
      wind: 'Wind speed',
      gust: 'Wind gust',
      precip: 'Precipitation',
      pressure: 'Pressure',
      humidity: 'Humidity',
    }[m] || m
  );
}

// --- Initial date inputs: last 7 days ---
q('#from').value = toISO(Date.now() - 7 * 86400000);
q('#to').value = toISO(Date.now());

// --- Map (Leaflet) ---
const map = L.map('map').setView([39.5, -98.35], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap' }).addTo(map);

let STATIONS = [];
let selected = null;
let chart;

// Return a list of code candidates we can try for /historical_weather
function stationCodes(station) {
  const s = station.raw || {};
  const base = [
    station.sid, station.id,
    s.station_id, s.icao, s.wmo, s.wmoid, s.code, s.uid, s.site, s.station
  ].filter(Boolean).map(String);

  let uniq = Array.from(new Set(base.map(x => x.toUpperCase())));
  const isUS = (station.country || '').toUpperCase() === 'US' || !!station.state;
  const isCA = (station.country || '').toUpperCase() === 'CA';

  const withPrefixes = [...uniq];
  uniq.forEach(c => {
    if (isUS && c.length === 3) withPrefixes.push('K' + c);
    if (isCA && c.length === 3) withPrefixes.push('C' + c);
  });

  // include lowercase variants too
  const plusLower = Array.from(new Set([...withPrefixes, ...withPrefixes.map(c => c.toLowerCase())]));
  return plusLower;
}

// Normalize station objects from unknown shapes to a consistent one
function normalizeStations(raw) {
  const list = Array.isArray(raw) ? raw : raw?.stations || [];
  return list
    .map((s, i) => {
      const sid =
        s.station_id ?? s.icao ?? s.wmo ?? s.wmoid ?? s.id ?? s.code ?? s.uid ?? s.site ?? s.station ?? null;
      return {
        sid,
        id: s.id ?? s.station_id ?? s.code ?? `station_${i}`,
        name: s.name || s.station_name || s.id || `Station ${i}`,
        lat: Number(s.lat ?? s.latitude ?? s.y),
        lon: Number(s.lon ?? s.longitude ?? s.x),
        country: s.country || s.ctry || '',
        state: s.state || s.region || '',
        raw: s,
      };
    })
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
}

// Filter stations by search term (supports BOS/KBOS, SFO/KSFO, etc.)
function filterStations(term) {
  term = term.trim().toUpperCase();
  if (!term) return STATIONS;

  const deK = term.startsWith('K') ? term.slice(1) : term;
  const deC = term.startsWith('C') ? term.slice(1) : term;

  return STATIONS.filter((s) => {
    const blob = `${s.sid || ''} ${s.id || ''} ${s.name || ''} ${s.state || ''} ${s.country || ''}`.toUpperCase();
    if (blob.includes(term)) return true;
    const codes = stationCodes(s);
    if (codes.some((c) => c.includes(term))) return true;
    if (codes.some((c) => c.includes(deK))) return true;
    if (codes.some((c) => c.includes(deC))) return true;
    return false;
  });
}

// Render up to 2000 markers for perf; bind a “Load” button in the popup
function renderMarkers(list) {
  if (window._markers) window._markers.forEach((m) => m.remove());
  window._markers = list.slice(0, 2000).map((s) => {
    const m = L.marker([s.lat, s.lon]).addTo(map);
    m.bindPopup(
      `<b>${s.name || s.id}</b><br/><small>${s.sid || s.id} • ${s.state || ''} ${s.country || ''}</small><br/>
       <button id="btn-${s.id}">Load</button>`
    );
    m.on('popupopen', () => {
      const b = document.getElementById(`btn-${s.id}`);
      if (b) b.onclick = () => selectStation(s);
    });
    return m;
  });
}

// Initial load
async function boot() {
  q('#info').textContent = 'Loading stations…';
  const raw = await Rate.stations();
  STATIONS = normalizeStations(raw);
  q('#info').textContent = `Loaded ${STATIONS.length} stations`;
  renderMarkers(STATIONS);
}

async function selectStation(s) {
  selected = s;
  selected._codes = stationCodes(s);
  map.flyTo([s.lat, s.lon], 8);
  q('#info').innerHTML = `<b>${s.name}</b>
    <div class="muted">${(selected._codes && selected._codes[0]) || s.sid || s.id} • ${s.state || ''} ${s.country || ''} • ${s.lat.toFixed(3)}, ${s.lon.toFixed(3)}</div>`;
  await refresh();
}

function inRange(t, from, to) {
  const x = t.getTime();
  return x >= from && x <= to;
}

function parseDateInput(selector, fallbackMillis) {
  const v = (q(selector).value || '').trim();
  if (!v) return fallbackMillis;

  // Try ISO yyyy-mm-dd first
  let t = Date.parse(v);
  if (Number.isFinite(t)) return t;

  // Try dd-mm-yyyy
  const m = v.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m) {
    const iso = `${m[3]}-${m[2]}-${m[1]}`;
    t = Date.parse(iso);
    if (Number.isFinite(t)) return t;
  }

  // Fallback
  return fallbackMillis;
}

// --- MAIN refresh ---
// --- TEMP BOS-only refresh to prove data path works ---
// --- FINAL general refresh (works for any station) ---
async function refresh() {
  if (!selected) return;
  q('#stats').textContent = 'Loading…';

  // Try multiple code variants until we get data (e.g., BOS/KBOS, SFO/KSFO, etc.)
  const candidates = selected._codes || stationCodes(selected);

  let raw = null;
  for (const code of candidates) {
    try {
      const resp = await Rate.history(code);
      const rows = extractRows(resp);
      if (Array.isArray(rows) && rows.length > 0) {
        raw = resp;
        selected._usedCode = code;
        break;
      }
    } catch (_) {
      /* try next code */
    }
  }

  // If all variants failed, try the original sid once
  if (!raw) {
    try { raw = await Rate.history(selected.sid); } catch (_) {}
  }

  const rows = extractRows(raw);
  const coerced = rows.map(coerce).filter(Boolean).sort((a, b) => a.time - b.time);

  // Robust date parsing (supports yyyy-mm-dd and dd-mm-yyyy)
  const from = parseDateInput('#from', Date.parse('2000-01-01T00:00:00Z'));
  const to   = parseDateInput('#to',   Date.now());

  const series = coerced.filter(r => {
    const x = r.time.getTime();
    return x >= from && x <= to;
  });

  const used = selected._usedCode ? ` • code: ${selected._usedCode}` : '';
  q('#stats').textContent =
    `${rows.length} rows • ${series.length} in range • ${Math.max(0, rows.length - coerced.length)} dropped as corrupted${used}`;

  draw(series);
  fillTable(series);
}



function draw(series) {
  const metric = q('#metric').value;
  q('#chartTitle').textContent = `${label(metric)} over time — ${selected?.name || ''}`;

  const labels = series.map((r) => r.time.toISOString().replace('T', ' ').slice(0, 16));
  const data = series.map((r) => (isNum(r[metric]) ? r[metric] : null));

  if (chart) chart.destroy();
  chart = new Chart(q('#chart'), {
    type: 'line',
    data: { labels, datasets: [{ label: label(metric), data, borderWidth: 2, spanGaps: true }] },
    options: { responsive: true, animation: false, scales: { x: { ticks: { maxTicksLimit: 12 } } } },
  });
}

function fillTable(series) {
  const tbody = q('#tbody');
  tbody.innerHTML = series
    .map(
      (r) => `
    <tr>
      <td>${r.time.toISOString().replace('T', ' ').slice(0, 16)}</td>
      <td>${fmt(r.temp)}</td>
      <td>${fmt(r.wind)}</td>
      <td>${fmt(r.gust)}</td>
      <td>${fmt(r.precip)}</td>
      <td>${fmt(r.pressure)}</td>
      <td>${fmt(r.humidity)}</td>
    </tr>`
    )
    .join('');
}

// --- UI hooks ---
q('#search').addEventListener('input', (e) => renderMarkers(filterStations(e.target.value)));
q('#clearBtn').onclick = () => { q('#search').value = ''; renderMarkers(STATIONS); };
q('#refresh').onclick = refresh;
q('#metric').onchange = () => { if (selected) refresh(); };

// Kick off
boot().catch((e) => {
  q('#info').textContent = 'Failed to load stations.';
  console.error(e);
});
