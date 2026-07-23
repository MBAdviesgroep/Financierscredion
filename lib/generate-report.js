// lib/generate-report.js — AI-casusrapport v2 (browser-module).
// Verbeteringen t.o.v. v1:
// - Voorselectie: de deterministische matching-engine brengt 130+ financiers terug
//   tot ± 22 kandidaten; het LLM redeneert diep over die set i.p.v. oppervlakkig over alles.
// - Twee fasen (analyse → advies): kleinere antwoorden, minder kans op afgekapte JSON.
// - Retry + JSON-herstel: een mislukte call kost niet meteen het hele rapport.
// - Kengetallen en uitkomst-historie (feedback-loop) gaan mee in de prompt.

function repairJson(s) {
  let t = String(s || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch (e) {}
  // Afgekapte JSON: sluit open strings/objecten/arrays.
  let fixed = t.replace(/,\s*([}\]])/g, '$1');
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of fixed) {
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    if (ch === '}' || ch === ']') stack.pop();
  }
  if (inStr) fixed += '"';
  while (stack.length) fixed += stack.pop();
  return JSON.parse(fixed);
}

// Eén JSON-call met retry; gedeeld door alle AI-functies.
export async function chatJson(chat, body, tries = 2) {
  let lastErr;
  for (let i = 0; i <= tries; i++) {
    try {
      const j = await chat(Object.assign({ response_format: { type: 'json_object' } }, body));
      const out = repairJson(j.choices[0].message.content);
      out.__usage = j.usage ? j.usage.total_tokens : null;
      out.__model = j.model || body.model;
      return out;
    } catch (e) { lastErr = e; if (i < tries) await new Promise(r => setTimeout(r, 1200 * (i + 1))); }
  }
  throw lastErr;
}

function compactFinancier(f, extra) {
  return Object.assign({
    id: f.id, naam: f.naam, type: f.type, vormen: f.vormen,
    rente: f.rente || null, min: f.minBedrag ?? null, max: f.maxBedrag ?? null,
    looptijd: f.looptijd || null, zekerheden: f.zekerheden || [], ltv: f.ltv || null,
    acceptatie: f.acceptatie || null, snelheid: f.snelheid || null, doelgroep: f.doelgroep || null,
    pp: (f.labels || []).includes('Preferred Partner') || undefined,
    databetrouwbaarheid: f.betrouwbaarheid,
  }, extra || {});
}

const ROL = 'Je bent een zeer ervaren senior financieringsadviseur bij een Nederlandse financieringsadviesorganisatie met 130+ aangesloten financiers. Wees concreet en kritisch — geen algemeenheden. Wees eerlijk over onzekerheid: als data ontbreekt of betrouwbaarheid laag is, benoem dat expliciet. Rentes zijn altijd indicatief; geef geen garanties. Antwoord uitsluitend met geldige JSON.';

