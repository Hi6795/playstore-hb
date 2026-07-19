#pragma once
#include <cstdint>
#if defined(PLAYSTOREHB_PS4)
#include <time.h>
// OpenOrbis v0.5.4's libc++ threading support references the POSIX declaration,
// but the SDK's trimmed time.h omits it. No client path calls this function;
// declaring the platform ABI here keeps standard headers self-consistent.
extern "C" int nanosleep(const struct timespec*, struct timespec*);
#endif
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace playstorehb {
struct InstallRequest { std::string package_path, game_id, title_id, content_id, version, sha256; };
struct InstallResult { bool success{}; std::string result_code, message; };
struct InstalledTitle { std::string game_id, title_id, content_id, version, package_hash, installed_at, catalog_source, local_state, last_update_check; };
struct NetworkDiagnostic { bool dns{}, tls{}, http{}; std::int64_t latency_ms{-1}; std::string message; };
struct IntegrityResult { bool ok{}; std::uint64_t actual_size{}; std::string actual_sha256, reason; };

class IPackageInstaller { public: virtual ~IPackageInstaller()=default; virtual InstallResult install(const InstallRequest&,const std::function<void(int)>&)=0; };
class IInstalledTitleService { public: virtual ~IInstalledTitleService()=default; virtual std::vector<InstalledTitle> list()=0; virtual void refresh()=0; };
class IStorageService { public: virtual ~IStorageService()=default; virtual std::uint64_t available_bytes(const std::string&)=0; virtual bool reserve(std::uint64_t)=0; };
class INetworkService { public: virtual ~INetworkService()=default; virtual bool is_online()=0; virtual NetworkDiagnostic diagnose(const std::string&)=0; };
class ICatalogService { public: virtual ~ICatalogService()=default; virtual bool refresh_signed_catalog()=0; virtual bool has_last_known_good() const=0; virtual std::uint64_t highest_sequence() const=0; };
class IIntegrityService { public: virtual ~IIntegrityService()=default; virtual IntegrityResult verify(const std::string&,std::uint64_t,const std::string&)=0; };
class IDownloadService { public: virtual ~IDownloadService()=default; virtual bool pause(const std::string&)=0; virtual bool resume(const std::string&)=0; virtual bool cancel(const std::string&)=0; };
class IPlatformDialogService { public: virtual ~IPlatformDialogService()=default; virtual bool confirm(const std::string&,const std::string&,bool)=0; virtual void error(const std::string&,const std::string&)=0; };
struct PlatformServices { IPackageInstaller& installer; IInstalledTitleService& installed_titles; IStorageService& storage; INetworkService& network; ICatalogService& catalog; IIntegrityService& integrity; IDownloadService& downloads; IPlatformDialogService& dialogs; };
}
