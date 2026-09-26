const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

const PORT = process.env.PORT || 4000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MOVEMENTS_FILE = path.join(DATA_DIR, 'movements.json');
const APP_UPDATE_FILE = path.join(DATA_DIR, 'app_update.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Default Google Sheets Webhook
let config = {
  sheetWebhookUrl: 'https://script.google.com/macros/s/AKfycbzQLByUG1VFb-qqDL1ngpmLZ0qMcPwzXMcbpxqrEwcZi3hhAl11zWOZtfSC6IDH9yCo/exec'
};

if (fs.existsSync(CONFIG_FILE)) {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
  } catch (e) {
    console.error('Error reading config file:', e.message);
  }
}

// In-Memory store backed by files
let movements = [];
if (fs.existsSync(MOVEMENTS_FILE)) {
  try {
    movements = JSON.parse(fs.readFileSync(MOVEMENTS_FILE, 'utf-8'));
  } catch (e) {
    console.error('Error reading movements file:', e.message);
    movements = [];
  }
}

let appUpdateInfo = {
  latestVersionCode: 4,
  latestVersionName: '1.3',
  downloadUrl: 'https://github.com/movement-tracker/releases/download/v1.3/FactoryMovementTracker.apk',
  updateNotes: '১. রেন্ডার সেন্ট্রাল সার্ভার রিয়েলটাইম সিঙ্ক।\n২. অটোমেটিক জিপিএস লাইভ ট্র্যাকিং ও প্রাইভেসি প্রটেকশন।\n৩. রাত ৯টার অ্যাডমিন অ্যালার্ট।',
  forceUpdate: false
};

if (fs.existsSync(APP_UPDATE_FILE)) {
  try {
    appUpdateInfo = { ...appUpdateInfo, ...JSON.parse(fs.readFileSync(APP_UPDATE_FILE, 'utf-8')) };
  } catch (e) {
    console.error('Error reading app update file:', e.message);
  }
}

// Active GPS Locations: Map of movementId -> { movementId, staffName, role, latitude, longitude, speed, timestamp }
// When worker is returned, entry is immediately removed to strictly respect privacy!
const activeLocations = new Map();

