const mongoose = require('mongoose');

const docSignerSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userName:       { type: String, required: true },
  userRole:       { type: String, default: '' },
  userOrg:        { type: String, default: '' },
  token:          { type: String, default: '' },
  qrDataUrl:      { type: String, default: '' },
  jabatanDisplay: { type: String, default: '' },
  displayMode:    { type: String, enum: ['full','name_only','qr_only'], default: 'full' },
  showDate:       { type: Boolean, default: true },
  status:         { type: String, enum: ['pending','signed'], default: 'pending' },
  position: {
    x:      { type: Number, default: 60 },
    y:      { type: Number, default: 680 },
    width:  { type: Number, default: 110 },
    height: { type: Number, default: 110 }
  },
  positionLocked: { type: Boolean, default: false },
  lokasiTtd:  { type: String, default: '' },
  tanggalTtd: { type: Date },
  addedAt:  { type: Date, default: Date.now },
  signedAt: { type: Date }
}, { _id: true });

const documentSignatureSchema = new mongoose.Schema({
  suratId:   { type: mongoose.Schema.Types.ObjectId, ref: 'SuratMasuk' },
  emailId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Email' },
  signers:   [docSignerSchema],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

// Sparse index — boleh null, tidak unique
documentSignatureSchema.index({ suratId: 1 }, { sparse: true });
documentSignatureSchema.index({ emailId: 1 }, { sparse: true });

module.exports = mongoose.model('DocumentSignature', documentSignatureSchema);
