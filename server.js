require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const User = require('./models/User');
const Email = require('./models/Email');
const ActivityLog = require('./models/ActivityLog');
const ShortUrl = require('./models/ShortUrl');
const Task = require('./models/Task');
const Signature = require('./models/Signature');
const Agreement = require('./models/Agreement');
const DocCounter = require('./models/DocCounter');
const SuratMasuk = require('./models/SuratMasuk');
const Direktorat = require('./models/Direktorat');
const KodeDireksi = require('./models/KodeDireksi');
const Jabatan    = require('./models/Jabatan');
const Organisasi = require('./models/Organisasi');
const DocumentSignature = require('./models/DocumentSignature');
const SiteSettings = require('./models/SiteSettings');
const NomorSaja   = require('./models/NomorSaja');
const Arsip       = require('./models/Arsip');
const Perusahaan       = require('./models/Perusahaan');
const ESignSession     = require('./models/ESignSession');
const PersonalDocument = require('./models/PersonalDocument');
const QRCode = require('qrcode');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
// Puppeteer di-require lazy supaya app tetap boot walau modul/Chromium belum terpasang
let puppeteer = null;
function loadPuppeteer() {
  if (!puppeteer) puppeteer = require('puppeteer');
  return puppeteer;
}

// ── Shared headless browser untuk render PDF (preview == download) ──
let _pdfBrowser = null;
async function getPdfBrowser() {
  if (_pdfBrowser && _pdfBrowser.isConnected && _pdfBrowser.isConnected()) return _pdfBrowser;
  _pdfBrowser = await loadPuppeteer().launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  return _pdfBrowser;
}

// Render sebuah EJS view (dengan data) menjadi PDF A4 buffer
function renderViewToPdf(app, view, data) {
  return new Promise((resolve, reject) => {
    app.render(view, data, async (err, html) => {
      if (err) return reject(err);
      let page;
      try {
        const browser = await getPdfBrowser();
        page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
        const pdf = await page.pdf({
          format: 'A4', printBackground: true, preferCSSPageSize: true,
          margin: { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' }
        });
        resolve(pdf);
      } catch (e) { reject(e); }
      finally { if (page) { try { await page.close(); } catch {} } }
    });
  });
}
const { groupUsersByDir } = require('./lib/userGroups');

const app = express();

// Pastikan folder uploads tersedia saat server mulai
['uploads', 'uploads/suratmasuk', 'uploads/esign', 'uploads/esign/signed'].forEach(dir => {
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Prevent HTML page caching so EJS changes take effect immediately
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  next();
});

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/inspira-mailer';

app.use(session({
  secret: process.env.SESSION_SECRET || 'inspira-secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGO_URI, touchAfter: 24 * 3600 }),
  cookie: { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log('MongoDB Atlas terhubung');
    // Drop index lama suratId_1 yang unique non-sparse (diganti sparse)
    try {
      await mongoose.connection.db.collection('documentsignatures').dropIndex('suratId_1');
      console.log('Index suratId_1 lama berhasil di-drop, akan dibuat ulang sebagai sparse.');
    } catch { /* index sudah tidak ada atau belum pernah dibuat */ }
    // Seed & cache kode direksi agar penomoran surat punya data
    try { await seedKodeDireksi(); await getKodeDireksiCached(); } catch (e) { console.error('Init KodeDireksi:', e.message); }
  })
  .catch(err => console.error('MongoDB error:', err));

// ── LOGGING HELPER ──

async function log(req, action, category, description, metadata = {}, status = 'success') {
  try {
    const user = req?.user;
    await ActivityLog.create({
      userId: user?._id || null,
      userName: user?.name || metadata.name || 'System',
      userEmail: user?.email || metadata.email || '',
      userRole: user?.role || 'system',
      action,
      category,
      description,
      metadata,
      ipAddress: req?.ip || req?.connection?.remoteAddress || '',
      userAgent: req?.headers?.['user-agent'] || '',
      status
    });
  } catch (e) {
    // logging failures should never crash the app
  }
}

// ── MIDDLEWARE ──

app.use(async (req, res, next) => {
  res.locals.user = null;
  if (req.session.userId) {
    try {
      const user = await User.findById(req.session.userId).select('-password');
      if (user && user.isActive) {
        // Cek session timeout inaktivitas
        const ss = await SiteSettings.getSettings();
        const timeoutMs = (ss.sessionTimeoutMinutes || 0) * 60 * 1000;
        if (timeoutMs > 0 && req.session.lastActivity) {
          if (Date.now() - req.session.lastActivity > timeoutMs) {
            req.session.destroy(() => {});
            if (req.xhr || req.headers.accept?.includes('application/json')) {
              return res.status(401).json({ error: 'Sesi habis karena tidak aktif.' });
            }
            return res.redirect('/login?timeout=1');
          }
        }
        req.session.lastActivity = Date.now();
        req.user = user;
        res.locals.user = user;
      } else {
        req.session.destroy(() => {});
      }
    } catch (e) {}
  }
  // Inject site settings ke semua view
  try {
    const ss = await SiteSettings.getSettings();
    res.locals.siteSettings = ss;
  } catch (e) {
    res.locals.siteSettings = {};
  }
  // Inject daftar direktorat + helper grup karyawan ke semua view (cache 60 dtk)
  res.locals.groupUsersByDir = groupUsersByDir;
  if (req.user) {
    try {
      res.locals.direktorats = await getDirektoratsCached();
    } catch (e) {
      res.locals.direktorats = [];
    }
  } else {
    res.locals.direktorats = [];
  }
  next();
});

// Cache ringan untuk daftar direktorat (dipakai semua view)
let _dirCache = { data: [], ts: 0 };
async function getDirektoratsCached() {
  if (Date.now() - _dirCache.ts < 60000 && _dirCache.data.length) return _dirCache.data;
  const data = await Direktorat.find().sort('kode').lean();
  _dirCache = { data, ts: Date.now() };
  return data;
}

// Cache + seeder untuk Kode Direksi (dipakai compose & penomoran)
let _kdCache = { data: [], ts: 0 };
const KODE_DIREKSI_DEFAULT = [
  { kode: 'KOM',  nama: 'Dewan Komisaris',            group: 'divisi',  urutan: 1 },
  { kode: 'CEO',  nama: 'Direktur Utama',             group: 'direksi', urutan: 2 },
  { kode: 'CTO',  nama: 'Direktur Teknik',            group: 'direksi', urutan: 3 },
  { kode: 'CMO',  nama: 'Direktur Marketing',         group: 'direksi', urutan: 4 },
  { kode: 'COO',  nama: 'Direktur Operasional',       group: 'direksi', urutan: 5 },
  { kode: 'PLAN', nama: 'Business Strategy & Finance',group: 'divisi',  urutan: 6 },
  { kode: 'TECH', nama: 'Technical & Operations',     group: 'divisi',  urutan: 7 },
  { kode: 'MP',   nama: 'Marketing & Partnership',    group: 'divisi',  urutan: 8 },
];
async function seedKodeDireksi() {
  try {
    const n = await KodeDireksi.countDocuments();
    if (n === 0) await KodeDireksi.insertMany(KODE_DIREKSI_DEFAULT);
  } catch (e) { console.error('Seed KodeDireksi gagal:', e.message); }
}
async function getKodeDireksiCached() {
  if (Date.now() - _kdCache.ts < 60000 && _kdCache.data.length) return _kdCache.data;
  let data = await KodeDireksi.find({ aktif: { $ne: false } }).sort('urutan kode').lean();
  if (!data.length) { await seedKodeDireksi(); data = await KodeDireksi.find({ aktif: { $ne: false } }).sort('urutan kode').lean(); }
  _kdCache = { data, ts: Date.now() };
  _kdCodes = data.map(d => d.kode);
  return data;
}
let _kdCodes = KODE_DIREKSI_DEFAULT.map(d => d.kode);

// ── PUBLIC REDIRECT — harus sebelum semua route lain ──
app.get('/inspira/:code', async (req, res) => {
  try {
    const su = await ShortUrl.findOneAndUpdate(
      { shortCode: req.params.code, isActive: true },
      { $inc: { clicks: 1 } },
      { new: true }
    );
    if (!su) return res.status(404).send('URL tidak ditemukan atau sudah tidak aktif.');
    res.redirect(su.originalUrl);
  } catch (err) {
    res.status(500).send('Terjadi kesalahan.');
  }
});
app.get('/s/:code', (req, res) => res.redirect('/inspira/' + req.params.code));

function requireAuth(req, res, next) {
  if (!req.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

// Role hierarchy: superadmin > admin > direktur > user
const ROLE_LEVEL = { superadmin: 4, admin: 3, direktur: 3, user: 1 };

function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user || (ROLE_LEVEL[req.user.role] || 0) < (ROLE_LEVEL[minRole] || 0)) {
      return res.status(403).redirect('/inbox');
    }
    next();
  };
}

const requireAdmin      = requireRole('admin');
const requireSuperAdmin = requireRole('superadmin');
const requireDirektur   = requireRole('direktur');

// Multer for document attachment (PDF, Word, images — max 10MB)
const lampiranUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, 'lampiran-' + Date.now() + ext);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/gif','application/pdf',
      'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Format file tidak didukung.'));
  }
});

// Multer for avatar — memory storage, resized then saved to MongoDB as base64
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Hanya file gambar yang diizinkan.'));
  }
});

