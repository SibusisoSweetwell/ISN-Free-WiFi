const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const outPath = path.join(__dirname, '..', 'server_run_capture.log');
const out = fs.createWriteStream(outPath, { flags: 'a' });
const env = Object.assign({}, process.env, { USE_SQLITE: 'true', SQLITE_PATH: path.join(__dirname, '..', 'data.sqlite') });
const node = process.execPath || 'node';
const serverFile = path.join(__dirname, '..', 'server.js');
const child = spawn(node, [serverFile], { env, cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
out.write('\n=== START ' + new Date().toISOString() + ' PID ' + child.pid + ' ===\n');
child.stdout.pipe(out);
child.stderr.pipe(out);
console.log('started', child.pid, 'log ->', outPath);
// Wait 6 seconds to capture startup then print a small tail
setTimeout(() => {
  out.write('\n=== END CAPTURE ' + new Date().toISOString() + ' ===\n');
  out.end();
  // print tail to stdout
  try {
    const data = fs.readFileSync(outPath, 'utf8');
    const parts = data.split('\n');
    const tail = parts.slice(-80).join('\n');
    console.log('\n--- last 80 lines of log ---\n' + tail);
  } catch (e) {
    console.error('failed to read log', e && e.message);
  }
  // don't kill child; leave server running
}, 6000);
