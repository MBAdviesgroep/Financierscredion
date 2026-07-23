// lib/extract-financials.js — gestructureerde kengetallen-extractie (browser-module).
// Haalt vóór de rapportgeneratie de financiële kerncijfers uit de casustekst en
// geüploade documenten, en berekent LTV / DSCR / schuld-EBITDA deterministisch in
// code (niet door het LLM laten rekenen). De adviseur kan het resultaat controleren
// vóórdat het rapport wordt gegenereerd.

import { chatJson } from './generate-report.js';

const fmt = n => n == null ? null : '€ ' + Math.round(n).toLocaleString('nl-NL');

export async function extractKengetallen({ chat, model, casus }) {
  const sys = 'Je bent een financieel analist. Haal UITSLUITEND expliciet genoemde of direct afleidbare cijfers uit de casustekst. ' +
    'Antwoord uitsluitend met geldige JSON, exact deze sleutels (getallen in hele euro\'s, null indien onbekend): ' +
    '{"bedrag": number|null (gevraagde financiering), "doel": string|null, "omzet": number|null, "ebitda": number|null, "nettowinst": number|null, ' +
    '"eigenInbreng": number|null, "vastgoedwaarde": number|null, "huurinkomsten": number|null (per jaar), "bestaandeSchuld": number|null, ' +
    '"sector": string|null, "jarenActief": number|null, "rentelasten": number|null (per jaar), "aflossingsverplichting": number|null (per jaar), ' +
    '"toelichting": string (1-2 zinnen: wat ontbreekt er nog om de casus goed te beoordelen)}. ' +
    'Verzin NIETS: liever null dan een schatting.';
  const raw = await chatJson(chat, {
    model, temperature: 0, max_tokens: 900,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: 'CASUSTEKST:\n' + casus }],
  });

  // Ratio's deterministisch berekenen.
  const r = Object.assign({}, raw);
  r.ltv = raw.bedrag && raw.vastgoedwaarde ? Math.round((raw.bedrag / raw.vastgoedwaarde) * 100) : null;
  r.debtEbitda = raw.ebitda ? Math.round(((raw.bedrag || 0) + (raw.bestaandeSchuld || 0)) / raw.ebitda * 10) / 10 : null;
  const dienst = (raw.rentelasten || 0) + (raw.aflossingsverplichting || 0);
  r.dscr = raw.ebitda && dienst > 0 ? Math.round((raw.ebitda / dienst) * 100) / 100 : null;
  r.ts = new Date().toLocaleString('nl-NL');

  // Weergavevelden voor de UI.
  r.velden = [
    ['Gevraagd bedrag', fmt(raw.bedrag)], ['Doel', raw.doel],
    ['Omzet', fmt(raw.omzet)], ['EBITDA', fmt(raw.ebitda)], ['Nettowinst', fmt(raw.nettowinst)],
    ['Eigen inbreng', fmt(raw.eigenInbreng)], ['Vastgoedwaarde', fmt(raw.vastgoedwaarde)],
    ['Huurinkomsten p/j', fmt(raw.huurinkomsten)], ['Bestaande schuld', fmt(raw.bestaandeSchuld)],
    ['Sector', raw.sector], ['Jaren actief', raw.jarenActief != null ? String(raw.jarenActief) : null],
    ['LTV', r.ltv != null ? r.ltv + '%' : null],
    ['Schuld/EBITDA', r.debtEbitda != null ? r.debtEbitda + 'x' : null],
    ['DSCR', r.dscr != null ? r.dscr + 'x' : null],
  ].filter(x => x[1] != null && x[1] !== '').map(([label, waarde]) => ({ label, waarde }));
  return r;
}

export function kengetallenText(k) {
  if (!k || !k.velden || !k.velden.length) return '';
  return k.velden.map(v => v.label + ': ' + v.waarde).join(' · ') + (k.toelichting ? '\nOntbrekend: ' + k.toelichting : '');
}
