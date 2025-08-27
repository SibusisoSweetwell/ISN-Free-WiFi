console.log('=== STARTING MINIMAL SERVER TEST ===');

process.stdout.write('Loading Express...\n');
const express = require('express');
process.stdout.write('Express loaded\n');

const app = express();
const PORT = 3150;

process.stdout.write('Setting up routes...\n');

// Serve static files from the current directory
app.use(express.static(__dirname));

// Basic routes
app.get('/', (req, res) => {
    res.redirect('/login.html');
});

app.get('/home.html', (req, res) => {
    res.sendFile(__dirname + '/home.html');
});

app.get('/login.html', (req, res) => {
    res.sendFile(__dirname + '/login.html');
});

app.get('/register.html', (req, res) => {
    res.sendFile(__dirname + '/register.html');
});

process.stdout.write('Starting server...\n');
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`=== SERVER STARTED ON PORT ${PORT} ===`);
    console.log('Server is ready to accept connections');
});

server.on('error', (err) => {
    console.error('Server error:', err);
    process.exit(1);
});

// Keep alive
setInterval(() => {
    console.log('Server heartbeat:', new Date().toISOString());
}, 30000);

console.log('=== SETUP COMPLETE ===');