function saveMovements() {
  try {
    fs.writeFileSync(MOVEMENTS_FILE, JSON.stringify(movements, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed saving movements:', e.message);
  }
}

function saveAppUpdate() {
  try {
    fs.writeFileSync(APP_UPDATE_FILE, JSON.stringify(appUpdateInfo, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed saving app update:', e.message);
  }
}

// Sync to Google Sheets Webhook
async function forwardToGoogleSheets(record, eventType = 'NEW_ENTRY') {
  if (!config.sheetWebhookUrl) return;
  try {
    const fullRoute = record.stops && record.stops.length > 0
      ? [record.destination, ...record.stops.map(s => s.destination)].join(' ➔ ')
      : record.destination;

    const payload = {
      id: record.id,
      name: record.name,
      role: record.role,
      purpose: `${fullRoute} - ${record.purpose}`,
      rawPurpose: record.purpose,
      destination: record.destination,
      outTime: record.outTime,
      returnTime: record.returnTime || 'এখনো ফিরে আসেননি',
      status: record.isReturned ? '🟢 ফিরে এসেছে' : '🔴 বাহিরে আছে',
      isReturned: record.isReturned,
      eventType: eventType,
      mapsUrl: record.mapsUrl || `https://maps.google.com/?q=${record.latitude || 23.7289},${record.longitude || 90.4124}`,
      stops: record.stops || []
    };

    fetch(config.sheetWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(err => console.log('Sheet sync background notice:', err.message));
  } catch (err) {
    console.error('Google sheet forward error:', err.message);
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API Endpoints ---

// Health Check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    serverTime: new Date().toISOString(),
    totalMovements: movements.length,
    activeStaffCount: movements.filter(m => !m.isReturned).length,
    connectedSockets: io.engine.clientsCount
  });
});

// 1. Get all movements
app.get('/api/movements', (req, res) => {
  res.json(movements);
});

// 2. Add movement record
app.post('/api/movements', (req, res) => {
  const { name, role, destination, purpose, outTime, latitude, longitude } = req.body;
  if (!name || !destination || !purpose) {
    return res.status(400).json({ error: 'Name, destination, and purpose are required.' });
  }

  const newRecord = {
    id: req.body.id || 'mov_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
    name: name.trim(),
    role: (role || 'স্টাফ').trim(),
    destination: destination.trim(),
    purpose: purpose.trim(),
    outTime: outTime || new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka', hour12: true }),
    returnTime: null,
    isReturned: false,
    stops: req.body.stops || [],
    latitude: latitude || null,
    longitude: longitude || null,
    mapsUrl: latitude && longitude ? `https://maps.google.com/?q=${latitude},${longitude}` : null,
    createdAt: new Date().toISOString()
  };

  movements.unshift(newRecord);
  saveMovements();

  // If GPS coordinates provided, add to active tracking
  if (latitude && longitude) {
    activeLocations.set(newRecord.id, {
      movementId: newRecord.id,
      staffName: newRecord.name,
      role: newRecord.role,
      destination: newRecord.destination,
      latitude,
      longitude,
      speed: 0,
      timestamp: Date.now()
    });
  }

  // Real-time broadcast to all connected devices (workers & admin)
  io.emit('movement_added', newRecord);
  io.emit('notification', {
    title: `🔔 নতুন মুভমেন্ট: ${newRecord.name} (${newRecord.role})`,
    message: `গন্তব্য: ${newRecord.destination} (${newRecord.purpose})`,
    recordId: newRecord.id
  });

  // Sync with Google Sheets
  forwardToGoogleSheets(newRecord, 'NEW_ENTRY');

  res.status(201).json(newRecord);
});

// 3. Mark movement as returned (Stops GPS tracking & respects privacy!)
app.post('/api/movements/:id/return', (req, res) => {
  const id = req.params.id;
  const index = movements.findIndex(m => m.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Record not found' });
  }

  const record = movements[index];
  record.isReturned = true;
  record.returnTime = req.body.returnTime || new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka', hour12: true });

  // PRIVACY FIRST: Immediately delete active GPS track when returned!
  activeLocations.delete(id);

  saveMovements();

  // Realtime Broadcast
  io.emit('movement_returned', record);
  io.emit('location_removed', { movementId: id });
  io.emit('notification', {
    title: `🟢 ফিরে এসেছেন: ${record.name}`,
    message: `${record.destination} থেকে কাজ সম্পন্ন করে ফ্যাক্টরিতে ফিরে এসেছেন।`,
    recordId: id
  });

  // Sync to Google Sheets
  forwardToGoogleSheets(record, 'RETURNED');

  res.json(record);
});

// 4. Add Next Stop
app.post('/api/movements/:id/stop', (req, res) => {
  const id = req.params.id;
  const index = movements.findIndex(m => m.id === id);
  if (index === -1) {
    return res.status(404).json({ error: 'Record not found' });
  }

  const { destination, purpose, latitude, longitude } = req.body;
  const newStop = {
    id: 'stop_' + Date.now(),
    destination: (destination || '').trim(),
    purpose: (purpose || '').trim(),
    time: new Date().toLocaleString('en-US', { timeZone: 'Asia/Dhaka', hour12: true }),
    mapsUrl: latitude && longitude ? `https://maps.google.com/?q=${latitude},${longitude}` : null
  };

  movements[index].stops = movements[index].stops || [];
  movements[index].stops.push(newStop);
  saveMovements();

  io.emit('movement_updated', movements[index]);
  forwardToGoogleSheets(movements[index], 'ADD_STOP');

  res.json(movements[index]);
});

// 5. Delete movement
app.delete('/api/movements/:id', (req, res) => {
  const id = req.params.id;
  movements = movements.filter(m => m.id !== id);
  activeLocations.delete(id);
  saveMovements();

  io.emit('movement_deleted', { id });
  res.json({ success: true, id });
});

// 6. Real-time GPS Location Ping (Active ONLY while staff is outside!)
app.post('/api/locations', (req, res) => {
  const { movementId, staffName, role, destination, latitude, longitude, speed } = req.body;
  if (!movementId || !latitude || !longitude) {
    return res.status(400).json({ error: 'movementId, latitude, and longitude are required' });
  }

  // Ensure movement is not returned
  const record = movements.find(m => m.id === movementId);
  if (record && record.isReturned) {
    // If user has already returned, ignore GPS ping for strict privacy
    activeLocations.delete(movementId);
    return res.status(403).json({ error: 'Worker has returned. Tracking is stopped for privacy.' });
  }

  const locData = {
    movementId,
    staffName: staffName || (record ? record.name : 'Unknown'),
    role: role || (record ? record.role : 'স্টাফ'),
    destination: destination || (record ? record.destination : ''),
    latitude: Number(latitude),
    longitude: Number(longitude),
    speed: speed || 0,
    timestamp: Date.now()
  };

  activeLocations.set(movementId, locData);

  // Update record last known location
  if (record) {
    record.latitude = Number(latitude);
    record.longitude = Number(longitude);
    record.mapsUrl = `https://maps.google.com/?q=${latitude},${longitude}`;
  }

  // Broadcast to all listening Admin dashboards
  io.emit('location_update', locData);

  res.json({ success: true, tracking: true });
});

// 7. Get all active GPS locations (for Google Maps view)
app.get('/api/locations', (req, res) => {
  const list = Array.from(activeLocations.values());
  res.json(list);
});

// 8. Night 9:00 PM Unreturned Alert Check
app.get('/api/alerts/night9pm', (req, res) => {
  const unreturned = movements.filter(m => !m.isReturned);
  res.json({
    count: unreturned.length,
    records: unreturned
  });
});

app.post('/api/alerts/night9pm/trigger', (req, res) => {
  const unreturned = movements.filter(m => !m.isReturned);
  if (unreturned.length > 0) {
    const names = unreturned.map(u => `${u.name} (${u.destination})`).join(', ');
    io.emit('night_9pm_alert', {
      count: unreturned.length,
      names: names,
      records: unreturned
    });
  }
  res.json({ success: true, triggeredCount: unreturned.length });
});

// 9. App Version Update Endpoints
app.get('/api/app-update', (req, res) => {
  res.json(appUpdateInfo);
});

app.post('/api/app-update', (req, res) => {
  const { latestVersionCode, latestVersionName, downloadUrl, updateNotes, forceUpdate } = req.body;
  if (!latestVersionCode || !latestVersionName) {
    return res.status(400).json({ error: 'latestVersionCode and latestVersionName are required.' });
  }

  appUpdateInfo = {
    latestVersionCode: Number(latestVersionCode),
    latestVersionName: String(latestVersionName),
    downloadUrl: downloadUrl || appUpdateInfo.downloadUrl,
    updateNotes: updateNotes || appUpdateInfo.updateNotes,
    forceUpdate: Boolean(forceUpdate)
  };

  saveAppUpdate();

  // Instant notification broadcast to all connected devices!
  io.emit('app_update_available', appUpdateInfo);

  res.json({ success: true, appUpdateInfo });
});

// 10. Webhook config endpoint
app.post('/api/config/webhook', (req, res) => {
  const { sheetWebhookUrl } = req.body;
  if (sheetWebhookUrl) {
    config.sheetWebhookUrl = sheetWebhookUrl.trim();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  }
  res.json({ success: true, config });
});

// 11. Direct APK Download link
app.get('/download/apk', (req, res) => {
  const candidates = [
    path.join(__dirname, '..', 'FactoryMovementTracker.apk'),
    path.join(__dirname, 'public', 'FactoryMovementTracker.apk'),
    path.join(__dirname, 'FactoryMovementTracker.apk')
  ];

  for (const apkPath of candidates) {
    if (fs.existsSync(apkPath)) {
      return res.download(apkPath, 'FactoryMovementTracker.apk');
    }
  }

  if (appUpdateInfo.downloadUrl) {
    return res.redirect(appUpdateInfo.downloadUrl);
  }

  res.status(404).send('APK not found on server.');
});

// Web Dashboard Homepage with Live Google Maps & Realtime Table
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Factory Movement Tracker - Live Server</title>
  <script src="/socket.io/socket.io.js"></script>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
    body { background:#0f172a; color:#f8fafc; padding:20px; }
    .header { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; border-bottom:1px solid #334155; padding-bottom:15px; }
    .title { font-size:24px; font-weight:bold; color:#38bdf8; display:flex; align-items:center; gap:10px; }
    .badge { background:#059669; color:#fff; padding:4px 12px; border-radius:9999px; font-size:12px; }
    .stats-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:15px; margin-bottom:20px; }
    .stat-card { background:#1e293b; padding:16px; border-radius:12px; border:1px solid #334155; }
    .stat-val { font-size:28px; font-weight:bold; color:#f1f5f9; }
    .stat-label { font-size:13px; color:#94a3b8; }
    #map { height:400px; border-radius:12px; margin-bottom:25px; border:2px solid #38bdf8; }
    table { width:100%; border-collapse:collapse; background:#1e293b; border-radius:12px; overflow:hidden; }
    th, td { padding:12px 16px; text-align:left; border-bottom:1px solid #334155; }
    th { background:#0f172a; color:#38bdf8; font-weight:600; }
    .tag-out { background:#dc2626; color:#fff; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:600; }
    .tag-ret { background:#16a34a; color:#fff; padding:3px 8px; border-radius:6px; font-size:11px; font-weight:600; }
    .btn-update { background:#3b82f6; color:#fff; padding:8px 16px; border:none; border-radius:8px; cursor:pointer; font-weight:bold; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">
      <span>🏭 ফ্যাক্টরি মুভমেন্ট ট্র্যাকার (সেন্ট্রাল সার্ভার)</span>
      <span class="badge" id="connStatus">অনলাইন</span>
    </div>
    <div>
      <a href="/download/apk" style="text-decoration:none;"><button class="btn-update">📥 APK ডাউনলোড</button></a>
    </div>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-val" id="statTotal" style="color:#38bdf8;">0</div>
      <div class="stat-label">মোট রেকর্ড</div>
    </div>
    <div class="stat-card">
      <div class="stat-val" id="statOut" style="color:#ef4444;">0</div>
      <div class="stat-label">বর্তমানে বাহিরে আছেন</div>
    </div>
    <div class="stat-card">
      <div class="stat-val" id="statRet" style="color:#22c55e;">0</div>
      <div class="stat-label">ফিরে এসেছেন</div>
    </div>
  </div>

  <h3 style="margin-bottom:10px; color:#38bdf8;">📍 রিয়েল-টাইম গুগল/ওপেনম্যাপ লাইভ ট্র্যাকিং</h3>
  <div id="map"></div>

  <h3 style="margin-bottom:10px; color:#38bdf8;">📋 আজকের মুভমেন্ট তালিকা</h3>
  <table>
    <thead>
      <tr>
        <th>নাম ও পদবি</th>
        <th>গন্তব্য</th>
        <th>কাজের উদ্দেশ্য</th>
        <th>বের হওয়ার সময়</th>
        <th>অবস্থা</th>
        <th>ম্যাপ</th>
      </tr>
    </thead>
    <tbody id="movementsBody">
      <tr><td colspan="6" style="text-align:center;">ডাটা লোড হচ্ছে...</td></tr>
    </tbody>
  </table>

  <script>
    const socket = io();
    const map = L.map('map').setView([23.7289, 90.4124], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    }).addTo(map);

    const markers = {};

    function updateStats(records) {
      document.getElementById('statTotal').innerText = records.length;
      document.getElementById('statOut').innerText = records.filter(r => !r.isReturned).length;
      document.getElementById('statRet').innerText = records.filter(r => r.isReturned).length;
    }

    function renderTable(records) {
      updateStats(records);
      const tbody = document.getElementById('movementsBody');
      if (records.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px;">কোনো এন্ট্রি পাওয়া যায়নি</td></tr>';
        return;
      }
      tbody.innerHTML = records.map(r => \`
        <tr>
          <td><strong>\${r.name}</strong><br><span style="font-size:11px; color:#94a3b8;">\${r.role}</span></td>
          <td>\${r.destination}</td>
          <td>\${r.purpose}</td>
          <td>\${r.outTime}</td>
          <td>\${r.isReturned ? '<span class="tag-ret">ফিরে এসেছে</span>' : '<span class="tag-out">বাহিরে আছে</span>'}</td>
          <td><a href="https://maps.google.com/?q=\${r.latitude || 23.7289},\${r.longitude || 90.4124}" target="_blank" style="color:#38bdf8; text-decoration:none;">🗺️ ভিউ</a></td>
        </tr>
      \`).join('');
    }

    async function loadData() {
      try {
        const res = await fetch('/api/movements');
        const data = await res.json();
        renderTable(data);
      } catch (e) {
        console.error(e);
      }
      try {
        const locRes = await fetch('/api/locations');
        const locs = await locRes.json();
        locs.forEach(loc => addOrUpdateMarker(loc));
      } catch (e) {
        console.error(e);
      }
    }

    function addOrUpdateMarker(loc) {
      if (markers[loc.movementId]) {
        markers[loc.movementId].setLatLng([loc.latitude, loc.longitude]);
      } else {
        const marker = L.marker([loc.latitude, loc.longitude]).addTo(map)
          .bindPopup(\`<b>\${loc.staffName} (\${loc.role})</b><br>গন্তব্য: \${loc.destination}<br><a href="https://maps.google.com/?q=\${loc.latitude},\${loc.longitude}" target="_blank">গুগল ম্যাপে দেখুন</a>\`);
        markers[loc.movementId] = marker;
      }
    }

    socket.on('connect', () => {
      document.getElementById('connStatus').innerText = 'সার্ভার কানেক্টেড';
      document.getElementById('connStatus').style.background = '#059669';
    });

    socket.on('disconnect', () => {
      document.getElementById('connStatus').innerText = 'ডিসকানেক্টেড';
      document.getElementById('connStatus').style.background = '#dc2626';
    });

    socket.on('movement_added', (rec) => {
      loadData();
    });

    socket.on('movement_returned', (rec) => {
      if (markers[rec.id]) {
        map.removeLayer(markers[rec.id]);
        delete markers[rec.id];
      }
      loadData();
    });

    socket.on('location_update', (loc) => {
      addOrUpdateMarker(loc);
    });

    socket.on('location_removed', (data) => {
      if (markers[data.movementId]) {
        map.removeLayer(markers[data.movementId]);
        delete markers[data.movementId];
      }
    });

    loadData();
  </script>
</body>
</html>
  `);
});

// Night 9:00 PM Auto Alert Loop (Checks every minute)
let lastAlertDate = null;
setInterval(() => {
  const now = new Date();
  const dhakaTimeStr = now.toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka', hour12: false });
  const [hours, minutes] = dhakaTimeStr.split(':').map(Number);
  const todayStr = now.toISOString().split('T')[0];

  // At 21:00 (9 PM) Dhaka time
  if (hours === 21 && minutes === 0 && lastAlertDate !== todayStr) {
    lastAlertDate = todayStr;
    const unreturned = movements.filter(m => !m.isReturned);
    if (unreturned.length > 0) {
      console.log(`[9:00 PM ALERT] ${unreturned.length} workers have not returned yet!`);
      const names = unreturned.map(u => `${u.name} (${u.destination})`).join(', ');
      io.emit('night_9pm_alert', {
        count: unreturned.length,
        names: names,
        records: unreturned
      });
    }
  }
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(` Factory Movement Tracker Server Running!`);
  console.log(` Port: ${PORT}`);
  console.log(` Ready for Render.com deployment`);
  console.log(`===============================================`);
});
