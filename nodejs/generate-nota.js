/**
 * generate-nota.js
 * Membuat "Nota Dinas" AirNav Indonesia dengan kop surat & footer
 * yang diambil APA ADANYA (tidak dimodifikasi) dari template Inspira.
 *
 * Jalankan:
 *   npm install
 *   npm run build:nota
 *
 * Hasil: ./output/Nota Dinas - Kop Inspira.pdf
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

// Rasio gambar header & footer hasil crop dari PDF Inspira (2482 x 495 / 167 px)
const HEADER_RATIO = 495 / 2482;
const FOOTER_RATIO = 167 / 2482;
const HEADER_H = PAGE_W * HEADER_RATIO;
const FOOTER_H = PAGE_W * FOOTER_RATIO;

const BLACK = rgb(0, 0, 0);

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([PAGE_W, PAGE_H]);

  const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const fontItalic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  // ---- Tempel header & footer Inspira (tanpa modifikasi) ----
  const headerBytes = fs.readFileSync(path.join(ASSETS, 'inspira_header.png'));
  const footerBytes = fs.readFileSync(path.join(ASSETS, 'inspira_footer.png'));
  const headerImg = await pdfDoc.embedPng(headerBytes);
  const footerImg = await pdfDoc.embedPng(footerBytes);

  page.drawImage(headerImg, {
    x: 0,
    y: PAGE_H - HEADER_H,
    width: PAGE_W,
    height: HEADER_H,
  });
  page.drawImage(footerImg, {
    x: 0,
    y: 0,
    width: PAGE_W,
    height: FOOTER_H,
  });

  // ---- Buat ikon & teks kontak di footer jadi clickable ----
  // Koordinat dihitung dari posisi ikon/teks pada gambar footer (2482 x 167 px),
  // diskalakan ke ukuran halaman PDF (PAGE_W x FOOTER_H).
  const FX = PAGE_W / 2482; // skala horizontal
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
  const leftMargin = 40;
  const rightMargin = 40;
  const contentWidth = PAGE_W - leftMargin - rightMargin;

  let y = PAGE_H - HEADER_H - 16;

  // Judul
  const title = 'N O T A   D I N A S';
  const titleSize = 13;
  const titleWidth = fontBold.widthOfTextAtSize(title, titleSize);
  page.drawText(title, {
    x: (PAGE_W - titleWidth) / 2,
    y,
    size: titleSize,
    font: fontBold,
    color: BLACK,
  });
  y -= 18;

  const nomor = 'Nomor : 226/SO/KLH.05/VI/2026';
  const nomorSize = 10;
  const nomorWidth = fontRegular.widthOfTextAtSize(nomor, nomorSize);
  page.drawText(nomor, {
    x: (PAGE_W - nomorWidth) / 2,
    y,
    size: nomorSize,
    font: fontRegular,
    color: BLACK,
  });
  y -= 26;

  // Tabel Kepada Yth / Dari / Perihal
  y = drawLabelValueTable(
    page,
    [
      ['Kepada Yth.', ':', 'Para Executive Vice President'],
      ['Dari', ':', 'EVP of Safety Operation'],
      ['Perihal', ':', 'Sosialisasi Safety Policy Perum LPPNPI'],
    ],
    {
      x: leftMargin,
      y,
      cols: [100, 14, contentWidth - 114],
      fontRegular,
      fontItalic,
      size: 10,
      lineHeight: 13,
      color: BLACK,
      rowGap: 2,
    }
  );
  y -= 8;

  // Butir 1
  y = drawRichText(
    page,
    '1. Mendasari Peraturan Direktorat Jenderal Perhubungan Udara Nomor: KP 62 Tahun 2020 ' +
      'tentang Pedoman Teknis Operasional Peraturan Keselamatan Penerbangan Sipil Bagian ' +
      '19-06 (Advisory Circular Part 19-06) Implementasi Sistem Manajemen Keselamatan ' +
      '(<i>Safety Management System</i>) Pada Penyelenggara Pelayanan Navigasi Penerbangan.',
    {
      x: leftMargin,
      y,
      maxWidth: contentWidth,
      fontRegular,
      fontItalic,
      size: 10,
      lineHeight: 14,
      color: BLACK,
    }
  );
  y -= 6;

  // Butir 2 (pembuka)
  y = drawRichText(
    page,
    '2. Sehubungan dengan butir 1 (satu) di atas, disampaikan undangan Sosialisasi Safety ' +
      'Policy Perum LPPNPI yang dilaksanakan pada:',
    {
      x: leftMargin,
      y,
      maxWidth: contentWidth,
      fontRegular,
      fontItalic,
      size: 10,
      lineHeight: 14,
      color: BLACK,
    }
  );
  y -= 4;

  // Tabel detail (indent ke kanan, meniru indentasi 28pt)
  const detailIndent = 28;
  y = drawLabelValueTable(
    page,
    [
      ['Hari/Tanggal', ':', 'Rabu, 10 Juni 2026'],
      ['Waktu', ':', 'Sesi I, 09.30 s.d 11.00 WIB<br/>Sesi II, 14.00 s.d 15.30 WIB'],
      ['Kegiatan', ':', 'Sosialisasi Safety Policy Perum LPPNPI'],
      [
        'Media',
        ':',
        'Zoom <i>https://airnav.id/Safety-Policy</i><br/>Meeting ID: 934 3696 7743, Passcode: 498639',
      ],
    ],
    {
      x: leftMargin + detailIndent,
      y,
      cols: [82, 14, contentWidth - detailIndent - 96],
      fontRegular,
      fontItalic,
      size: 10,
      lineHeight: 14,
      color: BLACK,
      rowGap: 2,
    }
  );
  y -= 4;

  // Paragraf "Selanjutnya..."
  y = drawRichText(
    page,
    'Selanjutnya, mohon Para Executive Vice President dapat menyampaikan kepada seluruh ' +
      'jajarannya untuk hadir pada salah satu sesi kegiatan dimaksud.',
    {
      x: leftMargin,
      y,
      maxWidth: contentWidth,
      fontRegular,
      fontItalic,
      size: 10,
      lineHeight: 14,
      color: BLACK,
    }
  );
  y -= 6;

  // Butir 3
  y = drawRichText(
    page,
    '3. Demikian disampaikan, atas perhatian dan kerjasamanya diucapkan terima kasih.',
    {
      x: leftMargin,
      y,
      maxWidth: contentWidth,
      fontRegular,
      fontItalic,
      size: 10,
      lineHeight: 14,
      color: BLACK,
    }
  );

  // ---- Blok tanda tangan (rata kanan) ----
  y -= 26;
  const signLines = ['Tangerang, 04 Juni 2026', 'EVP of Safety Operation'];
  signLines.forEach((line) => {
    const w = fontRegular.widthOfTextAtSize(line, 10);
    page.drawText(line, {
      x: PAGE_W - rightMargin - w,
      y,
      size: 10,
      font: fontRegular,
      color: BLACK,
    });
    y -= 13;
  });

  // QR code
  y -= 6;
  const qrSize = 60;
  const qrBytes = fs.readFileSync(path.join(ASSETS, 'qr_nota.png'));
  const qrImg = await pdfDoc.embedPng(qrBytes);
  page.drawImage(qrImg, {
    x: PAGE_W - rightMargin - qrSize - 50,
    y: y - qrSize,
    width: qrSize,
    height: qrSize,
  });
  y -= qrSize + 4;

  // Nama penanda tangan
  {
    const name = 'Suwandi';
    const w = fontRegular.widthOfTextAtSize(name, 10);
    page.drawText(name, {
      x: PAGE_W - rightMargin - w,
      y,
      size: 10,
      font: fontRegular,
      color: BLACK,
    });
  }

  // ---- Simpan ----
  const pdfBytes = await pdfDoc.save();
  const outPath = path.join(OUTPUT_DIR, 'Nota Dinas - Kop Inspira.pdf');
  fs.writeFileSync(outPath, pdfBytes);
  console.log('Berhasil dibuat:', outPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
