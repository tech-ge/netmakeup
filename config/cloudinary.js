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

// ── Document uploads (PDF / DOCX for writing jobs & data entry) ──────────────
const documentStorage = new CloudinaryStorage({
  cloudinary,
  params: (req, file) => {
    const isPdf = file.mimetype === 'application/pdf';
    return {
      folder:        'techgeo/documents',
      resource_type: 'raw',  // raw = any file type
      allowed_formats: ['pdf', 'docx', 'doc'],
      public_id: `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`
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
      'application/msword'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and Word documents are allowed'));
    }
  }
});

// ── Delete a file from Cloudinary ────────────────────────────────────────────
const deleteFile = async (publicId, resourceType = 'raw') => {
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.error('Cloudinary delete error:', err.message);
  }
};

module.exports = { uploadAudio, uploadDocument, deleteFile, cloudinary };