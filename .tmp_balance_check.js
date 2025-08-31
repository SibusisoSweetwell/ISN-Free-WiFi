const fs=require('fs'); const path=require('path'); const p=path.resolve('.tmp_extracted_specific.js'); const s=fs.readFileSync(p,'utf8');
let line=1,col=0; const report=(msg,i)=>{const upto=s.slice(0,i); line=upto.split('\n').length; col=i-upto.lastIndexOf('\n'); console.log(msg,'at index',i,'line',line,'col',col); console.log(s.slice(Math.max(0,i-120),Math.min(s.length,i+60))); process.exit(0);};
let stack=[]; let inSingle=false,inDouble=false,inTemplate=false,escaped=false,inLineComment=false,inBlockComment=false;
for(let i=0;i<s.length;i++){ const ch=s[i]; const prev=s[i-1]; if(inLineComment){ if(ch==='\n') inLineComment=false; continue;} if(inBlockComment){ if(prev==='*'&&ch==='/'){ inBlockComment=false;} continue;} if(escaped){ escaped=false; continue;} if(inSingle){ if(ch==='\\') { escaped=true; } else if(ch==='\'') { inSingle=false; } continue;} if(inDouble){ if(ch==='\\') { escaped=true; } else if(ch==='"') { inDouble=false; } continue;} if(inTemplate){ if(ch==='`') { inTemplate=false; } else if(ch==='\\') { escaped=true; } continue;} // not in string/comment
 if(prev==='/' && ch==='/' ){ inLineComment=true; continue;} if(prev==='/' && ch==='*'){ inBlockComment=true; continue;}
 if(ch==='\'') { inSingle=true; continue;} if(ch==='"') { inDouble=true; continue;} if(ch==='`'){ inTemplate=true; continue;} if(ch==='('){ stack.push('(');} else if(ch===')'){ if(stack.length===0||stack[stack.length-1]!=='(') report('Unmatched )',i); else stack.pop(); }
 if(ch==='['){ stack.push('[');} else if(ch===']'){ if(stack.length===0||stack[stack.length-1]!=='[') report('Unmatched ]',i); else stack.pop(); }
 if(ch==='{'){ stack.push('{'); } else if(ch==='}'){ if(stack.length===0||stack[stack.length-1] !== '{') report('Unmatched }',i); else stack.pop(); }
}
if(inSingle) console.log('Unclosed single quote at EOF');
if(inDouble) console.log('Unclosed double quote at EOF');
if(inTemplate) console.log('Unclosed template literal at EOF');
if(inBlockComment) console.log('Unclosed block comment at EOF');
if(stack.length) console.log('Unclosed tokens at EOF:', stack.slice(-20)); else console.log('All tokens balanced');
