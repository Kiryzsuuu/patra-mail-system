/**
 * generate-surat.js
 * Membuat "Surat Dinas" AirNav Indonesia dengan kop surat & footer
 * yang diambil APA ADANYA (tidak dimodifikasi) dari template Inspira.
 *
 * Jalankan:
 *   npm install
 *   npm run build:surat
 *
 * Hasil: ./output/Surat Dinas - Kop Inspira.pdf
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { drawRichText, drawLabelValueTable, addLinkAnnotation } = require('./utils');

const ASSETS = path.join(__dirname, 'assets');
const OUTPUT_DIR = path.join(__dirname, 'output');

// Ukuran halaman sama seperti template Inspira (A4)
const PAGE_W = 595.5;
const PAGE_H = 842.25;

const HEADER_RATIO = 495 / 2482;
const FOOTER_RATIO = 167 / 2482;
const HEADER_H = PAGE_W * HEADER_RATIO;
const FOOTER_H = PAGE_W * FOOTER_RATIO;

const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.33, 0.33, 0.33);

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  // ---- Tempel header & footer Inspira (tanpa modifikasi) ----
  const headerBytes = fs.readFileSync(path.join(ASSETS, 'inspira_header.png'));
  const footerBytes = fs.readFileSync(path.join(ASSETS, 'inspira_footer.png'));
  const headerImg = await pdfDoc.embedPng(headerBytes);
  const footerImg = await pdfDoc.embedPng(footerBytes);

  page.drawImage(headerImg, { x: 0, y: PAGE_H - HEADER_H, width: PAGE_W, height: HEADER_H });
  page.drawImage(footerImg, { x: 0, y: 0, width: PAGE_W, height: FOOTER_H });

  // ---- Buat ikon & teks kontak di footer jadi clickable ----
  const FX = PAGE_W / 2482; // skala horizontal (gambar footer asli: 2482 x 167 px)
  const footerLinks = [
    { x1: 240, x2: 840, url: 'mailto:corporate@inspiratekno.com' }, // email
    { x1: 875, x2: 1265, url: 'https://inspiratekno.com' }, // website
    { x1: 1300, x2: 1730, url: 'tel:+6285111636633' }, // telepon
    { x1: 1755, x2: 2130, url: 'https://instagram.com/inspira.teknologi' }, // instagram
  ];
  footerLinks.forEach(({ x1, x2, url }) => {
    addLinkAnnotation(pdfDoc, page, {
      x1: x1 * FX,
      x2: x2 * FX,
      y1: 4,
      y2: FOOTER_H - 4,
      url,
    });
  });

  // ---- Konten ----
  const leftMargin = 42;
  const rightMargin = 42;
  const contentWidth = PAGE_W - leftMargin - rightMargin;
  const size = 9.5;
  const lh = 13;

  let y = PAGE_H - HEADER_H - 16;

  // Tanggal
  page.drawText('Tangerang, 12 Januari 2026', {
    x: leftMargin,
    y,
    size,
    font: fontRegular,
    color: BLACK,
  });
  y -= 22;

  // Tabel Nomor / Sifat / Lampiran / Perihal
  y = drawLabelValueTable(
    page,
    [
      ['Nomor', ':', '124/S/TNG/LPPNPI/KMP.13/I/2026'],
      ['Sifat', ':', 'Biasa/ Terbuka'],
      ['Lampiran', ':', '-'],
      ['Perihal', ':', 'Undangan Rapat Konsolidasi Kegiatan terkait Keamanan Siber Tahun 2026'],
    ],
    {
      x: leftMargin,
      y,
      cols: [75, 14, contentWidth - 89],
      fontRegular,
      fontItalic,
      size,
      lineHeight: lh,
      color: BLACK,
      rowGap: 1.5,
    }
  );
  y -= 8;

  // Kepada Yth.
  [
    'Kepada Yth.',
    'Direktur Keamanan Siber dan Sandi Teknologi Informasi',
    'dan Komunikasi, Media dan Transportasi',
    'Badan Siber dan Sandi Negara',
    'Di Tempat',
  ].forEach((line) => {
    page.drawText(line, { x: leftMargin, y, size, font: fontRegular, color: BLACK });
    y -= 12;
  });
  y -= 6;

  // Butir 1 + sub a, b
  y = drawRichText(page, '1. Mendasari :', {
    x: leftMargin,
    y,
    maxWidth: contentWidth,
    fontRegular,
    fontItalic,
    size,
    lineHeight: lh,
    color: BLACK,
  });
  y = drawRichText(
    page,
    'a. Nota Kesepahaman antara Perum LPPNPI dengan dengan Badan Siber dan Sandi Negara ' +
      'Republik Indonesia tentang Pelindungan Informasi dan Transaksi Elektronik nomor: ' +
      'MOU.003/U/00/LPPNPI/KMP.13/II/2023 dan PERJ.46/KABSSN/HK.07.01/02/2023 tanggal 16 ' +
      'Februari 2023;',
    {
      x: leftMargin + 18,
      y,
      maxWidth: contentWidth - 18,
      fontRegular,
      fontItalic,
      size,
      lineHeight: lh,
      color: BLACK,
    }
  );
  y -= 3;
  y = drawRichText(
    page,
    'b. Perjanjian Kerja Sama antara Perum LPPNPI dengan Direktorat Keamanan Siber dan ' +
      'Sandi, TIK dan Komunikasi, Media dan Transportasi BSSN tentang Pelaksanaan ' +
      'Peningkatan Kapasitas Keamanan Siber pada Perum LPPNPI nomor: ' +
      'PKS.014/S/00/LPPNPI/KMP.13/II/2023 dan PERJ.49/BSSN/D4/HK.07.02/02/2023 tanggal 16 ' +
      'Februari 2023.',
    {
      x: leftMargin + 18,
      y,
      maxWidth: contentWidth - 18,
      fontRegular,
      fontItalic,
      size,
      lineHeight: lh,
      color: BLACK,
    }
  );
  y -= 6;

  // Butir 2
  y = drawRichText(
    page,
    '2. Dalam rangka evaluasi perkembangan kerja sama antara Perum LPPNPI dengan Direktorat ' +
      'Keamanan Siber dan Sandi, TIK dan Komunikasi, Media dan Transportasi BSSN, dimana ' +
      'saat ini telah berjalan dengan baik, selanjutnya dipandang perlu untuk dilaksanakan ' +
      'suatu rapat konsolidasi bertujuan guna merumuskan langkah-langkah strategis untuk ' +
      'implementasi kegiatan terkait keamanan siber yang lebih efektif dan relevan serta ' +
      'membahas persiapan simulasi Table Top Exercise bersama BSSN yang direncanakan ' +
      'pelaksanaannya pada tahun 2026.',
    {
      x: leftMargin,
      y,
      maxWidth: contentWidth,
      fontRegular,
      fontItalic,
      size,
      lineHeight: lh,
      color: BLACK,
    }
  );
  y -= 6;

  // Butir 3 (pembuka)
  y = drawRichText(
    page,
    '3. Sehubungan dengan hal tersebut di atas, bersama ini disampaikan undangan rapat ' +
      'konsolidasi yang akan diselenggarakan pada:',
    {
      x: leftMargin,
      y,
      maxWidth: contentWidth,
      fontRegular,
      fontItalic,
      size,
      lineHeight: lh,
      color: BLACK,
    }
  );
  y -= 4;

  // Tabel agenda
  const agendaIndent = 18;
  y = drawLabelValueTable(
    page,
    [
      ['Hari, tanggal', ':', 'Selasa, 13 Januari 2026'],
      ['Waktu', ':', 'Pukul 09.30 WIB - selesai'],
      [
        'Tempat',
        ':',
        'Ruang Rapat Divisi Standard and Security, Lt. 2 Gedung Support, Kantor Pusat ' +
          'AirNav Indonesia',
      ],
      [
        'Agenda',
        ':',
        '1. Pembahasan Rencana Kegiatan terkait Keamanan Siber<br/>' +
          '2. Pembahasan Persiapan Simulasi Table Top Exercise Keamanan Siber',
      ],
    ],
    {
      x: leftMargin + agendaIndent,
      y,
      cols: [85, 14, contentWidth - agendaIndent - 99],
      fontRegular,
      fontItalic,
      size,
      lineHeight: lh,
      color: BLACK,
      rowGap: 1.5,
    }
  );
  y -= 6;

  // Butir 4
  y = drawRichText(
    page,
    '4. Demikian disampaikan, atas perhatian dan kehadirannya diucapkan terima kasih.',
    {
      x: leftMargin,
      y,
      maxWidth: contentWidth,
      fontRegular,
      fontItalic,
      size,
      lineHeight: lh,
      color: BLACK,
    }
  );

  // ---- Blok tanda tangan ----
  y -= 24;
  page.drawText('Direktur Keselamatan, Keamanan, dan Standardisasi', {
    x: leftMargin,
    y,
    size,
    font: fontRegular,
    color: BLACK,
  });
  y -= 6;

  const qrSize = 55;
  const qrBytes = fs.readFileSync(path.join(ASSETS, 'qr_surat.png'));
  const qrImg = await pdfDoc.embedPng(qrBytes);
  page.drawImage(qrImg, { x: leftMargin, y: y - qrSize, width: qrSize, height: qrSize });
  y -= qrSize + 4;

  page.drawText('Nurcahyo Utomo', { x: leftMargin, y, size, font: fontRegular, color: BLACK });

  // ---- Catatan tanda tangan elektronik (centered, italic, kecil) ----
  y -= 20;
  const footnote =
    'Dokumen ini telah ditandatangani secara elektronik menggunakan sertifikat elektronik ' +
    'yang diterbitkan oleh Balai Sertifikasi Elektronik (BSrE), Badan Siber dan Sandi Negara';
  drawCenteredWrapped(page, footnote, {
    y,
    maxWidth: contentWidth,
    pageWidth: PAGE_W,
    font: fontItalic,
    size: 8,
    lineHeight: 10,
    color: GRAY,
  });

  // ---- Simpan ----
  const pdfBytes = await pdfDoc.save();
  const outPath = path.join(OUTPUT_DIR, 'Surat Dinas - Kop Inspira.pdf');
  fs.writeFileSync(outPath, pdfBytes);
  console.log('Berhasil dibuat:', outPath);
}

/** Gambar paragraf rata tengah dengan word-wrap (untuk catatan footer). */
function drawCenteredWrapped(page, text, opts) {
  const { y, maxWidth, pageWidth, font, size, lineHeight, color } = opts;
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  words.forEach((word) => {
    const test = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  });
  if (current) lines.push(current);

  let cursorY = y;
  lines.forEach((line) => {
    const w = font.widthOfTextAtSize(line, size);
    page.drawText(line, { x: (pageWidth - w) / 2, y: cursorY, size, font, color });
    cursorY -= lineHeight;
  });
  return cursorY;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
