// Pengelompokan & pengurutan daftar karyawan per direktorat.
// Satu sumber kebenaran dipakai semua view (compose, draft, e-sign, tugas, disposisi, dll).

// Urutan tampil grup. Komisaris & Direksi selalu di atas (bukan direktorat operasional).
const DIR_ORDER = ['KOM', 'DIR', 'PLAN', 'TECH', 'MP'];

// Label fallback bila koleksi `direktorats` tidak tersedia / tidak punya entri.
const DEFAULT_LABELS = {
  KOM:  'Dewan Komisaris',
  DIR:  'Dewan Direksi',
  PLAN: 'PLAN — Business Strategy & Finance',
  TECH: 'TECH — Technical & Operations',
  MP:   'MP — Marketing & Partnership',
};

const LAIN_KEY = '_LAIN';

/**
 * Kelompokkan user per kodeDir, urutkan grup & anggota, beri label.
 * @param {Array} users        daftar user (punya kodeDir, name, enik, jabatan)
 * @param {Array} direktorats  koleksi Direktorat [{kode, nama}] (opsional)
 * @returns {Array<{key, label, users}>}
 */
function groupUsersByDir(users = [], direktorats = []) {
  const labels = { ...DEFAULT_LABELS };
  (direktorats || []).forEach(d => {
    if (d && d.kode) labels[String(d.kode).toUpperCase()] = d.nama || d.kode;
  });

  const grouped = {};
  (users || []).forEach(u => {
    const k = (u.kodeDir && String(u.kodeDir).trim()) ? String(u.kodeDir).toUpperCase() : LAIN_KEY;
    (grouped[k] = grouped[k] || []).push(u);
  });

  // Urutan: DIR_ORDER dulu, lalu kode lain (alfabet), terakhir "Lainnya".
  const known = DIR_ORDER.filter(k => grouped[k]);
  const extra = Object.keys(grouped)
    .filter(k => !DIR_ORDER.includes(k) && k !== LAIN_KEY)
    .sort();
  const keys = [...known, ...extra];
  if (grouped[LAIN_KEY]) keys.push(LAIN_KEY);

  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'id');

  return keys.map(k => ({
    key: k,
    label: labels[k] || (k === LAIN_KEY ? 'Lainnya' : k),
    users: grouped[k].sort(byName),
  }));
}

module.exports = { groupUsersByDir, DIR_ORDER, DEFAULT_LABELS };
