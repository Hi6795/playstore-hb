export const SUPPORTED_CATEGORIES = [
  "arcade", "community-releases", "horror", "local-multiplayer",
  "online-multiplayer", "platformers", "puzzle", "racing", "rhythm",
  "rpg", "shooters", "strategy"
] as const;

export type Category = (typeof SUPPORTED_CATEGORIES)[number];
export type DistributionMode = "ready_to_play" | "requires_original_files";
export type CompatibilityStatus = "unverified" | "partially_verified" | "verified" | "incompatible";

export interface PackageDescriptor {
  url: string;
  size_bytes: number;
  sha256: string;
  filename: string;
  etag?: string;
  expires_at?: string;
}

export interface CatalogGame {
  id: string;
  title_id: string;
  content_id: string;
  name: string;
  developer: string;
  publisher: string;
  version: string;
  release_date: string;
  updated_at: string;
  summary: string;
  description: string;
  distribution_mode: DistributionMode;
  requires_original_files: boolean;
  original_files_notice: string | null;
  categories: Category[];
  tags: string[];
  players_min: number;
  players_max: number;
  local_multiplayer: boolean;
  online_multiplayer: boolean;
  internet_required: boolean;
  package: PackageDescriptor;
  media: {
    cover: string;
    background: string;
    icon: string;
    screenshots: string[];
  };
  compatibility: {
    status: CompatibilityStatus;
    models: Array<"fat" | "slim" | "pro">;
    firmware_reports: Array<{ firmware: string; environment: string; result: "pass" | "fail"; tested_at: string }>;
    notes: string[];
  };
  legal: {
    code_license: string;
    data_license: string;
    source_url: string;
    redistribution_status: "pending" | "approved" | "revoked";
    redistribution_evidence_id: string;
    attribution: string[];
  };
  controls?: string[];
  known_issues?: string[];
  changelog: Array<{ version: string; date: string; changes: string[] }>;
  development_test_data?: boolean;
}

export interface CatalogManifest {
  schema_version: 1;
  catalog_version: string;
  catalog_sequence: number;
  generated_at: string;
  expires_at: string;
  minimum_client_version: string;
  key_id: string;
  channel: "stable" | "beta" | "development";
  games: CatalogGame[];
}

export interface InstalledTitle {
  gameId: string;
  titleId: string;
  contentId: string;
  installedVersion: string;
  packageHash: string;
  installedAt: string;
  catalogSource: string;
  localState: "installed" | "damaged" | "missing";
  lastUpdateCheck: string;
}

export type DownloadStatus = "queued" | "preflighting" | "downloading" | "paused" | "verifying" | "ready" | "failed" | "cancelled";
export interface DownloadRecord {
  id: string;
  gameId: string;
  sourceUrl: string;
  destination: string;
  expectedSize: number;
  expectedSha256: string;
  expectedEtag?: string;
  status: DownloadStatus;
  bytesCompleted: number;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  errorCode?: string;
  speedBytesPerSecond?: number;
  estimatedSeconds?: number;
}

export interface AppSettings {
  confirmButton: "cross" | "circle";
  downloadConcurrency: 1 | 2 | 3;
  bandwidthLimitKbps: number;
  keepDownloadedPackages: boolean;
  automaticUpdateChecks: boolean;
  cacheLimitMiB: number;
  backgroundArtwork: boolean;
  animationLevel: "none" | "reduced" | "full";
  soundEffects: boolean;
  textSize: "normal" | "large" | "extra-large";
  highContrast: boolean;
  reducedMotion: boolean;
  repositoryChannel: "stable" | "beta";
  diagnosticsLogging: boolean;
  safeAreaPercent: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  confirmButton: "cross",
  downloadConcurrency: 1,
  bandwidthLimitKbps: 0,
  keepDownloadedPackages: false,
  automaticUpdateChecks: true,
  cacheLimitMiB: 512,
  backgroundArtwork: true,
  animationLevel: "full",
  soundEffects: true,
  textSize: "normal",
  highContrast: false,
  reducedMotion: false,
  repositoryChannel: "stable",
  diagnosticsLogging: false,
  safeAreaPercent: 5
};
