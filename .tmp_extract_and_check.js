const fs = require('fs');
const path = require('path');
const htmlPath = path.resolve('c:/Users/Teacher/ISN Free WiFi/home.html');
const outPath = path.resolve('c:/Users/Teacher/ISN Free WiFi/.tmp_extracted_script.js');
const s = fs.readFileSync(htmlPath,'utf8');
const start = s.indexOf('<script>');
const end = s.lastIndexOf('</script>');
if(start===-1||end===-1||end<=start){
  console.error('Could not locate single <script>...</script> block');
  process.exit(2);
}
const script = s.slice(start+8,end);
fs.writeFileSync(outPath, script, 'utf8');
console.log('Wrote', outPath, 'size', script.length);
