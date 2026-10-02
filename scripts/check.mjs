import { readFileSync, readdirSync } from 'node:fs';
import { Script } from 'node:vm';
import { execFileSync } from 'node:child_process';
execFileSync(process.execPath,['--check','src/index.js'],{stdio:'inherit'});
for (const path of readdirSync('public',{recursive:true}).filter(p=>p.endsWith('.html'))) {
  const html=readFileSync('public/'+path,'utf8');
  for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new Script(match[1],{filename:path});
}
console.log('Worker and all inline scripts parsed successfully.');
