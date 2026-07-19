# Asset processor

Run `pnpm publisher process-media <directory> --output <directory>`. Outputs are deterministic WebP renditions, never upscale source pixels, strip metadata through re-encoding, and include SHA-256 hashes in the JSON report.
