const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
const PORT = process.env.PORT || 10000;

/* ================= PATHS ================= */

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/* ================= MIDDLEWARE ================= */

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

/* ================= HOME ================= */

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

/* ================= ADMIN AUTH ================= */

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).send('Unauthorized');
  }
  next();
}

/* ================= WHATSAPP ================= */

let latestQR = null;
let isReady = false;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '/opt/render/project/src/uploads/.whatsapp-web.js' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    dumpio: true
  }
});

client.on('qr', qr => {
  latestQR = qr;
  isReady = false;
  console.log('📲 QR generated');
});

client.on('ready', () => {
  isReady = true;
  latestQR = null;
  console.log('✅ WhatsApp connected');
});

client.on('disconnected', (reason) => {
  console.error('❌ WhatsApp disconnected:', reason);
  console.log('🔄 Reinitializing WhatsApp...');
  //client.initialize();
});

client.on('auth_failure', msg => {
  console.error('❌ Auth failure:', msg);
});

client.initialize();

/* ================= QR PAGE ================= */

app.get('/qr', async (req, res) => {
  if (isReady) {
    return res.send('<h2>✅ WhatsApp already authenticated</h2>');
  }

  if (!latestQR) {
    return res.send('<h2>⏳ QR not ready. Refresh in 5 seconds</h2>');
  }

  try {
    const qrImage = await QRCode.toDataURL(latestQR);
    res.send(`
      <h2>Scan QR with WhatsApp</h2>
      <img src="${qrImage}" />
      <p>WhatsApp → Linked Devices → Link a device</p>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to generate QR');
  }
});

/* ================= IMAGE UPLOAD ================= */

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, 'vishwas-slip.jpg')
});

const imageUpload = multer({
  storage: imageStorage,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files allowed'));
    }
    cb(null, true);
  }
});

app.post('/upload-image', adminAuth, imageUpload.single('image'), (req, res) => {
  res.json({ success: true });
});

app.get('/image-status', (req, res) => {
  const imgPath = path.join(UPLOADS_DIR, 'vishwas-slip.jpg');
  res.json({ uploaded: fs.existsSync(imgPath) });
});

/* ================= EXCEL UPLOAD ================= */

const upload = multer({ storage: multer.memoryStorage() });

let queue = [];
let processing = false;
let total = 0;
let processed = 0;

app.post('/upload', adminAuth, upload.single('file'), async (req, res) => {
  if (!isReady) return res.status(503).send('WhatsApp not ready');
  if (!req.file) return res.status(400).send('No file uploaded');

  const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet);

  queue.push(...data);
  total = queue.length;
  processed = 0;

  startWorker();
  res.json({ success: true, total });
});

/* ================= PROGRESS ================= */

app.get('/progress', (req, res) => {
  res.json({ total, processed });
});

/* ================= WORKER ================= */

function normalizeNumber(num) {
  num = String(num).trim();
  return num.length === 10 ? '91' + num : num;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function sendMessage(row) {
  if (!row.mobileNumber || !row.message) return;

  const chatId = `${normalizeNumber(row.mobileNumber)}@c.us`;
  const mediaPath = path.join(UPLOADS_DIR, 'vishwas-slip.jpg');

  const media = fs.existsSync(mediaPath)
    ? MessageMedia.fromFilePath(mediaPath)
    : null;

  if (media) {
    await client.sendMessage(chatId, media, { caption: row.message });
  } else {
    await client.sendMessage(chatId, row.message);
  }
}

async function startWorker() {
  if (processing) return;
  processing = true;

  while (queue.length) {
    const row = queue.shift();
    processed++;
    await sendMessage(row);
    await delay(15000); // 15 sec delay (safe)
  }

  processing = false;
}

/* ================= START ================= */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
