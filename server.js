const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// إعداد الجلسات والمجلدات العامة
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));
app.use(session({
    secret: 'discord_arabic_secret_key',
    resave: false,
    saveUninitialized: false
}));

// إعداد نظام رفع الملفات والصور
const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// الاتصال بقاعدة البيانات SQLite وإنشاء الجداول
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error(err.message);
    console.log('تم الاتصال بقاعدة بيانات SQLite بنجاح.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT, avatar TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, icon TEXT, invite_code TEXT UNIQUE)`);
    db.run(`CREATE TABLE IF NOT EXISTS channels (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER, name TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER, username TEXT, message TEXT, file_url TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

// مصفوفة لتتبع حالة اتصال المستخدمين لحظياً
let activeUsers = {};

// --- مسارات الـ API الحسابات والسيرفرات ---
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    const hashedPassword = bcrypt.hashSync(password, 10);
    const avatar = `https://dicebear.com{username}`;

    db.run(`INSERT INTO users (username, password, avatar) VALUES (?, ?, ?)`, [username, hashedPassword, avatar], function(err) {
        if (err) return res.status(400).json({ error: 'اسم المستخدم مسجل مسبقاً!' });
        res.json({ success: true });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, user) => {
        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.status(400).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        }
        req.session.user = { id: user.id, username: user.username, avatar: user.avatar };
        res.json({ success: true, user: req.session.user });
    });
});

app.get('/api/me', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'غير مسجل الدخول' });
    res.json(req.session.user);
});

app.post('/api/servers', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'غير مصرح' });
    const { name } = req.body;
    const inviteCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const icon = `https://dicebear.com{name}`;

    db.run(`INSERT INTO servers (name, icon, invite_code) VALUES (?, ?, ?)`, [name, icon, inviteCode], function(err) {
        const serverId = this.lastID;
        // إنشاء قناة عامة تلقائياً عند إنشاء السيرفر
        db.run(`INSERT INTO channels (server_id, name) VALUES (?, ?)`, [serverId, 'العامة'], () => {
            res.json({ success: true, serverId });
        });
    });
});

app.get('/api/servers', (req, res) => {
    db.all(`SELECT * FROM servers`, [], (err, rows) => res.json(rows || []));
});

app.get('/api/servers/:serverId/channels', (req, res) => {
    db.all(`SELECT * FROM channels WHERE server_id = ?`, [req.params.serverId], (err, rows) => res.json(rows || []));
});

app.post('/api/servers/:serverId/channels', (req, res) => {
    const { name } = req.body;
    db.run(`INSERT INTO channels (server_id, name) VALUES (?, ?)`, [req.params.serverId, name], function() {
        res.json({ success: true });
    });
});

app.get('/api/channels/:channelId/messages', (req, res) => {
    db.all(`SELECT * FROM messages WHERE channel_id = ? ORDER BY timestamp ASC`, [req.params.channelId], (err, rows) => res.json(rows || []));
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع ملف' });
    res.json({ fileUrl: `/uploads/${req.file.filename}` });
});

// --- إدارة اتصالات Socket.io الفورية ---
io.on('connection', (socket) => {
    socket.on('user_connected', (username) => {
        activeUsers[socket.id] = { username, status: 'online' };
        io.emit('update_user_status', Object.values(activeUsers));
    });

    socket.on('join_channel', (channelId) => {
        socket.join(`channel_${channelId}`);
    });

    socket.on('send_message', (data) => {
        const { channelId, username, message, fileUrl } = data;
        db.run(`INSERT INTO messages (channel_id, username, message, file_url) VALUES (?, ?, ?, ?)`, 
        [channelId, username, message, fileUrl || null], function() {
            io.to(`channel_${channelId}`).emit('new_message', {
                id: this.lastID, channel_id: channelId, username, message, file_url: fileUrl || null, timestamp: new Date()
            });
        });
    });

    socket.on('disconnect', () => {
        delete activeUsers[socket.id];
        io.emit('update_user_status', Object.values(activeUsers));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`السيرفر يعمل على المنفذ المفتوح: http://localhost:${PORT}`));
