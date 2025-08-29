const fs = require('fs');
const path = require('path');
const file = path.resolve(__dirname, '..', 'server.js');
const s = fs.readFileSync(file, 'utf8');
let brace=0, paren=0, bracket=0;
let inSingle=false,inDouble=false,inBack=false,inLine=false,inBlock=false,esc=false;
const problems=[];
for(let i=0;i<s.length;i++){
  const ch = s[i];
  if(inLine){ if(ch==='\n') inLine=false; continue; }
  if(inBlock){ if(ch==='*' && s[i+1]==='/'){ inBlock=false; i++; continue; } continue; }
  if(esc){ esc=false; continue; }
  if(ch==='\\') { esc=true; continue; }
  if(!inSingle && !inDouble && !inBack){ if(ch==='/' && s[i+1]==='/'){ inLine=true; i++; continue; } if(ch==='/' && s[i+1]==='*'){ inBlock=true; i++; continue; } }
  if(!inDouble && !inBack && ch==="'"){ inSingle=!inSingle; continue; }
  if(!inSingle && !inBack && ch==='"'){ inDouble=!inDouble; continue; }
  if(!inSingle && !inDouble && ch==='`'){ inBack=!inBack; continue; }
  if(inSingle||inDouble||inBack) continue;
  if(ch==='{') brace++; else if(ch==='}') { brace--; if(brace<0) problems.push({i,reason:'brace negative',context:s.slice(Math.max(0,i-40),i+40)}); }
  else if(ch==='(') paren++; else if(ch===')'){ paren--; if(paren<0) problems.push({i,reason:'paren negative',context:s.slice(Math.max(0,i-40),i+40)}); }
  else if(ch==='[') bracket++; else if(ch===']'){ bracket--; if(bracket<0) problems.push({i,reason:'bracket negative',context:s.slice(Math.max(0,i-40),i+40)}); }
}
const tail = s.slice(-2000);
const out = { brace, paren, bracket, problems: problems.slice(0,20), tail };
fs.writeFileSync(path.resolve(__dirname, '..', '_parse_report.json'), JSON.stringify(out,null,2));
console.log('wrote _parse_report.json');
