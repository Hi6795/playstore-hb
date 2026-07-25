#pragma once

#if defined(PLAYSTOREHB_PS4)
#include <time.h>
// OpenOrbis v0.5.4's libc++ atomics include a threading shim whose declaration
// is absent from the trimmed SDK time.h.
extern "C" int nanosleep(const struct timespec*, struct timespec*);
#endif

#include <atomic>
#include <cstddef>
#include <cstdint>

namespace playstorehb {

inline constexpr const char* kPs4DownloadDirectory = "/data/PlaystoreHB";
inline constexpr std::uint64_t kPs4DefaultFreeSpaceReserve = 512ULL * 1024ULL * 1024ULL;
inline constexpr std::uint64_t kPs4MaximumPackageSize = 100ULL * 1024ULL * 1024ULL * 1024ULL;

enum class Ps4DownloadCode : std::int32_t {
  success = 0,
  already_complete,
  invalid_argument,
  invalid_url,
  unapproved_host,
  unsafe_destination,
  initialization_failed,
  insufficient_storage,
  destination_conflict,
  filesystem_error,
  http_error,
  tls_or_network_error,
  redirect_rejected,
  redirect_loop,
  redirect_limit,
  response_length_mismatch,
  resume_rejected,
  cancelled,
  hash_mismatch,
  promotion_failed,
  receive_timeout_unavailable,
};

struct Ps4DownloadControl {
  std::atomic<bool> cancel_requested{false};
  std::atomic<std::int32_t> active_request_id{-1};
  // Serializes publication, abort, clearing, and deletion of the request ID.
  // A caller must not use one control for more than one in-flight download.
  std::atomic_flag request_lifetime_guard = ATOMIC_FLAG_INIT;
};

struct Ps4DownloadRequest {
  const char* url{};
  const char* destination_path{};
  const char* expected_sha256{};
  std::uint64_t expected_size{};
  const char* expected_etag{};
  const char* const* allowed_hosts{};
  std::size_t allowed_host_count{};
  std::uint64_t free_space_reserve{kPs4DefaultFreeSpaceReserve};
  Ps4DownloadControl* control{};
};

struct Ps4DownloadResult {
  Ps4DownloadCode code{Ps4DownloadCode::invalid_argument};
  std::int32_t platform_error{};
  std::int32_t http_status{};
  std::uint64_t bytes_completed{};
  bool resumed{};
  char actual_sha256[65]{};
};

// Safe to call from another thread while download() is blocked in
// sceHttpReadData. Publication/abort/delete of the platform request is
// serialized so an ID cannot be aborted after it has been deleted and reused.
void request_ps4_download_cancel(Ps4DownloadControl* control) noexcept;

// Hashes the exact already-open regular, single-link descriptor and rejects a
// size/identity/timestamp change observed while reading it. The descriptor
// remains owned by the caller.
bool sha256_ps4_file_descriptor(std::int32_t descriptor, char output[65],
                                std::uint64_t* size = nullptr) noexcept;

// One downloader instance is single-worker only. Network work is synchronous and
// must not be invoked from the render thread.
//
// OpenOrbis v0.5.4 does not provide a typed sceHttpSetRecvTimeOut declaration.
// download() therefore fails closed with receive_timeout_unavailable instead of
// guessing a platform ABI or allowing an unbounded blocking receive.
class Ps4HttpsDownloader final {
 public:
  Ps4HttpsDownloader() = default;
  ~Ps4HttpsDownloader();
  Ps4HttpsDownloader(const Ps4HttpsDownloader&) = delete;
  Ps4HttpsDownloader& operator=(const Ps4HttpsDownloader&) = delete;

  bool initialize(std::int32_t* platform_error = nullptr);
  void shutdown() noexcept;
  Ps4DownloadResult download(const Ps4DownloadRequest& request);

 private:
  std::int32_t net_pool_id_{-1};
  std::int32_t ssl_context_id_{-1};
  std::int32_t http_context_id_{-1};
  bool initialized_{false};
};

}  // namespace playstorehb
