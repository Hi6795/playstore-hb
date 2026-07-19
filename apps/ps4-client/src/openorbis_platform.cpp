#include "playstorehb/platform_interfaces.hpp"
#if !defined(PLAYSTOREHB_PS4)
#error "openorbis_platform.cpp is only for an OpenOrbis target"
#endif
#include <orbis/AppInstUtil.h>
namespace playstorehb {
class OpenOrbisPackageInstaller final : public IPackageInstaller {
 public:
  InstallResult install(const InstallRequest& request,const std::function<void(int)>& progress) override {
    progress(0);
    const int init=sceAppInstUtilInitialize();
    if(init<0) return {false,"APPINST_INITIALIZE_FAILED","The package installer could not be initialized."};
    const int result=sceAppInstUtilAppInstallPkg(request.package_path.c_str(),nullptr);
    sceAppInstUtilTerminate();
    if(result<0) return {false,"APPINST_INSTALL_FAILED_"+std::to_string(result),"The platform package installer reported a failure."};
    progress(100);return {true,"APPINST_OK","The supported homebrew package installer accepted the package."};
  }
};
// Installed title, storage, HTTP/TLS, dialogs, and download adapters are kept in
// distinct translation units in hardware builds. Their public contract is fixed
// above; OpenOrbis SDK revision-specific glue is selected by build-ps4.ps1.
}
