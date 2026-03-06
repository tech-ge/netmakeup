const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// ── Audio uploads (transcription jobs) ───────────────────────────────────────
// IMPORTANT: resource_type MUST be inside a params function — if passed as a
// plain object, multer-storage-cloudinary ignores it and defaults to 'image',
// which rejects all audio. Using a function forces it through correctly.
const audioStorage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => ({
    folder:        'techgeo/audio',
    resource_type: 'video',       // Cloudinary stores audio under 'video' type
    access_mode:   'public',      // allow unauthenticated playback
    public_id: `audio_${Date.now()}_${file.originalname
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9._-]/g, '')
      .replace(/\.[^.]+$/, '')}` // strip extension — Cloudinary adds it
  })
});

// ── Document uploads (writing jobs & data entry) ─────────────────────────────
const documentStorage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => ({
    folder:        'techgeo/documents',
    resource_type: 'raw',         // raw = non-image/video files (PDF, DOCX, XLSX…)
    access_mode:   'public',      // allow unauthenticated download
    public_id: `doc_${Date.now()}_${file.originalname
      .replace(/\s+/g, '_')
      .replace(/[^a-zA-Z0-9._-]/g, '')}`
  })
});

// ── Multer: audio ─────────────────────────────────────────────────────────────
const AUDIO_MIMETYPES = [
  'audio/mpeg',       // .mp3
  'audio/wav',        // .wav
  'audio/wave',       // .wav (alternate)
  'audio/mp4',        // .m4a
  'audio/x-m4a',      // .m4a (alternate)
  'audio/ogg',        // .ogg
  'audio/aac',        // .aac
  'audio/webm',       // .webm audio
  'video/mp4',        // some browsers report mp4 audio as video/mp4
  'video/webm',       // same for webm
  'application/octet-stream' // fallback when browser doesn't detect type
];

const uploadAudio = multer({
  storage: audioStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (req, file, cb) => {
    // Check mimetype OR extension as fallback
    const ext = file.originalname.split('.').pop().toLowerCase();
    const allowedExts = ['mp3', 'wav', 'm4a', 'ogg', 'aac', 'webm'];
    if (AUDIO_MIMETYPES.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Audio files only (mp3, wav, m4a, ogg, aac). Got: ${file.mimetype}`));
    }
  }
});

// ── Multer: documents ─────────────────────────────────────────────────────────
const DOC_MIMETYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword',  // .doc
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // .xlsx
  'application/vnd.ms-excel',  // .xls
  'text/csv',
  'application/octet-stream'   // fallback
];

const uploadDocument = multer({
  storage: documentStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const ext = file.originalname.split('.').pop().toLowerCase();
    const allowedExts = ['pdf', 'doc', 'docx', 'xlsx', 'xls', 'csv'];
    if (DOC_MIMETYPES.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Documents only (pdf, doc, docx, xlsx, csv). Got: ${file.mimetype}`));
    }
  }
});

// ── Generate a signed URL for private files (fallback for old uploads) ────────
const getSignedDownloadUrl = (publicId, resourceType = 'raw', expiresInSeconds = 3600) => {
  return cloudinary.utils.private_download_url(publicId, '', {
    resource_type: resourceType,
    expires_at:    Math.floor(Date.now() / 1000) + expiresInSeconds,
    attachment:    true
  });
};

// ── Delete a file from Cloudinary ─────────────────────────────────────────────
const deleteFile = async (publicId, resourceType = 'raw') => {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.error('Cloudinary delete error:', err.message);
  }
};

module.exports = { uploadAudio, uploadDocument, deleteFile, getSignedDownloadUrl, cloudinary };
