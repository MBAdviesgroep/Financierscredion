// api/store.js — Vercel serverless function: gedeelde teamopslag via Supabase.
// Optioneel: zonder SUPABASE_URL/SUPABASE_SERVICE_KEY werkt de app gewoon met localStorage.
//
// Setup (eenmalig, ± 5 minuten):
// 1. Maak een gratis project op supabase.com.
// 2. SQL Editor → voer uit:
//      create table if not exists cfp_store (
//        key text primary key,
//        value jsonb,
//        updated_at timestamptz default now()
//      );
// 3. Vercel → Settings → Environment Variables:
//      SUPABASE_URL         = https://<project>.supabase.co
//      SUPABASE_SERVICE_KEY = service_role key (Settings → API — geheim houden!)
// 4. Redeploy. De app detecteert de gedeelde opslag automatisch.
//
// Beveiliging: zelfde APP_TOKEN-check als /api/ai. Zet die dus zeker aan als je
// gedeelde opslag gebruikt, anders kan iedereen met de URL de data lezen/schrijven.

import { checkAuth } from './ai.js';

function cfg() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  return url && key ? { url: url.replace(/\/$/, ''), key } : null;
}

export default async function handler(req, res) {
  const c = cfg();
  if (req.method === 'GET' && req.query && req.query.health === '1') {
    return res.status(200).json({ ok: true, store: !!c, auth: !!process.env.APP_TOKEN });
  }
  if (!c) return res.status(200).json({ ok: true, store: false, value: null });
  if (!checkAuth(req, res)) return;
  const headers = { apikey: c.key, Authorization: 'Bearer ' + c.key, 'Content-Type': 'application/json' };
  const table = c.url + '/rest/v1/cfp_store';
  try {
    if (req.method === 'GET') {
      const k = (req.query && req.query.key) || 'main';
      const r = await fetch(table + '?key=eq.' + encodeURIComponent(k) + '&select=value,updated_at', { headers });
      const rows = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: JSON.stringify(rows).slice(0, 200) });
      return res.status(200).json({ ok: true, store: true, value: rows[0] ? rows[0].value : null, updated_at: rows[0] ? rows[0].updated_at : null });
    }
    if (req.method === 'POST') {
      const { key: k = 'main', value } = req.body || {};
      if (value == null) return res.status(400).json({ error: 'value ontbreekt' });
      const r = await fetch(table + '?on_conflict=key', {
        method: 'POST',
        headers: Object.assign({ Prefer: 'resolution=merge-duplicates' }, headers),
        body: JSON.stringify([{ key: k, value, updated_at: new Date().toISOString() }]),
      });
      if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: t.slice(0, 200) }); }
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Alleen GET/POST' });
  } catch (e) {
    return res.status(502).json({ error: 'Opslag-fout: ' + e.message });
  }
}
