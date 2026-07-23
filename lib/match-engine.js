// lib/match-engine.js — deterministische matching-engine (browser-module).
// Harde pre-filter + transparante scoring vóórdat het LLM iets ziet:
// consistenter, goedkoper en controleerbaar. Wordt gebruikt door de
// Matching-view én als voorselectie voor het AI-casusrapport.

const num = s => parseFloat(String(s == null ? '' : s).replace(/[^\d]/g, '')) || 0;

// ---- Feedback-loop: uitkomsten uit alle casussen aggregeren per financier ----
export function outcomesFromCases(cases) {
  const map = {};
  (cases || []).forEach(c => (c.uitkomsten || []).forEach(u => {
    const m = map[u.fid] || (map[u.fid] = { gefinancierd: 0, afgewezen: 0, offerte: 0, redenen: [] });
    if (u.resultaat === 'Gefinancierd') m.gefinancierd++;
    else if (u.resultaat === 'Afgewezen') m.afgewezen++;
    else m.offerte++;
    if (u.reden) m.redenen.push(u.resultaat.toLowerCase() + ': ' + u.reden);
  }));
  return map;
}

export function outcomesSummaryText(financiers, uitkomsten) {
  const regels = [];
  Object.entries(uitkomsten || {}).forEach(([fid, m]) => {
    const f = financiers.find(x => x.id === fid);
    if (!f) return;
    const delen = [];
    if (m.gefinancierd) delen.push(m.gefinancierd + 'x gefinancierd');
    if (m.offerte) delen.push(m.offerte + 'x offerte');
    if (m.afgewezen) delen.push(m.afgewezen + 'x afgewezen');
    regels.push(f.naam + ' (' + fid + '): ' + delen.join(', ') + (m.redenen.length ? ' — ' + m.redenen.slice(-3).join('; ') : ''));
  });
  return regels.join('\n');
}

