// api/ai.js — Vercel serverless function: beveiligde OpenAI-proxy.
// Sleutel in env var OPENAI_API_KEY; komt nooit in de browser.
// Optionele beveiliging: zet APP_TOKEN in de environment variables — dan is een
// toegangscode verplicht (header x-app-token). Sterk aanbevolen voor productie.
// Rate limiting: max RATE_LIMIT verzoeken per IP per uur (standaard 60, best effort).

const buckets = globalThis.__cfpRate || (globalThis.__cfpRate = new Map());

export function rateLimited(req) {
  const limit = parseInt(process.env.RATE_LIMIT || '60', 10);
  const ip = (req.headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now > b.reset) { b = { count: 0, reset: now + 3600e3 }; buckets.set(ip, b); }
  b.count++;
  if (buckets.size > 5000) buckets.clear();
  return b.count > limit;
}

export function checkAuth(req, res) {
  const token = process.env.APP_TOKEN;
  if (!token) return true;
  if ((req.headers['x-app-token'] || '') === token) return true;
  res.status(401).json({ error: 'Toegangscode ontbreekt of is onjuist. Vul de toegangscode in onder AI-verrijking.' });
  return false;
}

// Toegestane modellen: exacte namen of prefixes (nieuwere versies automatisch toegestaan).
const ALLOWED_PREFIXES = ['gpt-4o', 'gpt-4.1', 'gpt-5', 'o3', 'o4'];
export function pickModel(m) {
  if (typeof m === 'string' && ALLOWED_PREFIXES.some(p => m === p || m.startsWith(p + '-'))) return m;
  return process.env.OPENAI_MODEL || 'gpt-4.1';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    // Health check voor de app (geen sleutelinfo lekken).
    return res.status(405).json({ ok: true, auth: !!process.env.APP_TOKEN, error: 'Alleen POST — dit endpoint is de AI-proxy van het Credion Financiersplatform.' });
  }
  if (!checkAuth(req, res)) return;
  if (rateLimited(req)) return res.status(429).json({ error: 'Te veel verzoeken — probeer het over een uur opnieuw (rate limit).' });
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY ontbreekt in de environment variables.' });
  const body = req.body || {};
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: pickModel(body.model),
        temperature: body.temperature ?? 0.2,
        max_tokens: Math.min(body.max_tokens || 4000, 16000),
        response_format: body.response_format,
        messages: body.messages,
      }),
    });
    const j = await r.json();
    return res.status(r.status).json(j);
  } catch (e) {
    return res.status(502).json({ error: 'Proxy-fout: ' + e.message });
  }
}
