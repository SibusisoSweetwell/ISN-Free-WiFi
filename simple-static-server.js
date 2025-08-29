const express = require('express');
const path = require('path');
const app = express();
const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT,10) || 3150;

app.use(express.static(path.join(__dirname)));
app.get('/', (req,res)=> res.sendFile(path.join(__dirname,'home.html')));

const server = app.listen(PORT, HOST, ()=>{
  console.log(`Static server running on http://${HOST}:${PORT}`);
});
server.on('error', (err)=>{
  console.error('Static server failed:', err && err.message);
  process.exit(1);
});

process.on('uncaughtException', err=>{ console.error('[uncaughtException]', err); });
process.on('unhandledRejection', err=>{ console.error('[unhandledRejection]', err); });