async function processAvatar(buffer) {
  const resized = await sharp(buffer)
    .resize(200, 200, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
  return 'data:image/jpeg;base64,' + resized.toString('base64');
}

// Email transporter
let transporter = null;
if (process.env.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

// ── HELPERS ──

const MONTHS = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];

function formatDate(d) {
  const date = new Date(d);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function formatDateTime(d) {
  const date = new Date(d);
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${h}:${m}`;
}

async function getMailCounts(userId) {
  const [inboxCount, draftCount, suratMasukCount] = await Promise.all([
    Email.countDocuments({
      'to.userId': userId,
      status: 'sent',
      deletedBy: { $ne: userId },
      readBy: { $not: { $elemMatch: { $eq: userId } } }
    }),
    Email.countDocuments({
      'from.userId': userId,
      status: 'draft',
      deletedBy: { $ne: userId }
    }),
    SuratMasuk.countDocuments({ status: 'baru' })
  ]);
  return { inboxCount, draftCount, suratMasukCount };
}

// Cek apakah user berhak edit/akses dokumen sebagai pemilik
function canEditDoc(email, userId) {
  const uid = userId.toString();
  return email.from.userId?.toString() === uid ||
         email.ownerUserId?.toString() === uid;
}

// ── AUTH ROUTES ──

app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/inbox');
  const error = req.query.timeout === '1' ? 'Sesi Anda berakhir karena tidak aktif. Silakan masuk kembali.' : null;
  res.render('login', { title: 'Masuk', error, savedEnik: '' });
});

app.post('/login', async (req, res) => {
  const { enik, password } = req.body;
  const enikTrimmed = enik?.trim();
  try {
    const user = await User.findOne({ enik: enikTrimmed });
    if (!user || !(await user.matchPassword(password))) {
      await log(req, 'login_failed', 'auth', `Percobaan login gagal untuk enik: ${enikTrimmed}`, { enik: enikTrimmed }, 'failed');
      return res.render('login', { title: 'Masuk', error: 'Enik atau kata sandi salah.', savedEnik: enikTrimmed });
    }
    if (!user.isActive) {
      await log(req, 'login_failed', 'auth', `Login ditolak - akun dinonaktifkan: ${enikTrimmed}`, { enik: enikTrimmed }, 'failed');
      return res.render('login', { title: 'Masuk', error: 'Akun Anda telah dinonaktifkan.', savedEnik: enikTrimmed });
    }
    req.session.userId = user._id;
    user.lastLogin = new Date();
    await user.save();
    req.user = user;
    await log(req, 'login', 'auth', `${user.name} berhasil masuk ke sistem`, { role: user.role });
    const to = req.session.returnTo || '/inbox';
    delete req.session.returnTo;
    res.redirect(to);
  } catch (err) {
    console.error(err);
    res.render('login', { title: 'Masuk', error: 'Terjadi kesalahan, coba lagi.', savedEnik: enikTrimmed });
  }
});

app.get('/register', (req, res) => {
  if (req.user) return res.redirect('/inbox');
  res.render('register', { title: 'Daftar', error: null, data: {} });
});

app.post('/register', async (req, res) => {
  const { name, email, enik, password, password2, organization } = req.body;
  const data = { name, email, enik, organization };
  if (!name?.trim() || !email?.trim() || !enik?.trim() || !password) {
    return res.render('register', { title: 'Daftar', error: 'Semua kolom wajib diisi.', data });
  }
  if (password !== password2) {
    return res.render('register', { title: 'Daftar', error: 'Kata sandi tidak cocok.', data });
  }
  if (password.length < 8) {
    return res.render('register', { title: 'Daftar', error: 'Kata sandi minimal 8 karakter.', data });
  }
  try {
    if (await User.findOne({ email: email.toLowerCase().trim() })) {
      return res.render('register', { title: 'Daftar', error: 'Email sudah terdaftar.', data });
    }
    if (await User.findOne({ enik: enik.trim() })) {
      return res.render('register', { title: 'Daftar', error: 'Nomor enik sudah digunakan.', data });
    }
    const hashed = await bcrypt.hash(password, 12);
    const user = await User.create({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      enik: enik.trim(),
      password: hashed,
      organization: organization?.trim() || 'Inspira Tekno',
      role: 'user'
    });
    req.session.userId = user._id;
    req.user = user;
    await log(req, 'register', 'auth', `Akun baru didaftarkan: ${user.name} (${user.email})`);
    res.redirect('/inbox');
  } catch (err) {
    console.error(err);
    res.render('register', { title: 'Daftar', error: 'Terjadi kesalahan, coba lagi.', data });
  }
});

app.get('/forgot-password', (req, res) => {
  if (req.user) return res.redirect('/inbox');
  res.render('forgot-password', { title: 'Lupa Kata Sandi', error: null, success: null });
});

app.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const user = await User.findOne({ email: email?.toLowerCase()?.trim() });
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      user.resetToken = token;
      user.resetTokenExpiry = Date.now() + 3600000;
      await user.save();
      const resetUrl = `${process.env.APP_URL || 'http://localhost:3005'}/reset-password/${token}`;
      await log(req, 'password_reset_request', 'auth', `Permintaan reset kata sandi untuk: ${user.email}`, { email: user.email });
      if (transporter) {
        const _rss = await SiteSettings.getSettings();
        const _rName = _rss.mailerName || (_rss.siteName + ' ' + _rss.siteSub).trim() || 'Mailer';
        await transporter.sendMail({
          from: `"${_rName}" <${process.env.SMTP_USER}>`,
          to: user.email,
          subject: `Reset Kata Sandi — ${_rName}`,
          html: `<p>Halo ${user.name},</p><p>Klik link berikut untuk mereset kata sandi Anda (berlaku 1 jam):</p><p><a href="${resetUrl}">${resetUrl}</a></p>`
        });
      } else {
        console.log('[Reset URL]', resetUrl);
      }
    }
    res.render('forgot-password', { title: 'Lupa Kata Sandi', error: null, success: 'Jika email terdaftar, link reset kata sandi telah dikirimkan.' });
  } catch (err) {
    console.error(err);
    res.render('forgot-password', { title: 'Lupa Kata Sandi', error: 'Terjadi kesalahan, coba lagi.', success: null });
  }
});

app.get('/reset-password/:token', async (req, res) => {
  try {
    const user = await User.findOne({ resetToken: req.params.token, resetTokenExpiry: { $gt: Date.now() } });
    if (!user) {
      return res.render('reset-password', { title: 'Reset Kata Sandi', error: 'Link tidak valid atau sudah kedaluwarsa.', token: null, success: null });
    }
    res.render('reset-password', { title: 'Reset Kata Sandi', error: null, token: req.params.token, success: null });
  } catch (err) {
    res.render('reset-password', { title: 'Reset Kata Sandi', error: 'Terjadi kesalahan.', token: null, success: null });
  }
});

app.post('/reset-password/:token', async (req, res) => {
  const { password, password2 } = req.body;
  try {
    const user = await User.findOne({ resetToken: req.params.token, resetTokenExpiry: { $gt: Date.now() } });
    if (!user) {
      return res.render('reset-password', { title: 'Reset Kata Sandi', error: 'Link tidak valid atau sudah kedaluwarsa.', token: null, success: null });
    }
    if (password !== password2) {
      return res.render('reset-password', { title: 'Reset Kata Sandi', error: 'Kata sandi tidak cocok.', token: req.params.token, success: null });
    }
    if (password.length < 8) {
      return res.render('reset-password', { title: 'Reset Kata Sandi', error: 'Kata sandi minimal 8 karakter.', token: req.params.token, success: null });
    }
    user.password = await bcrypt.hash(password, 12);
    user.resetToken = undefined;
    user.resetTokenExpiry = undefined;
    await user.save();
    req.user = user;
    await log(req, 'password_reset', 'auth', `Kata sandi berhasil direset untuk: ${user.email}`, { email: user.email });
    res.render('reset-password', { title: 'Reset Kata Sandi', error: null, token: null, success: 'Kata sandi berhasil diubah. Silakan masuk.' });
  } catch (err) {
    res.render('reset-password', { title: 'Reset Kata Sandi', error: 'Terjadi kesalahan.', token: req.params.token, success: null });
  }
});

app.get('/logout', requireAuth, async (req, res) => {
  await log(req, 'logout', 'auth', `${req.user.name} keluar dari sistem`);
  req.session.destroy(() => res.redirect('/login'));
});

// ── MAIN ROUTES ──

app.get('/', requireAuth, (req, res) => res.redirect('/inbox'));

app.get('/inbox', requireAuth, async (req, res) => {
  try {
    const uid = req.user._id.toString();
    const mails = await Email.find({
      status: 'sent',
      deletedBy: { $ne: req.user._id },
      $or: [
        { 'to.userId': req.user._id },
        { 'disposisi.userId': req.user._id },
        { ownerUserId: req.user._id }
      ]
    }).sort({ createdAt: -1 });

    const counts = await getMailCounts(req.user._id);
    const formatted = mails.map(m => {
      const isDisposisi = (m.disposisi || []).some(d => d.userId?.toString() === uid)
        || (m.ownerUserId && m.ownerUserId.toString() === uid && !(m.to || []).some(t => t.userId?.toString() === uid));
      return {
        _id: m._id,
        id: m._id,
        from: m.from.name,
        subject: m.subject,
        date: formatDate(m.createdAt),
        dateISO: m.createdAt ? new Date(m.createdAt).toISOString().slice(0,10) : '',
        tag: m.tag || 'Biasa',
        berkas: m.berkas,
        jenis: m.jenis || 'internal',
        nomorSurat: m.nomorSurat || '-',
        tipeSurat: m.tipeSurat || 'Surat',
        isDisposisi,
        read: m.readBy.some(id => id.toString() === req.user._id.toString())
      };
    });

    res.render('inbox', { mails: formatted, active: 'inbox', title: 'Kotak Masuk', ...counts });
  } catch (err) {
    console.error(err);
    res.render('inbox', { mails: [], active: 'inbox', title: 'Kotak Masuk', inboxCount: 0, draftCount: 0 });
  }
});

app.get('/sent', requireAuth, async (req, res) => {
  try {
    const mails = await Email.find({
      $or: [{ 'from.userId': req.user._id }, { ownerUserId: req.user._id }],
      status: 'sent',
      deletedBy: { $ne: req.user._id }
    }).sort({ createdAt: -1 });

    const counts = await getMailCounts(req.user._id);
    const formatted = mails.map(m => ({
      _id: m._id,
      id: m._id,
      to: m.to.map(t => t.name).join(', ') || (m.toExternal||[]).map(r=>r.name||r.email).join(', ') || '-',
      subject: m.subject,
      date: formatDate(m.createdAt),
      dateISO: m.createdAt ? new Date(m.createdAt).toISOString().slice(0,10) : '',
      tag: m.tag || 'Biasa',
      berkas: m.berkas,
      jenis: m.jenis || 'internal',
      nomorSurat: m.nomorSurat || '-',
      tipeSurat: m.tipeSurat || 'Surat'
    }));

    res.render('sent', { mails: formatted, active: 'sent', title: 'Terkirim', ...counts });
  } catch (err) {
    console.error(err);
    res.render('sent', { mails: [], active: 'sent', title: 'Terkirim', inboxCount: 0, draftCount: 0 });
  }
});

// ── SOFT DELETE INBOX / SENT ──
app.delete('/inbox/:id', requireAuth, async (req, res) => {
  try {
    const email = await Email.findOne({ _id: req.params.id, 'to.userId': req.user._id, status: 'sent' });
    if (!email) return res.json({ ok: false, message: 'Surat tidak ditemukan.' });
    await Email.findByIdAndUpdate(email._id, { $addToSet: { deletedBy: req.user._id } });
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

app.post('/inbox/bulk-delete', requireAuth, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.json({ ok: false });
    await Email.updateMany(
      { _id: { $in: ids }, 'to.userId': req.user._id, status: 'sent' },
      { $addToSet: { deletedBy: req.user._id } }
    );
    res.json({ ok: true, deleted: ids.length });
  } catch (err) { res.json({ ok: false }); }
});

app.delete('/sent/:id', requireAuth, async (req, res) => {
  try {
    const email = await Email.findOne({
      _id: req.params.id,
      $or: [{ 'from.userId': req.user._id }, { ownerUserId: req.user._id }],
      status: 'sent'
    });
    if (!email) return res.json({ ok: false, message: 'Surat tidak ditemukan.' });
    await Email.findByIdAndUpdate(email._id, { $addToSet: { deletedBy: req.user._id } });
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

app.post('/sent/bulk-delete', requireAuth, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.json({ ok: false });
    await Email.updateMany(
      { _id: { $in: ids }, $or: [{ 'from.userId': req.user._id }, { ownerUserId: req.user._id }], status: 'sent' },
      { $addToSet: { deletedBy: req.user._id } }
    );
    res.json({ ok: true, deleted: ids.length });
  } catch (err) { res.json({ ok: false }); }
});

// ── ADMIN MAILBOX MANAGEMENT ──
app.get('/admin/mailbox', requireAuth, requireAdmin, async (req, res) => {
  try {
    const counts = await getMailCounts(req.user._id);
    const users = await User.find({ isActive: true }).sort('name').select('name email role jabatan kodeDir organization avatar').lean();
    const userIds = users.map(u => u._id);

    const [inboxCounts, sentCounts] = await Promise.all([
      Email.aggregate([
        { $match: { 'to.userId': { $in: userIds }, status: 'sent' } },
        { $unwind: '$to' },
        { $match: { 'to.userId': { $in: userIds } } },
        { $group: { _id: '$to.userId', count: { $sum: 1 } } }
      ]),
      Email.aggregate([
        { $match: { 'from.userId': { $in: userIds }, status: 'sent' } },
        { $group: { _id: '$from.userId', count: { $sum: 1 } } }
      ])
    ]);

    const inboxMap = Object.fromEntries(inboxCounts.map(x => [x._id.toString(), x.count]));
    const sentMap  = Object.fromEntries(sentCounts.map(x => [x._id.toString(), x.count]));

    const usersWithCounts = users.map(u => ({
      ...u,
      inboxCount: inboxMap[u._id.toString()] || 0,
      sentCount:  sentMap[u._id.toString()]  || 0,
    }));

    res.render('admin-mailbox', { title: 'Kelola Kotak Surat', active: 'admin', users: usersWithCounts, ...counts });
  } catch (err) { console.error(err); res.redirect('/admin'); }
});

app.get('/admin/mailbox/:userId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const counts = await getMailCounts(req.user._id);
    const targetUser = await User.findById(req.params.userId).select('name email role jabatan kodeDir organization').lean();
    if (!targetUser) return res.redirect('/admin/mailbox');

    const uid = targetUser._id;
    const tab = req.query.tab || 'inbox';

    let mails;
    if (tab === 'sent') {
      mails = await Email.find({ $or: [{ 'from.userId': uid }, { ownerUserId: uid }], status: 'sent' })
        .sort({ createdAt: -1 }).lean();
    } else {
      mails = await Email.find({ 'to.userId': uid, status: 'sent' })
        .sort({ createdAt: -1 }).lean();
    }

    const formatted = mails.map(m => ({
      _id: m._id,
      from: m.from?.name || '—',
      to: (m.to||[]).map(t => t.name).join(', ') || (m.toExternal||[]).map(r=>r.name||r.email).join(', ') || '—',
      subject: m.subject,
      date: formatDate(m.createdAt),
      nomorSurat: m.nomorSurat || '—',
      tipeSurat: m.tipeSurat || 'Surat',
      jenis: m.jenis || 'internal',
      deletedByUser: (m.deletedBy||[]).some(id => id.toString() === uid.toString()),
    }));

    const inboxTotal = await Email.countDocuments({ 'to.userId': uid, status: 'sent' });
    const sentTotal  = await Email.countDocuments({ $or: [{ 'from.userId': uid }, { ownerUserId: uid }], status: 'sent' });

    res.render('admin-mailbox-user', {
      title: `Kotak Surat — ${targetUser.name}`,
      active: 'admin',
      targetUser, mails: formatted, tab,
      inboxTotal, sentTotal,
      ...counts
    });
  } catch (err) { console.error(err); res.redirect('/admin/mailbox'); }
});

app.delete('/admin/mailbox/:userId/email/:emailId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) return res.json({ ok: false, message: 'User tidak ditemukan.' });
    const email = await Email.findById(req.params.emailId);
    if (!email) return res.json({ ok: false, message: 'Surat tidak ditemukan.' });
    await Email.findByIdAndUpdate(email._id, { $addToSet: { deletedBy: targetUser._id } });
    await log(req, 'email_deleted', 'email',
      `Admin ${req.user.name} menghapus surat "${email.subject}" dari kotak ${targetUser.name}`,
      { emailId: email._id, targetUserId: targetUser._id }
    );
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

app.post('/admin/mailbox/:userId/bulk-delete', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.json({ ok: false });
    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) return res.json({ ok: false });
    await Email.updateMany({ _id: { $in: ids } }, { $addToSet: { deletedBy: targetUser._id } });
    await log(req, 'email_deleted', 'email',
      `Admin ${req.user.name} menghapus ${ids.length} surat dari kotak ${targetUser.name}`,
      { count: ids.length, targetUserId: targetUser._id }
    );
    res.json({ ok: true, deleted: ids.length });
  } catch (err) { res.json({ ok: false }); }
});

app.get('/draft', requireAuth, async (req, res) => {
  try {
    const mails = await Email.find({
      'from.userId': req.user._id,
      status: 'draft',
      deletedBy: { $ne: req.user._id }
    }).sort({ createdAt: -1 });

    const counts = await getMailCounts(req.user._id);
    res.render('draft', { mails, active: 'draft', title: 'Draf', formatDate, ...counts });
  } catch (err) {
    console.error(err);
    res.render('draft', { mails: [], active: 'draft', title: 'Draf', formatDate, inboxCount: 0, draftCount: 0 });
  }
});

// Edit draft — buka compose form dengan data yang sudah ada
app.get('/draft/:id/edit', requireAuth, async (req, res) => {
  try {
    const email = await Email.findById(req.params.id);
    if (!email || !canEditDoc(email, req.user._id))
      return res.redirect('/draft');
    const users  = await User.find({ _id: { $ne: req.user._id }, isActive: true }).select('name email organization enik jabatan kodeDir').sort('name');
    const counts = await getMailCounts(req.user._id);
    const allowedKodeDir = getAllowedKodeDir(req.user);
    const allowedSifat   = getAllowedSifat(req.user);
    res.render('draft-edit', { active: 'draft', title: 'Edit Draf', email, users, formatDate, allowedKodeDir, allowedSifat, ...counts });
  } catch (err) {
    console.error(err);
    res.redirect('/draft');
  }
});

// Update draft content
app.post('/draft/:id/update', requireAuth, lampiranUpload.array('lampiran', 10), async (req, res) => {
  try {
    const { to, cc, subject, body, tag, berkas, sifat, jenis, externalRecipients,
            kodeDiv, kodeLay, kodeDir, pengirimResmi, sumberTemplate, action, hapusLampiran, suratData } = req.body;
    const email = await Email.findById(req.params.id);
    if (!email || !canEditDoc(email, req.user._id))
      return res.json({ ok: false });
    if (email.isLocked) return res.json({ ok: false, message: 'Dokumen terkunci karena sudah ditandatangani.' });

    // Validasi hierarki kodeDir & sifat
    const allowedKDir2 = getAllowedKodeDir(req.user);
    const submittedKd2 = kodeDir || kodeDiv || email.kodeDir || 'DIR';
    if (!allowedKDir2.includes(submittedKd2)) return res.redirect(`/draft/${req.params.id}/edit?error=kodeDir`);
    const allowedSft2 = getAllowedSifat(req.user);
    if (sifat && !allowedSft2.includes(sifat)) return res.redirect(`/draft/${req.params.id}/edit?error=sifat`);

    const toIds = [].concat(to || []).filter(Boolean);
    const ccIds = [].concat(cc || []).filter(Boolean);
    const [toUsers, ccUsers] = await Promise.all([
      User.find({ _id: { $in: toIds } }).select('name email'),
      User.find({ _id: { $in: ccIds } }).select('name email')
    ]);
    let extRecipients = [];
    try { extRecipients = JSON.parse(externalRecipients || '[]'); } catch {}
    let parsedSuratData = email.suratData || {};
    if (suratData !== undefined) { try { parsedSuratData = JSON.parse(suratData || '{}'); } catch {} }

    const ROMAN_M = ['','I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];
    const seqPart = (email.nomorSurat || '').split('/')[0] || '001';
    const datePart = email.createdAt || new Date();
    const kd = kodeDir || kodeDiv || email.kodeDir || email.kodeDiv || 'DIR';
    const tipe = email.tipeSurat || 'Nota Dinas';
    const nomorSurat = buildNomorSurat(parseInt(seqPart), tipe, kd, jenis || email.jenis || 'internal',
      ROMAN_M[datePart.getMonth()+1], datePart.getFullYear());

    // Tentukan lampiran: file baru (bisa >1), hapus, atau tetap
    let lampiranUpdate = {};
    if (req.files && req.files.length) {
      lampiranUpdate = {
        lampiran: '/uploads/' + req.files[0].filename,
        lampiranNama: req.files[0].originalname,
        lampiranList: req.files.map(f => ({ path: '/uploads/' + f.filename, nama: f.originalname }))
      };
    } else if (hapusLampiran === '1') {
      lampiranUpdate = { lampiran: '', lampiranNama: '', lampiranList: [] };
    }

    await Email.findByIdAndUpdate(email._id, {
      to:             toUsers.map(u => ({ userId: u._id, name: u.name, email: u.email })),
      cc:             ccUsers.map(u => ({ userId: u._id, name: u.name, email: u.email })),
      toExternal:     jenis === 'eksternal' ? extRecipients : [],
      subject:        subject?.trim() || '(Tanpa Subjek)',
      body:           body || '',
      tag:            tag || 'Normal',
      berkas:         berkas?.trim() || '',
      sifat:          sifat || 'Biasa/Terbuka',
      jenis:          jenis || 'internal',
      kodeDiv:        kodeDiv || email.kodeDiv || 'OPS',
      kodeLay:        kodeLay || email.kodeLay || 'INT',
      kodeDir:        kd,
      pengirimResmi:  pengirimResmi?.trim() || email.pengirimResmi || '',
      sumberTemplate: sumberTemplate || email.sumberTemplate || 'internal',
      suratData:      parsedSuratData,
      nomorSurat,
      ...lampiranUpdate
    });

    // Update ownerUserId dan from jika pengirimResmi berubah
    const updatedResmi = (pengirimResmi?.trim() || email.pengirimResmi || '').toLowerCase();
    if (updatedResmi && updatedResmi !== req.user.name.toLowerCase()) {
      const ownerUser = await User.findOne({
        name: { $regex: `^${(pengirimResmi?.trim() || email.pengirimResmi).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
        isActive: true
      }).select('_id name email').lean();
      if (ownerUser) {
        await Email.findByIdAndUpdate(email._id, {
          ownerUserId: ownerUser._id,
          builtBy: { userId: req.user._id, name: req.user.name },
          from: { userId: ownerUser._id, name: ownerUser.name, email: ownerUser.email }
        });
      }
    } else if (!updatedResmi || updatedResmi === req.user.name.toLowerCase()) {
      await Email.findByIdAndUpdate(email._id, {
        ownerUserId: null, builtBy: null,
        from: { userId: req.user._id, name: req.user.name, email: req.user.email }
      });
    }
    if (action === 'draft') {
      res.redirect('/compose');
    } else {
      res.redirect(`/email/${email._id}/preview`);
    }
  } catch (err) {
    console.error(err);
    res.redirect('/compose');
  }
});

// Delete single draft
app.delete('/draft/:id', requireAuth, async (req, res) => {
  try {
    const email = await Email.findById(req.params.id);
    if (!email || email.from.userId?.toString() !== req.user._id.toString())
      return res.json({ ok: false });
    await Email.findByIdAndDelete(email._id);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// Bulk delete drafts
app.post('/draft/bulk-delete', requireAuth, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.json({ ok: false });
    await Email.deleteMany({
      _id: { $in: ids },
      'from.userId': req.user._id,
      status: 'draft'
    });
    res.json({ ok: true, deleted: ids.length });
  } catch (err) {
    res.json({ ok: false });
  }
});

// Kode divisi & kode direksi per spesifikasi
const KODE_DIR_MAP = {
  'KOM':'KOM',
  // Kode direksi (untuk SK)
  'CEO':'CEO','CTO':'CTO','CMO':'CMO','COO':'COO',
  // Kode divisi (untuk surat internal)
  'PLAN':'PLAN','TECH':'TECH','MP':'MP'
};
// Hierarki akses kodeDir berdasarkan role & kodeDir user
function getAllowedKodeDir(user) {
  const all = (_kdCodes && _kdCodes.length) ? _kdCodes : ['KOM','CEO','CTO','CMO','COO','PLAN','TECH','MP'];
  if (['admin','superadmin','direktur'].includes(user.role)) return all;
  // role user: hanya kodeDir yang ditugaskan, fallback ke semua divisi yang tersedia
  if (user.kodeDir) return [user.kodeDir];
  const divisi = (_kdCache.data || []).filter(d => d.group === 'divisi').map(d => d.kode);
  return divisi.length ? divisi : ['PLAN','TECH','MP'];
}
// Sifat surat yang diizinkan per role
function getAllowedSifat(user) {
  if (['superadmin','admin','direktur'].includes(user.role)) return ['Biasa/Terbuka','Segera','Terbatas','Rahasia'];
  return ['Biasa/Terbuka','Segera'];
}
// Dokumen khusus → nomor pakai kode tipe langsung
const TIPE_KHUSUS = ['MoU','MoA','Contract','IA','PKS','SPK','SK','Surat Keputusan'];

// Kode resmi per jenis dokumen (sesuai pedoman tata naskah)
const TIPE_TO_CODE = {
  'SK':'SK', 'Surat Keputusan':'SK',
  'MoU':'MOU', 'MoA':'MOA', 'Contract':'CONTRACT',
  'IA':'IA', 'PKS':'PKS', 'SPK':'SPK',
};

const TIPE_COUNTER_KEY = {
  'Nota Dinas':          'ND',
  'Surat Eksternal':     'SU',
  'Surat':               'SU',
  'Surat Umum':          'SU',
  'SK':                  'SK',
  'Surat Keputusan':     'SK',
  'Risalah Rapat':       'RR',
  'Berita Acara':        'BA',
  'Surat Undangan':      'UND',
  'Surat Tugas':         'ST',
  'Surat Kuasa':         'SKU',
  'MoU':                 'MOU',
  'MoA':                 'MOA',
  'Contract':            'CONTRACT',
  'IA':                  'IA',
  'PKS':                 'PKS',
  'SPK':                 'SPK',
  'NDA':                 'NDA',
  'SOP':                 'SOP',
  'Pedoman':             'PED',
  'Kebijakan':           'KEB',
  'Laporan':             'LAP',
  'Proposal':            'PROP',
  'Invoice':             'INV',
  'Quotation':           'QTN',
};
function getTipeCounterKey(tipeSurat) {
  return TIPE_COUNTER_KEY[tipeSurat] || 'SU';
}

function buildNomorSurat(seq, tipeSurat, kodeDir, jenis, roman, year) {
  const s = String(seq).padStart(3,'0');
  // Format SK: 001/SK/{kodeDir}/NIT/{bulan}/{tahun}
  if (tipeSurat === 'SK' || tipeSurat === 'Surat Keputusan') {
    const kd = KODE_DIR_MAP[kodeDir] || kodeDir || 'CEO';
    return `${s}/SK/${kd}/NIT/${roman}/${year}`;
  }
  // Format MoU/PKS/dll: 001/MOU/NIT/{bulan}/{tahun}
  if (TIPE_KHUSUS.includes(tipeSurat)) {
    const tCode = TIPE_TO_CODE[tipeSurat] || tipeSurat.toUpperCase();
    return `${s}/${tCode}/NIT/${roman}/${year}`;
  }
  // Format internal: 001/{kodeDiv}/NIT/{bulan}/{tahun}
  const kd = KODE_DIR_MAP[kodeDir] || kodeDir || 'PLAN';
  return `${s}/${kd}/NIT/${roman}/${year}`;
}

// Manajemen Dokumen — Overview
app.get('/compose', requireAuth, requireAdmin, async (req, res) => {
  try {
    const counts = await getMailCounts(req.user._id);
    const { q, tipe, status } = req.query;
    const userId = req.user._id;

    // Query dokumen milik user — sebagai pembuat ATAU sebagai pemilik (dibuatkan admin)
    const ownerClause = { $or: [{ 'from.userId': userId }, { ownerUserId: userId }] };
    const conditions = [ownerClause];
    if (tipe === 'khusus') conditions.push({ tipeSurat: { $in: TIPE_KHUSUS } });
    else if (tipe)         conditions.push({ tipeSurat: tipe });
    if (status)            conditions.push({ status });
    if (q)                 conditions.push({ $or: [
      { subject:    { $regex: q, $options: 'i' } },
      { nomorSurat: { $regex: q, $options: 'i' } },
      { tipeSurat:  { $regex: q, $options: 'i' } }
    ]});
    const filter = conditions.length === 1 ? conditions[0] : { $and: conditions };

    const base = ownerClause;
    const [docs, totalAll, totalDraft, totalSent, tabNota, tabSurat, tabKhusus] = await Promise.all([
      Email.find(filter).sort({ createdAt: -1 }).limit(100).lean(),
      Email.countDocuments(base),
      Email.countDocuments({ $and: [base, { status: 'draft' }] }),
      Email.countDocuments({ $and: [base, { status: 'sent'  }] }),
      Email.countDocuments({ $and: [base, { tipeSurat: 'Nota Dinas' }] }),
      Email.countDocuments({ $and: [base, { tipeSurat: 'Surat Eksternal' }] }),
      Email.countDocuments({ $and: [base, { tipeSurat: { $in: TIPE_KHUSUS } }] }),
    ]);

    res.render('dokumen-overview', {
      active: 'compose', title: 'Manajemen Dokumen',
      docs, totalAll, totalDraft, totalSent,
      tabNota, tabSurat, tabKhusus,
      q: q||'', tipe: tipe||'', status: status||'',
      formatDate, TIPE_KHUSUS, ...counts
    });
  } catch (err) {
    console.error(err);
    res.redirect('/inbox');
  }
});

// Manajemen Dokumen — Hapus surat (pemilik / admin)
app.post('/compose/:id/delete', requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = req.user._id;
    const email = await Email.findById(req.params.id);
    if (!email) return res.json({ ok: false, message: 'Surat tidak ditemukan.' });
    // Hanya pembuat / pemilik (atau superadmin) yang boleh menghapus
    const isOwner = String(email.from?.userId) === String(userId) || String(email.ownerUserId) === String(userId);
    if (!isOwner && req.user.role !== 'superadmin') {
      return res.json({ ok: false, message: 'Anda tidak berhak menghapus surat ini.' });
    }
    await Email.deleteOne({ _id: email._id });
    await log(req, 'email_deleted', 'email',
      `${req.user.name} menghapus surat No. ${email.nomorSurat || '-'} — "${email.subject}"`,
      { emailId: email._id, nomorSurat: email.nomorSurat, subject: email.subject }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, message: 'Terjadi kesalahan saat menghapus.' });
  }
});

