const fs=require('fs'); const path='c:/Users/Teacher/ISN Free WiFi/home.html'; const s=fs.readFileSync(path,'utf8'); const open = s.lastIndexOf('<script>'); const close = s.lastIndexOf('</script>'); const code = s.slice(open+8, close); const lines=code.split('\n'); let stack=[]; const push=(c,i)=>stack.push({c,i}); for(let line=0;line<lines.length;line++){ const str=lines[line]; for(let col=0;col<str.length;col++){ const ch=str[col]; const top=stack.length?stack[stack.length-1].c:null; // handle escapes in strings/backticks
 if(top==='"' || top==="'" || top==='`'){
  if(ch==='\\') { col++; continue; }
  if(ch===top){ stack.pop(); continue; }
  continue;
 }
 if(ch==='"' || ch==="'" || ch==='`'){ push(ch,{line:line+1,col:col+1}); continue; }
 if(ch==='('||ch==='['||ch==='{'){ push(ch,{line:line+1,col:col+1}); continue; }
 if(ch===')'){ if(stack.length && stack[stack.length-1].c==='(') stack.pop(); else { console.log('UNMATCHED ) at',line+1,col+1); process.exit(1);} }
 if(ch===']'){ if(stack.length && stack[stack.length-1].c==='[') stack.pop(); else { console.log('UNMATCHED ] at',line+1,col+1); process.exit(1);} }
 if(ch==='}'){ if(stack.length && stack[stack.length-1].c==='{') stack.pop(); else { console.log('UNMATCHED } at',line+1,col+1); process.exit(1);} }
 }
}
if(stack.length){ console.log('UNBALANCED tokens found (top):', stack[stack.length-1]); console.log('Total remaining:',stack.length); process.exit(2);} console.log('ALL BALANCED');
