const fs=require('fs'); const p='.tmp_extracted_specific.js'; const s=fs.readFileSync(p,'utf8');
let stack=[]; let inSingle=false,inDouble=false,inTemplate=false,escaped=false,inLineComment=false,inBlockComment=false;
for(let i=0;i<s.length;i++){ const ch=s[i]; const prev=s[i-1]; if(inLineComment){ if(ch==='\n') inLineComment=false; continue;} if(inBlockComment){ if(prev==='*'&&ch==='/'){ inBlockComment=false;} continue;} if(escaped){ escaped=false; continue;} if(inSingle){ if(ch==='\\') escaped=true; else if(ch==='\'') inSingle=false; continue;} if(inDouble){ if(ch==='\\') escaped=true; else if(ch==='"') inDouble=false; continue;} if(inTemplate){ if(ch==='`') inTemplate=false; else if(ch==='\\') escaped=true; continue;} // not in string/comment
 if(prev==='/' && ch==='/' ){ inLineComment=true; continue;} if(prev==='/' && ch==='*'){ inBlockComment=true; continue;}
 if(ch==='\'') { inSingle=true; continue;} if(ch==='"') { inDouble=true; continue;} if(ch==='`'){ inTemplate=true; continue;} if(ch==='('){ stack.push({type:'(',i}); } else if(ch===')'){ if(stack.length===0||stack[stack.length-1].type!=='(') console.log('Unmatched ) at',i); else stack.pop(); }
 if(ch==='['){ stack.push({type:'[',i}); } else if(ch===']'){ if(stack.length===0||stack[stack.length-1].type!=='[') console.log('Unmatched ] at',i); else stack.pop(); }
 if(ch==='{'){ stack.push({type:'{',i}); } else if(ch==='}'){ if(stack.length===0||stack[stack.length-1].type!=='{') console.log('Unmatched } at',i); else stack.pop(); }
}
function pos(i){ const upto=s.slice(0,i); const line=upto.split('\n').length; const col=i-upto.lastIndexOf('\n'); return {line,col}; }
console.log('Remaining stack length',stack.length);
stack.forEach((e,idx)=>{ const ppos=pos(e.i); console.log(idx, e.type, 'at index', e.i, 'line', ppos.line, 'col', ppos.col); const ctx=s.slice(Math.max(0,e.i-120), Math.min(s.length,e.i+60)); console.log('---context---\n'+ctx+'\n----'); });