// generateReport({ chat, model, casus, financiers, kandidaten, kengetallen, uitkomstenText, onStep })
// - kandidaten: voorgeselecteerde [{f, score, redenen, aandacht}] uit de matching-engine
// - onStep(tekst): voortgang voor de UI
export async function generateReport({ chat, model, casus, financiers, kandidaten, kengetallen, uitkomstenText, onStep }) {
  if (!casus || casus.trim().length < 20) throw new Error('Omschrijf de casus iets uitgebreider (minimaal enkele zinnen)');
  const step = onStep || (() => {});
  const mdl = model || 'gpt-4.1';
  const kText = kengetallen && kengetallen.velden && kengetallen.velden.length
    ? '\n\nGECONTROLEERDE KENGETALLEN (door de app berekend, gebruik deze als waarheid):\n' + kengetallen.velden.map(v => v.label + ': ' + v.waarde).join('\n')
    : '';

  // ---- Fase 1: casusanalyse ----
  step('Fase 1/2 — casus analyseren…');
  const sysA = ROL + '\nAnalyseer de klantcasus volledig: onderneming, sector, trackrecord, financiële kengetallen, financieringsbehoefte, zekerhedenpositie. Structuur:\n' +
    '{"samenvatting": string (5-7 zinnen, managementsamenvatting),' +
    '"casusAnalyse": {"gevraagd": string, "doel": string, "ondernemingsprofiel": string (3-5 zinnen), "zekerhedenpositie": string (2-3 zinnen), ' +
    '"kerngegevens": [{"label": string, "waarde": string}] (6-10, alleen wat afleidbaar is), "sterktes": [string] (4-6), "risicos": [string] (4-6), "ratios": string|null}}';
  const fase1 = await chatJson(chat, {
    model: mdl, temperature: 0.2, max_tokens: 2200,
    messages: [{ role: 'system', content: sysA }, { role: 'user', content: 'CASUS:\n' + casus.trim() + kText }],
  });

  // ---- Fase 2: shortlist & advies over voorgeselecteerde kandidaten ----
  step('Fase 2/2 — ' + (kandidaten ? kandidaten.length : 0) + ' kandidaten beoordelen…');
  const lijst = (kandidaten && kandidaten.length ? kandidaten : financiers.map(f => ({ f, score: null, redenen: [], aandacht: [] })))
    .map(r => compactFinancier(r.f, { prefilterScore: r.score, prefilterRedenen: r.redenen, prefilterAandacht: r.aandacht }));
  const sysB = ROL + '\nJe krijgt een klantcasus met analyse en een VOORGESELECTEERDE kandidatenlijst (uit ' + financiers.length + ' financiers, deterministisch gefilterd op producttype, bedrag en profiel; "prefilterScore/Redenen/Aandacht" tonen waarom). ' +
    'Gebruik UITSLUITEND financiers uit de lijst en verwijs met hun "id". "pp" = Preferred Partner. ' +
    (uitkomstenText ? 'UITKOMST-HISTORIE van eerdere Credion-casussen weegt zwaar mee: een financier die vergelijkbare casussen afwees is minder kansrijk. ' : '') +
    'Structuur:\n' +
    '{"shortlist": [{"id": string, "kans": "hoog"|"middel"|"laag", "score": number 0-100, "motivatie": string (3-4 zinnen, concreet voor DEZE casus), "aandachtspunten": string (2-3 zinnen), "indicatieveStructuur": string (bedrag, looptijd, aflossing, zekerheden), "renteIndicatie": string|null, "verwachteVoorwaarden": string|null, "doorlooptijd": string|null, "benodigdeDocumenten": string|null}] (6-9, gesorteerd op kans/score),' +
    '"afvallers": [{"id": string, "reden": string (1-2 zinnen)}] (3-6 voor de hand liggende kandidaten die je bewust NIET voorstelt),' +
    '"alternatieveRoutes": [string] (2-4 combinatie-/alternatieve structuren, concreet met bedragen),' +
    '"onderhandelingstips": [string] (3-5 concrete tips richting financiers),' +
    '"vervolgstappen": [string] (5-8 acties in logische volgorde, met wie/wat),' +
    '"disclaimer": string}';
  const userB = 'CASUS:\n' + casus.trim() + kText +
    '\n\nANALYSE (fase 1):\n' + JSON.stringify(fase1.casusAnalyse || {}) +
    (uitkomstenText ? '\n\nUITKOMST-HISTORIE:\n' + uitkomstenText : '') +
    '\n\nKANDIDATEN (JSON):\n' + JSON.stringify(lijst);
  const fase2 = await chatJson(chat, {
    model: mdl, temperature: 0.25, max_tokens: 5200,
    messages: [{ role: 'system', content: sysB }, { role: 'user', content: userB }],
  });

  const report = {
    samenvatting: fase1.samenvatting || '',
    casusAnalyse: fase1.casusAnalyse || {},
    shortlist: fase2.shortlist || [],
    afvallers: fase2.afvallers || [],
    alternatieveRoutes: fase2.alternatieveRoutes || [],
    onderhandelingstips: fase2.onderhandelingstips || [],
    vervolgstappen: fase2.vervolgstappen || [],
    disclaimer: fase2.disclaimer || 'Concept op basis van deels indicatieve data — te valideren door de adviseur.',
  };
  report._meta = {
    model: fase2.__model || mdl,
    ts: new Date().toLocaleString('nl-NL'),
    tokens: (fase1.__usage || 0) + (fase2.__usage || 0) || null,
    kandidaten: lijst.length, totaal: financiers.length,
  };
  return report;
}
