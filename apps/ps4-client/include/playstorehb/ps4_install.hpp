#pragma once

#include <cstdint>

namespace playstorehb {

enum class Ps4InstallCode : std::int32_t {
  success = 0,
  explicit_confirmation_required,
  invalid_argument,
  unsafe_package_path,
  appinst_initialize_failed,
  package_metadata_failed,
  title_id_mismatch,
  package_is_not_application,
  hash_mismatch,
  package_changed,
  content_id_unverifiable,
  install_failed,
};

struct Ps4InstallRequest {
  const char* package_path{};
  const char* expected_title_id{};
  const char* expected_content_id{};
  const char* expected_sha256{};
  bool explicit_user_confirmation{};
};

struct Ps4InstallResult {
  Ps4InstallCode code{Ps4InstallCode::invalid_argument};
  std::int32_t platform_error{};
  char actual_title_id[16]{};
  char actual_sha256[65]{};
  bool is_application{};
  bool content_id_independently_verified{};
  bool pathname_only_install_boundary{true};
};

// This function performs no UI. The caller must obtain an explicit confirmation
// and set explicit_user_confirmation only for that single install action.
// OpenOrbis v0.5.4's typed AppInstUtil surface accepts only a pathname and does
// not expose a content-ID reader. The helper holds and hashes a no-follow file
// descriptor and rechecks its device/inode, then fails closed with
// content_id_unverifiable. It never invokes AppInstUtil or reports success while
// the content ID and final pathname boundary remain unverifiable.
Ps4InstallResult install_verified_ps4_package(const Ps4InstallRequest& request);

}  // namespace playstorehb
