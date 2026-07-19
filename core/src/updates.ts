import { compareSemver } from "./catalog.js";
import type { CatalogGame, InstalledTitle } from "./types.js";

export function availableUpdate(installed: InstalledTitle, game: CatalogGame, catalogSigned: boolean): CatalogGame | null {
  if (!catalogSigned || installed.gameId !== game.id || installed.titleId !== game.title_id || installed.contentId !== game.content_id) return null;
  if (game.legal.redistribution_status !== "approved" || !/^[a-f0-9]{64}$/.test(game.package.sha256)) return null;
  return compareSemver(game.version, installed.installedVersion) > 0 ? game : null;
}
