import { chmod, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** Deterministic LSP transport peer, configured through the real settings UI. */
export async function createLanguageHarness(root: string) {
  const executable = join(root, "language-fixture")
  const calls = join(root, "language-calls.jsonl")
  await writeFile(
    executable,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
let buffer=Buffer.alloc(0),opened=new Map();
const send=(id,result)=>{const data=Buffer.from(JSON.stringify({jsonrpc:'2.0',id,result}));process.stdout.write('Content-Length: '+data.length+'\\r\\n\\r\\n');process.stdout.write(data);};
for await (const chunk of process.stdin) {
 buffer=Buffer.concat([buffer,chunk]);
 while(true) {
  const split=buffer.indexOf('\\r\\n\\r\\n');if(split<0)break;
  const length=Number(buffer.subarray(0,split).toString().match(/Content-Length:\\s*(\\d+)/i)?.[1]);if(buffer.length<split+4+length)break;
  const message=JSON.parse(buffer.subarray(split+4,split+4+length));buffer=buffer.subarray(split+4+length);
  const {id,method,params}=message;
  appendFileSync(${JSON.stringify(calls)},JSON.stringify({method,uri:params?.textDocument?.uri})+'\\n');
  if(method==='textDocument/didOpen')opened.set(params.textDocument.uri,params.textDocument.text);
  if(id===undefined)continue;
  let result=null;
  if(method==='initialize')result={capabilities:{positionEncoding:'utf-16',hoverProvider:true,definitionProvider:true,referencesProvider:true,documentSymbolProvider:true,semanticTokensProvider:{full:true,legend:{tokenTypes:['parameter'],tokenModifiers:['declaration']}}}};
  if(method==='textDocument/semanticTokens/full') { const text=opened.get(params.textDocument.uri)||'',column=text.split('\\n')[0].indexOf('userId');result={data:column<0?[]:[0,column,6,0,1]}; }
  if(method==='textDocument/hover')result={contents:{kind:'markdown',value:'**Captured parameter** — used by this version of the function.'}};
  if(method==='textDocument/definition'||method==='textDocument/references')result=[params.textDocument.uri,params.textDocument.uri.replace(/answer\\.ts$/,'other.ts')].map(uri=>({uri,range:{start:{line:0,character:0},end:{line:0,character:1}}}));
  if(method==='textDocument/documentSymbol')result=[{name:'renderUser',kind:12,range:{start:{line:0,character:0},end:{line:0,character:1}},selectionRange:{start:{line:0,character:0},end:{line:0,character:1}}}];
  send(id,result);
 }
}
`
  )
  await chmod(executable, 0o700)
  return { executable, calls }
}
