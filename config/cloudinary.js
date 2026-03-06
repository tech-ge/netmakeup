const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name:  process.env.CLOUDINARY_CLOUD_NAME,
  api_key:     process.env.CLOUDINARY_API_KEY,
  api_secret:  process.env.CLOUDINARY_API_SECRET
});

// ── Audio uploads (for transcription jobs) ──────────────────────────────────
const audioStorage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder:        'techgeo/audio',
    resource_type: 'video', // Cloudinary uses 'video' for audio files too
    allowed_formats: ['mp3', 'wav', 'm4a', 'ogg', 'aac'],
    transformation: [{ quality: 'auto' }]
  }
});

// ── Document uploads (PDF / DOCX / XLSX for writing jobs & data entry) ───────
// access_mode: 'public' makes raw files publicly downloadable without auth
const documentStorage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => {
    return {
      folder:          'techgeo/documents',
      resource_type:   'raw',     // raw = PDFs, docs, xlsx, csv etc
      access_mode:     'public',  // ← KEY FIX: allows unauthenticated download
      allowed_formats: ['pdf', 'docx', 'doc', 'xlsx', 'csv'],
      public_id: `${Date.now()}-${file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '')}`
    };
  }
});

// ── Multer instances ─────────────────────────────────────────────────────────
const uploadAudio = multer({
  storage: audioStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max audio
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/mpeg','audio/wav','audio/mp4','audio/ogg','audio/aac','audio/x-m4a'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only audio files are allowed (mp3, wav, m4a, ogg, aac)'));
    }
  }
});

const uploadDocument = multer({
  storage: documentStorage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB max document
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, Word, Excel and CSV files are allowed'));
    }
  }
});

// ── Generate a signed time-limited download URL (fallback for restricted accounts) ──
// Call this server-side when serving file download links to users.
// Signed URLs expire after 1 hour by default and force browser download.
const getSignedDownloadUrl = (publicId, resourceType = 'raw', expiresInSeconds = 3600) => {
  try {
    return cloudinary.utils.private_download_url(publicId, '', {
      resource_type: resourceType,
      expires_at:    Math.floor(Date.now() / 1000) + expiresInSeconds,
      attachment:    true  // forces download instead of browser preview
    });
  } catch (err) {
    console.error('Signed URL generation error:', err.message);
    return null;
  }
};

// ── Delete a file from Cloudinary ────────────────────────────────────────────
const deleteFile = async (publicId, resourceType = 'raw') => {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.error('Cloudinary delete error:', err.message);
  }
};

module.exports = { uploadAudio, uploadDocument, deleteFile, getSignedDownloadUrl, cloudinary };
