const mongoose = require('mongoose');

const kodeDireksiSchema = new mongoose.Schema({
  kode:  { type: String, required: true, trim: true, uppercase: true, unique: true },
  nama:  { type: String, required: true, trim: true },
  group: { type: String, enum: ['direksi', 'divisi'], default: 'divisi' },
  urutan:{ type: Number, default: 0 },
  aktif: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('KodeDireksi', kodeDireksiSchema);
