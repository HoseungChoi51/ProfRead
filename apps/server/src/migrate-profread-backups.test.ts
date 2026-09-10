import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const directories:string[]=[],execute=promisify(execFile),script=resolve('scripts/migrate-profread-backups.mjs');
afterEach(async()=>{for(const directory of directories.splice(0))await rm(directory,{recursive:true,force:true})});
async function fixture(){const directory=await mkdtemp(join(tmpdir(),'profread-history-test-'));directories.push(directory);const source=join(directory,'afterdraft'),target=join(directory,'profread');await mkdir(source);return{source,target}}
describe('backup history carry-forward',()=>{
  it('copies and verifies nested histories without renaming checksum references or modifying legacy archives',async()=>{
    const{source,target}=await fixture(),archive='afterdraft-20260909T180814Z.tar.gz';await mkdir(join(source,'20260909T180814Z'));
    const files:{[key:string]:string}={[archive]:'immutable archive',[`${archive}.sha256`]:`old-checksum  ${archive}\n`,[`20260909T180814Z/metadata.txt`]:'volume=afterdraft-data\n'};
    for(const[name,value]of Object.entries(files))await writeFile(join(source,name),value);
    await symlink(archive,join(source,'latest-archive'));
    const result=await execute(process.execPath,[script,source,target]);
    expect(JSON.parse(result.stdout)).toMatchObject({copiedFilesVerified:3,legacyHistoryPreserved:true});
    for(const[name,value]of Object.entries(files)){expect(await readFile(join(source,name),'utf8')).toBe(value);expect(await readFile(join(target,name),'utf8')).toBe(value)}
    expect(await readFile(join(target,'latest-archive'),'utf8')).toBe('immutable archive');
    expect(await readdir(target)).not.toContain('.profread-history-migration-incomplete');
    await expect(execute(process.execPath,[script,source,target])).rejects.toThrow();
  });
  it('refuses ambiguous paths, symlink roots, and existing target histories',async()=>{
    const{source,target}=await fixture();await mkdir(target);await writeFile(join(target,'keep.txt'),'existing backup');
    await expect(execute(process.execPath,[script,source,target])).rejects.toThrow();
    expect(await readFile(join(target,'keep.txt'),'utf8')).toBe('existing backup');
    await expect(execute(process.execPath,[script,source,join(target,'nested')])).rejects.toThrow();
    const second=await fixture();await rm(second.source,{recursive:true});await symlink(source,second.source);
    await expect(execute(process.execPath,[script,second.source,second.target])).rejects.toThrow();
  });
});
