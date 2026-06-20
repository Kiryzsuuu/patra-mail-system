const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  name: String,
  email: String
}, { _id: false });

const externalSchema = new mongoose.Schema({
  name:    String,
  email:   String,
  jabatan: String
}, { _id: false });

const emailSchema = new mongoose.Schema({
  from:        { type: participantSchema, required: true },
  to:          [participantSchema],
  cc:          [participantSchema],
  toExternal:  [externalSchema],
  subject:     { type: String, required: true },
  body:        { type: String, default: '' },
  tag:         { type: String, enum: ['Biasa','Penting','Segera','Mendesak','Draft'], default: 'Biasa' },
  berkas:      { type: String, default: '' },
  nomorSurat:  { type: String, default: '' },
  kodeDiv:     { type: String, default: 'OPS' },
  kodeLay:     { type: String, default: 'INT' },
  sifat:       { type: String, enum: ['Biasa/Terbuka','Rahasia','Terbatas','Segera'], default: 'Biasa/Terbuka' },
  jenis:       { type: String, enum: ['internal','eksternal'], default: 'internal' },
  tipeSurat:      { type: String, default: 'Nota Dinas' },
  lampiran:       { type: String, default: '' },
  lampiranNama:   { type: String, default: '' },
  lampiranList:   { type: [{ path: String, nama: String }], default: [] },
  sumberTemplate: { type: String, enum: ['internal','eksternal'], default: 'internal' },
  pengirimResmi:  { type: String, default: '' },
  kodeDir:        { type: String, default: '' },
  suratData:      { type: mongoose.Schema.Types.Mixed, default: {} },
  status:         { type: String, enum: ['draft','sent'], default: 'draft' },
  readBy:      [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  deletedBy:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  builtBy:     { userId: mongoose.Schema.Types.ObjectId, name: String },
  isLocked:    { type: Boolean, default: false },
  isDeleted:   { type: Boolean, default: false },
  deletedAt:   { type: Date },
  deletedByAdmin: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  disposisi: [{
    userId:  mongoose.Schema.Types.ObjectId,
    nama:    String,
    jabatan: String,
    _id:     false
  }],
  disposisiCatatan: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('Email', emailSchema);
