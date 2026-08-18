import { describe, expect, it } from 'vitest';
import { isUtf16Boundary, utf16ContextWindow } from './context.js';

describe('UTF-16 anchor context windows',()=>{
  it('widens both nominal 32-unit edges instead of splitting surrogate pairs',()=>{
    const prefix=`🙂${'a'.repeat(31)}`,exact='target',suffix=`${'b'.repeat(31)}🙂`,text=prefix+exact+suffix,start=prefix.length,end=start+exact.length,context=utf16ContextWindow(text,start,end);
    expect(context).toEqual({prefix,suffix});
    expect(context.prefix.length).toBe(33);expect(context.suffix.length).toBe(33);
    expect(isUtf16Boundary(text,start-context.prefix.length)).toBe(true);
    expect(isUtf16Boundary(text,end+context.suffix.length)).toBe(true);
  });

  it('rejects exact selection offsets inside a surrogate pair',()=>{
    expect(isUtf16Boundary('🙂 target',1)).toBe(false);
    expect(()=>utf16ContextWindow('🙂 target',1,2)).toThrow(/UTF-16/);
    expect(()=>utf16ContextWindow('target 🙂',0,8)).toThrow(/UTF-16/);
  });
});
