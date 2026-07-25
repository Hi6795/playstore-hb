#include "playstorehb/platform_interfaces.hpp"
#include "playstorehb/ps4_download.hpp"
#include "playstorehb/ps4_install.hpp"
#if !defined(PLAYSTOREHB_PS4)
#error "openorbis_platform.cpp is only for an OpenOrbis target"
#endif

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <string>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

namespace playstorehb {

namespace {

bool valid_title_id(const char* value) {
  if (value == nullptr || std::strlen(value) != 9) return false;
  for (int index = 0; index < 4; ++index) {
    if (value[index] < 'A' || value[index] > 'Z') return false;
  }
  for (int index = 4; index < 9; ++index) {
    if (value[index] < '0' || value[index] > '9') return false;
  }
  return true;
}

bool ascii_alphanumeric(char value) {
  return (value >= 'A' && value <= 'Z') ||
         (value >= 'a' && value <= 'z') ||
         (value >= '0' && value <= '9');
}

bool confined_package_path(const char* path, std::string& filename_out) {
  if (path == nullptr) return false;
  constexpr const char* prefix = "/data/PlaystoreHB/";
  constexpr std::size_t prefix_size = 18;
  if (std::strncmp(path, prefix, prefix_size) != 0) return false;
  const char* filename = path + prefix_size;
  const std::size_t length = std::strlen(filename);
  if (length < 5 || length > 131 || std::strstr(filename, "..") != nullptr ||
      std::strcmp(filename + length - 4, ".pkg") != 0 ||
      !ascii_alphanumeric(filename[0])) {
    return false;
  }
  for (std::size_t index = 0; index < length; ++index) {
    const char value = filename[index];
    if (!ascii_alphanumeric(value) && value != '.' && value != '_' &&
        value != '-') {
      return false;
    }
  }
  filename_out.assign(filename, length);
  return true;
}

bool valid_sha256(const char* value) {
  if (value == nullptr || std::strlen(value) != 64) return false;
  for (std::size_t index = 0; index < 64; ++index) {
    const char current = value[index];
    if (!((current >= '0' && current <= '9') ||
          (current >= 'a' && current <= 'f'))) {
      return false;
    }
  }
  return true;
}

bool valid_content_id(const char* value, const char* expected_title_id) {
  if (value == nullptr || expected_title_id == nullptr ||
      std::strlen(value) != 36) {
    return false;
  }
  for (std::size_t index = 0; index < 36; ++index) {
    const char current = value[index];
    const bool separator =
        (index == 6 && current == '-') ||
        (index == 16 && current == '_') ||
        (index == 17 && current == '0') ||
        (index == 18 && current == '0') ||
        (index == 19 && current == '-');
    if (separator) continue;
    if (index < 2 || (index >= 7 && index < 11)) {
      if (current < 'A' || current > 'Z') return false;
    } else if (index >= 20) {
      if (!((current >= 'A' && current <= 'Z') ||
            (current >= '0' && current <= '9'))) return false;
    } else if (index < 6 || (index >= 11 && index < 16)) {
      if (current < '0' || current > '9') return false;
    } else {
      return false;
    }
  }
  return std::strncmp(value + 7, expected_title_id, 9) == 0;
}

class ScopedDescriptor final {
 public:
  explicit ScopedDescriptor(int descriptor = -1) : descriptor_(descriptor) {}
  ~ScopedDescriptor() {
    if (descriptor_ >= 0) close(descriptor_);
  }
  ScopedDescriptor(const ScopedDescriptor&) = delete;
  ScopedDescriptor& operator=(const ScopedDescriptor&) = delete;
  int get() const { return descriptor_; }

