// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
/** Only built-ins: resolve the installed package before importing any native dependency. */
export const PANE_ENDPOINT_BOOTSTRAP: string = String.raw`
(async()=>{
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),url=require('node:url');
const fail=code=>{throw Object.assign(new Error(code),{paneCode:code})};
const [digest,protocolText,requestText]=process.argv.slice(1),protocol=Number(protocolText);
if(!/^[a-f0-9]{64}$/.test(digest)||!Number.isSafeInteger(protocol)||protocol<1||Buffer.byteLength(requestText||'')>1048576)fail('pane-endpoint-protocol-mismatch');
const uid=process.getuid?.(),safe=(p,directory,privateMode=false)=>{let s;try{s=fs.lstatSync(p)}catch(e){if(e.code==='ENOENT')fail('pane-installation-missing');throw e}if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile())||uid!==undefined&&(s.uid!==uid||(s.mode&(privateMode?0o077:0o022))!==0))fail('pane-installation-unsafe');return s};
const root=process.env.SPIDER_GLOBAL_ROOT||path.join(os.homedir(),'.pi','agent','spider');
if(!path.isAbsolute(root))fail('pane-installation-unsafe');
const dir=path.join(root,'herdr'),registry=path.join(dir,'installation.json');safe(dir,true,true);safe(registry,false,true);
let entry;try{const fd=fs.openSync(registry,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));try{const s=fs.fstatSync(fd);if(s.size>16384||uid!==undefined&&(s.uid!==uid||(s.mode&0o077)!==0))fail('pane-installation-unsafe');entry=JSON.parse(fs.readFileSync(fd,'utf8'))}finally{fs.closeSync(fd)}}catch(e){if(e.paneCode)throw e;fail('pane-installation-unsafe')}
if(!entry||entry.version!==1||typeof entry.packageRoot!=='string'||!path.isAbsolute(entry.packageRoot))fail('pane-installation-unsafe');
safe(entry.packageRoot,true);safe(path.join(entry.packageRoot,'dist'),true);safe(path.join(entry.packageRoot,'dist','herdr'),true);
if(!entry.endpoint)fail('pane-installation-missing');if(entry.endpoint.protocol!==protocol)fail('pane-endpoint-protocol-mismatch');if(entry.endpoint.digest!==digest||entry.endpoint.file!=='pane-endpoint-'+digest+'.mjs')fail('pane-endpoint-build-mismatch');
const original=path.join(entry.packageRoot,'dist','herdr','pane-endpoint.mjs');safe(original,false);if(crypto.createHash('sha256').update(fs.readFileSync(original)).digest('hex')!==digest)fail('pane-endpoint-build-mismatch');
const endpoint=path.join(entry.packageRoot,'dist','herdr',entry.endpoint.file);safe(endpoint,false);
const bytes=fs.readFileSync(endpoint);if(crypto.createHash('sha256').update(bytes).digest('hex')!==digest)fail('pane-endpoint-build-mismatch');
const installed=await import(url.pathToFileURL(endpoint).href);
if(crypto.createHash('sha256').update(fs.readFileSync(endpoint)).digest('hex')!==digest)fail('pane-endpoint-build-mismatch');
const admitted=installed.createProductionPaneEndpointPorts(digest);if(admitted.protocol!==protocol)fail('pane-endpoint-protocol-mismatch');if(admitted.buildDigest!==digest)fail('pane-endpoint-build-mismatch');
const create=async()=>installed.createProductionPaneEndpointPorts(digest);
const handshake=JSON.parse(await installed.runPaneEndpointCli(['--json',JSON.stringify({version:1,op:'handshake',protocol,buildDigest:digest})],create));
if(handshake.protocol!==protocol)fail('pane-endpoint-protocol-mismatch');if(handshake.buildDigest!==digest)fail('pane-endpoint-build-mismatch');
process.stdout.write(await installed.runPaneEndpointCli(['--json',requestText],create)+'\n');
})().catch(error=>{process.stderr.write(JSON.stringify({code:error.paneCode||'pane-endpoint-failed'})+'\n');process.exitCode=1});
`;

