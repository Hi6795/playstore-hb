#pragma once
#include "platform_interfaces.hpp"
namespace playstorehb {
enum class InstallStage { confirm_catalog, confirm_approval, preflight_storage, verify_size_and_hash, show_details, await_explicit_action, install, refresh_titles, complete, failed };
struct ApprovedPackage { InstallRequest install; std::uint64_t expected_size{}; bool catalog_signature_valid{}; bool legal_approval_active{}; };
class Application {
 public: explicit Application(PlatformServices services):services_(services){}
  InstallResult install_approved_package(const ApprovedPackage& package);
 private: PlatformServices services_;
};
}
