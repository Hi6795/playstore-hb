import { describe, expect, it } from "vitest";
import { NavigationModel, availableUpdate } from "../../core/src/index.js";
import { developmentGame } from "../fixtures/catalog.js";

describe("navigation and updates",()=>{
  it("restores focus when navigating back",()=>{const nav=new NavigationModel({screen:"home",focusId:"featured-3",history:[],categoryIndex:0,page:0});nav.open("game-details","download");nav.back();expect(nav.state).toMatchObject({screen:"home",focusId:"featured-3"});});
  it("debounces controller input",()=>{const nav=new NavigationModel();expect(nav.acceptInput(1000)).toBe(true);expect(nav.acceptInput(1050)).toBe(false);expect(nav.acceptInput(1200)).toBe(true);});
  it("requires identity, signature, approval, and newer semver for updates",()=>{const game=developmentGame({version:"1.1.0"});const installed={gameId:game.id,titleId:game.title_id,contentId:game.content_id,installedVersion:"1.0.0",packageHash:"0".repeat(64),installedAt:"2026-01-01T00:00:00Z",catalogSource:"stable",localState:"installed" as const,lastUpdateCheck:"2026-01-01T00:00:00Z"};expect(availableUpdate(installed,game,true)?.version).toBe("1.1.0");expect(availableUpdate(installed,game,false)).toBeNull();});
});
