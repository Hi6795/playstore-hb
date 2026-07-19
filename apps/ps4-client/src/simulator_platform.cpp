#include "playstorehb/platform_interfaces.hpp"
#include <filesystem>
#include <fstream>
#include <utility>
namespace playstorehb {
class SimulatorInstaller final:public IPackageInstaller{public:InstallResult install(const InstallRequest& request,const std::function<void(int)>& progress)override{if(!std::filesystem::exists(request.package_path))return{false,"SIM_FILE_MISSING","The simulator package file does not exist."};progress(0);progress(100);return{true,"SIMULATED_INSTALL","Desktop contract simulation completed; no PS4 package was installed."};}};
class SimulatorStorage final:public IStorageService{public:std::uint64_t available_bytes(const std::string& path)override{const auto parent=std::filesystem::path(path).parent_path();return std::filesystem::space(parent.empty()?".":parent).available;}bool reserve(std::uint64_t)override{return true;}};
}
