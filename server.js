const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { Client, MessageMedia, LocalAuth } = require('whatsapp-web.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ================= ADMIN AUTH ================= */

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/* ================= WHATSAPP ================= */

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: '.whatsapp-web.js' }),
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

/* ================= QR PAGE ================= */

app.get('/qr', (req, res) => {
  if (isReady) return res.send('✅ WhatsApp already authenticated');
  if (!latestQR) return res.send('⏳ QR not ready. Refresh in 5 seconds');

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${latestQR}`;
  res.send(`<h2>Scan QR</h2><img src="${qrUrl}" />`);
});

/* ================= IMAGE UPLOAD ================= */

const imageStorage = multer.diskStorage({
  destination: (req, file, cb) =>
    cb(null, path.join(__dirname, 'public')),
  filename: (req, file, cb) =>
    cb(null, 'vishwas-slip.jpg')
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
  res.json({ success: true, url: '/vishwas-slip.jpg' });
});

app.get('/image-status', (req, res) => {
  const imgPath = path.join(__dirname, 'public', 'vishwas-slip.jpg');
  res.json({ uploaded: fs.existsSync(imgPath) });
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
  fs.writeFileSync('queue.json', JSON.stringify(jobQueue));

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

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function sendWhatsAppMessage(to, message) {
  const chatId = `${normalizeNumber(to)}@c.us`;
  const mediaPath = path.join(__dirname, 'public', 'vishwas-slip.jpg');
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
    fs.writeFileSync('queue.json', JSON.stringify(jobQueue));

    if (row.mobileNumber && row.message) {
      await sendWhatsAppMessage(row.mobileNumber, row.message);
      await delay(getRandomDelay(15000, 30000));
    }
  }

  isProcessing = false;
}

/* ================= RESUME ON RESTART ================= */

if (fs.existsSync('queue.json')) {
  jobQueue = JSON.parse(fs.readFileSync('queue.json'));
  startWorker();
}

/* ================= START SERVER ================= */

app.listen(PORT, () =>
  console.log(`🚀 Server running on port ${PORT}`)
);
