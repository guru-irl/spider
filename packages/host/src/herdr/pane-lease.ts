// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Gurupungav Narayanan
export const PANE_LEASE_WRITER: string = String.raw`
try{
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),[root,id]=process.argv.slice(1),uid=process.getuid?.();
const fail=()=>{throw new Error('pane-lease-unsafe')},check=(file,directory)=>{const s=fs.lstatSync(file);if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile())||uid!==undefined&&(s.uid!==uid||(s.mode&0o077)!==0))fail()};
if(!path.isAbsolute(root)||fs.realpathSync(root)!==root||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(id)||id==='.'||id==='..')fail();check(root,true);
const dir=path.join(root,'.view-leases');try{fs.mkdirSync(dir,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e}check(dir,true);
const bytes=fs.readFileSync(0);if(bytes.length>65536)fail();const value=JSON.parse(bytes);if(value.version!==1||value.leaseId!==id||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<0)fail();
const file=path.join(dir,id+'.json');try{check(file,false)}catch(e){if(e.code!=='ENOENT')throw e}
if(value.state==='stopped'){if(value.expiresAt!==0)fail();try{fs.unlinkSync(file)}catch(e){if(e.code!=='ENOENT')throw e}}
else{const temporary=file+'.'+crypto.randomUUID()+'.new';const fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(temporary,file)}
}catch(error){process.stderr.write('pane-lease-unsafe\n');process.exitCode=1}
`;