// Roster Dokumen — dokumen bertanda tangan, dikelompokkan per jenis
app.get('/roster-dokumen', requireAuth, async (req, res) => {
  try {
    const counts = await getMailCounts(req.user._id);
    const uid = req.user._id;

    // Ambil semua email yang ter-lock (sudah ditandatangani) dan user terlibat
    const docs = await Email.find({
      isLocked: true,
      status: 'sent',
      $or: [
        { 'from.userId': uid },
        { 'to.userId': uid },
        { 'cc.userId': uid },
        { 'disposisi.userId': uid }
      ]
    }).sort({ createdAt: -1 }).lean();

    // Kelompokkan per tipeSurat
    const grouped = {};
    for (const doc of docs) {
      const tipe = doc.tipeSurat || 'Lainnya';
      if (!grouped[tipe]) grouped[tipe] = [];
      grouped[tipe].push(doc);
    }

    res.render('roster-dokumen', {
      active: 'roster-dokumen', title: 'Roster Dokumen',
      grouped, formatDate, ...counts
    });
  } catch (err) { console.error(err); res.redirect('/inbox'); }
});

// Dokumen Tersimpan dihapus — sekarang muncul di Kotak Masuk dengan tanda "Disposisi"
app.get('/dokumen-tersimpan', requireAuth, (req, res) => res.redirect('/inbox'));

// Manajemen Dokumen — Form buat dokumen baru
app.get('/compose/new', requireAuth, async (req, res) => {
  try {
    const counts = await getMailCounts(req.user._id);
    const kodeDireksiList = await getKodeDireksiCached();
    const allowedKodeDir = getAllowedKodeDir(req.user);
    const allowedSifat   = getAllowedSifat(req.user);

    let pengirimUsers = [];
    if (['admin','superadmin'].includes(req.user.role)) {
      // Admin bisa pilih semua user (direktur, komisaris, siapapun)
      pengirimUsers = await User.find({ isActive: true }).select('name email enik jabatan kodeDir role').sort('name').lean();
    } else if (req.user.role === 'direktur') {
      // Direktur hanya bisa atas nama diri sendiri — picker dikosongkan
      pengirimUsers = [];
    } else {
      // User biasa: hanya pilih dari sesama direktorat (kodeDir sama)
      const kd = req.user.kodeDir;
      pengirimUsers = kd
        ? await User.find({ kodeDir: kd, isActive: true }).select('name email enik jabatan kodeDir role').sort('name').lean()
        : [];
    }

    const allUsers = await User.find({ _id: { $ne: req.user._id }, isActive: true }).select('name email organization enik jabatan kodeDir').sort('name').lean();
    res.render('compose', { active: 'compose', title: 'Buat Dokumen Baru', users: allUsers, pengirimUsers, allowedKodeDir, allowedSifat, kodeDireksiList, jenisDefault: null, hideJenisTabs: false, ...counts });
  } catch (err) {
    res.render('compose', { active: 'compose', title: 'Buat Dokumen Baru', users: [], pengirimUsers: [], allowedKodeDir: ['PLAN','TECH','MP'], allowedSifat: ['Biasa/Terbuka','Segera'], jenisDefault: null, hideJenisTabs: false, inboxCount: 0, draftCount: 0 });
  }
});

