const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');

const app = express();
const PORT = process.env.PORT || 10000;

/* ================= PATHS ================= */

const PUBLIC_PATH = path.join(__dirname, 'public');
const UPLOAD_PATH = path.join(__dirname, 'uploads');
const QUEUE_FILE = path.join(__dirname, 'queue.json');

// Ensure uploads folder exists
if (!fs.existsSync(UPLOAD_PATH)) {
  fs.mkdirSync(UPLOAD_PATH, { recursive: true });
}

/* ================= MIDDLEWARE ================= */

app.use(express.json());
app.use(express.static(PUBLIC_PATH));
app.use('/uploads', express.static(UPLOAD_PATH));

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_PATH, 'index.html'));
});

/* ================= ADMIN AUTH ================= */

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/* ================= WHATSAPP ================= */

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: path.join(UPLOAD_PATH, '.wwebjs_auth')
  }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

let latestQR = null;
let isReady = false;

client.on('qr', qr => {
  latestQR = qr;
  isReady = false;
});

client.on('ready', () => {
  isReady = true;
  latestQR = null;
  console.log('✅ WhatsApp connected');
});

client.initialize();

/* ================= QR API ================= */

app.get('/qr', (req, res) => {
  if (isReady) return res.send('✅ WhatsApp already authenticated');
  if (!latestQR) return res.send('⏳ QR not ready');

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${latestQR}`;
  res.send(`<img src="${qrUrl}" />`);
});

/* ================= IMAGE UPLOAD ================= */

const imageStorage = multer.diskStorage({
  destination: UPLOAD_PATH,
  filename: (req, file, cb) => cb(null, 'vishwas-slip.jpg')
});

const imageUpload = multer({
  storage: imageStorage,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only images allowed'));
    }
    cb(null, true);
  }
});

app.post('/upload-image', adminAuth, imageUpload.single('image'), (req, res) => {
  res.json({ success: true, url: '/uploads/vishwas-slip.jpg' });
});

app.get('/image-status', (req, res) => {
  res.json({
    uploaded: fs.existsSync(path.join(UPLOAD_PATH, 'vishwas-slip.jpg'))
  });
});

/* ================= EXCEL UPLOAD ================= */

const upload = multer({ storage: multer.memoryStorage() });

let jobQueue = [];
let isProcessing = false;
let totalRows = 0;
let processedRows = 0;

app.post('/upload', adminAuth, upload.single('file'), (req, res) => {
  if (!isReady) return res.status(503).send('WhatsApp not ready');
  if (!req.file) return res.status(400).send('No file uploaded');

  const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(sheet);

  jobQueue.push(...data);
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(jobQueue));

  startWorker();
  res.json({ success: true, total: data.length });
});

/* ================= PROGRESS ================= */

app.get('/progress', (req, res) => {
  res.json({ total: totalRows, processed: processedRows });
});

/* ================= WORKER ================= */

function normalizeNumber(num) {
  num = num.toString().trim();
  return num.length === 10 ? '91' + num : num;
}

const delay = ms => new Promise(r => setTimeout(r, ms));
const randomDelay = () => Math.floor(Math.random() * 15000) + 15000;

async function sendWhatsAppMessage(to, message) {
  const chatId = `${normalizeNumber(to)}@c.us`;
  const mediaPath = path.join(UPLOAD_PATH, 'vishwas-slip.jpg');
  const media = MessageMedia.fromFilePath(mediaPath);
  await client.sendMessage(chatId, media, { caption: message });
}

async function startWorker() {
  if (isProcessing) return;
  isProcessing = true;

  totalRows = jobQueue.length;
  processedRows = 0;

  while (jobQueue.length) {
    const row = jobQueue.shift();
    processedRows++;
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(jobQueue));

    if (row.mobileNumber && row.message) {
      try {
        await sendWhatsAppMessage(row.mobileNumber, row.message);
        await delay(randomDelay());
      } catch (err) {
        console.error('Send failed:', err.message);
      }
    }
  }

  isProcessing = false;
}

/* ================= RESUME QUEUE ================= */

if (fs.existsSync(QUEUE_FILE)) {
  jobQueue = JSON.parse(fs.readFileSync(QUEUE_FILE));
  startWorker();
}

/* ================= START SERVER ================= */

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