// ---- Kernscoring: één financier tegen één vraag ----
// vraag: { vorm, bedrag, doel, zek[], omzet, ebitda, waarde, snelheid, risico }
export function scoreFinancier(f, vraag, uitkomsten) {
  const bedrag = num(vraag.bedrag);
  const isVastgoed = /vastgoed|hypotheek|verhuur|projectontw/i.test((vraag.vorm || '') + ' ' + (vraag.doel || ''));
  const wilSnel = vraag.snelheid === 'Binnen 1 week';
  let score = 0;
  const redenen = [], aandacht = [];

  // Producttype — harde poort: geen aansluiting = geen kandidaat.
  if ((f.vormen || []).includes(vraag.vorm)) { score += 40; redenen.push('biedt ' + String(vraag.vorm).toLowerCase() + (f.vormenAanname ? ' (aanname o.b.v. type)' : '')); }
  else if (isVastgoed && f.type === 'Vastgoedfinancier') { score += 30; redenen.push('gespecialiseerd in vastgoedfinanciering'); }
  else if (isVastgoed && f.type === 'Bank') { score += 18; redenen.push('bancair vastgoed mogelijk'); }
  else if (!vraag.vorm && f.type === 'Bank') { score += 10; }
  if (score === 0) return null;

  // Bedrag binnen range — harde poort bij grote afwijking.
  if (bedrag && f.minBedrag != null && f.maxBedrag != null) {
    if (bedrag >= f.minBedrag && bedrag <= f.maxBedrag) { score += 20; redenen.push('bedrag valt binnen bekende range'); }
    else if (bedrag < f.minBedrag * 0.5 || bedrag > f.maxBedrag * 2) return null; // ver buiten range: uitsluiten
    else { score -= 15; aandacht.push('gevraagd bedrag valt (net) buiten bekende range'); }
  } else if (bedrag) { aandacht.push('financieringsrange nog onbekend — valideren'); score += 4; }

  if ((f.labels || []).includes('Preferred Partner')) { score += 12; redenen.push('Preferred Partner van Credion'); }

  if (wilSnel) {
    if (['Non-bank lender', 'Crowdfundingplatform', 'Factoringmaatschappij'].includes(f.type)) { score += 8; redenen.push('non-bancair — doorgaans snelle beoordeling'); }
    if (f.type === 'Bank') { score -= 6; aandacht.push('bancair traject duurt meestal langer dan een week'); }
  }
  if (vraag.risico === 'Verhoogd — maatwerk' && f.type === 'Bank') { score -= 8; aandacht.push('verhoogd risicoprofiel past minder goed bij bancaire acceptatie'); }
  if (vraag.risico === 'Laag — sterke cijfers' && f.type === 'Bank') { score += 6; redenen.push('sterk profiel — bancaire pricing waarschijnlijk gunstig'); }

  if (f.rente) { score += 5; redenen.push('indicatieve rente bekend: ' + f.rente); } else aandacht.push('rente onbekend — opvragen');
  if ((vraag.zek || []).length === 0 && bedrag > 100000) aandacht.push('geen zekerheden opgegeven — blanco financiering beperkt de opties');

  // LTV
  if (isVastgoed && num(vraag.waarde) && bedrag) {
    const ltv = Math.round((bedrag / num(vraag.waarde)) * 100);
    if (ltv > 80) { score -= 6; aandacht.push('LTV ' + ltv + '% is hoog; veel vastgoedfinanciers zitten op max 70–80%'); }
    else redenen.push('LTV ' + ltv + '% ligt binnen gangbare kaders');
  }
  // Debt/EBITDA
  if (num(vraag.ebitda) && bedrag) {
    const de = bedrag / num(vraag.ebitda);
    if (de > 5) { score -= 5; aandacht.push('schuld/EBITDA ± ' + de.toFixed(1) + 'x is fors'); }
    else if (de <= 3.5) { score += 4; redenen.push('schuld/EBITDA ± ' + de.toFixed(1) + 'x — comfortabel'); }
  }

  // Datakwaliteit
  if (f.betrouwbaarheid === 'laag') { score -= 4; aandacht.push('profieldata nog niet gevalideerd'); }
  else if (f.betrouwbaarheid === 'hoog') score += 3;

  // Feedback-loop: eerdere uitkomsten wegen mee.
  const u = (uitkomsten || {})[f.id];
  if (u) {
    if (u.gefinancierd) { score += Math.min(12, u.gefinancierd * 6); redenen.push('track record: ' + u.gefinancierd + 'x eerder gefinancierd via Credion'); }
    if (u.afgewezen) { score -= Math.min(10, u.afgewezen * 4); aandacht.push('eerder ' + u.afgewezen + 'x afgewezen' + (u.redenen.length ? ' (' + u.redenen[u.redenen.length - 1] + ')' : '')); }
  }

  return { f, score: Math.max(5, Math.min(98, score + 30)), redenen, aandacht };
}

export function matchFinanciers(financiers, vraag, uitkomsten) {
  return financiers
    .map(f => scoreFinancier(f, vraag, uitkomsten))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

// ---- Voorselectie voor het AI-rapport ----
// Brengt 130+ financiers terug tot de beste `n` kandidaten, zodat het LLM
// diep kan redeneren over een behapbare set i.p.v. oppervlakkig over alles.
export function preselectForReport(financiers, caseInfo, kengetallen, uitkomsten, n = 22) {
  const k = kengetallen || {};
  const vraag = {
    vorm: caseInfo.vorm || '',
    bedrag: caseInfo.bedrag || k.bedrag || '',
    doel: (caseInfo.titel || '') + ' ' + (caseInfo.vorm || ''),
    zek: [],
    omzet: k.omzet || '', ebitda: k.ebitda || '', waarde: k.vastgoedwaarde || '',
    snelheid: '', risico: '',
  };
  let scored = matchFinanciers(financiers, vraag, uitkomsten);
  // Vangnet: bij te weinig kandidaten (bv. vorm onbekend) breedste selectie op type.
  if (scored.length < 8) {
    const ids = new Set(scored.map(r => r.f.id));
    financiers.filter(f => !ids.has(f.id) && ((f.labels || []).includes('Preferred Partner') || f.type === 'Bank' || f.rente)).slice(0, 12)
      .forEach(f => scored.push({ f, score: 30, redenen: ['breed inzetbaar — toegevoegd als vangnet'], aandacht: [] }));
  }
  return scored.slice(0, n);
}
