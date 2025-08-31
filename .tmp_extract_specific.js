const fs = require('fs');
const path = require('path');
const htmlPath = path.resolve('c:/Users/Teacher/ISN Free WiFi/home.html');
const outPath = path.resolve('c:/Users/Teacher/ISN Free WiFi/.tmp_extracted_specific.js');
const s = fs.readFileSync(htmlPath,'utf8');
const marker = '// --- Quota enforcement client logic ---';
const markerIdx = s.indexOf(marker);
if(markerIdx===-1){ console.error('Marker not found'); process.exit(2); }
const scriptOpen = s.lastIndexOf('<script', markerIdx);
if(scriptOpen===-1){ console.error('No <script before marker'); process.exit(2); }
const openTagEnd = s.indexOf('>', scriptOpen);
const closeTag = s.indexOf('</script>', markerIdx);
if(openTagEnd===-1||closeTag===-1){ console.error('Could not find script boundaries'); process.exit(2); }
const script = s.slice(openTagEnd+1, closeTag);
fs.writeFileSync(outPath, script, 'utf8');
console.log('Wrote', outPath, 'size', script.length);
