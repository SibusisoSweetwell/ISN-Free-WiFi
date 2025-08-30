const { spawn } = require('child_process');
const fs = require('fs');

function run(cmd, args, outFile){
  return new Promise((resolve, reject)=>{
    const p = spawn(cmd, args, { stdio: ['ignore','pipe','pipe'] });
    let out=''; let err='';
    p.stdout.on('data', d=> out += d.toString());
    p.stderr.on('data', d=> err += d.toString());
    p.on('close', code=>{
      if(code===0){ fs.writeFileSync(outFile, out || err); resolve(out || err); }
      else { fs.writeFileSync(outFile, out + '\n' + err); resolve(out + '\n' + err); }
    });
  });
}

(async ()=>{
  try{
    // Use curl-like PowerShell invoke-restmethod in a child process to avoid PSReadLine issues
    const grantCmd = 'powershell';
    const grantArgs = ['-NoProfile','-Command',"$h=@{ 'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64)'; 'X-Router-Id'='test-router' }; $b=@{ identifier='joseph@gmail.com'; bundleMB=100; routerId='test-router'; source='manual-test'; totalWatchTime=60; videosCompleted=5 } | ConvertTo-Json -Compress; (Invoke-RestMethod -Uri 'http://127.0.0.1:3150/api/bundle/grant' -Method Post -Body $b -ContentType 'application/json' -Headers $h) | ConvertTo-Json -Depth 5"];
    console.log('Posting grant...');
    await run(grantCmd, grantArgs, 'grant_result.txt');

    const checkCmd = 'powershell';
    const checkArgs = ['-NoProfile','-Command',"$h=@{ 'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64)'; 'X-Router-Id'='test-router' }; (Invoke-RestMethod -Uri 'http://127.0.0.1:3150/api/access/check?identifier=joseph@gmail.com' -Method Get -Headers $h) | ConvertTo-Json -Depth 5"];
    console.log('Checking access...');
    await run(checkCmd, checkArgs, 'access_result.txt');

    // capture a slice of server.log
    try{ const logs = fs.readFileSync('server.log','utf8').split('\n').slice(-200).join('\n'); fs.writeFileSync('server_recent.log', logs); }
    catch(e){ fs.writeFileSync('server_recent.log', 'failed to read server.log: '+e.message); }

    console.log('Saved grant_result.txt, access_result.txt, server_recent.log');
  }catch(e){ console.error('ERR', e.message); process.exit(2); }
})();
