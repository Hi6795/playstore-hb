import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AtomicJsonStore, DEFAULT_SETTINGS, validateSettings } from "../../core/src/index.js";

describe("atomic persistence",()=>{
  it("round trips validated state",async()=>{const dir=await mkdtemp(join(tmpdir(),"pshb-state-"));const path=join(dir,"settings.json");const store=new AtomicJsonStore(path,validateSettings,DEFAULT_SETTINGS);await store.save({...DEFAULT_SETTINGS,highContrast:true});expect((await store.load()).highContrast).toBe(true);expect(JSON.parse(await readFile(path,"utf8"))).toBeTruthy();});
  it("recovers corrupt state to defaults",async()=>{const dir=await mkdtemp(join(tmpdir(),"pshb-corrupt-"));const path=join(dir,"state.json");await writeFile(path,"{bad");const store=new AtomicJsonStore(path,(v)=>v as {items:number[]},{items:[]});expect(await store.load()).toEqual({items:[]});});
  it("rejects invalid settings",()=>expect(()=>validateSettings({...DEFAULT_SETTINGS,downloadConcurrency:9})).toThrow("Invalid concurrency"));
});
