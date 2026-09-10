import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const paths:string[]=[];
const script=fileURLToPath(new URL('../../../scripts/migrate-profread-environment.mjs',import.meta.url));
function fixture(value:string){const directory=mkdtempSync(join(tmpdir(),'profread-env-migration-'));paths.push(directory);const source=join(directory,'afterdraft.env'),target=join(directory,'profread.env');writeFileSync(source,value,{mode:0o600});return{source,target}}
afterEach(()=>{for(const path of paths.splice(0))rmSync(path,{recursive:true,force:true})});

describe('environment rename utility',()=>{
  it('changes variable keys only, preserves source values, and restricts output permissions',()=>{
    const value='# Keep comment\nAFTERDRAFT_PASSWORD=literal-afterdraft-value\nAFTERDRAFT_SESSION_SECRET=literal-AFTERDRAFT-value\nOPENAI_API_KEY=unchanged\n';
    const{source,target}=fixture(value);
    const output=execFileSync(process.execPath,[script,source,target],{encoding:'utf8'});
    expect(readFileSync(source,'utf8')).toBe(value);
    expect(readFileSync(target,'utf8')).toBe(value.replace('AFTERDRAFT_PASSWORD=','PROFREAD_PASSWORD=').replace('AFTERDRAFT_SESSION_SECRET=','PROFREAD_SESSION_SECRET='));
    expect(statSync(target).mode&0o777).toBe(0o600);
    expect(output).not.toContain('literal-');
  });
  it('refuses conflicting canonical configuration and existing targets',()=>{
    const first=fixture('AFTERDRAFT_PASSWORD=one\nPROFREAD_PASSWORD=two\n');
    expect(()=>execFileSync(process.execPath,[script,first.source,first.target],{stdio:'pipe'})).toThrow();
    const second=fixture('AFTERDRAFT_PASSWORD=one\n');writeFileSync(second.target,'existing');
    expect(()=>execFileSync(process.execPath,[script,second.source,second.target],{stdio:'pipe'})).toThrow();
    expect(readFileSync(second.target,'utf8')).toBe('existing');
  });
});
