import express from 'express';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 8080;
const API_BASE = process.env.API_BASE || 'https://sfc.windbornesystems.com';

// Serve static files from /public
app.use(express.static('public', { maxAge: '1h' }));

// Proxy to avoid CORS issues
app.get('/api/stations', async (_req, res) => {
  try {
    const r = await fetch(`${API_BASE}/stations`, { headers: { Accept: 'application/json' } });
    res.status(r.status).set('Content-Type', 'application/json');
    res.send(await r.text());
  } catch (e) {
    res.status(502).json({ error: 'Upstream error', detail: String(e) });
  }
});

app.get('/api/historical_weather', async (req, res) => {
  const station = req.query.station || '';
  try {
    const r = await fetch(`${API_BASE}/historical_weather?station=${encodeURIComponent(station)}`, { headers: { Accept: 'application/json' } });
    res.status(r.status).set('Content-Type', 'application/json');
    res.send(await r.text());
  } catch (e) {
    res.status(502).json({ error: 'Upstream error', detail: String(e) });
  }
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
