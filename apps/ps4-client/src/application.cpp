#include "playstorehb/application.hpp"
namespace playstorehb {
InstallResult Application::install_approved_package(const ApprovedPackage& package) {
  if (!package.catalog_signature_valid) return {false,"CATALOG_SIGNATURE_REQUIRED","The catalog signature is not valid."};
  if (!package.legal_approval_active) return {false,"PACKAGE_NOT_APPROVED","The release is not approved for distribution."};
  constexpr std::uint64_t safety_margin=512ULL*1024ULL*1024ULL;
  if (services_.storage.available_bytes(package.install.package_path)<package.expected_size+safety_margin || !services_.storage.reserve(package.expected_size+safety_margin)) return {false,"INSUFFICIENT_STORAGE","Not enough storage is available with the required safety margin."};
  const auto integrity=services_.integrity.verify(package.install.package_path,package.expected_size,package.install.sha256);
  if (!integrity.ok) return {false,integrity.reason,"The package failed size or SHA-256 verification."};
  const std::string details="Package: "+package.install.package_path+"\nVersion: "+package.install.version+"\nSHA-256: "+package.install.sha256+"\nA matching hash proves identity, not safety.";
  if (!services_.dialogs.confirm("Install authorized homebrew package?",details,false)) return {false,"USER_DECLINED","Installation was not requested."};
  auto result=services_.installer.install(package.install,[](int){/* renderer consumes backend progress through the event queue */});
  if(result.success) services_.installed_titles.refresh(); else services_.dialogs.error(result.result_code,result.message);
  return result;
}
}
