/**
 * utils.js
 * Helper kecil untuk layout teks di atas pdf-lib (wrapping, rich text <i>...<\/i>,
 * dan tabel label : value sederhana).
 */

const { PDFName, PDFArray, PDFString } = require('pdf-lib');

const SPACE_RE = /(\s+)/;

/**
 * Pecah string menjadi token { text, italic }.
 * Mendukung tag <i>...</i> untuk teks italic (mis. nama Zoom, "Safety Management System").
 */
function tokenize(text) {
  const tokens = [];
  const re = /<i>(.*?)<\/i>|([^<]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, italicPart, plainPart] = m;
    const part = italicPart !== undefined ? italicPart : plainPart;
    const italic = italicPart !== undefined;
    part.split(SPACE_RE).forEach((chunk) => {
      if (chunk.length > 0) tokens.push({ text: chunk, italic });
    });
  }
  return tokens;
}

/**
 * Gambar paragraf rich-text (boleh memuat <i>...</i>) dengan word-wrap.
 * Mendukung pemisah baris manual via "<br/>".
 *
 * @returns y setelah paragraf digambar (sudah dikurangi lineHeight terakhir)
 */
function drawRichText(page, raw, opts) {
  const {
    x,
    y,
    maxWidth,
    fontRegular,
    fontItalic,
    size,
    lineHeight,
    color,
    indent = 0,
  } = opts;

  let cursorY = y;
  const paragraphs = raw.split('<br/>');

  paragraphs.forEach((paragraph, pIdx) => {
    const tokens = tokenize(paragraph);
    let line = [];
    let lineWidth = 0;
    const availWidth = maxWidth - (pIdx === 0 ? 0 : indent);
    const startX = x + (pIdx === 0 ? 0 : indent);

    const flushLine = () => {
      let cx = startX;
      line.forEach((tok) => {
        const f = tok.italic ? fontItalic : fontRegular;
        page.drawText(tok.text, { x: cx, y: cursorY, size, font: f, color });
        cx += f.widthOfTextAtSize(tok.text, size);
      });
      cursorY -= lineHeight;
      line = [];
      lineWidth = 0;
    };

    tokens.forEach((tok) => {
      const f = tok.italic ? fontItalic : fontRegular;
      const w = f.widthOfTextAtSize(tok.text, size);
      // jangan biarkan baris dimulai dengan whitespace
      if (line.length === 0 && /^\s+$/.test(tok.text)) return;
      if (lineWidth + w > availWidth && line.length > 0) {
        flushLine();
        if (/^\s+$/.test(tok.text)) return; // skip leading space pada baris baru
      }
      line.push(tok);
      lineWidth += w;
    });
    if (line.length > 0) flushLine();
    else cursorY -= lineHeight; // paragraf/baris kosong
  });

  return cursorY;
}

/**
 * Gambar tabel sederhana 3 kolom: label | ":" | value (value boleh rich text & multiline).
 * cols = [labelWidth, colonWidth, valueWidth]
 */
function drawLabelValueTable(page, rows, opts) {
  const {
    x,
    y,
    cols,
    fontRegular,
    fontItalic,
    size,
    lineHeight,
    color,
    rowGap = 2,
  } = opts;

  let cursorY = y;
  rows.forEach(([label, colon, value]) => {
    const startY = cursorY;
    // label
    page.drawText(label, { x, y: cursorY, size, font: fontRegular, color });
    // colon
    page.drawText(colon, { x: x + cols[0], y: cursorY, size, font: fontRegular, color });
    // value (rich, bisa multi-baris)
    const valueX = x + cols[0] + cols[1];
    const afterValueY = drawRichText(page, value, {
      x: valueX,
      y: cursorY,
      maxWidth: cols[2],
      fontRegular,
      fontItalic,
      size,
      lineHeight,
      color,
    });
    cursorY = Math.min(afterValueY, startY - lineHeight) - rowGap;
  });
  return cursorY;
}

/**
 * Tambahkan area link (clickable) di atas halaman PDF.
 * rect dalam koordinat PDF (origin kiri-bawah): { x1, y1, x2, y2 }
 */
function addLinkAnnotation(pdfDoc, page, { x1, y1, x2, y2, url }) {
  const linkAnnot = pdfDoc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [x1, y1, x2, y2],
    Border: [0, 0, 0],
    A: {
      Type: 'Action',
      S: 'URI',
      URI: PDFString.of(url),
    },
  });
  const linkRef = pdfDoc.context.register(linkAnnot);

  let annots = page.node.get(PDFName.of('Annots'));
  if (annots) annots = pdfDoc.context.lookup(annots);
  if (!(annots instanceof PDFArray)) {
    annots = pdfDoc.context.obj([]);
    page.node.set(PDFName.of('Annots'), annots);
  }
  annots.push(linkRef);
}

module.exports = { tokenize, drawRichText, drawLabelValueTable, addLinkAnnotation };
