// server.js
import express from 'express';
import fetch from 'node-fetch';
import dns from 'dns';
import path from 'path';
import { fileURLToPath } from 'url';

// Prefer IPv4 to avoid upstream AAAA/IPv6 issues on some hosts
dns.setDefaultResultOrder?.('ipv4first');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';
const API_BASE = process.env.API_BASE || 'https://sfc.windbornesystems.com';

// Serve static files
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// Simple health check so Render can always hit something
app.get('/healthz', (_req, res) => res.type('text/plain').send('ok'));

// Small helper: robust fetch with timeout + JSON fallback
async function robustFetchJSON(url) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000); // 15s timeout
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body, text };
  } finally {
    clearTimeout(t);
  }
}

// Proxy endpoints (avoid CORS in browser)
app.get('/api/stations', async (_req, res) => {
  const url = `${API_BASE}/stations`;
  try {
    const { status, body, text } = await robustFetchJSON(url);
    console.log('UPSTREAM /stations ->', status);
    res.status(status).type('application/json').send(typeof body === 'string' ? text : body);
  } catch (e) {
    console.error('UPSTREAM /stations ERROR', e);
    res.status(502).json({ error: 'Upstream error', detail: String(e) });
  }
});

app.get('/api/historical_weather', async (req, res) => {
  const station = req.query.station || '';
  const url = `${API_BASE}/historical_weather?station=${encodeURIComponent(station)}`;
  try {
    const { status, body, text } = await robustFetchJSON(url);
    console.log('UPSTREAM /historical_weather', station, '->', status);
    res.status(status).type('application/json').send(typeof body === 'string' ? text : body);
  } catch (e) {
    console.error('UPSTREAM /historical_weather ERROR', station, e);
    res.status(502).json({ error: 'Upstream error', detail: String(e) });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
