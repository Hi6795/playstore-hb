export const SCREENS = [
  "splash", "first-run", "home", "browse", "categories", "search", "search-results", "game-details",
  "screenshots", "download-queue", "download-details", "installed", "updates", "storage", "settings",
  "network-diagnostics", "repository-status", "about", "error-details", "offline"
] as const;
export type Screen = (typeof SCREENS)[number];
export type ControllerAction = "up" | "down" | "left" | "right" | "select" | "back" | "search" | "secondary" | "previous-category" | "next-category" | "previous-page" | "next-page" | "menu";

export interface NavigationState { screen: Screen; focusId: string; history: Array<{ screen: Screen; focusId: string }>; categoryIndex: number; page: number }
export class NavigationModel {
  private lastInputAt = 0;
  constructor(public state: NavigationState = { screen: "splash", focusId: "start", history: [], categoryIndex: 0, page: 0 }) {}
  open(screen: Screen, focusId = "screen-root"): void { this.state.history.push({ screen: this.state.screen, focusId: this.state.focusId }); this.state.screen = screen; this.state.focusId = focusId; }
  back(): void { const previous = this.state.history.pop(); if (previous) { this.state.screen = previous.screen; this.state.focusId = previous.focusId; } }
  acceptInput(now = Date.now(), debounceMs = 120): boolean { if (now - this.lastInputAt < debounceMs) return false; this.lastInputAt = now; return true; }
  changeCategory(delta: number, count: number): void { this.state.categoryIndex = Math.max(0, Math.min(count - 1, this.state.categoryIndex + delta)); }
  changePage(delta: number, maxPage: number): void { this.state.page = Math.max(0, Math.min(maxPage, this.state.page + delta)); }
}
