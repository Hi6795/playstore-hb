import type { CatalogManifest, DownloadRecord, InstalledTitle } from "./types.js";

export interface InstallRequest { packagePath: string; gameId: string; titleId: string; contentId: string; version: string; sha256: string }
export interface InstallResult { success: boolean; resultCode: string; message: string }
export interface IPackageInstaller { install(request: InstallRequest, onProgress?: (percent: number) => void): Promise<InstallResult> }
export interface IInstalledTitleService { list(): Promise<InstalledTitle[]>; refresh(): Promise<void> }
export interface IStorageService { availableBytes(path: string): Promise<number>; reserve(bytes: number): Promise<boolean> }
export interface INetworkService { isOnline(): Promise<boolean>; diagnose(url: string): Promise<{ dns: boolean; tls: boolean; http: boolean; latencyMs: number | null; message: string }> }
export interface ICatalogService { current(): Promise<CatalogManifest | null>; refresh(): Promise<CatalogManifest> }
export interface IIntegrityService { verify(path: string, size: number, sha256: string): Promise<{ ok: boolean; reason?: string }> }
export interface IDownloadService { list(): Promise<DownloadRecord[]>; pause(id: string): Promise<void>; resume(id: string): Promise<void>; cancel(id: string): Promise<void> }
export interface IPlatformDialogService { confirm(title: string, message: string, destructive?: boolean): Promise<boolean>; showError(code: string, message: string): Promise<void> }

export class DesktopPackageInstaller implements IPackageInstaller {
  async install(request: InstallRequest, onProgress?: (percent: number) => void): Promise<InstallResult> {
    onProgress?.(0); await new Promise((resolve) => setTimeout(resolve, 30)); onProgress?.(100);
    return { success: true, resultCode: "SIMULATED_INSTALL", message: `Desktop simulation recorded ${request.gameId}; no PS4 package was installed.` };
  }
}
