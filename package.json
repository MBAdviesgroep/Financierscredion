// lib/parse-file.js — leest casusdocumenten in de browser (txt/md, PDF, DOCX).
function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector('script[src="' + src + '"]')) return res();
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('Kon leesbibliotheek niet laden (geen internet?)'));
    document.head.appendChild(s);
  });
}
export async function extractText(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.pdf')) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
    const pdfjs = window['pdfjs-dist/build/pdf'] || window.pdfjsLib;
    pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const tc = await (await doc.getPage(p)).getTextContent();
      out.push(tc.items.map(i => i.str).join(' '));
    }
    return out.join('\n\n').replace(/[ \t]+/g, ' ').trim();
  }
  if (name.endsWith('.docx')) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
    const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
    const entry = zip.file('word/document.xml');
    if (!entry) throw new Error('geen geldig Word-bestand');
    const xml = await entry.async('string');
    return xml.replace(/<w:p[ >]/g, '\n<w:p ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim();
  }
  if (name.endsWith('.doc')) throw new Error('oud .doc-formaat wordt niet ondersteund — sla op als .docx of PDF');
  return (await file.text()).trim();
}