app.post('/compose', requireAuth, lampiranUpload.array('lampiran', 10), async (req, res) => {
  const { to, cc, subject, body, tag, berkas, action, sifat, jenis, externalRecipients,
          tipeSurat, suratData, kodeDiv, kodeLay, sumberTemplate, pengirimResmi, kodeDir } = req.body;
  try {
    // Dokumen khusus hanya untuk direktur+admin
    if (TIPE_KHUSUS.includes(tipeSurat) && !['superadmin','admin','direktur'].includes(req.user.role)) {
      return res.redirect('/compose?error=access');
    }
    // Validasi kodeDir sesuai hierarki role
    const allowedKDir = getAllowedKodeDir(req.user);
    const submittedKodeDir = kodeDir || kodeDiv || 'DIR';
    if (!allowedKDir.includes(submittedKodeDir)) {
      return res.redirect('/compose/new?error=kodeDir');
    }
    // Validasi sifat sesuai role
    const allowedSft = getAllowedSifat(req.user);
    if (sifat && !allowedSft.includes(sifat)) {
      return res.redirect('/compose/new?error=sifat');
    }

    const toIds = [].concat(to || []).filter(Boolean);
    const ccIds = [].concat(cc || []).filter(Boolean);
    const [toUsers, ccUsers] = await Promise.all([
      User.find({ _id: { $in: toIds } }).select('name email'),
      User.find({ _id: { $in: ccIds } }).select('name email')
    ]);

    let extRecipients = [];
    try { extRecipients = JSON.parse(externalRecipients || '[]'); } catch {}

    let parsedSuratData = {};
    try { parsedSuratData = JSON.parse(suratData || '{}'); } catch {}

    const now  = new Date();
    const year = now.getFullYear();
    const ROMAN_M = ['','I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];
    const tipe = tipeSurat || 'Nota Dinas';
    const seq  = await DocCounter.nextSeq(getTipeCounterKey(tipe), year);
    const nomorSurat = buildNomorSurat(seq, tipe, kodeDir || kodeDiv || 'DIR', jenis || 'internal', ROMAN_M[now.getMonth()+1], year);

    const isDraft = action === 'draft';

    // Cari owner: jika pengirimResmi berbeda dengan pembuat, cari user yang namanya cocok
    const resmiName = pengirimResmi?.trim() || req.user.name;
    let ownerUserId = null;
    let builtBy = null;
    if (resmiName && resmiName.toLowerCase() !== req.user.name.toLowerCase()) {
      const ownerUser = await User.findOne({
        name: { $regex: `^${resmiName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
        isActive: true
      }).select('_id name').lean();
      if (ownerUser) {
        ownerUserId = ownerUser._id;
        builtBy = { userId: req.user._id, name: req.user.name };
      }
    }

    // Jika dibuatkan untuk user lain, from menggunakan info pemilik
    let ownerUser2 = null;
    if (ownerUserId) ownerUser2 = await User.findById(ownerUserId).select('_id name email').lean();
    const fromInfo = ownerUser2
      ? { userId: ownerUser2._id, name: ownerUser2.name, email: ownerUser2.email }
      : { userId: req.user._id, name: req.user.name, email: req.user.email };

    const email = await Email.create({
      from:           fromInfo,
      to:             toUsers.map(u => ({ userId: u._id, name: u.name, email: u.email })),
      cc:             ccUsers.map(u => ({ userId: u._id, name: u.name, email: u.email })),
      toExternal:     jenis === 'eksternal' ? extRecipients : [],
      subject:        subject?.trim() || '(Tanpa Subjek)',
      body:           body || '',
      tag:            tag || 'Normal',
      berkas:         berkas?.trim() || '',
      sifat:          sifat || 'Biasa/Terbuka',
      jenis:          jenis || 'internal',
      tipeSurat:      tipe,
      sumberTemplate: sumberTemplate || 'internal',
      pengirimResmi:  resmiName,
      kodeDir:        kodeDir || kodeDiv || 'DIR',
      kodeDiv:        kodeDiv || 'OPS',
      kodeLay:        kodeLay || 'INT',
      suratData:      parsedSuratData,
      nomorSurat,
      lampiran:       (req.files && req.files[0]) ? '/uploads/' + req.files[0].filename : '',
      lampiranNama:   (req.files && req.files[0]) ? req.files[0].originalname : '',
      lampiranList:   (req.files || []).map(f => ({ path: '/uploads/' + f.filename, nama: f.originalname })),
      status:         'draft',
      ownerUserId,
      builtBy
    });

    await log(req, 'email_draft', 'email', `Surat dibuat: "${email.subject}"`, { emailId: email._id });

    if (isDraft) {
      res.redirect('/compose');          // kembali ke overview → draf terlihat
    } else {
      res.redirect(`/email/${email._id}/preview`);
    }
  } catch (err) {
    console.error(err);
    res.redirect('/compose/new');
  }
});

// ── EMAIL PREVIEW + SIGN + SEND ──

app.get('/email/:id/preview', requireAuth, async (req, res) => {
  try {
    const email = await Email.findById(req.params.id);
    if (!email) return res.redirect('/inbox');
    const uid = req.user._id.toString();
    const isSender = email.from.userId?.toString() === uid;
    const isOwner  = email.ownerUserId?.toString() === uid;
    const isReceiver = email.to.some(t => t.userId?.toString() === uid)
                    || email.cc.some(t => t.userId?.toString() === uid);
    const isPrivileged = ['superadmin','admin','direktur'].includes(req.user.role);
    const isDisposisi  = email.disposisi?.some(d => d.userId?.toString() === uid);

    // Izinkan juga co-signer yang diundang
    const docSig = await DocumentSignature.findOne({ emailId: email._id });
    const isPendingCosigner = docSig?.signers.some(
      s => s.userId.toString() === uid && s.status === 'pending'
    );

    if (!isSender && !isOwner && !isReceiver && !isPrivileged && !isDisposisi && !isPendingCosigner) {
      return res.redirect('/inbox');
    }

    const [users, counts] = await Promise.all([
      User.find({ isActive: true }, 'name email role organization jabatan kodeDir _id').sort({ name: 1 }),
      getMailCounts(req.user._id)
    ]);
    res.render('email-preview', {
      title: 'Preview & Tanda Tangan', email,
      docSig: docSig || { signers: [] },
      isSender, isOwner, isPendingCosigner,
      currentUser: req.user, users, formatDate, ...counts
    });
  } catch (err) { console.error(err); res.redirect('/inbox'); }
});

// Download PDF — render server-side (Puppeteer) supaya hasilnya identik dengan preview
app.get('/email/:id/pdf', requireAuth, async (req, res) => {
  try {
    const email = await Email.findById(req.params.id);
    if (!email) return res.status(404).send('Surat tidak ditemukan');
    const uid = req.user._id.toString();
    const isSender = email.from.userId?.toString() === uid;
    const isOwner  = email.ownerUserId?.toString() === uid;
    const isReceiver = email.to.some(t => t.userId?.toString() === uid)
                    || email.cc.some(t => t.userId?.toString() === uid);
    const isPrivileged = ['superadmin','admin','direktur'].includes(req.user.role);
    const isDisposisi  = email.disposisi?.some(d => d.userId?.toString() === uid);

    const docSig = await DocumentSignature.findOne({ emailId: email._id });
    const isPendingCosigner = docSig?.signers.some(
      s => s.userId.toString() === uid && s.status === 'pending'
    );
    if (!isSender && !isOwner && !isReceiver && !isPrivileged && !isDisposisi && !isPendingCosigner) {
      return res.status(403).send('Tidak punya akses');
    }

    const [users, counts] = await Promise.all([
      User.find({ isActive: true }, 'name email role organization jabatan kodeDir _id').sort({ name: 1 }),
      getMailCounts(req.user._id)
    ]);

    const baseHref = process.env.APP_URL || `http://localhost:${process.env.PORT || 3005}`;
    const pdf = await renderViewToPdf(app, 'email-preview', {
      title: 'Preview & Tanda Tangan', email,
      docSig: docSig || { signers: [] },
      isSender, isOwner, isPendingCosigner,
      currentUser: req.user, users, formatDate, baseHref, ...counts
    });

    const safe = (email.subject || 'surat').replace(/[^\w\d\-_. ]+/g, '').trim() || 'surat';
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safe}.pdf"`
    });
    res.send(pdf);
  } catch (err) {
    console.error('PDF render error:', err);
    res.status(500).send('Gagal membuat PDF');
  }
});

// Tambah diri sendiri — langsung generate QR
app.post('/email/:id/sign/add-self', requireAuth, async (req, res) => {
  try {
    const email = await Email.findById(req.params.id);
    if (!email) return res.json({ ok: false, message: 'Surat tidak ditemukan.' });

    // Hanya pengirim, owner, pengirimResmi, atau co-signer yang diundang boleh tanda tangan
    const uid = req.user._id.toString();
    const isSender       = email.from.userId?.toString() === uid;
    const isOwner        = email.ownerUserId?.toString() === uid;
    const isPengirimResmi = email.pengirimResmi &&
      email.pengirimResmi.toLowerCase() === req.user.name.toLowerCase();

    let docSig = await DocumentSignature.findOne({ emailId: email._id });
    if (!docSig) {
      if (!isSender && !isOwner && !isPengirimResmi) return res.json({ ok: false, message: 'Anda tidak memiliki akses.' });
      docSig = new DocumentSignature({ emailId: email._id, createdBy: req.user._id, signers: [] });
    }

    const existing = docSig.signers.find(s => s.userId.toString() === uid);
    if (existing && existing.status === 'signed') return res.json({ ok: false, message: 'Anda sudah menandatangani.' });
    if (existing && existing.status === 'pending') {
      // Co-signer menandatangani dirinya sendiri
    } else if (isSender || isOwner || isPengirimResmi) {
      // Pengirim, pemilik, atau pengirimResmi menambah dirinya
    } else {
      return res.json({ ok: false, message: 'Anda tidak diundang sebagai penandatangan.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3005}`;
    const qrDataUrl = await QRCode.toDataURL(`${appUrl}/verify/doc/${token}`, {
      errorCorrectionLevel: 'H', margin: 2, width: 200, color: { dark: '#000000', light: '#ffffff' }
    });

    if (existing) {
      // Update pending → signed
      await DocumentSignature.updateOne(
        { emailId: email._id, 'signers._id': existing._id },
        { $set: { 'signers.$.token': token, 'signers.$.qrDataUrl': qrDataUrl, 'signers.$.status': 'signed', 'signers.$.signedAt': new Date() } }
      );
      await Email.findByIdAndUpdate(email._id, { isLocked: true });
      await docSig.populate('signers');
      const updated = (await DocumentSignature.findOne({ emailId: email._id })).signers.id(existing._id);
      return res.json({ ok: true, signer: updated, action: 'updated' });
    }

    // Pengirim menambah dirinya pertama kali
    const n = docSig.signers.length;
    docSig.signers.push({
      userId: req.user._id, userName: req.user.name,
      userRole: req.user.role || '', userOrg: req.user.organization || '',
      jabatanDisplay: req.user.jabatan || '',
      token, qrDataUrl, status: 'signed', signedAt: new Date(),
      position: { x: 60 + n * 140, y: 640, width: 120, height: 185 }
    });
    await docSig.save();
    await Email.findByIdAndUpdate(email._id, { isLocked: true });
    res.json({ ok: true, signer: docSig.signers[docSig.signers.length - 1], action: 'added' });
  } catch (err) { console.error(err); res.json({ ok: false, message: 'Gagal.' }); }
});

// Undang co-signer — hanya buat entri pending, TANPA QR
app.post('/email/:id/sign/invite-cosigner', requireAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    const email = await Email.findById(req.params.id);
    if (!email) return res.json({ ok: false, message: 'Surat tidak ditemukan.' });
    if (email.from.userId?.toString() !== req.user._id.toString())
      return res.json({ ok: false, message: 'Hanya pengirim yang bisa mengundang co-signer.' });

    const targetUser = await User.findById(userId);
    if (!targetUser) return res.json({ ok: false, message: 'Pengguna tidak ditemukan.' });

    let docSig = await DocumentSignature.findOne({ emailId: email._id });
    if (!docSig) docSig = new DocumentSignature({ emailId: email._id, createdBy: req.user._id, signers: [] });
    if (docSig.signers.some(s => s.userId.toString() === userId.toString()))
      return res.json({ ok: false, message: 'Penandatangan sudah diundang.' });

    const n = docSig.signers.length;
    docSig.signers.push({
      userId: targetUser._id, userName: targetUser.name,
      userRole: targetUser.role || '', userOrg: targetUser.organization || '',
      jabatanDisplay: targetUser.jabatan || '',
      token: '', qrDataUrl: '', status: 'pending',
      position: { x: 60 + n * 140, y: 640, width: 120, height: 185 }
    });
    await docSig.save();
    res.json({ ok: true, signer: docSig.signers[docSig.signers.length - 1] });
  } catch (err) { console.error(err); res.json({ ok: false, message: 'Gagal.' }); }
});

app.post('/email/:id/sign/update-position', requireAuth, async (req, res) => {
  try {
    const { signerId, x, y, width, height, locked } = req.body;
    const set = { 'signers.$.position': { x, y, width, height } };
    if (locked !== undefined) set['signers.$.positionLocked'] = locked;
    await DocumentSignature.updateOne(
      { emailId: req.params.id, 'signers._id': signerId },
      { $set: set }
    );
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

app.post('/email/:id/sign/update-lokasi-tanggal', requireAuth, async (req, res) => {
  try {
    const { signerId, lokasi, tanggal, showDate } = req.body;
    const update = {};
    if (lokasi !== undefined) update['signers.$.lokasiTtd'] = lokasi;
    if (tanggal !== undefined) update['signers.$.tanggalTtd'] = tanggal ? new Date(tanggal) : null;
    if (showDate !== undefined) update['signers.$.showDate'] = showDate;
    await DocumentSignature.updateOne(
      { emailId: req.params.id, 'signers._id': signerId },
      { $set: update }
    );
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

app.post('/email/:id/sign/update-jabatan', requireAuth, async (req, res) => {
  try {
    const { signerId, jabatan } = req.body;
    await DocumentSignature.updateOne(
      { emailId: req.params.id, 'signers._id': signerId },
      { $set: { 'signers.$.jabatanDisplay': jabatan || '' } }
    );
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

app.post('/email/:id/sign/update-display-mode', requireAuth, async (req, res) => {
  try {
    const { signerId, displayMode } = req.body;
    const valid = ['full','name_only','qr_only'];
    if (!valid.includes(displayMode)) return res.json({ ok: false, message: 'Mode tidak valid.' });
    await DocumentSignature.updateOne(
      { emailId: req.params.id, 'signers._id': signerId },
      { $set: { 'signers.$.displayMode': displayMode } }
    );
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

app.post('/surat-masuk/:id/pdf/update-jabatan', requireAuth, async (req, res) => {
  try {
    const { signerId, jabatan } = req.body;
    await DocumentSignature.updateOne(
      { suratId: req.params.id, 'signers._id': signerId },
      { $set: { 'signers.$.jabatanDisplay': jabatan || '' } }
    );
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

app.delete('/email/:id/sign/signers/:signerId', requireAuth, async (req, res) => {
  try {
    const docSig = await DocumentSignature.findOne({ emailId: req.params.id });
    if (!docSig) return res.json({ ok: false });
    const signer = docSig.signers.id(req.params.signerId);
    const wasCurrentUser = signer?.userId?.toString() === req.user._id.toString();
    await DocumentSignature.updateOne({ emailId: req.params.id }, { $pull: { signers: { _id: req.params.signerId } } });
    res.json({ ok: true, wasCurrentUser });
  } catch { res.json({ ok: false }); }
});

app.post('/email/:id/send', requireAuth, async (req, res) => {
  try {
    const email = await Email.findById(req.params.id);
    if (!email) return res.json({ ok: false, message: 'Surat tidak ditemukan.' });
    if (email.from.userId.toString() !== req.user._id.toString()) return res.json({ ok: false });
    if (email.status === 'sent') return res.json({ ok: false, message: 'Surat sudah dikirim.' });

    await Email.findByIdAndUpdate(email._id, { status: 'sent' });

    const allEmails = [
      ...email.to.map(r => r.email), ...email.cc.map(r => r.email),
      ...(email.toExternal||[]).map(r => r.email)
    ].filter(Boolean);

    if (transporter && allEmails.length > 0) {
      const _ss = await SiteSettings.getSettings();
      const mailerName = _ss.mailerName || (_ss.siteName + ' ' + _ss.siteSub).trim() || 'Inspira Mailer';
      const recipientNames = [
        ...email.to.map(r => r.name),
        ...(email.toExternal||[]).map(r => r.name || r.email)
      ].join(', ') || '-';
      const sifatColor = {'Biasa/Terbuka':'#16a34a','Rahasia':'#9333ea','Terbatas':'#d97706','Segera':'#dc2626'}[email.sifat]||'#6b7280';
      const tgl = new Date().toLocaleDateString('id-ID',{day:'numeric',month:'long',year:'numeric'});

      const htmlBody = `<div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;">
        <div style="background:#071840;padding:24px 32px;border-radius:8px 8px 0 0;">
          <div style="color:#fff;font-size:18px;font-weight:700;">${mailerName}</div>
          <div style="color:rgba(255,255,255,.6);font-size:12px;margin-top:2px;">${_ss.siteTagline || 'Sistem Surat Digital'}</div>
        </div>
        <div style="border:1px solid #e2e8f0;border-top:none;padding:32px;border-radius:0 0 8px 8px;background:#fff;">
          <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid #f1f5f9;">
            <span style="background:#f0f5ff;color:#1a56a8;border:1px solid #bfcfed;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:600;margin-right:6px;">${email.jenis === 'internal' ? 'Internal' : 'Eksternal'}</span>
            <span style="background:${sifatColor}20;color:${sifatColor};border:1px solid ${sifatColor}40;padding:3px 12px;border-radius:20px;font-size:12px;font-weight:600;">${email.sifat}</span>
          </div>
          <p style="font-size:12px;color:#94a3b8;margin:0 0 6px;">No. Surat: <strong>${email.nomorSurat}</strong></p>
          <h2 style="font-size:20px;font-weight:700;color:#0f172a;margin:0 0 20px;">${email.subject}</h2>
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px;font-size:13px;">
            <tr><td style="padding:5px 0;color:#94a3b8;width:90px;">Dari</td><td style="padding:5px 0;color:#0f172a;font-weight:500;">${email.from.name} &lt;${email.from.email}&gt;</td></tr>
            <tr><td style="padding:5px 0;color:#94a3b8;">Kepada</td><td style="padding:5px 0;color:#0f172a;">${recipientNames}</td></tr>
            <tr><td style="padding:5px 0;color:#94a3b8;">Tanggal</td><td style="padding:5px 0;color:#0f172a;">${tgl}</td></tr>
            ${email.berkas ? `<tr><td style="padding:5px 0;color:#94a3b8;">Berkas</td><td style="padding:5px 0;color:#0f172a;">${email.berkas}</td></tr>` : ''}
          </table>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px 24px;font-size:14px;line-height:1.8;color:#334155;">
            ${email.body || '<em>Tidak ada isi surat.</em>'}
          </div>
          <p style="font-size:11px;color:#94a3b8;margin-top:24px;padding-top:12px;border-top:1px solid #f1f5f9;">
            Dikirim melalui <strong>${mailerName}</strong> &middot; Nomor: ${email.nomorSurat}
          </p>
        </div></div>`;

      const mailOptions = {
        from: `"${email.from.name} via ${mailerName}" <${process.env.SMTP_USER}>`,
        to: allEmails.join(', '),
        replyTo: email.from.email,
        subject: `[${email.nomorSurat}] ${email.subject}`,
        html: htmlBody
      };
      const attachments = [];

      // Lampiran PDF surat lengkap (berkop + TTD/QR, identik dengan preview)
      try {
        const docSig = await DocumentSignature.findOne({ emailId: email._id });
        const [users, counts] = await Promise.all([
          User.find({ isActive: true }, 'name email role organization jabatan kodeDir _id').sort({ name: 1 }),
          getMailCounts(req.user._id)
        ]);
        const baseHref = process.env.APP_URL || `http://localhost:${process.env.PORT || 3005}`;
        const suratPdf = await renderViewToPdf(app, 'email-preview', {
          title: 'Surat', email,
          docSig: docSig || { signers: [] },
          isSender: false, isOwner: false, isPendingCosigner: false,
          currentUser: req.user, users, formatDate, baseHref, ...counts
        });
        const safe = (email.nomorSurat || email.subject || 'surat').replace(/[^\w\d\-_. ]+/g, '_').trim() || 'surat';
        attachments.push({ filename: `${safe}.pdf`, content: suratPdf, contentType: 'application/pdf' });
      } catch (e) { console.error('Gagal render PDF surat untuk email:', e); }

      // Lampiran tambahan yang diupload
      const lampiranAll = (email.lampiranList && email.lampiranList.length)
        ? email.lampiranList
        : (email.lampiran ? [{ path: email.lampiran, nama: email.lampiranNama }] : []);
      lampiranAll.forEach(l => attachments.push({
        filename: l.nama || path.basename(l.path),
        path: path.join(__dirname, l.path)
      }));

      if (attachments.length) mailOptions.attachments = attachments;
      await transporter.sendMail(mailOptions);
    }

    const toNames = [...email.to.map(r=>r.name),...(email.toExternal||[]).map(r=>r.name||r.email)].join(', ')||'-';
    await log(req, 'email_sent', 'email', `Surat dikirim kepada ${toNames}: "${email.subject}"`, { nomorSurat: email.nomorSurat });
    res.json({ ok: true });
  } catch (err) { console.error(err); res.json({ ok: false, message: 'Gagal mengirim.' }); }
});

// Email detail
app.get('/email/:id', requireAuth, async (req, res) => {
  try {
    const email = await Email.findById(req.params.id);
    if (!email) return res.redirect('/inbox');
    const uid        = req.user._id.toString();
    const isSender   = email.from.userId?.toString() === uid;
    const isOwner    = email.ownerUserId?.toString() === uid;
    const isReceiver = email.to.some(t => t.userId?.toString() === uid)
                    || email.cc.some(t => t.userId?.toString() === uid);
    const isPrivileged = ['superadmin','admin','direktur'].includes(req.user.role);
    const isDisposisi  = email.disposisi?.some(d => d.userId?.toString() === uid);
    if (!isSender && !isOwner && !isReceiver && !isPrivileged && !isDisposisi) return res.redirect('/inbox');
    if (isReceiver && !email.readBy.map(String).includes(String(req.user._id))) {
      await Email.findByIdAndUpdate(email._id, { $addToSet: { readBy: req.user._id } });
    }
    const counts = await getMailCounts(req.user._id);
    const [allUsers, direktorats, docSigCheck] = await Promise.all([
      User.find({ isActive: true }, 'name jabatan kodeDir _id').sort('name').lean(),
      Direktorat.find().sort('kode').lean(),
      DocumentSignature.findOne({ emailId: email._id })
    ]);
    res.render('email-detail', {
      title: email.subject, active: isSender ? 'sent' : 'inbox',
      email, docSig: docSigCheck || { signers: [] },
      isSender, isOwner, currentUser: req.user,
      users: allUsers.filter(u => u._id.toString() !== uid), direktorats,
      formatDate, formatDateTime, ...counts
    });
  } catch (err) { console.error(err); res.redirect('/inbox'); }
});

// Mark email read
app.post('/email/:id/read', requireAuth, async (req, res) => {
  try {
    const email = await Email.findByIdAndUpdate(req.params.id, { $addToSet: { readBy: req.user._id } }, { new: true });
    if (email) {
      await log(req, 'email_read', 'email', `Surat dibaca: "${email.subject}"`, { emailId: email._id, subject: email.subject });
    }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false });
  }
});

// Disposisi email
app.post('/email/:id/disposisi', requireAuth, async (req, res) => {
  try {
    const { disposisi, disposisiCatatan } = req.body;
    const email = await Email.findById(req.params.id);
    if (!email) return res.json({ ok: false, message: 'Surat tidak ditemukan.' });

    const disposisiList = disposisi || [];
    email.disposisi = disposisiList;
    email.disposisiCatatan = disposisiCatatan || '';

    // Tambahkan penerima disposisi ke email.to agar muncul di inbox mereka
    if (disposisiList.length > 0) {
      const userIds = disposisiList.map(d => d.userId).filter(Boolean);
      const users = await User.find({ _id: { $in: userIds } }).select('name email').lean();
      const existingToIds = email.to.map(t => t.userId?.toString());
      for (const u of users) {
        if (!existingToIds.includes(u._id.toString())) {
          email.to.push({ userId: u._id, name: u.name, email: u.email });
        }
      }
    }

    await email.save();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.json({ ok: false }); }
});

// Admin delete email — soft delete, simpan rekam jejak
app.delete('/email/:id/admin-delete', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { konfirmasi } = req.body;
    const email = await Email.findById(req.params.id);
    if (!email) return res.json({ ok: false, message: 'Surat tidak ditemukan.' });
    // Validasi ketik ulang nomor surat
    if (!konfirmasi || konfirmasi.trim() !== (email.nomorSurat || '').trim()) {
      return res.json({ ok: false, message: 'Nomor surat tidak cocok. Hapus dibatalkan.' });
    }
    // Soft delete — isi dihapus, nomor & metadata dipertahankan
    await Email.findByIdAndUpdate(email._id, {
      isDeleted:      true,
      deletedAt:      new Date(),
      deletedByAdmin: req.user._id,
      subject:        `[DIHAPUS] ${email.subject}`,
      body:           '',
      to:             [],
      cc:             [],
      toExternal:     [],
      lampiran:       '',
      lampiranNama:   '',
      suratData:      {}
    });
    await log(req, 'email_deleted', 'email',
      `Admin ${req.user.name} menghapus surat No. ${email.nomorSurat} — "${email.subject}"`,
      { emailId: email._id, nomorSurat: email.nomorSurat, subject: email.subject }
    );
    res.json({ ok: true, nomorSurat: email.nomorSurat });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, message: 'Terjadi kesalahan.' });
  }
});

// ── PROFILE ──

app.get('/profile', requireAuth, async (req, res) => {
  const counts = await getMailCounts(req.user._id);
  res.render('profile', { active: 'profile', title: 'Profil Saya', success: null, error: null, emailSuccess: null, emailError: null, ...counts });
});

app.post('/profile', requireAuth, async (req, res) => {
  const { name, organization, jabatan, phone, bio, enik } = req.body;
  const counts = await getMailCounts(req.user._id);
  try {
    if (!name?.trim()) {
      return res.render('profile', { active: 'profile', title: 'Profil Saya', success: null, error: 'Nama tidak boleh kosong.', ...counts });
    }
    await User.findByIdAndUpdate(req.user._id, {
      enik: enik?.trim() || '',
      name: name.trim(),
      organization: organization?.trim() || 'Inspira Tekno',
      jabatan: jabatan?.trim() || '',
      phone: phone?.trim() || '',
      bio: bio?.trim() || ''
    });
    await log(req, 'profile_update', 'profile', `${req.user.name} memperbarui profil`);
    const updated = await User.findById(req.user._id).select('-password');
    req.user = updated;
    res.locals.user = updated;
    res.render('profile', { active: 'profile', title: 'Profil Saya', success: 'Profil berhasil diperbarui.', error: null, emailSuccess: null, emailError: null, ...counts });
  } catch (err) {
    res.render('profile', { active: 'profile', title: 'Profil Saya', success: null, error: 'Gagal memperbarui profil.', emailSuccess: null, emailError: null, ...counts });
  }
});

app.post('/profile/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const counts = await getMailCounts(req.user._id);
  const fail = async (msg) => {
    await log(req, 'password_change', 'profile', `Gagal mengubah kata sandi: ${msg}`, {}, 'failed');
    res.render('profile', { active: 'profile', title: 'Profil Saya', success: null, error: msg, ...counts });
  };
  try {
    const user = await User.findById(req.user._id);
    if (!(await user.matchPassword(currentPassword))) return fail('Kata sandi lama salah.');
    if (newPassword !== confirmPassword) return fail('Konfirmasi kata sandi tidak cocok.');
    if (newPassword.length < 8) return fail('Kata sandi minimal 8 karakter.');
    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
    await log(req, 'password_change', 'profile', `${req.user.name} berhasil mengubah kata sandi`);
    res.render('profile', { active: 'profile', title: 'Profil Saya', success: 'Kata sandi berhasil diubah.', error: null, ...counts });
  } catch (err) {
    fail('Terjadi kesalahan.');
  }
});

app.post('/profile/email', requireAuth, async (req, res) => {
  const counts = await getMailCounts(req.user._id);
  const fail = (msg) => res.render('profile', {
    active: 'profile', title: 'Profil Saya',
    success: null, error: null, emailError: msg, emailSuccess: null, ...counts
  });
  try {
    const { newEmail, confirmEmail, password } = req.body;
    if (!newEmail?.trim() || !confirmEmail?.trim() || !password)
      return fail('Semua field wajib diisi.');
    if (newEmail.trim().toLowerCase() !== confirmEmail.trim().toLowerCase())
      return fail('Konfirmasi email tidak cocok.');
    const emailLower = newEmail.trim().toLowerCase();
    if (emailLower === req.user.email)
      return fail('Email baru sama dengan email saat ini.');
    const exists = await User.findOne({ email: emailLower, _id: { $ne: req.user._id } });
    if (exists) return fail('Email sudah digunakan akun lain.');
    const user = await User.findById(req.user._id);
    const valid = await user.matchPassword(password);
    if (!valid) return fail('Kata sandi salah.');
    await User.findByIdAndUpdate(req.user._id, { email: emailLower });
    await log(req, 'profile_update', 'profile', `${req.user.name} mengubah email ke ${emailLower}`);
    req.user.email = emailLower;
    res.render('profile', {
      active: 'profile', title: 'Profil Saya',
      success: null, error: null,
      emailSuccess: 'Email berhasil diubah menjadi ' + emailLower,
      emailError: null, ...counts
    });
  } catch (err) {
    console.error(err);
    fail('Gagal mengubah email. Coba lagi.');
  }
});

app.post('/profile/avatar', requireAuth, (req, res) => {
  upload.single('avatar')(req, res, async (err) => {
    const counts = await getMailCounts(req.user._id);
    if (err) {
      return res.render('profile', {
        active: 'profile', title: 'Profil Saya',
        success: null, error: err.message, ...counts
      });
    }
    if (!req.file) return res.redirect('/profile');
    try {
      const base64 = await processAvatar(req.file.buffer);
      await User.findByIdAndUpdate(req.user._id, { avatar: base64 });
      await log(req, 'avatar_update', 'profile', `${req.user.name} memperbarui foto profil`);
    } catch (e) {
      console.error('Avatar processing error:', e.message);
    }
    res.redirect('/profile');
  });
});

// ── SITE SETTINGS ──

app.get('/admin/site-settings', requireAuth, requireAdmin, async (req, res) => {
  try {
    const ss = await SiteSettings.getSettings();
    const counts = await getMailCounts(req.user._id);
    res.render('site-settings', { active: 'admin', title: 'Pengaturan Situs', ss, success: null, error: null, ...counts });
  } catch (err) {
    console.error(err);
    res.redirect('/admin');
  }
});

const ssUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

app.post('/admin/site-settings', requireAuth, requireAdmin, ssUpload.single('logo'), async (req, res) => {
  try {
    const ss = await SiteSettings.getSettings();
    const counts = await getMailCounts(req.user._id);
    const { siteName, siteSub, siteTagline, siteDesc, orgCode, mailerName, smtpHost, smtpPort, smtpUser, smtpPass, sessionTimeoutMinutes } = req.body;

    ss.siteName    = siteName?.trim()    || ss.siteName;
    ss.siteSub     = siteSub?.trim()     || ss.siteSub;
    if (siteTagline !== undefined) ss.siteTagline = siteTagline.trim();
    ss.siteDesc    = siteDesc?.trim()    !== undefined ? siteDesc.trim()    : ss.siteDesc;
    ss.orgCode     = orgCode?.trim()     || ss.orgCode;
    if (mailerName?.trim()) ss.mailerName = mailerName.trim();
    ss.smtpHost = smtpHost?.trim() || ss.smtpHost;
    ss.smtpPort = parseInt(smtpPort) || ss.smtpPort;
    ss.smtpUser = smtpUser?.trim() || ss.smtpUser;
    if (smtpPass?.trim()) ss.smtpPass = smtpPass.trim();
    if (sessionTimeoutMinutes !== undefined) ss.sessionTimeoutMinutes = Math.max(0, parseInt(sessionTimeoutMinutes) || 0);

    if (req.file) {
      const resized = await sharp(req.file.buffer).resize(200, 200, { fit: 'inside' }).png().toBuffer();
      ss.logoBase64 = 'data:image/png;base64,' + resized.toString('base64');
    }

    await ss.save();

    // Update transporter SMTP setelah save
    if (ss.smtpUser && ss.smtpPass) {
      transporter = nodemailer.createTransport({
        host: ss.smtpHost, port: ss.smtpPort,
        auth: { user: ss.smtpUser, pass: ss.smtpPass }
      });
    }

    res.render('site-settings', { active: 'admin', title: 'Pengaturan Situs', ss, success: 'Pengaturan berhasil disimpan.', error: null, ...counts });
  } catch (err) {
    console.error(err);
    const ss = await SiteSettings.getSettings();
    const counts = await getMailCounts(req.user._id);
    res.render('site-settings', { active: 'admin', title: 'Pengaturan Situs', ss, success: null, error: 'Gagal menyimpan.', ...counts });
  }
});

// Patch ownerUserId for existing docs (admin only)
app.post('/admin/patch-owner', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { emailId, ownerName } = req.body;
    if (!emailId || !ownerName) return res.json({ ok: false, message: 'emailId dan ownerName wajib diisi' });
    const ownerUser = await User.findOne({
      name: { $regex: `^${ownerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
      isActive: true
    }).select('_id name').lean();
    if (!ownerUser) return res.json({ ok: false, message: `User "${ownerName}" tidak ditemukan` });
    const email = await Email.findById(emailId);
    if (!email) return res.json({ ok: false, message: 'Dokumen tidak ditemukan' });
    const ownerFull = await User.findById(ownerUser._id).select('_id name email').lean();
    email.ownerUserId = ownerFull._id;
    email.from = { userId: ownerFull._id, name: ownerFull.name, email: ownerFull.email };
    if (!email.builtBy) email.builtBy = { userId: req.user._id, name: req.user.name };
    await email.save();
    res.json({ ok: true, message: `Dokumen diset atas nama ${ownerFull.name}` });
  } catch (err) { res.json({ ok: false, message: err.message }); }
});

// ── ADMIN ──

app.get('/admin', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [totalUsers, totalSent, totalDraft, users, recentLogs, counters, jabatans, direktorats, organisasis] = await Promise.all([
      User.countDocuments(),
      Email.countDocuments({ status: 'sent' }),
      Email.countDocuments({ status: 'draft' }),
      User.find().sort({ createdAt: -1 }).select('-password'),
      ActivityLog.find().sort({ createdAt: -1 }).limit(50).lean(),
      DocCounter.find().sort({ key: 1 }).lean(),
      Jabatan.find().sort('nama').lean(),
      Direktorat.find().sort('kode').lean(),
      Organisasi.find().sort('nama').lean()
    ]);
    const counts = await getMailCounts(req.user._id);

    const logsFormatted = recentLogs.map(l => ({
      ...l,
      dateTime: formatDateTime(l.createdAt)
    }));

    res.render('admin', {
      active: 'admin',
      title: 'Admin Dashboard',
      stats: { totalUsers, totalSent, totalDraft, totalEmails: totalSent + totalDraft },
      users, counters, jabatans, direktorats, organisasis,
      logs: logsFormatted,
      ROLE_LEVEL,
      ...counts
    });
  } catch (err) {
    console.error(err);
    res.redirect('/inbox');
  }
});

// API: get more logs
// Log Penomoran Surat
app.get('/log-penomoran', requireAuth, async (req, res) => {
  try {
    const counts = await getMailCounts(req.user._id);
    const q = req.query.q || '';

    const emailFilter = { nomorSurat: { $exists: true, $ne: '' } };
    const nomorFilter = {};
    if (q) {
      const rx = { $regex: q, $options: 'i' };
      emailFilter.$or = [{ nomorSurat: rx }, { subject: rx }, { tipeSurat: rx }];
      nomorFilter.$or = [{ nomorSurat: rx }, { perihal: rx }, { tipeSurat: rx }];
    }

    const [emailDocs, nomorDocs] = await Promise.all([
      Email.find(emailFilter).sort({ createdAt: -1 }).limit(200).lean(),
      NomorSaja.find(nomorFilter).sort({ createdAt: -1 }).limit(200).lean(),
    ]);

    // Gabungkan dan urutkan berdasarkan createdAt terbaru
    const allDocs = [
      ...emailDocs.map(d => ({
        _id: d._id, source: 'email',
        nomorSurat: d.nomorSurat, tipeSurat: d.tipeSurat || '—',
        perihal: d.subject, pengirim: d.from?.name || '—',
        pengirimResmi: d.pengirimResmi || '',
        status: d.status === 'sent' ? 'Terkirim' : 'Draf',
        isDeleted: false, deletedBy: null, deletedAt: null,
        createdAt: d.createdAt,
      })),
      ...nomorDocs.map(d => ({
        _id: d._id, source: 'nomor-saja',
        nomorSurat: d.nomorSurat, tipeSurat: d.tipeSurat || '—',
        perihal: d.perihal || '—', pengirim: d.createdBy?.name || '—',
        pengirimResmi: '',
        status: d.isDeleted ? 'Dihapus' : 'Generate Nomor',
        isDeleted: d.isDeleted, deletedBy: d.deletedBy, deletedAt: d.deletedAt,
        createdAt: d.createdAt,
      })),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 200);

    res.render('log-penomoran', { active: 'log-penomoran', title: 'Log Penomoran', docs: allDocs, q, formatDate, ...counts });
  } catch (err) {
    console.error(err);
    res.redirect('/inbox');
  }
});

app.get('/admin/logs', requireAuth, requireAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = 50;
    const filter = {};
    if (req.query.action) filter.action = req.query.action;
    if (req.query.category) filter.category = req.query.category;
    if (req.query.userId) filter.userId = req.query.userId;

    const [logs, total] = await Promise.all([
      ActivityLog.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ActivityLog.countDocuments(filter)
    ]);

    res.json({
      ok: true,
      logs: logs.map(l => ({ ...l, dateTime: formatDateTime(l.createdAt) })),
      total,
      pages: Math.ceil(total / limit)
    });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.post('/admin/users/:id/toggle', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      return res.json({ ok: false, message: 'Tidak dapat menonaktifkan diri sendiri.' });
    }
    const target = await User.findById(req.params.id);
    if (!target) return res.json({ ok: false, message: 'Pengguna tidak ditemukan.' });
    target.isActive = !target.isActive;
    await target.save();
    await log(req, 'user_toggled', 'user_management',
      `Admin ${req.user.name} ${target.isActive ? 'mengaktifkan' : 'menonaktifkan'} akun ${target.name} (${target.email})`,
      { targetId: target._id, targetEmail: target.email, isActive: target.isActive }
    );
    res.json({ ok: true, isActive: target.isActive });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.post('/admin/users/:id/role', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    if (!['user', 'direktur', 'admin', 'superadmin'].includes(role)) return res.json({ ok: false, message: 'Role tidak valid.' });
    if (req.params.id === req.user._id.toString()) {
      return res.json({ ok: false, message: 'Tidak dapat mengubah role diri sendiri.' });
    }
    // Hanya superadmin yang boleh assign/ubah role superadmin
    if (role === 'superadmin' && req.user.role !== 'superadmin') {
      return res.json({ ok: false, message: 'Hanya Super Admin yang dapat menetapkan role Super Admin.' });
    }
    const target = await User.findById(req.params.id);
    if (!target) return res.json({ ok: false, message: 'Pengguna tidak ditemukan.' });
    // Admin tidak boleh mengubah role user yang sudah superadmin
    if (target.role === 'superadmin' && req.user.role !== 'superadmin') {
      return res.json({ ok: false, message: 'Hanya Super Admin yang dapat mengubah role Super Admin.' });
    }
    const oldRole = target.role;
    await User.findByIdAndUpdate(req.params.id, { role });
    await log(req, 'user_role_changed', 'user_management',
      `Admin ${req.user.name} mengubah role ${target.name} dari "${oldRole}" menjadi "${role}"`,
      { targetId: target._id, targetEmail: target.email, oldRole, newRole: role }
    );
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.post('/admin/users/:id/enik', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { enik, jabatan, organization, kodeDir } = req.body;
    const target = await User.findById(req.params.id);
    if (!target) return res.json({ ok: false, message: 'Pengguna tidak ditemukan.' });
    await User.findByIdAndUpdate(req.params.id, {
      enik:         enik?.trim() || '',
      jabatan:      jabatan?.trim() || '',
      organization: organization?.trim() || target.organization || '',
      kodeDir:      kodeDir?.trim() || ''
    });
    await log(req, 'user_updated', 'user_management', `Admin ${req.user.name} mengupdate profil ${target.name}`, { targetId: target._id });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.post('/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 8) return res.json({ ok: false, message: 'Kata sandi minimal 8 karakter.' });
    const target = await User.findById(req.params.id);
    if (!target) return res.json({ ok: false, message: 'Pengguna tidak ditemukan.' });
    const hashed = await bcrypt.hash(password, 12);
    await User.findByIdAndUpdate(req.params.id, { password: hashed });
    await log(req, 'password_reset', 'user_management', `Admin ${req.user.name} mereset password ${target.name}`, { targetId: target._id });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.post('/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, email, password, role, organization, jabatan, enik, kodeDir } = req.body;
    if (!name || !email || !password) return res.json({ ok: false, message: 'Nama, email, dan kata sandi wajib diisi.' });
    if (password.length < 8) return res.json({ ok: false, message: 'Kata sandi minimal 8 karakter.' });
    const exists = await User.findOne({ email: email.toLowerCase().trim() });
    if (exists) return res.json({ ok: false, message: 'Email sudah terdaftar.' });
    if (!['user','direktur','admin','superadmin'].includes(role)) return res.json({ ok: false, message: 'Role tidak valid.' });
    const hashed = await bcrypt.hash(password, 12);
    const newUser = await User.create({
      name: name.trim(), email: email.toLowerCase().trim(), password: hashed,
      role: role || 'user', organization: organization?.trim() || 'Inspira Tekno',
      jabatan: jabatan?.trim() || '', enik: enik?.trim() || '',
      kodeDir: kodeDir?.trim() || ''
    });
    await log(req, 'user_created', 'user_management', `Admin ${req.user.name} membuat akun ${newUser.name} (${newUser.email})`, { targetId: newUser._id });
    res.json({ ok: true, user: {
      _id: newUser._id, name: newUser.name, email: newUser.email,
      role: newUser.role, jabatan: newUser.jabatan, organization: newUser.organization,
      enik: newUser.enik, kodeDir: newUser.kodeDir, isActive: true
    }});
  } catch (err) {
    console.error(err);
    res.json({ ok: false, message: 'Gagal membuat pengguna.' });
  }
});

app.delete('/admin/users/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    if (req.params.id === req.user._id.toString()) {
      return res.json({ ok: false, message: 'Tidak dapat menghapus diri sendiri.' });
    }
    const target = await User.findByIdAndDelete(req.params.id);
    if (!target) return res.json({ ok: false, message: 'Pengguna tidak ditemukan.' });
    await log(req, 'user_deleted', 'user_management',
      `Admin ${req.user.name} menghapus akun ${target.name} (${target.email})`,
      { targetEmail: target.email, targetRole: target.role }
    );
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// ── PENOMORAN ROUTES ──
app.get('/admin/counters', requireAuth, requireAdmin, async (req, res) => {
  try {
    const counters = await DocCounter.find().sort({ key: 1 }).lean();
    res.json({ ok: true, counters });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.post('/admin/counters/set', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { key, seq } = req.body;
    if (!key) return res.json({ ok: false, message: 'Key wajib diisi.' });
    const n = parseInt(seq);
    if (isNaN(n) || n < 0) return res.json({ ok: false, message: 'Nomor tidak valid.' });
    const counter = await DocCounter.findOneAndUpdate(
      { key },
      { $set: { seq: n } },
      { upsert: true, new: true }
    );
    await log(req, 'system', 'user_management',
      `Admin ${req.user.name} mengatur counter "${key}" ke ${n}`, { key, seq: n });
    res.json({ ok: true, counter });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.delete('/admin/counters/:key', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    await DocCounter.findOneAndDelete({ key });
    await log(req, 'system', 'user_management',
      `Admin ${req.user.name} menghapus counter "${key}"`, { key });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// ── DIREKTORAT ROUTES ──
app.get('/admin/direktorat', requireAuth, requireAdmin, async (req, res) => {
  try {
    const counts = await getMailCounts(req.user._id);
    const [direktorats, users] = await Promise.all([
      Direktorat.find().sort('kode').lean(),
      User.find({ isActive: true }, 'name jabatan kodeDir').sort('name').lean()
    ]);
    res.render('admin-direktorat', { title: 'Direktorat', active: 'admin', direktorats, users, ...counts });
  } catch (err) { console.error(err); res.redirect('/admin'); }
});

app.post('/admin/direktorat', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { kode, nama } = req.body;
    const existing = await Direktorat.findOne({ kode: kode.toUpperCase() });
    if (existing) return res.json({ ok: false, message: `Kode "${kode}" sudah digunakan.` });
    await Direktorat.create({ kode: kode.toUpperCase(), nama });
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, message: 'Gagal menyimpan.' }); }
});

app.put('/admin/direktorat/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nama } = req.body;
    await Direktorat.findByIdAndUpdate(req.params.id, { nama });
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

app.delete('/admin/direktorat/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await Direktorat.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

// ── KODE DIREKSI ROUTES ──
app.get('/admin/kode-direksi', requireAuth, requireAdmin, async (req, res) => {
  try {
    const counts = await getMailCounts(req.user._id);
    await seedKodeDireksi();
    const kodeList = await KodeDireksi.find().sort('urutan kode').lean();
    res.render('admin-kode-direksi', { title: 'Kode Direksi', active: 'kode-direksi', kodeList, ...counts });
  } catch (err) { console.error(err); res.redirect('/admin'); }
});

app.post('/admin/kode-direksi', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { kode, nama, group, urutan, aktif } = req.body;
    if (!kode || !nama) return res.json({ ok: false, message: 'Kode dan nama wajib diisi.' });
    const existing = await KodeDireksi.findOne({ kode: kode.toUpperCase() });
    if (existing) return res.json({ ok: false, message: `Kode "${kode}" sudah digunakan.` });
    await KodeDireksi.create({
      kode: kode.toUpperCase(), nama: nama.trim(),
      group: group === 'direksi' ? 'direksi' : 'divisi',
      urutan: parseInt(urutan) || 0, aktif: aktif !== false && aktif !== 'false'
    });
    _kdCache = { data: [], ts: 0 };
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, message: 'Gagal menyimpan.' }); }
});

app.put('/admin/kode-direksi/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nama, group, urutan, aktif } = req.body;
    await KodeDireksi.findByIdAndUpdate(req.params.id, {
      nama: (nama || '').trim(),
      group: group === 'direksi' ? 'direksi' : 'divisi',
      urutan: parseInt(urutan) || 0, aktif: aktif !== false && aktif !== 'false'
    });
    _kdCache = { data: [], ts: 0 };
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

app.delete('/admin/kode-direksi/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await KodeDireksi.findByIdAndDelete(req.params.id);
    _kdCache = { data: [], ts: 0 };
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

// ── JABATAN ROUTES ──
app.get('/admin/jabatan', requireAuth, requireAdmin, async (req, res) => {
  try {
    const counts = await getMailCounts(req.user._id);
    const [jabatans, users] = await Promise.all([
      Jabatan.find().sort('nama').lean(),
      User.find({ isActive: true }, 'name jabatan').lean()
    ]);
    res.render('admin-jabatan', { title: 'Jabatan', active: 'jabatan', jabatans, users, ...counts });
  } catch (err) { console.error(err); res.redirect('/admin'); }
});

app.post('/admin/jabatan', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nama } = req.body;
    const existing = await Jabatan.findOne({ nama });
    if (existing) return res.json({ ok: false, message: `Jabatan "${nama}" sudah ada.` });
    await Jabatan.create({ nama });
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

app.put('/admin/jabatan/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await Jabatan.findByIdAndUpdate(req.params.id, { nama: req.body.nama });
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

app.delete('/admin/jabatan/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await Jabatan.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

// ── ORGANISASI ROUTES ──
app.get('/admin/organisasi', requireAuth, requireAdmin, async (req, res) => {
  try {
    const counts = await getMailCounts(req.user._id);
    const [organisasis, users] = await Promise.all([
      Organisasi.find().sort('nama').lean(),
      User.find({ isActive: true }, 'name organization').lean()
    ]);
    res.render('admin-organisasi', { title: 'Organisasi', active: 'organisasi', organisasis, users, ...counts });
  } catch (err) { console.error(err); res.redirect('/admin'); }
});

app.post('/admin/organisasi', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nama } = req.body;
    const existing = await Organisasi.findOne({ nama });
    if (existing) return res.json({ ok: false, message: `Organisasi "${nama}" sudah ada.` });
    await Organisasi.create({ nama });
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

app.put('/admin/organisasi/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await Organisasi.findByIdAndUpdate(req.params.id, { nama: req.body.nama });
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

app.delete('/admin/organisasi/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await Organisasi.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

// ── DIREKTUR ROUTES ──
// Direktur and admin can see all emails (organization-wide view)
app.get('/direktur/overview', requireAuth, requireDirektur, async (req, res) => {
  try {
    const counts = await getMailCounts(req.user._id);
    const [allSent, allDraft, allUsers] = await Promise.all([
      Email.find({ status: 'sent' }).sort({ createdAt: -1 }).limit(20).lean(),
      Email.find({ status: 'draft' }).sort({ createdAt: -1 }).limit(10).lean(),
      User.countDocuments()
    ]);

    const sentFormatted = allSent.map(m => ({
      ...m,
      fromName: m.from?.name || '-',
      toNames: (m.to || []).map(t => t.name).join(', ') || '-',
      date: formatDate(m.createdAt),
      dateISO: m.createdAt ? new Date(m.createdAt).toISOString().slice(0,10) : ''
    }));

    res.render('direktur', {
      active: 'direktur',
      title: 'Ringkasan Organisasi',
      sentMails: sentFormatted,
      draftCount: allDraft.length,
      totalUsers: allUsers,
      ...counts
    });
  } catch (err) {
    console.error(err);
    res.redirect('/inbox');
  }
});

// ── SHORT URL ──

function generateCode(len = 6) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}


app.get('/shorturl', requireAuth, async (req, res) => {
  try {
    const urls = await ShortUrl.find({ userId: req.user._id }).sort({ createdAt: -1 });
    const counts = await getMailCounts(req.user._id);
    res.render('shorturl', { active: 'shorturl', title: 'Short URL', urls, error: null, success: null, ...counts });
  } catch (err) {
    res.render('shorturl', { active: 'shorturl', title: 'Short URL', urls: [], error: null, success: null, inboxCount: 0, draftCount: 0 });
  }
});

app.post('/shorturl', requireAuth, async (req, res) => {
  const { originalUrl, title, customSlug } = req.body;
  const counts = await getMailCounts(req.user._id);
  const fail = async (msg) => {
    const urls = await ShortUrl.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.render('shorturl', { active: 'shorturl', title: 'Short URL', urls, error: msg, success: null, ...counts });
  };
  try {
    if (!originalUrl?.trim()) return fail('URL tidak boleh kosong.');
    let url = originalUrl.trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    // Tolak URL internal PATRA — short URL hanya untuk link eksternal
    const appHost = (process.env.APP_URL || '').replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase();
    const urlHost = url.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    if (appHost && urlHost === appHost) return fail('Short URL hanya dapat dibuat untuk link eksternal, bukan halaman PATRA.');

    let shortCode;
    if (customSlug?.trim()) {
      shortCode = customSlug.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '-');
      if (shortCode.length < 3) return fail('Custom nama minimal 3 karakter.');
      const exists = await ShortUrl.findOne({ shortCode });
      if (exists) return fail(`Nama "${shortCode}" sudah digunakan. Pilih nama lain.`);
    } else {
      let exists = true;
      while (exists) { shortCode = generateCode(6); exists = await ShortUrl.findOne({ shortCode }); }
    }

    await ShortUrl.create({
      userId: req.user._id,
      userName: req.user.name,
      originalUrl: url,
      shortCode,
      title: title?.trim() || url
    });

    await log(req, 'system', 'system', `Short URL dibuat: /inspira/${shortCode} -> ${url}`);
    const urls = await ShortUrl.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.render('shorturl', { active: 'shorturl', title: 'Short URL', urls, error: null, success: `Short URL berhasil dibuat: /s/${shortCode}`, ...counts });
  } catch (err) {
    console.error(err);
    fail('Terjadi kesalahan, coba lagi.');
  }
});

app.delete('/shorturl/:id', requireAuth, async (req, res) => {
  try {
    await ShortUrl.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.post('/shorturl/:id/toggle', requireAuth, async (req, res) => {
  try {
    const su = await ShortUrl.findOne({ _id: req.params.id, userId: req.user._id });
    if (!su) return res.json({ ok: false });
    su.isActive = !su.isActive;
    await su.save();
    res.json({ ok: true, isActive: su.isActive });
  } catch (err) {
    res.json({ ok: false });
  }
});

// ── TUGAS ──

app.get('/panduan', requireAuth, (req, res) => {
  res.redirect('/panduan/print');
});

app.get('/panduan/print', requireAuth, async (req, res) => {
  try {
    const ss = await SiteSettings.getSettings();
    res.render('panduan-print', { ss });
  } catch (err) { console.error(err); res.redirect('/inbox'); }
});

app.get('/panduan/download', requireAuth, (req, res) => {
  res.redirect('/panduan/print');
});

app.get('/tugas', requireAuth, async (req, res) => {
  try {
    const myId = req.user._id;
    const [myTasks, assignedTasks, users] = await Promise.all([
      Task.find({ 'createdBy.userId': myId }).sort({ createdAt: -1 }),
      Task.find({ 'assignedTo.userId': myId, 'createdBy.userId': { $ne: myId } }).sort({ createdAt: -1 }),
      User.find({ _id: { $ne: myId }, isActive: true }).select('name email jabatan kodeDir').sort('name')
    ]);
    const counts = await getMailCounts(myId);
    const MONTHS = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
    const fmt = (d) => d ? `${new Date(d).getDate()} ${MONTHS[new Date(d).getMonth()]} ${new Date(d).getFullYear()}` : null;
    const format = tasks => tasks.map(t => ({ ...t.toObject(), dueDateFmt: fmt(t.dueDate) }));
    res.render('tugas', {
      active: 'tugas', title: 'Tugas',
      myTasks: format(myTasks),
      assignedTasks: format(assignedTasks),
      users,
      ...counts
    });
  } catch (err) {
    console.error(err);
    res.render('tugas', { active: 'tugas', title: 'Tugas', myTasks: [], assignedTasks: [], users: [], inboxCount: 0, draftCount: 0 });
  }
});

app.post('/tugas', requireAuth, async (req, res) => {
  const { title, description, priority, dueDate, assignedTo, pemberiTugas, pemberiTugasCustom } = req.body;
  try {
    const toIds = [].concat(assignedTo || []).filter(Boolean);
    const assignedUsers = await User.find({ _id: { $in: toIds } }).select('name email');
    const pemberi = pemberiTugas === 'lainnya' ? (pemberiTugasCustom?.trim() || '') : (pemberiTugas?.trim() || '');
    const task = await Task.create({
      createdBy: { userId: req.user._id, name: req.user.name, email: req.user.email },
      assignedTo: assignedUsers.map(u => ({ userId: u._id, name: u.name, email: u.email })),
      pemberiTugas: pemberi,
      title: title?.trim(),
      description: description?.trim() || '',
      priority: priority || 'normal',
      dueDate: dueDate ? new Date(dueDate) : null
    });
    await log(req, 'system', 'system', `Tugas dibuat: "${task.title}"`, { taskId: task._id });
    res.redirect('/tugas');
  } catch (err) {
    console.error(err);
    res.redirect('/tugas');
  }
});

app.post('/tugas/:id/status', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['pending', 'dikerjakan', 'selesai', 'dibatalkan'];
    if (!valid.includes(status)) return res.json({ ok: false });
    const task = await Task.findOne({
      _id: req.params.id,
      $or: [{ 'createdBy.userId': req.user._id }, { 'assignedTo.userId': req.user._id }]
    });
    if (!task) return res.json({ ok: false, message: 'Tugas tidak ditemukan.' });
    task.status = status;
    if (status === 'selesai') task.completedAt = new Date();
    await task.save();
    res.json({ ok: true, status });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.delete('/tugas/:id', requireAuth, async (req, res) => {
  try {
    const task = await Task.findOneAndDelete({ _id: req.params.id, 'createdBy.userId': req.user._id });
    if (!task) return res.json({ ok: false, message: 'Hanya pembuat yang bisa menghapus tugas.' });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// ── DIGSIG ──

app.get('/digsig', requireAuth, async (req, res) => {
  try {
    const sig = await Signature.findOne({ userId: req.user._id });
    const counts = await getMailCounts(req.user._id);
    res.render('digsig', { active: 'digsig', title: 'Tanda Tangan Digital', sig, success: null, ...counts });
  } catch (err) {
    res.render('digsig', { active: 'digsig', title: 'Tanda Tangan Digital', sig: null, success: null, inboxCount: 0, draftCount: 0 });
  }
});

// Generate new QR — every call invalidates the old one
app.post('/digsig/generate', requireAuth, async (req, res) => {
  try {
    const { fullName, position, organization, locationLabel, lat, lng } = req.body;
    if (!fullName?.trim()) return res.json({ ok: false, message: 'Nama lengkap wajib diisi.' });

    // New unique token every time — old QR instantly invalid
    const token = crypto.randomBytes(32).toString('hex');
    const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3005}`;
    const verifyUrl = `${appUrl}/verify/${token}`;

    const qrCodeDataUrl = await QRCode.toDataURL(verifyUrl, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 320,
      color: { dark: '#000000', light: '#ffffff' }
    });

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
              || req.socket?.remoteAddress || '';

    await Signature.findOneAndUpdate(
      { userId: req.user._id },
      {
        $set: {
          userId: req.user._id,
          fullName: fullName.trim(),
          position: position?.trim() || '',
          organization: organization?.trim() || req.user.organization || '',
          verifyToken: token,
          qrCodeDataUrl,
          signedAt: new Date(),
          imageData: null,
          imagePath: null,
          location: {
            label: locationLabel?.trim() || '',
            lat:   lat  ? parseFloat(lat)  : null,
            lng:   lng  ? parseFloat(lng)  : null,
            ipAddress: ip
          }
        }
      },
      { upsert: true, new: true }
    );

    await log(req, 'system', 'profile',
      `${req.user.name} membuat QR tanda tangan digital baru`,
      { token: token.slice(0, 8) + '...' }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, message: 'Gagal membuat QR Code.' });
  }
});

app.delete('/digsig', requireAuth, async (req, res) => {
  try {
    await Signature.findOneAndDelete({ userId: req.user._id });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// ── VERIFY (public) ──

app.get('/verify/esign/:token', async (req, res) => {
  try {
    const session = await ESignSession.findOne({ 'signers.token': req.params.token });
    if (!session) return res.render('verify-esign', { valid: false, signer: null, session: null, scanTime: new Date() });
    const signer = session.signers.find(s => s.token === req.params.token);
    res.render('verify-esign', { valid: true, signer, session, scanTime: new Date() });
  } catch (err) {
    res.render('verify-esign', { valid: false, signer: null, session: null, scanTime: new Date() });
  }
});

// PENTING: route /verify/doc/:token harus SEBELUM /verify/:token
// agar Express tidak salah cocokkan "doc" sebagai :token
app.get('/verify/doc/:token', async (req, res) => {
  try {
    const docSig = await DocumentSignature.findOne({ 'signers.token': req.params.token });
    if (!docSig) {
      return res.render('verify-doc', { title: 'Verifikasi Dokumen', valid: false, signer: null, surat: null, scanTime: new Date() });
    }
    const signer = docSig.signers.find(s => s.token === req.params.token);
    const surat  = await SuratMasuk.findById(docSig.suratId);
    res.render('verify-doc', { title: 'Verifikasi Dokumen', valid: true, signer, surat, scanTime: new Date() });
  } catch (err) {
    res.render('verify-doc', { title: 'Verifikasi Dokumen', valid: false, signer: null, surat: null, scanTime: new Date() });
  }
});

app.get('/verify/:token', async (req, res) => {
  try {
    const sig = await Signature.findOne({ verifyToken: req.params.token });
    if (!sig) {
      return res.render('verify', {
        title: 'Verifikasi Tanda Tangan',
        valid: false,
        sig: null,
        scanTime: new Date()
      });
    }
    res.render('verify', {
      title: 'Verifikasi Tanda Tangan',
      valid: true,
      sig,
      scanTime: new Date()
    });
  } catch (err) {
    res.render('verify', { title: 'Verifikasi Tanda Tangan', valid: false, sig: null, scanTime: new Date() });
  }
});

// ── AGREEMENT (MOU / PKS / SPK / KONTRAK) ──

const ROMAN = ['','I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];
let ORG_CODE = process.env.ORG_CODE || 'INSPIRA';
SiteSettings.getSettings().then(s => { if (s.orgCode) ORG_CODE = s.orgCode; }).catch(() => {});

function buildNomor(type, seq, bulan, tahun) {
  const pad = String(seq).padStart(3, '0');
  return `${type}/${pad}/${ORG_CODE}/${ROMAN[bulan]}/${tahun}`;
}

function formatRupiah(n) {
  if (!n) return '-';
  return 'Rp ' + Number(n).toLocaleString('id-ID');
}

app.get('/agreements', requireAuth, requireDirektur, async (req, res) => {
  try {
    const { type, status, q } = req.query;
    const filter = {};
    if (type)   filter.type   = type;
    if (status) filter.status = status;
    if (q)      filter.judul  = { $regex: q, $options: 'i' };

    const [docs, counts] = await Promise.all([
      Agreement.find(filter).sort({ createdAt: -1 }),
      getMailCounts(req.user._id)
    ]);

    const stats = {
      total:    await Agreement.countDocuments(),
      aktif:    await Agreement.countDocuments({ status: 'aktif' }),
      draft:    await Agreement.countDocuments({ status: 'draft' }),
      berakhir: await Agreement.countDocuments({ status: 'berakhir' })
    };

    res.render('agreements', {
      active: 'agreements', title: 'Dokumen & Penomoran',
      docs, stats, filter: { type, status, q },
      formatRupiah, ROMAN,
      ...counts
    });
  } catch (err) {
    console.error(err);
    res.redirect('/inbox');
  }
});

app.get('/agreements/new', requireAuth, requireDirektur, async (req, res) => {
  const counts = await getMailCounts(req.user._id);
  res.render('agreement-form', {
    active: 'agreements', title: 'Buat Dokumen Baru',
    doc: null, error: null, ...counts
  });
});

app.post('/agreements/new', requireAuth, requireDirektur, async (req, res) => {
  const counts = await getMailCounts(req.user._id);
  const fail = (msg) => res.render('agreement-form', {
    active: 'agreements', title: 'Buat Dokumen Baru',
    doc: req.body, error: msg, ...counts
  });

  try {
    const { type, judul, pihakPertama, pihakKedua, nilaiKontrak,
            tanggalMulai, tanggalBerakhir, deskripsi } = req.body;

    if (!type || !judul?.trim()) return fail('Jenis dokumen dan judul wajib diisi.');
    if (!['MOU','PKS','SPK','KONTRAK'].includes(type)) return fail('Jenis dokumen tidak valid.');

    const now   = new Date();
    const tahun = now.getFullYear();
    const bulan = now.getMonth() + 1;

    const seq   = await DocCounter.nextSeq(type, tahun);
    const nomor = buildNomor(type, seq, bulan, tahun);

    const agreement = await Agreement.create({
      type, nomor, urutan: seq, tahun, bulan,
      judul: judul.trim(),
      pihakPertama: pihakPertama?.trim() || ORG_CODE,
      pihakKedua:   pihakKedua?.trim()   || '',
      nilaiKontrak: nilaiKontrak ? parseFloat(nilaiKontrak) : null,
      tanggalMulai:   tanggalMulai   ? new Date(tanggalMulai)   : null,
      tanggalBerakhir: tanggalBerakhir ? new Date(tanggalBerakhir) : null,
      deskripsi: deskripsi?.trim() || '',
      status: 'draft',
      createdBy: {
        userId: req.user._id,
        name:   req.user.name,
        email:  req.user.email,
        role:   req.user.role
      },
      riwayat: [{ status: 'draft', catatan: 'Dokumen dibuat', oleh: req.user.name }]
    });

    await log(req, 'system', 'system',
      `Dokumen ${type} dibuat: ${nomor} — ${judul}`,
      { agreementId: agreement._id, nomor }
    );

    res.redirect('/agreements/' + agreement._id);
  } catch (err) {
    console.error(err);
    fail('Terjadi kesalahan, coba lagi.');
  }
});

app.get('/agreements/:id', requireAuth, requireDirektur, async (req, res) => {
  try {
    const doc = await Agreement.findById(req.params.id);
    if (!doc) return res.redirect('/agreements');
    const counts = await getMailCounts(req.user._id);
    res.render('agreement-detail', {
      active: 'agreements', title: doc.nomor,
      doc, ROMAN, formatRupiah, ...counts
    });
  } catch (err) {
    res.redirect('/agreements');
  }
});

app.post('/agreements/:id/status', requireAuth, requireDirektur, async (req, res) => {
  try {
    const { status, catatan } = req.body;
    const valid = ['draft','review','aktif','berakhir','dibatalkan'];
    if (!valid.includes(status)) return res.json({ ok: false, message: 'Status tidak valid.' });

    const doc = await Agreement.findById(req.params.id);
    if (!doc) return res.json({ ok: false, message: 'Dokumen tidak ditemukan.' });

    // Only direktur/admin can move to aktif
    if (status === 'aktif' && !['direktur','admin','superadmin'].includes(req.user.role)) {
      return res.json({ ok: false, message: 'Hanya Direktur / Admin yang dapat mengaktifkan dokumen.' });
    }

    doc.status = status;
    doc.riwayat.push({ status, catatan: catatan || '', oleh: req.user.name });
    await doc.save();

    await log(req, 'system', 'system',
      `Status dokumen ${doc.nomor} diubah menjadi "${status}" oleh ${req.user.name}`,
      { agreementId: doc._id, nomor: doc.nomor, status }
    );

    res.json({ ok: true, status });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.delete('/agreements/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await Agreement.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// ── PERUSAHAAN (MANAGE EKSTERNAL) ──

app.get('/perusahaan', requireAuth, requireDirektur, async (req, res) => {
  try {
    const counts = await getMailCounts(req.user._id);
    const { q } = req.query;
    const filter = { isActive: true };
    if (q) filter.$or = [
      { nama:     { $regex: q, $options: 'i' } },
      { singkatan:{ $regex: q, $options: 'i' } },
      { email:    { $regex: q, $options: 'i' } },
    ];
    const list  = await Perusahaan.find(filter).sort({ nama: 1 }).lean();
    const total = await Perusahaan.countDocuments({ isActive: true });
    res.render('perusahaan', {
      active: 'perusahaan', title: 'Manage Perusahaan',
      list, total, q: q||'', formatDate, ...counts
    });
  } catch (err) { console.error(err); res.redirect('/inbox'); }
});

app.get('/perusahaan/:id/json', requireAuth, requireDirektur, async (req, res) => {
  try {
    const p = await Perusahaan.findById(req.params.id).lean();
    if (!p) return res.json({ ok: false });
    res.json({ ok: true, data: p });
  } catch { res.json({ ok: false }); }
});

app.post('/perusahaan', requireAuth, requireDirektur, async (req, res) => {
  try {
    const { nama, singkatan, alamat, email, telepon, website, keterangan, kontakJson } = req.body;
    if (!nama?.trim()) return res.redirect('/perusahaan?error=1');
    let kontak = [];
    try { kontak = JSON.parse(kontakJson || '[]'); } catch {}
    await Perusahaan.create({
      nama: nama.trim(), singkatan: singkatan?.trim() || '',
      alamat: alamat?.trim() || '', email: email?.trim() || '',
      telepon: telepon?.trim() || '', website: website?.trim() || '',
      keterangan: keterangan?.trim() || '', kontak,
      createdBy: { userId: req.user._id, name: req.user.name },
    });
    await log(req, 'perusahaan_create', 'perusahaan', `Perusahaan "${nama}" ditambahkan`, { nama });
    res.redirect('/perusahaan');
  } catch (err) { console.error(err); res.redirect('/perusahaan'); }
});

app.put('/perusahaan/:id', requireAuth, requireDirektur, async (req, res) => {
  try {
    const { nama, singkatan, alamat, email, telepon, website, keterangan, kontakJson } = req.body;
    let kontak = [];
    try { kontak = JSON.parse(kontakJson || '[]'); } catch {}
    await Perusahaan.findByIdAndUpdate(req.params.id, {
      nama: nama?.trim(), singkatan: singkatan?.trim() || '',
      alamat: alamat?.trim() || '', email: email?.trim() || '',
      telepon: telepon?.trim() || '', website: website?.trim() || '',
      keterangan: keterangan?.trim() || '', kontak,
    });
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

app.delete('/perusahaan/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await Perusahaan.findByIdAndUpdate(req.params.id, { isActive: false });
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// JSON list untuk compose picker
app.get('/perusahaan-list', requireAuth, async (req, res) => {
  try {
    const list = await Perusahaan.find({ isActive: true }, 'nama singkatan email alamat kontak').sort({ nama: 1 }).lean();
    res.json(list);
  } catch { res.json([]); }
});

// ── COMPOSE INTERNAL / EKSTERNAL (terpisah) ──

app.get('/compose/internal', requireAuth, async (req, res) => {
  try {
    const counts = await getMailCounts(req.user._id);
    const kodeDireksiList = await getKodeDireksiCached();
    const allowedKodeDir = getAllowedKodeDir(req.user);
    const allowedSifat   = getAllowedSifat(req.user);
    let pengirimUsers = [];
    if (['admin','superadmin'].includes(req.user.role)) {
      pengirimUsers = await User.find({ isActive: true }).select('name email enik jabatan kodeDir role').sort('name').lean();
    } else if (req.user.role !== 'direktur') {
      const kd = req.user.kodeDir;
      pengirimUsers = kd ? await User.find({ kodeDir: kd, isActive: true }).select('name email enik jabatan kodeDir role').sort('name').lean() : [];
    }
    // Untuk to/cc penerima, ambil semua user kecuali diri sendiri
    const allUsers = await User.find({ _id: { $ne: req.user._id }, isActive: true }).select('name email organization enik jabatan kodeDir').sort('name').lean();
    res.render('compose', {
      active: 'compose-internal', title: 'Tulis Surat Internal',
      users: allUsers, pengirimUsers, allowedKodeDir, allowedSifat, kodeDireksiList,
      jenisDefault: 'internal', hideJenisTabs: true, ...counts
    });
  } catch (err) {
    res.redirect('/compose/new');
  }
});

app.get('/compose/eksternal', requireAuth, requireDirektur, async (req, res) => {
  try {
    const counts = await getMailCounts(req.user._id);
    const kodeDireksiList = await getKodeDireksiCached();
    const allowedKodeDir = getAllowedKodeDir(req.user);
    const allowedSifat   = getAllowedSifat(req.user);
    let pengirimUsers = [];
    if (['admin','superadmin'].includes(req.user.role)) {
      pengirimUsers = await User.find({ isActive: true }).select('name email enik jabatan kodeDir role').sort('name').lean();
    } else if (req.user.role !== 'direktur') {
      const kd = req.user.kodeDir;
      pengirimUsers = kd ? await User.find({ kodeDir: kd, isActive: true }).select('name email enik jabatan kodeDir role').sort('name').lean() : [];
    }
    const allUsers = await User.find({ _id: { $ne: req.user._id }, isActive: true }).select('name email organization enik jabatan kodeDir').sort('name').lean();
    res.render('compose', {
      active: 'compose-eksternal', title: 'Tulis Surat Eksternal',
      users: allUsers, pengirimUsers, allowedKodeDir, allowedSifat, kodeDireksiList,
      jenisDefault: 'eksternal', hideJenisTabs: true, ...counts
    });
  } catch (err) {
    res.redirect('/compose/new');
  }
});

// ── GENERATE NOMOR SAJA ──

const ALL_TIPE_SURAT = ['MoU','MoA','Contract','IA','PKS','SPK','SK'];

app.get('/nomor-saja', requireAuth, requireDirektur, async (req, res) => {
  try {
    const counts  = await getMailCounts(req.user._id);
    const { q, tipe } = req.query;
    const filter = { 'createdBy.userId': req.user._id };
    if (tipe) filter.tipeSurat = tipe;
    if (q)    filter.$or = [
      { nomorSurat: { $regex: q, $options: 'i' } },
      { perihal:    { $regex: q, $options: 'i' } },
    ];
    const list = await NomorSaja.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    res.render('nomor-saja', {
      active: 'nomor-saja', title: 'Generate Nomor Surat',
      list, q: q||'', tipe: tipe||'',
      ALL_TIPE_SURAT, allowedKodeDir: getAllowedKodeDir(req.user),
      formatDate, ...counts
    });
  } catch (err) { console.error(err); res.redirect('/inbox'); }
});

app.post('/nomor-saja', requireAuth, requireDirektur, async (req, res) => {
  try {
    const { tipeSurat, perihal, tanggal, kodeDir, jenis } = req.body;
    if (!tipeSurat || !tanggal) return res.redirect('/nomor-saja?error=1');

    const allowedKDir = getAllowedKodeDir(req.user);
    const kd = kodeDir || req.user.kodeDir || 'DIR';
    if (!allowedKDir.includes(kd)) return res.redirect('/nomor-saja?error=kodeDir');

    const d = new Date(tanggal);
    const year = d.getFullYear();
    const ROMAN_M = ['','I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];
    const seq = await DocCounter.nextSeq(getTipeCounterKey(tipeSurat), year);
    const nomorSurat = buildNomorSurat(seq, tipeSurat, kd, jenis || 'internal', ROMAN_M[d.getMonth()+1], year);

    await NomorSaja.create({
      nomorSurat, tipeSurat,
      perihal: perihal?.trim() || '(Tanpa Perihal)',
      tanggal: d, kodeDir: kd, jenis: jenis || 'internal',
      createdBy: { userId: req.user._id, name: req.user.name, email: req.user.email },
    });

    await log(req, 'nomor_generate', 'surat', `Nomor ${nomorSurat} di-generate oleh ${req.user.name}`, { nomorSurat });
    res.redirect('/nomor-saja');
  } catch (err) { console.error(err); res.redirect('/nomor-saja'); }
});

app.delete('/nomor-saja/:id', requireAuth, requireDirektur, async (req, res) => {
  try {
    const doc = await NomorSaja.findById(req.params.id);
    if (!doc) return res.json({ ok: false, message: 'Data tidak ditemukan.' });
    if (doc.isDeleted) return res.json({ ok: false, message: 'Nomor sudah dihapus.' });
    const { konfirmasi } = req.body;
    if (!konfirmasi || konfirmasi.trim() !== (doc.nomorSurat || '').trim()) {
      return res.json({ ok: false, message: 'Nomor surat tidak cocok. Hapus dibatalkan.' });
    }
    await NomorSaja.findByIdAndUpdate(doc._id, {
      isDeleted: true,
      deletedAt: new Date(),
      deletedBy: { userId: req.user._id, name: req.user.name },
    });
    // Jika nomor yang dihapus adalah nomor TERAKHIR yang di-generate untuk tipe+tahun ini,
    // kembalikan counter agar nomor berikutnya tidak loncat.
    try {
      const seqParsed = parseInt((doc.nomorSurat || '').split('/')[0]);
      if (!isNaN(seqParsed)) {
        const year = new Date(doc.tanggal).getFullYear();
        const cKey = `${getTipeCounterKey(doc.tipeSurat)}-${year}`;
        const counter = await DocCounter.findOne({ key: cKey });
        if (counter && counter.seq === seqParsed) {
          await DocCounter.findOneAndUpdate({ key: cKey }, { $inc: { seq: -1 } });
        }
      }
    } catch (_) {}
    await log(req, 'nomor_delete', 'surat',
      `Nomor ${doc.nomorSurat} dihapus oleh ${req.user.name}`,
      { nomorSurat: doc.nomorSurat, tipeSurat: doc.tipeSurat }
    );
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// Edit nomor surat (perihal, tanggal, jenis)
app.put('/nomor-saja/:id', requireAuth, requireDirektur, async (req, res) => {
  try {
    const doc = await NomorSaja.findById(req.params.id);
    if (!doc || doc.isDeleted) return res.json({ ok: false, message: 'Data tidak ditemukan.' });
    const { perihal, tanggal, jenis } = req.body;
    const update = {};
    if (perihal !== undefined) update.perihal = perihal.trim() || '(Tanpa Perihal)';
    if (tanggal) update.tanggal = new Date(tanggal);
    if (jenis)   update.jenis  = jenis;
    await NomorSaja.findByIdAndUpdate(doc._id, { $set: update });
    await log(req, 'nomor_edit', 'surat', `Nomor ${doc.nomorSurat} diedit oleh ${req.user.name}`, { nomorSurat: doc.nomorSurat });
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// ── RESET DATA (superadmin only) ──
app.post('/admin/reset/nomor-saja', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const ALL_KEYS = Object.values(TIPE_COUNTER_KEY || {});
    await NomorSaja.deleteMany({});
    // Reset semua counter nomor-saja
    const year = new Date().getFullYear();
    const keyPattern = new RegExp(`^(${[...new Set(ALL_KEYS)].join('|')})-`);
    await DocCounter.deleteMany({ key: keyPattern });
    await log(req, 'reset_nomor_saja', 'system', `Superadmin ${req.user.name} mereset semua data Generate Nomor Surat`);
    res.json({ ok: true, message: 'Semua data Generate Nomor Surat berhasil dihapus.' });
  } catch (err) { console.error(err); res.json({ ok: false, message: 'Gagal reset.' }); }
});

app.post('/admin/reset/persuratan', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await Promise.all([
      Email.deleteMany({}),
      DocumentSignature.deleteMany({}),
      ESignSession.deleteMany({}),
      Arsip.deleteMany({}),
      SuratMasuk.deleteMany({}),
      PersonalDocument.deleteMany({}),
    ]);
    // Reset counter nomor surat (internal generate dari compose)
    await DocCounter.deleteMany({});
    await log(req, 'reset_persuratan', 'system', `Superadmin ${req.user.name} mereset semua data persuratan`);
    res.json({ ok: true, message: 'Semua data persuratan berhasil dihapus.' });
  } catch (err) { console.error(err); res.json({ ok: false, message: 'Gagal reset.' }); }
});

// ── DOKUMEN ARSIP ──

const arsipUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, 'uploads', 'arsip');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, Date.now() + '-' + Math.round(Math.random()*1e6) + ext);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const ARSIP_KATEGORI = ['Umum','Surat Masuk','Surat Keluar','Eksternal','Perjanjian','Laporan','Keuangan','SDM','Lainnya'];

app.get('/arsip', requireAuth, requireDirektur, async (req, res) => {
  try {
    const counts = await getMailCounts(req.user._id);
    const { q, kategori } = req.query;
    const filter = {};
    if (kategori) filter.kategori = kategori;
    if (q) filter.$or = [
      { judul:      { $regex: q, $options: 'i' } },
      { nomorArsip: { $regex: q, $options: 'i' } },
      { keterangan: { $regex: q, $options: 'i' } },
    ];
    const list  = await Arsip.find(filter).sort({ tanggal: -1 }).limit(200).lean();
    const total = await Arsip.countDocuments();
    // Daftar perusahaan kerjasama (untuk pilihan Sumber) & direktur (untuk Tertuju + auto-kirim)
    const [perusahaanList, direkturList] = await Promise.all([
      Perusahaan.find({ isActive: true }).sort({ nama: 1 }).select('nama singkatan').lean(),
      User.find({ role: 'direktur' }).sort({ name: 1 }).select('name email jabatan').lean(),
    ]);
    res.render('arsip', {
      active: 'arsip', title: 'Dokumen Arsip',
      list, total, q: q||'', kategori: kategori||'',
      ARSIP_KATEGORI, perusahaanList, direkturList, formatDate, ...counts
    });
  } catch (err) { console.error(err); res.redirect('/inbox'); }
});

app.post('/arsip', requireAuth, requireDirektur, arsipUpload.single('lampiran'), async (req, res) => {
  try {
    const { nomorArsip, judul, kategori, tanggal, keterangan, sumber, tertuju, tertujuUserId } = req.body;
    if (!judul || !tanggal) return res.redirect('/arsip?error=1');

    // Resolve direktur tujuan (untuk auto-kirim)
    let direktur = null;
    if (tertujuUserId) direktur = await User.findById(tertujuUserId).lean().catch(() => null);

    const lampiranPath = req.file ? '/uploads/arsip/' + req.file.filename : '';
    const arsip = await Arsip.create({
      nomorArsip: nomorArsip?.trim() || '',
      judul: judul.trim(),
      kategori: kategori || 'Umum',
      tanggal: new Date(tanggal),
      keterangan: keterangan?.trim() || '',
      sumber: sumber?.trim() || '',
      tertuju: direktur ? direktur.name : (tertuju?.trim() || ''),
      tertujuUserId: direktur ? direktur._id : null,
      lampiran: lampiranPath,
      lampiranNama: req.file ? req.file.originalname : '',
      createdBy: { userId: req.user._id, name: req.user.name, email: req.user.email },
    });
    await log(req, 'arsip_create', 'arsip', `Arsip "${judul}" ditambahkan oleh ${req.user.name}`);

    // Auto-kirim ke Direktur yang dituju agar langsung bisa dibaca di Kotak Masuk
    if (direktur) {
      const bodyHtml = `<p>Dokumen arsip berikut ditujukan kepada Anda:</p>`
        + `<p><strong>Judul:</strong> ${judul.trim()}<br>`
        + (nomorArsip?.trim() ? `<strong>Nomor Arsip:</strong> ${nomorArsip.trim()}<br>` : '')
        + `<strong>Kategori:</strong> ${kategori || 'Umum'}<br>`
        + (sumber?.trim() ? `<strong>Sumber / Asal:</strong> ${sumber.trim()}<br>` : '')
        + (keterangan?.trim() ? `<strong>Keterangan:</strong> ${keterangan.trim()}` : '')
        + `</p>`;
      await Email.create({
        from:    { userId: req.user._id, name: req.user.name, email: req.user.email },
        to:      [{ userId: direktur._id, name: direktur.name, email: direktur.email }],
        subject: `[Arsip] ${judul.trim()}`,
        body:    bodyHtml,
        tag:     'Biasa',
        nomorSurat: nomorArsip?.trim() || '',
        tipeSurat: 'Arsip',
        jenis:   'internal',
        status:  'sent',
        lampiran:     lampiranPath,
        lampiranNama: req.file ? req.file.originalname : '',
      });
      await log(req, 'arsip_dispatch', 'arsip', `Arsip "${judul}" otomatis dikirim ke Direktur ${direktur.name}`);
    }
    res.redirect('/arsip');
  } catch (err) { console.error(err); res.redirect('/arsip'); }
});

// Ambil data arsip (untuk form edit)
app.get('/arsip/:id/json', requireAuth, requireDirektur, async (req, res) => {
  try {
    const doc = await Arsip.findById(req.params.id);
    if (!doc) return res.json({ ok: false });
    res.json({ ok: true, data: doc });
  } catch { res.json({ ok: false }); }
});

// Edit arsip (termasuk tambah tertuju/disposisi)
app.put('/arsip/:id', requireAuth, requireDirektur, async (req, res) => {
  try {
    const { nomorArsip, judul, kategori, tanggal, keterangan, sumber, tertuju, tertujuUserId } = req.body;
    let direktur = null;
    if (tertujuUserId) direktur = await User.findById(tertujuUserId).lean().catch(() => null);
    const update = {
      nomorArsip: nomorArsip?.trim() || '',
      kategori: kategori || 'Umum',
      keterangan: keterangan?.trim() || '',
      sumber: sumber?.trim() || '',
      tertuju: direktur ? direktur.name : (tertuju?.trim() || ''),
      tertujuUserId: direktur ? direktur._id : null,
    };
    if (judul?.trim()) update.judul = judul.trim();
    if (tanggal) update.tanggal = new Date(tanggal);
    await Arsip.findByIdAndUpdate(req.params.id, update);
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

app.delete('/arsip/:id', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') return res.json({ ok: false, message: 'Hanya superadmin yang dapat menghapus.' });
    const doc = await Arsip.findById(req.params.id);
    if (!doc) return res.json({ ok: false, message: 'Data tidak ditemukan.' });
    const { konfirmasi } = req.body;
    const identifier = (doc.nomorArsip || doc.judul || '').trim();
    if (!konfirmasi || konfirmasi.trim() !== identifier) {
      return res.json({ ok: false, message: 'Nomor/judul tidak cocok. Hapus dibatalkan.' });
    }
    if (doc.lampiran) {
      const fp = path.join(__dirname, doc.lampiran);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    await Arsip.findByIdAndDelete(req.params.id);
    await log(req, 'arsip_delete', 'arsip', `Arsip "${doc.judul}" dihapus oleh ${req.user.name}`);
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// ── SURAT MASUK ──

const smUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(__dirname, 'uploads', 'suratmasuk');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf','image/jpeg','image/png','image/jpg'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Hanya file PDF, JPG, atau PNG yang diizinkan.'));
  }
});

app.get('/surat-masuk', requireAuth, async (req, res) => {
  try {
    const { status, klasifikasi, q, dateFrom, dateTo, dateMonth, dateYear, sort } = req.query;
    const filter = {};
    if (status)      filter.status      = status;
    if (klasifikasi) filter.klasifikasi = klasifikasi;
    if (q) filter.$or = [
      { perihal:      { $regex: q, $options: 'i' } },
      { dariInstansi: { $regex: q, $options: 'i' } },
      { nomorSurat:   { $regex: q, $options: 'i' } }
    ];
    if (dateFrom || dateTo) {
      filter.tanggalTerima = {};
      if (dateFrom) filter.tanggalTerima.$gte = new Date(dateFrom);
      if (dateTo)   filter.tanggalTerima.$lte = new Date(dateTo + 'T23:59:59');
    } else if (dateMonth || dateYear) {
      const y = parseInt(dateYear) || new Date().getFullYear();
      const m = parseInt(dateMonth);
      if (m) {
        filter.tanggalTerima = { $gte: new Date(y, m-1, 1), $lt: new Date(y, m, 1) };
      } else {
        filter.tanggalTerima = { $gte: new Date(y, 0, 1), $lt: new Date(y+1, 0, 1) };
      }
    }

    const [surats, counts] = await Promise.all([
      SuratMasuk.find(filter).sort({ tanggalTerima: sort === 'oldest' ? 1 : -1 }),
      getMailCounts(req.user._id)
    ]);

    const stats = {
      total:           await SuratMasuk.countDocuments(),
      baru:            await SuratMasuk.countDocuments({ status: 'baru' }),
      ditindaklanjuti: await SuratMasuk.countDocuments({ status: 'ditindaklanjuti' }),
      selesai:         await SuratMasuk.countDocuments({ status: 'selesai' })
    };

    res.render('surat-masuk', {
      active: 'surat-masuk', title: 'Surat Masuk',
      surats, stats, filter: { status, klasifikasi, q, dateFrom, dateTo, dateMonth, dateYear, sort },
      formatDate, ...counts
    });
  } catch (err) {
    console.error(err);
    res.redirect('/inbox');
  }
});

app.post('/surat-masuk', requireAuth, (req, res) => {
  smUpload.single('fileSurat')(req, res, async (err) => {
    const counts = await getMailCounts(req.user._id);
    const fail = (msg) => res.render('surat-masuk', {
      active: 'surat-masuk', title: 'Surat Masuk',
      surats: [], stats: {}, filter: {},
      error: msg, formatDate, ...counts
    });

    if (err) return fail(err.message);

    try {
      const { nomorSurat, dariInstansi, perihal, tanggalSurat,
              tanggalTerima, klasifikasi, catatan } = req.body;

      if (!dariInstansi?.trim() || !perihal?.trim() || !tanggalTerima) {
        return fail('Instansi pengirim, perihal, dan tanggal terima wajib diisi.');
      }

      const data = {
        nomorSurat:    nomorSurat?.trim() || '',
        dariInstansi:  dariInstansi.trim(),
        perihal:       perihal.trim(),
        tanggalSurat:  tanggalSurat  ? new Date(tanggalSurat)  : null,
        tanggalTerima: new Date(tanggalTerima),
        klasifikasi:   klasifikasi   || 'Normal',
        catatan:       catatan?.trim() || '',
        dicatatOleh: {
          userId: req.user._id,
          name:   req.user.name,
          email:  req.user.email
        },
        status: 'baru'
      };

      if (req.file) {
        data.file = {
          originalName: req.file.originalname,
          path:         '/uploads/suratmasuk/' + req.file.filename,
          mimetype:     req.file.mimetype,
          size:         req.file.size
        };
      }

      await SuratMasuk.create(data);
      await log(req, 'system', 'email',
        `Surat masuk dicatat: "${perihal}" dari ${dariInstansi}`,
        { nomorSurat, dariInstansi }
      );

      res.redirect('/surat-masuk');
    } catch (e) {
      console.error(e);
      fail('Terjadi kesalahan, coba lagi.');
    }
  });
});

app.get('/surat-masuk/:id', requireAuth, async (req, res) => {
  try {
    const surat  = await SuratMasuk.findById(req.params.id);
    if (!surat) return res.redirect('/surat-masuk');
    const [users, direktorats, counts] = await Promise.all([
      User.find({ _id: { $ne: req.user._id }, isActive: true }).select('name email jabatan kodeDir organization').sort('name').lean(),
      Direktorat.find().sort('kode').lean(),
      getMailCounts(req.user._id)
    ]);
    // Auto-tandai dibaca
    if (surat.status === 'baru') {
      await SuratMasuk.findByIdAndUpdate(req.params.id, { status: 'dibaca' });
      surat.status = 'dibaca';
    }
    res.render('surat-masuk-detail', {
      active: 'surat-masuk', title: 'Detail Surat Masuk',
      surat, users, direktorats, formatDate, formatDateTime, ...counts
    });
  } catch (err) {
    res.redirect('/surat-masuk');
  }
});

app.post('/surat-masuk/:id/status', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['baru','dibaca','ditindaklanjuti','selesai'];
    if (!valid.includes(status)) return res.json({ ok: false });
    await SuratMasuk.findByIdAndUpdate(req.params.id, { status });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.post('/surat-masuk/:id/disposisi', requireAuth, async (req, res) => {
  try {
    const { disposisi, disposisiCatatan } = req.body;
    await SuratMasuk.findByIdAndUpdate(req.params.id, {
      disposisi: disposisi || [],
      disposisiCatatan: disposisiCatatan?.trim() || '',
      status: 'ditindaklanjuti'
    });
    await log(req, 'system', 'email', `Disposisi surat masuk oleh ${req.user.name}`, { suratId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.delete('/surat-masuk/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const surat = await SuratMasuk.findById(req.params.id);
    if (!surat) return res.json({ ok: false });
    // Delete physical file if exists
    if (surat.file?.path) {
      const fp = path.join(__dirname, surat.file.path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    await SuratMasuk.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

// Serve uploaded letter files (protected)
app.get('/uploads/suratmasuk/:filename', requireAuth, (req, res) => {
  const fp = path.join(__dirname, 'uploads', 'suratmasuk', req.params.filename);
  if (!fs.existsSync(fp)) return res.status(404).send('File tidak ditemukan.');
  res.sendFile(fp);
});

// ── SURAT MASUK PDF EDITOR ──

app.get('/surat-masuk/:id/pdf', requireAuth, async (req, res) => {
  try {
    const surat = await SuratMasuk.findById(req.params.id);
    if (!surat) return res.redirect('/surat-masuk');
    const [docSig, users, counts] = await Promise.all([
      DocumentSignature.findOne({ suratId: surat._id }),
      User.find({ isActive: true }, 'name email role organization jabatan kodeDir _id').sort({ name: 1 }),
      getMailCounts(req.user._id)
    ]);
    res.render('surat-pdf-editor', {
      title: 'Editor PDF',
      surat,
      docSig: docSig || { signers: [] },
      currentUser: req.user,
      users,
      formatDate,
      ...counts
    });
  } catch (err) {
    console.error(err);
    res.redirect('/surat-masuk');
  }
});

app.post('/surat-masuk/:id/pdf/add-signer', requireAuth, async (req, res) => {
  try {
    const { userId } = req.body;
    const surat = await SuratMasuk.findById(req.params.id);
    if (!surat) return res.json({ ok: false, message: 'Surat tidak ditemukan.' });

    const targetUser = await User.findById(userId);
    if (!targetUser) return res.json({ ok: false, message: 'Pengguna tidak ditemukan.' });

    let docSig = await DocumentSignature.findOne({ suratId: surat._id });
    if (!docSig) {
      docSig = new DocumentSignature({ suratId: surat._id, createdBy: req.user._id, signers: [] });
    }

    if (docSig.signers.some(s => s.userId.toString() === userId.toString())) {
      return res.json({ ok: false, message: 'Penandatangan sudah ditambahkan.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3005}`;
    const verifyUrl = `${appUrl}/verify/doc/${token}`;

    const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
      errorCorrectionLevel: 'H',
      margin: 2,
      width: 200,
      color: { dark: '#000000', light: '#ffffff' }
    });

    const signerCount = docSig.signers.length;
    docSig.signers.push({
      userId: targetUser._id,
      userName: targetUser.name,
      userRole: targetUser.role || '',
      userOrg: targetUser.organization || '',
      jabatanDisplay: targetUser.jabatan || '',
      token,
      qrDataUrl,
      position: {
        x: 60 + (signerCount * 140),
        y: 680,
        width: 110,
        height: 110
      }
    });

    await docSig.save();

    const newSigner = docSig.signers[docSig.signers.length - 1];
    res.json({ ok: true, signer: newSigner });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, message: 'Gagal menambahkan penandatangan.' });
  }
});

app.post('/surat-masuk/:id/pdf/update-position', requireAuth, async (req, res) => {
  try {
    const { signerId, x, y, width, height } = req.body;
    await DocumentSignature.updateOne(
      { suratId: req.params.id, 'signers._id': signerId },
      { $set: { 'signers.$.position': { x, y, width, height } } }
    );
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false });
  }
});

app.delete('/surat-masuk/:id/pdf/signers/:signerId', requireAuth, async (req, res) => {
  try {
    const docSig = await DocumentSignature.findOne({ suratId: req.params.id });
    if (!docSig) return res.json({ ok: false });

    const signer = docSig.signers.id(req.params.signerId);
    const wasCurrentUser = signer && signer.userId.toString() === req.user._id.toString();

    await DocumentSignature.updateOne(
      { suratId: req.params.id },
      { $pull: { signers: { _id: req.params.signerId } } }
    );
    res.json({ ok: true, wasCurrentUser, removedUserId: signer?.userId?.toString() });
  } catch (err) {
    res.json({ ok: false });
  }
});

// ── E-SIGN PDF ──

const esignUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads/esign')),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext);
    }
  }),
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Hanya file PDF yang diizinkan'));
  },
  limits: { fileSize: 10 * 1024 * 1024 }
});

// Helper: generate QR stamp for a signer (same pattern as DocumentSignature)
async function generateESignQR(sessionId, signerId) {
  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3005}`;
  const token  = crypto.randomBytes(32).toString('hex');
  const verifyUrl = `${appUrl}/verify/esign/${token}`;
  const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
    errorCorrectionLevel: 'H', margin: 2, width: 200,
    color: { dark: '#000000', light: '#00000000' }
  });
  return { token, qrDataUrl };
}

// Rebuild signed PDF — embeds all signed QR stamps using stored qrDataUrl (pixel positions)
// The editor renders PDF at ~794px wide (A4 72dpi). We scale positions to actual PDF pt dimensions.
async function rebuildSignedPdf(session) {
  const originalPath = path.join(__dirname, session.originalFile);
  const pdfBytes = fs.readFileSync(originalPath);
  const pdfDoc   = await PDFDocument.load(pdfBytes);
  const pages    = pdfDoc.getPages();
  const font     = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const RENDER_W = 794; // px width used in the editor canvas

  for (const signer of session.signers) {
    if (signer.status !== 'signed' || !signer.qrDataUrl) continue;
    const page = pages[signer.position.page] || pages[0];
    const { width: pw, height: ph } = page.getSize();
    const scale = pw / RENDER_W;

    let pdfX = signer.position.x * scale;
    let pdfW = signer.position.width  * scale;
    let pdfH = signer.position.height * scale;
    // Convert from top-left origin (browser) to bottom-left origin (PDF)
    let pdfY = ph - (signer.position.y * scale) - pdfH;

    // Clamp agar tidak keluar batas halaman
    pdfX = Math.max(0, Math.min(pdfX, pw - pdfW));
    pdfY = Math.max(0, Math.min(pdfY, ph - pdfH));
    pdfW = Math.min(pdfW, pw - pdfX);
    pdfH = Math.min(pdfH, ph - pdfY);

    const dm       = signer.displayMode || 'full';
    const showDate = signer.showDate !== false;
    const showName = dm !== 'qr_only';
    const showRole = dm === 'full';
    const lokasi   = signer.lokasiTtd || '';
    const tglDate  = signer.tanggalTtd || signer.signedAt || new Date();
    const dateStr  = new Date(tglDate).toLocaleDateString('id-ID', { day:'numeric', month:'long', year:'numeric' });
    const fullDate = lokasi ? `${lokasi}, ${dateStr}` : dateStr;

    try {
      const qrBase64 = signer.qrDataUrl.split(',')[1];
      const qrBytes  = Buffer.from(qrBase64, 'base64');
      const qrImage  = await pdfDoc.embedPng(qrBytes);
      const lh       = Math.max(5, Math.min(9, pdfH / 5));

      // Date line above QR (if showDate)
      let yOffset = 0;
      if (showDate) {
        yOffset = lh + 3;
        page.drawText(fullDate.slice(0, 45), {
          x: pdfX + 2, y: pdfY + pdfH - yOffset,
          size: lh - 1, font, color: rgb(0.2, 0.2, 0.2), maxWidth: pdfW - 4
        });
      }

      // QR image
      const qrTop = pdfH - yOffset;
      const qrBot = showName ? lh * 2 + 8 : 2;
      const qrSize = qrTop - qrBot;
      if (qrSize > 0) {
        page.drawImage(qrImage, { x: pdfX + (pdfW - qrSize) / 2, y: pdfY + qrBot, width: qrSize, height: qrSize });
      }

      // Separator line + name
      if (showName) {
        const name  = (signer.userName || '').slice(0, 30);
        const jabat = (signer.jabatanDisplay || signer.userOrg || '').slice(0, 32);
        const lineY = pdfY + lh * 2 + 8;
        page.drawLine({ start: { x: pdfX + 4, y: lineY }, end: { x: pdfX + pdfW - 4, y: lineY }, thickness: 0.75, color: rgb(0,0,0) });
        page.drawText(name, { x: pdfX + 4, y: pdfY + lh + 6, size: lh, font: boldFont, color: rgb(0,0,0), maxWidth: pdfW - 8 });
        if (showRole && jabat) page.drawText(jabat, { x: pdfX + 4, y: pdfY + 5, size: lh - 1, font, color: rgb(0.3,0.3,0.3), maxWidth: pdfW - 8 });
      }
    } catch {}
  }

  const signedBytes = await pdfDoc.save();
  const signedName  = 'signed-' + path.basename(session.originalFile);
  const signedPath  = path.join(__dirname, 'uploads/esign/signed', signedName);
  fs.writeFileSync(signedPath, signedBytes);
  return 'uploads/esign/signed/' + signedName;
}

app.get('/e-sign', requireAuth, async (req, res) => {
  try {
    const [sessions, personalDocs, users, counts] = await Promise.all([
      ESignSession.find({
        $or: [{ createdBy: req.user._id }, { 'signers.userId': req.user._id }]
      }).sort({ updatedAt: -1 }),
      PersonalDocument.find({ createdBy: req.user._id }).sort({ createdAt: -1 }),
      User.find({ isActive: true }, 'name email jabatan kodeDir _id').sort({ name: 1 }),
      getMailCounts(req.user._id)
    ]);
    res.render('e-sign', {
      title: 'E-Sign PDF',
      sessions, personalDocs, users,
      currentUser: req.user, active: 'e-sign',
      uploadError: req.query.error || null,
      ...counts
    });
  } catch (err) { console.error(err); res.redirect('/inbox'); }
});

app.post('/e-sign/upload', requireAuth, (req, res, next) => {
  esignUpload.single('pdf')(req, res, err => {
    if (err && err.code === 'LIMIT_FILE_SIZE') return res.redirect('/e-sign?error=toobig');
    if (err) return res.redirect('/e-sign?error=1');
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.redirect('/e-sign?error=nofile');
    const { title } = req.body;
    const session = await ESignSession.create({
      title: (title || req.file.originalname.replace(/\.pdf$/i, '')).trim() || 'Dokumen',
      originalFile: 'uploads/esign/' + req.file.filename,
      originalName: req.file.originalname,
      createdBy: req.user._id,
      signers: []
    });
    await log(req, 'ESIGN_UPLOAD', 'document', `Upload PDF untuk e-sign: ${session.title}`);
    res.redirect('/e-sign/' + session._id);
  } catch (err) { console.error(err); res.redirect('/e-sign?error=1'); }
});

app.get('/e-sign/:id/pdf', requireAuth, async (req, res) => {
  try {
    const session = await ESignSession.findById(req.params.id);
    if (!session) return res.status(404).send('Not found');
    const ok = session.createdBy.toString() === req.user._id.toString() ||
      session.signers.some(s => s.userId.toString() === req.user._id.toString());
    if (!ok) return res.status(403).send('Forbidden');
    // Editor selalu memuat PDF ASLI (tanpa QR ter-burn). Stamp digambar sebagai overlay dari DB,
    // sehingga tidak muncul tanda tangan ganda (file ber-QR hanya untuk download).
    const filePath = path.join(__dirname, session.originalFile);
    if (!fs.existsSync(filePath)) return res.status(404).send('File tidak ditemukan');
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(filePath);
  } catch (err) { res.status(500).send('Error'); }
});

app.get('/e-sign/:id', requireAuth, async (req, res) => {
  try {
    const session = await ESignSession.findById(req.params.id);
    if (!session) return res.redirect('/e-sign');
    const isCreator = session.createdBy.toString() === req.user._id.toString();
    const isSigner  = session.signers.some(s => s.userId.toString() === req.user._id.toString());
    if (!isCreator && !isSigner) return res.redirect('/e-sign');
    const [users, counts] = await Promise.all([
      User.find({ isActive: true }, 'name email jabatan kodeDir _id').sort({ name: 1 }),
      getMailCounts(req.user._id)
    ]);
    res.render('e-sign-editor', {
      title: 'E-Sign: ' + session.title,
      session, users, isCreator,
      user: req.user, currentUser: req.user, active: 'e-sign',
      ...counts
    });
  } catch (err) { console.error(err); res.redirect('/e-sign'); }
});

app.post('/e-sign/:id/add-signer', requireAuth, async (req, res) => {
  try {
    const session = await ESignSession.findById(req.params.id);
    if (!session) return res.json({ ok: false, message: 'Sesi tidak ditemukan' });
    if (session.createdBy.toString() !== req.user._id.toString())
      return res.json({ ok: false, message: 'Hanya pembuat yang dapat menambah penandatangan' });

    const userId = req.body.userId || req.user._id.toString();
    if (session.signers.some(s => s.userId.toString() === userId))
      return res.json({ ok: false, message: 'Penandatangan sudah ditambahkan' });

    const targetUser = await User.findById(userId);
    if (!targetUser) return res.json({ ok: false, message: 'Pengguna tidak ditemukan' });

    const { token, qrDataUrl } = await generateESignQR(session._id, userId);
    const signerCount = session.signers.length;
    const xOffset = (signerCount % 3) * 130;

    const jabatanDisplay = targetUser.jabatan || targetUser.organization || '';

    session.signers.push({
      userId:         targetUser._id,
      userName:       targetUser.name,
      userRole:       targetUser.role || '',
      userOrg:        targetUser.organization || '',
      jabatanDisplay,
      token,
      qrDataUrl,
      status:         'pending',
      position: { page: 0, x: 60 + xOffset, y: 680, width: 110, height: 110 }
    });
    await session.save();
    const newSigner = session.signers[session.signers.length - 1];

    // Kirim notifikasi email ke signer
    if (transporter && targetUser.email) {
      try {
        const _ss = await SiteSettings.getSettings();
        const _mailerName = _ss.mailerName || _ss.siteName || 'PATRA';
        const esignUrl = `${process.env.APP_URL || 'http://localhost:3005'}/e-sign/${session._id}`;
        await transporter.sendMail({
          from: `"${_mailerName}" <${process.env.SMTP_USER}>`,
          to: targetUser.email,
          subject: `Undangan Tanda Tangan Digital — ${session.title}`,
          html: `<p>Halo ${targetUser.name},</p>
<p>Anda diundang untuk menandatangani dokumen secara digital:</p>
<p><strong>${session.title}</strong></p>
<p>Klik link berikut untuk membuka dokumen dan menandatanganinya:</p>
<p><a href="${esignUrl}">${esignUrl}</a></p>
<p>Salam,<br>${_mailerName}</p>`
        });
      } catch (mailErr) { console.error('[E-Sign mail error]', mailErr.message); }
    }

    res.json({ ok: true, signer: newSigner });
  } catch (err) { res.json({ ok: false, message: err.message }); }
});

app.delete('/e-sign/:id/signers/:sid', requireAuth, async (req, res) => {
  try {
    const session = await ESignSession.findById(req.params.id);
    if (!session) return res.json({ ok: false });
    if (session.createdBy.toString() !== req.user._id.toString())
      return res.json({ ok: false, message: 'Hanya pembuat yang dapat menghapus penandatangan' });
    const signer = session.signers.id(req.params.sid);
    if (!signer) return res.json({ ok: false });
    if (signer.userId.toString() === req.user._id.toString())
      return res.json({ ok: false, message: 'Tidak dapat menghapus diri sendiri' });
    await ESignSession.updateOne({ _id: session._id }, { $pull: { signers: { _id: req.params.sid } } });
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

app.post('/e-sign/:id/update-display-mode', requireAuth, async (req, res) => {
  try {
    const { signerId, displayMode } = req.body;
    const valid = ['full', 'name_only', 'qr_only'];
    if (!valid.includes(displayMode)) return res.json({ ok: false });
    await ESignSession.updateOne(
      { _id: req.params.id, 'signers._id': signerId },
      { $set: { 'signers.$.displayMode': displayMode } }
    );
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

app.post('/e-sign/:id/update-jabatan', requireAuth, async (req, res) => {
  try {
    const { signerId, jabatan } = req.body;
    await ESignSession.updateOne(
      { _id: req.params.id, 'signers._id': signerId },
      { $set: { 'signers.$.jabatanDisplay': jabatan || '' } }
    );
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

app.post('/e-sign/:id/update-lokasi-tanggal', requireAuth, async (req, res) => {
  try {
    const { signerId, lokasi, tanggal, tanggalDisplay, showDate } = req.body;
    const update = {};
    if (lokasi          !== undefined) update['signers.$.lokasiTtd']     = lokasi;
    if (tanggal         !== undefined) update['signers.$.tanggalTtd']    = tanggal ? new Date(tanggal) : null;
    if (tanggalDisplay  !== undefined) update['signers.$.tanggalDisplay'] = tanggalDisplay;
    if (showDate        !== undefined) update['signers.$.showDate']      = showDate;
    await ESignSession.updateOne(
      { _id: req.params.id, 'signers._id': signerId },
      { $set: update }
    );
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

app.post('/e-sign/:id/update-position', requireAuth, async (req, res) => {
  try {
    const session = await ESignSession.findById(req.params.id);
    if (!session) return res.json({ ok: false });
    const { signerId, page, x, y, width, height } = req.body;
    const signer = session.signers.id(signerId);
    if (!signer) return res.json({ ok: false });
    // Signer sendiri ATAU pembuat sesi boleh mengatur posisi (termasuk stamp co-signer)
    const isSelf    = signer.userId.toString() === req.user._id.toString();
    const isCreator = session.createdBy.toString() === req.user._id.toString();
    if (!isSelf && !isCreator) return res.json({ ok: false });
    // Stamp yang sudah ditandatangani tidak boleh dipindah
    if (signer.status === 'signed') return res.json({ ok: false });
    signer.position = {
      page:   parseInt(page)   || 0,
      x:      parseFloat(x)    || 0,
      y:      parseFloat(y)    || 0,
      width:  parseFloat(width) || 110,
      height: parseFloat(height)|| 110,
    };
    await session.save();
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

app.post('/e-sign/:id/sign', requireAuth, async (req, res) => {
  try {
    const session = await ESignSession.findById(req.params.id);
    if (!session) return res.json({ ok: false, message: 'Sesi tidak ditemukan' });
    const idx = session.signers.findIndex(s => s.userId.toString() === req.user._id.toString());
    if (idx === -1) return res.json({ ok: false, message: 'Anda bukan penandatangan dokumen ini' });
    if (session.signers[idx].status === 'signed')
      return res.json({ ok: false, message: 'Anda sudah menandatangani dokumen ini' });
    session.signers[idx].status   = 'signed';
    session.signers[idx].signedAt = new Date();
    const signedFilePath = await rebuildSignedPdf(session);
    session.signedFile = signedFilePath;
    const allSigned = session.signers.every(s => s.status === 'signed');
    session.status = allSigned ? 'signed' : 'partial';
    await session.save();
    await log(req, 'ESIGN_SIGN', 'document', `Menandatangani e-sign: ${session.title}`);
    res.json({ ok: true, allSigned, status: session.status });
  } catch (err) { console.error(err); res.json({ ok: false, message: 'Gagal: ' + err.message }); }
});

app.get('/e-sign/:id/download', requireAuth, async (req, res) => {
  try {
    const session = await ESignSession.findById(req.params.id);
    if (!session) return res.status(404).send('Not found');
    const ok = session.createdBy.toString() === req.user._id.toString() ||
      session.signers.some(s => s.userId.toString() === req.user._id.toString());
    if (!ok) return res.status(403).send('Forbidden');
    const filePath = session.signedFile
      ? path.join(__dirname, session.signedFile)
      : path.join(__dirname, session.originalFile);
    if (!fs.existsSync(filePath)) return res.status(404).send('File tidak ditemukan');
    const dlName = session.signedFile ? 'signed-' + session.originalName : session.originalName;
    res.download(filePath, dlName || 'document.pdf');
  } catch (err) { res.status(500).send('Error'); }
});

app.post('/e-sign/:id/save', requireAuth, async (req, res) => {
  try {
    const session = await ESignSession.findById(req.params.id);
    if (!session) return res.json({ ok: false, message: 'Sesi tidak ditemukan' });
    const ok = session.createdBy.toString() === req.user._id.toString() ||
      session.signers.some(s => s.userId.toString() === req.user._id.toString());
    if (!ok) return res.json({ ok: false });
    const filePath    = session.signedFile || session.originalFile;
    const signerNames = session.signers.filter(s => s.status === 'signed').map(s => s.userName);
    const doc = await PersonalDocument.create({
      title: session.title, filePath,
      originalName: session.originalName,
      type: session.signedFile ? 'esigned' : 'uploaded',
      signerNames, createdBy: req.user._id, esignSessionId: session._id
    });
    await log(req, 'ESIGN_SAVE', 'document', `Simpan ke dokumen pribadi: ${session.title}`);
    res.json({ ok: true, docId: doc._id });
  } catch (err) { res.json({ ok: false, message: err.message }); }
});

app.delete('/e-sign/:id', requireAuth, async (req, res) => {
  try {
    const session = await ESignSession.findById(req.params.id);
    if (!session) return res.json({ ok: false });
    if (session.createdBy.toString() !== req.user._id.toString())
      return res.json({ ok: false, message: 'Hanya pembuat yang dapat menghapus' });
    [session.originalFile, session.signedFile].filter(Boolean).forEach(fp => {
      const full = path.join(__dirname, fp);
      if (fs.existsSync(full)) try { fs.unlinkSync(full); } catch {}
    });
    await ESignSession.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

app.get('/personal-docs', requireAuth, async (req, res) => {
  try {
    const [docs, counts] = await Promise.all([
      PersonalDocument.find({ createdBy: req.user._id }).sort({ createdAt: -1 }),
      getMailCounts(req.user._id)
    ]);
    res.render('personal-docs', {
      title: 'Dokumen Pribadi', docs, currentUser: req.user, active: 'personal-docs', ...counts
    });
  } catch (err) { res.redirect('/inbox'); }
});

app.get('/personal-docs/:id/download', requireAuth, async (req, res) => {
  try {
    const doc = await PersonalDocument.findById(req.params.id);
    if (!doc) return res.status(404).send('Not found');
    if (doc.createdBy.toString() !== req.user._id.toString()) return res.status(403).send('Forbidden');
    const filePath = path.join(__dirname, doc.filePath);
    if (!fs.existsSync(filePath)) return res.status(404).send('File tidak ditemukan');
    res.download(filePath, doc.originalName || 'document.pdf');
  } catch (err) { res.status(500).send('Error'); }
});

app.delete('/personal-docs/:id', requireAuth, async (req, res) => {
  try {
    const doc = await PersonalDocument.findById(req.params.id);
    if (!doc) return res.json({ ok: false });
    if (doc.createdBy.toString() !== req.user._id.toString()) return res.json({ ok: false });
    await PersonalDocument.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false }); }
});

// ── START ──

const PORT = process.env.PORT || 3005;
app.listen(PORT, () => console.log(`Inspira Mailer berjalan di http://localhost:${PORT}`));
