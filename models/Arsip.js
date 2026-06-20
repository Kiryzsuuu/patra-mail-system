const mongoose = require('mongoose');

const arsipSchema = new mongoose.Schema({
  nomorArsip:  { type: String, default: '' },
  judul:       { type: String, required: true },
  kategori:    { type: String, default: 'Umum' },
  tanggal:     { type: Date, required: true },
  keterangan:  { type: String, default: '' },
  sumber:      { type: String, default: '' },
  tertuju:     { type: String, default: '' },
  lampiran:    { type: String, default: '' },
  lampiranNama:{ type: String, default: '' },
  createdBy:   {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    name:   String,
    email:  String,
  },
}, { timestamps: true });

module.exports = mongoose.model('Arsip', arsipSchema);