 private:
  int descriptor_;
};

bool same_file_identity(const struct stat& left, const struct stat& right) {
  return left.st_dev == right.st_dev && left.st_ino == right.st_ino &&
         left.st_gen == right.st_gen;
}

int directory_open_flags() {
  int flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
#ifdef O_CLOEXEC
  flags |= O_CLOEXEC;
#endif
  return flags;
}

int open_download_directory() {
  const int flags = directory_open_flags();
  ScopedDescriptor filesystem_root(open("/", flags));
  if (filesystem_root.get() < 0) return -1;
  ScopedDescriptor data_root(openat(filesystem_root.get(), "data", flags));
  if (data_root.get() < 0) return -1;
  struct stat data_info {};
  if (fstat(data_root.get(), &data_info) != 0 ||
      !S_ISDIR(data_info.st_mode)) {
    return -1;
  }
  const int directory =
      openat(data_root.get(), "PlaystoreHB", directory_open_flags());
  if (directory < 0) return -1;
  struct stat opened_info {};
  struct stat named_info {};
  if (fstat(directory, &opened_info) != 0 ||
      !S_ISDIR(opened_info.st_mode) ||
      fstatat(data_root.get(), "PlaystoreHB", &named_info,
              AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISDIR(named_info.st_mode) ||
      !same_file_identity(opened_info, named_info) ||
      fchmod(directory, 0700) != 0) {
    const int saved_error = errno;
    close(directory);
    errno = saved_error;
    return -1;
  }
  return directory;
}

bool path_matches_descriptor(int directory, const std::string& filename,
                             int descriptor, const struct stat& expected) {
  struct stat named_info {};
  struct stat descriptor_info {};
  return fstatat(directory, filename.c_str(), &named_info,
                 AT_SYMLINK_NOFOLLOW) == 0 &&
         fstat(descriptor, &descriptor_info) == 0 &&
         S_ISREG(named_info.st_mode) && S_ISREG(descriptor_info.st_mode) &&
         named_info.st_nlink == 1 && descriptor_info.st_nlink == 1 &&
         same_file_identity(expected, named_info) &&
         same_file_identity(expected, descriptor_info);
}

bool absolute_directory_matches(int directory) {
  ScopedDescriptor fresh(open_download_directory());
  struct stat held_info {};
  struct stat fresh_info {};
  return fresh.get() >= 0 && fstat(directory, &held_info) == 0 &&
         fstat(fresh.get(), &fresh_info) == 0 &&
         S_ISDIR(held_info.st_mode) && S_ISDIR(fresh_info.st_mode) &&
         same_file_identity(held_info, fresh_info);
}

}  // namespace

#if defined(__clang__)
__attribute__((used, retain))
#endif
Ps4InstallResult install_verified_ps4_package(const Ps4InstallRequest& request) {
  Ps4InstallResult result;
  std::string package_filename;
  if (!valid_title_id(request.expected_title_id) ||
      !valid_content_id(request.expected_content_id,
                        request.expected_title_id) ||
      !valid_sha256(request.expected_sha256)) {
    result.code = Ps4InstallCode::invalid_argument;
    return result;
  }
  if (!confined_package_path(request.package_path, package_filename)) {
    result.code = Ps4InstallCode::unsafe_package_path;
    return result;
  }
  if (!request.explicit_user_confirmation) {
    result.code = Ps4InstallCode::explicit_confirmation_required;
    return result;
  }

  ScopedDescriptor directory(open_download_directory());
  if (directory.get() < 0) {
    result.code = Ps4InstallCode::unsafe_package_path;
    result.platform_error = errno;
    return result;
  }
  int package_flags = O_RDONLY | O_NOFOLLOW;
#ifdef O_CLOEXEC
  package_flags |= O_CLOEXEC;
#endif
  ScopedDescriptor package(
      openat(directory.get(), package_filename.c_str(), package_flags));
  struct stat package_info {};
  if (package.get() < 0 || flock(package.get(), LOCK_EX | LOCK_NB) != 0 ||
      fstat(package.get(), &package_info) != 0 ||
      !S_ISREG(package_info.st_mode) || package_info.st_nlink != 1 ||
      package_info.st_size <= 0 ||
      !path_matches_descriptor(directory.get(), package_filename,
                               package.get(), package_info)) {
    result.code = Ps4InstallCode::unsafe_package_path;
    result.platform_error = errno;
    return result;
  }
  std::uint64_t package_size = 0;
  if (!sha256_ps4_file_descriptor(package.get(), result.actual_sha256,
                                  &package_size) ||
      package_size == 0 ||
      std::strcmp(result.actual_sha256, request.expected_sha256) != 0 ||
      !path_matches_descriptor(directory.get(), package_filename,
                               package.get(), package_info)) {
    result.code = Ps4InstallCode::hash_mismatch;
    return result;
  }

  // Rehash the held descriptor immediately before the platform boundary. This
  // proves the approved pathname still names the approved inode, but it cannot
  // make a subsequent pathname-only AppInstUtil call race-proof.
  char immediately_verified_hash[65]{};
  std::uint64_t immediately_verified_size = 0;
  if (!sha256_ps4_file_descriptor(package.get(), immediately_verified_hash,
                                  &immediately_verified_size) ||
      immediately_verified_size != package_size ||
      std::strcmp(immediately_verified_hash, request.expected_sha256) != 0 ||
      !absolute_directory_matches(directory.get()) ||
      !path_matches_descriptor(directory.get(), package_filename,
                               package.get(), package_info)) {
    result.code = Ps4InstallCode::package_changed;
    return result;
  }
  std::memcpy(result.actual_sha256, immediately_verified_hash,
              sizeof(immediately_verified_hash));

  // OpenOrbis v0.5.4 exposes neither a typed content-ID reader nor an
  // descriptor-taking installer. Never cross that known-unverifiable boundary:
  // this exported helper cannot call AppInstUtil or report success.
  result.content_id_independently_verified = false;
  result.pathname_only_install_boundary = true;
  result.code = Ps4InstallCode::content_id_unverifiable;
  return result;
}

class OpenOrbisPackageInstaller final : public IPackageInstaller {
 public:
  InstallResult install(const InstallRequest& request,const std::function<void(int)>& progress) override {
    (void)request;
    progress(0);
    return {
        false,
        "NATIVE_CONFIRMATION_CONTEXT_REQUIRED",
        "The current IPackageInstaller adapter does not carry a caller-supplied "
        "single-action confirmation token. Native installation is disabled "
        "until that contract can pass confirmation, expected SHA-256, and "
        "content ID into install_verified_ps4_package."};
  }
};

// OpenOrbis v0.5.4 exposes title ID and isApp through
// sceAppInstUtilGetTitleIdFromPkg. It has no typed content-ID/category reader
// and AppInstUtil's installation entry point remains pathname-only.
}
