// api/search.js — Vercel serverless function: AI-verrijking MET live webtoegang.
// Gebruikt de OpenAI Responses API met de web_search tool: het model zoekt de
// financier daadwerkelijk op internet op en levert een profiel met echte bron-URLs.
// Zelfde beveiliging als /api/ai (APP_TOKEN + rate limit).

import { checkAuth, rateLimited } from './ai.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: true, auth: !!process.env.APP_TOKEN, websearch: true });
  if (!checkAuth(req, res)) return;
  if (rateLimited(req)) return res.status(429).json({ error: 'Te veel verzoeken — probeer het later opnieuw (rate limit).' });
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY ontbreekt in de environment variables.' });
  const f = (req.body || {}).financier || {};
  if (!f.naam) return res.status(400).json({ error: 'financier.naam ontbreekt' });

  const instructie = 'Je bent een Nederlandse zakelijke-financieringsanalist. Zoek op internet actuele, feitelijke informatie over de financier "' + f.naam + '" (Nederland' +
    (f.website ? ', website vermoedelijk ' + f.website : '') + (f.adres ? ', adres ' + f.adres : '') + (f.type ? ', type vermoedelijk ' + f.type : '') + '). ' +
    'Zoek minimaal: aangeboden financieringsvormen, doelgroep, minimum/maximum financieringsbedrag, indicatieve rentes/tarieven, kosten, looptijden, zekerheden, LTV-grenzen, acceptatiecriteria, doorlooptijd. ' +
    'Gebruik bij voorkeur de eigen website van de financier. Wees conservatief: gebruik null voor alles wat je niet op een bron kunt baseren. Rentes ALTIJD als bandbreedte met "(indicatief)". ' +
    'Antwoord UITSLUITEND met een JSON-object met exact deze sleutels: website, doelgroep, sectorFocus, vormen (array), minBedrag (getal EUR of null), maxBedrag, rente, kosten, looptijd, aflossing, zekerheden (array), ltv, dscr, eigenInbreng, acceptatie, snelheid, documenten, bijzonderheden, bronnen (array met de URLs die je daadwerkelijk hebt geraadpleegd), betrouwbaarheid ("hoog"|"middel"|"laag"), opmerking. Geen tekst buiten de JSON.';

  try {
    const r = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: process.env.OPENAI_SEARCH_MODEL || 'gpt-4.1',
        tools: [{ type: 'web_search' }],
        input: instructie,
      }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: (j.error && j.error.message) || 'OpenAI-fout' });

    // Tekst + geraadpleegde URLs uit het antwoord halen.
    let text = j.output_text || '';
    const urls = new Set();
    (j.output || []).forEach(item => {
      (item.content || []).forEach(c => {
        if (c.text && !text) text = c.text;
        (c.annotations || []).forEach(a => { if (a.url) urls.add(a.url); });
      });
      if (item.action && item.action.url) urls.add(item.action.url);
    });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(502).json({ error: 'Geen geldig JSON-profiel in het antwoord.' });
    let profiel;
    try { profiel = JSON.parse(m[0]); } catch (e) { return res.status(502).json({ error: 'JSON niet leesbaar: ' + e.message }); }
    const bronnen = Array.from(new Set([...(profiel.bronnen || []), ...urls]));
    profiel.bronnen = bronnen;
    return res.status(200).json({ profiel, webVerified: bronnen.length > 0, model: j.model || null });
  } catch (e) {
    return res.status(502).json({ error: 'Zoek-fout: ' + e.message });
  }
}
