#include "playstorehb/ps4_download.hpp"

#if !defined(PLAYSTOREHB_PS4)
#error "ps4_download.cpp is only for an OpenOrbis target"
#endif

#include <orbis/Http.h>
#include <orbis/Net.h>
#include <orbis/Ssl.h>
#include <orbis/Sysmodule.h>

#include <cerrno>
#include <climits>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <limits>
#include <string>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>
#include <utility>
#include <vector>

namespace playstorehb {
namespace {

#if defined(__clang__)
#define PLAYSTOREHB_RETAIN __attribute__((used, retain))
#else
#define PLAYSTOREHB_RETAIN
#endif

constexpr std::size_t kMaximumUrlLength = 2048;
constexpr std::size_t kMaximumHeaderBytes = 64 * 1024;
constexpr std::size_t kMaximumEtagLength = 255;
constexpr std::size_t kMaximumAllowedHosts = 32;
constexpr std::size_t kIoBufferBytes = 128 * 1024;
constexpr int kMaximumRedirects = 5;
constexpr int kRequestHeaderOverwrite = 0;
constexpr std::uint32_t kResolveTimeoutUsec = 10U * 1000U * 1000U;
constexpr std::uint32_t kConnectTimeoutUsec = 15U * 1000U * 1000U;
constexpr std::uint32_t kSendTimeoutUsec = 15U * 1000U * 1000U;
constexpr int kNetPoolBytes = 4 * 1024 * 1024;
constexpr std::size_t kSslPoolBytes = 256 * 1024;
constexpr std::size_t kHttpPoolBytes = 1024 * 1024;
constexpr const char* kUserAgent = "Playstore-HB/1.0 OpenOrbis";
#if defined(AT_EMPTY_PATH)
constexpr int kAtEmptyPath = AT_EMPTY_PATH;
#else
// OpenOrbis v0.5.4's fcntl.h exposes this flag under its BSD/GNU feature gate.
constexpr int kAtEmptyPath = 0x1000;
#endif

bool cancelled(const Ps4DownloadControl* control) {
  return control != nullptr && control->cancel_requested.load(std::memory_order_acquire);
}

bool ascii_equal_ignore_case(char left, char right) {
  if (left >= 'A' && left <= 'Z') left = static_cast<char>(left + ('a' - 'A'));
  if (right >= 'A' && right <= 'Z') right = static_cast<char>(right + ('a' - 'A'));
  return left == right;
}

bool ascii_equal_ignore_case(const std::string& left, const std::string& right) {
  if (left.size() != right.size()) return false;
  for (std::size_t index = 0; index < left.size(); ++index) {
    if (!ascii_equal_ignore_case(left[index], right[index])) return false;
  }
  return true;
}

char ascii_lower(char value) {
  return value >= 'A' && value <= 'Z' ? static_cast<char>(value + ('a' - 'A')) : value;
}

bool is_decimal_digit(char value) { return value >= '0' && value <= '9'; }
bool is_ascii_alpha(char value) {
  return (value >= 'A' && value <= 'Z') || (value >= 'a' && value <= 'z');
}
bool is_ascii_alphanumeric(char value) { return is_ascii_alpha(value) || is_decimal_digit(value); }

bool looks_like_ip_literal(const std::string& host) {
  bool only_decimal_and_dots = true;
  for (char value : host) {
    if (!is_decimal_digit(value) && value != '.') {
      only_decimal_and_dots = false;
      break;
    }
  }
  if (only_decimal_and_dots) return true;

  bool every_label_is_numeric = true;
  std::size_t start = 0;
  while (start < host.size()) {
    const std::size_t end = host.find('.', start);
    const std::size_t limit = end == std::string::npos ? host.size() : end;
    const std::string label = host.substr(start, limit - start);
    bool numeric_label = !label.empty();
    if (label.size() > 2 && label[0] == '0' && ascii_lower(label[1]) == 'x') {
      for (std::size_t index = 2; index < label.size(); ++index) {
        const char value = ascii_lower(label[index]);
        if (!is_decimal_digit(value) && (value < 'a' || value > 'f')) numeric_label = false;
      }
    } else {
      for (char value : label) {
        if (!is_decimal_digit(value)) numeric_label = false;
      }
    }
    if (!numeric_label) every_label_is_numeric = false;
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return every_label_is_numeric;
}

bool valid_dns_hostname(const std::string& host) {
  if (host.empty() || host.size() > 253 || host.front() == '.' || host.back() == '.' ||
      looks_like_ip_literal(host)) {
    return false;
  }
  std::size_t label_start = 0;
  while (label_start < host.size()) {
    const std::size_t dot = host.find('.', label_start);
    const std::size_t label_end = dot == std::string::npos ? host.size() : dot;
    const std::size_t label_size = label_end - label_start;
    if (label_size == 0 || label_size > 63 || host[label_start] == '-' || host[label_end - 1] == '-') {
      return false;
    }
    for (std::size_t index = label_start; index < label_end; ++index) {
      if (!is_ascii_alphanumeric(host[index]) && host[index] != '-') return false;
    }
    if (dot == std::string::npos) break;
    label_start = dot + 1;
  }
  return true;
}

bool host_is_allowed(const std::string& host, const Ps4DownloadRequest& request) {
  if (request.allowed_hosts == nullptr || request.allowed_host_count == 0 ||
      request.allowed_host_count > kMaximumAllowedHosts) {
    return false;
  }
  bool matched = false;
  for (std::size_t index = 0; index < request.allowed_host_count; ++index) {
    const char* entry = request.allowed_hosts[index];
    if (entry == nullptr) return false;
    const std::string allowed(entry);
    if (!valid_dns_hostname(allowed)) return false;
    if (ascii_equal_ignore_case(host, allowed)) matched = true;
  }
  return matched;
}

struct ParsedUrl {
  std::string normalized;
  std::string host;
};

Ps4DownloadCode parse_secure_url(const char* raw, const Ps4DownloadRequest& request, ParsedUrl& parsed) {
  if (raw == nullptr) return Ps4DownloadCode::invalid_url;
  const std::string input(raw);
  if (input.size() < 9 || input.size() > kMaximumUrlLength || input.compare(0, 8, "https://") != 0 ||
      input.find('#') != std::string::npos) {
    return Ps4DownloadCode::invalid_url;
  }
  for (unsigned char value : input) {
    if (value <= 0x20U || value >= 0x7fU || value == '\\') return Ps4DownloadCode::invalid_url;
  }

  const std::size_t authority_start = 8;
  const std::size_t authority_end = input.find_first_of("/?", authority_start);
  const std::size_t end = authority_end == std::string::npos ? input.size() : authority_end;
  if (end == authority_start) return Ps4DownloadCode::invalid_url;
  const std::string authority = input.substr(authority_start, end - authority_start);
  if (authority.find('@') != std::string::npos || authority.find('[') != std::string::npos ||
      authority.find(']') != std::string::npos || authority.find('%') != std::string::npos) {
    return Ps4DownloadCode::invalid_url;
  }

  std::string host = authority;
  const std::size_t colon = authority.find(':');
  if (colon != std::string::npos) {
    if (authority.find(':', colon + 1) != std::string::npos || authority.substr(colon + 1) != "443") {
      return Ps4DownloadCode::invalid_url;
    }
    host = authority.substr(0, colon);
  }
  for (char& value : host) value = ascii_lower(value);
  if (!valid_dns_hostname(host)) return Ps4DownloadCode::invalid_url;
  if (!host_is_allowed(host, request)) return Ps4DownloadCode::unapproved_host;

  std::string suffix = authority_end == std::string::npos ? "/" : input.substr(authority_end);
  if (!suffix.empty() && suffix.front() == '?') suffix.insert(suffix.begin(), '/');
  parsed.host = host;
  parsed.normalized = "https://" + host + suffix;
  return Ps4DownloadCode::success;
}

bool safe_package_filename(const char* path, std::string& filename_out) {
  if (path == nullptr) return false;
  constexpr const char* prefix = "/data/PlaystoreHB/";
  constexpr std::size_t prefix_size = 18;
  if (std::strncmp(path, prefix, prefix_size) != 0) return false;
  const char* filename = path + prefix_size;
  const std::size_t length = std::strlen(filename);
  if (length < 5 || length > 131 || std::strstr(filename, "..") != nullptr ||
      std::strcmp(filename + length - 4, ".pkg") != 0 || !is_ascii_alphanumeric(filename[0])) {
    return false;
  }
  for (std::size_t index = 0; index < length; ++index) {
    const char value = filename[index];
    if (!is_ascii_alphanumeric(value) && value != '.' && value != '_' && value != '-') return false;
  }
  filename_out.assign(filename, length);
  return true;
}

bool valid_sha256(const char* value) {
  if (value == nullptr || std::strlen(value) != 64) return false;
  for (std::size_t index = 0; index < 64; ++index) {
    if (!is_decimal_digit(value[index]) && (value[index] < 'a' || value[index] > 'f')) return false;
  }
  return true;
}

bool safe_header_value(const char* value, std::size_t maximum_length) {
  if (value == nullptr) return true;
  const std::size_t length = std::strlen(value);
  if (length == 0 || length > maximum_length) return false;
  for (std::size_t index = 0; index < length; ++index) {
    const unsigned char current = static_cast<unsigned char>(value[index]);
    if (current < 0x20U || current == 0x7fU) return false;
  }
  return true;
}

std::uint32_t rotate_right(std::uint32_t value, unsigned amount) {
  return (value >> amount) | (value << (32U - amount));
}

class Sha256 final {
 public:
  Sha256() { reset(); }

  void reset() {
    state_[0] = 0x6a09e667U;
    state_[1] = 0xbb67ae85U;
    state_[2] = 0x3c6ef372U;
    state_[3] = 0xa54ff53aU;
    state_[4] = 0x510e527fU;
    state_[5] = 0x9b05688cU;
    state_[6] = 0x1f83d9abU;
    state_[7] = 0x5be0cd19U;
    bit_count_ = 0;
    buffered_ = 0;
  }

  void update(const std::uint8_t* data, std::size_t size) {
    bit_count_ += static_cast<std::uint64_t>(size) * 8U;
    while (size > 0) {
      const std::size_t room = sizeof(buffer_) - buffered_;
      const std::size_t take = size < room ? size : room;
      std::memcpy(buffer_ + buffered_, data, take);
      buffered_ += take;
      data += take;
      size -= take;
      if (buffered_ == sizeof(buffer_)) {
        transform(buffer_);
        buffered_ = 0;
      }
    }
  }

  void finish(char output[65]) {
    const std::uint64_t message_bits = bit_count_;
    buffer_[buffered_++] = 0x80U;
    if (buffered_ > 56) {
      while (buffered_ < sizeof(buffer_)) buffer_[buffered_++] = 0;
      transform(buffer_);
      buffered_ = 0;
    }
    while (buffered_ < 56) buffer_[buffered_++] = 0;
    for (int shift = 56; shift >= 0; shift -= 8) {
      buffer_[buffered_++] = static_cast<std::uint8_t>(message_bits >> static_cast<unsigned>(shift));
    }
    transform(buffer_);

    static constexpr char hex[] = "0123456789abcdef";
    for (std::size_t index = 0; index < 8; ++index) {
      for (std::size_t byte = 0; byte < 4; ++byte) {
        const std::uint8_t value =
            static_cast<std::uint8_t>(state_[index] >> static_cast<unsigned>((3 - byte) * 8));
        output[(index * 8) + (byte * 2)] = hex[value >> 4U];
        output[(index * 8) + (byte * 2) + 1] = hex[value & 0x0fU];
      }
    }
    output[64] = '\0';
  }

 private:
  void transform(const std::uint8_t block[64]) {
    static constexpr std::uint32_t constants[64] = {
        0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U, 0x3956c25bU, 0x59f111f1U, 0x923f82a4U,
        0xab1c5ed5U, 0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U, 0x72be5d74U, 0x80deb1feU,
        0x9bdc06a7U, 0xc19bf174U, 0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU, 0x2de92c6fU,
        0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU, 0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
        0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U, 0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU,
        0x53380d13U, 0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U, 0xa2bfe8a1U, 0xa81a664bU,
        0xc24b8b70U, 0xc76c51a3U, 0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U, 0x19a4c116U,
        0x1e376c08U, 0x2748774cU, 0x34b0bcb5U, 0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
        0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U, 0x90befffaU, 0xa4506cebU, 0xbef9a3f7U,
        0xc67178f2U};
    std::uint32_t words[64]{};
    for (std::size_t index = 0; index < 16; ++index) {
      words[index] = (static_cast<std::uint32_t>(block[index * 4]) << 24U) |
                     (static_cast<std::uint32_t>(block[(index * 4) + 1]) << 16U) |
                     (static_cast<std::uint32_t>(block[(index * 4) + 2]) << 8U) |
                     static_cast<std::uint32_t>(block[(index * 4) + 3]);
    }
    for (std::size_t index = 16; index < 64; ++index) {
      const std::uint32_t s0 =
          rotate_right(words[index - 15], 7) ^ rotate_right(words[index - 15], 18) ^ (words[index - 15] >> 3U);
      const std::uint32_t s1 =
          rotate_right(words[index - 2], 17) ^ rotate_right(words[index - 2], 19) ^ (words[index - 2] >> 10U);
      words[index] = words[index - 16] + s0 + words[index - 7] + s1;
    }

    std::uint32_t a = state_[0];
    std::uint32_t b = state_[1];
    std::uint32_t c = state_[2];
    std::uint32_t d = state_[3];
    std::uint32_t e = state_[4];
    std::uint32_t f = state_[5];
    std::uint32_t g = state_[6];
    std::uint32_t h = state_[7];
    for (std::size_t index = 0; index < 64; ++index) {
      const std::uint32_t sum1 = rotate_right(e, 6) ^ rotate_right(e, 11) ^ rotate_right(e, 25);
      const std::uint32_t choice = (e & f) ^ ((~e) & g);
      const std::uint32_t temporary1 = h + sum1 + choice + constants[index] + words[index];
      const std::uint32_t sum0 = rotate_right(a, 2) ^ rotate_right(a, 13) ^ rotate_right(a, 22);
      const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
      const std::uint32_t temporary2 = sum0 + majority;
      h = g;
      g = f;
      f = e;
      e = d + temporary1;
      d = c;
      c = b;
      b = a;
      a = temporary1 + temporary2;
    }
    state_[0] += a;
    state_[1] += b;
    state_[2] += c;
    state_[3] += d;
    state_[4] += e;
    state_[5] += f;
    state_[6] += g;
    state_[7] += h;
  }

  std::uint32_t state_[8]{};
  std::uint64_t bit_count_{};
  std::uint8_t buffer_[64]{};
  std::size_t buffered_{};
};

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

class ScopedFileLock final {
 public:
  explicit ScopedFileLock(int descriptor) : descriptor_(descriptor) {
    locked_ = flock(descriptor_, LOCK_EX | LOCK_NB) == 0;
  }
  ~ScopedFileLock() {
    if (locked_) flock(descriptor_, LOCK_UN);
  }
  ScopedFileLock(const ScopedFileLock&) = delete;
  ScopedFileLock& operator=(const ScopedFileLock&) = delete;
  bool locked() const { return locked_; }

 private:
  int descriptor_;
  bool locked_{false};
};

bool same_file_identity(const struct stat& left, const struct stat& right) {
  return left.st_dev == right.st_dev && left.st_ino == right.st_ino &&
         left.st_gen == right.st_gen;
}

bool stable_file_snapshot(const struct stat& before, const struct stat& after) {
  return same_file_identity(before, after) && before.st_mode == after.st_mode &&
         before.st_nlink == after.st_nlink && before.st_size == after.st_size &&
         before.st_mtim.tv_sec == after.st_mtim.tv_sec &&
         before.st_mtim.tv_nsec == after.st_mtim.tv_nsec &&
         before.st_ctim.tv_sec == after.st_ctim.tv_sec &&
         before.st_ctim.tv_nsec == after.st_ctim.tv_nsec;
}

bool regular_single_link_file(const struct stat& info) {
  return S_ISREG(info.st_mode) && info.st_nlink == 1 && info.st_size >= 0;
}

Ps4DownloadCode hash_descriptor(int descriptor, Ps4DownloadControl* control, Sha256& hash,
                                std::uint64_t& size, char output[65]) {
  struct stat before {};
  if (fstat(descriptor, &before) != 0 || !regular_single_link_file(before)) {
    return Ps4DownloadCode::filesystem_error;
  }
  size = static_cast<std::uint64_t>(before.st_size);
  std::uint64_t offset = 0;
  std::uint8_t buffer[kIoBufferBytes];
  while (offset < size) {
    if (cancelled(control)) {
      return Ps4DownloadCode::cancelled;
    }
    const std::uint64_t remaining = size - offset;
    const std::size_t requested =
        remaining < sizeof(buffer) ? static_cast<std::size_t>(remaining) : sizeof(buffer);
    const ssize_t count =
        pread(descriptor, buffer, requested, static_cast<off_t>(offset));
    if (count < 0) {
      if (errno == EINTR) continue;
      return Ps4DownloadCode::filesystem_error;
    }
    if (count == 0) return Ps4DownloadCode::filesystem_error;
    hash.update(buffer, static_cast<std::size_t>(count));
    offset += static_cast<std::uint64_t>(count);
  }
  struct stat after {};
  if (fstat(descriptor, &after) != 0 || !regular_single_link_file(after) ||
      !stable_file_snapshot(before, after)) {
    return Ps4DownloadCode::filesystem_error;
  }
  if (output != nullptr) hash.finish(output);
  return Ps4DownloadCode::success;
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
  if (fstat(data_root.get(), &data_info) != 0 || !S_ISDIR(data_info.st_mode)) return -1;

  if (mkdirat(data_root.get(), "PlaystoreHB", 0700) != 0 && errno != EEXIST) return -1;
  const int download_root = openat(data_root.get(), "PlaystoreHB", flags);
  if (download_root < 0) return -1;
  struct stat opened_info {};
  struct stat named_info {};
  if (fstat(download_root, &opened_info) != 0 || !S_ISDIR(opened_info.st_mode) ||
      fstatat(data_root.get(), "PlaystoreHB", &named_info, AT_SYMLINK_NOFOLLOW) != 0 ||
      !S_ISDIR(named_info.st_mode) || !same_file_identity(opened_info, named_info) ||
      fchmod(download_root, 0700) != 0) {
    const int saved_error = errno;
    close(download_root);
    errno = saved_error;
    return -1;
  }
  return download_root;
}

bool path_matches_descriptor(int directory, const std::string& name, int descriptor) {
  struct stat path_info {};
  struct stat descriptor_info {};
  return fstatat(directory, name.c_str(), &path_info, AT_SYMLINK_NOFOLLOW) == 0 &&
         fstat(descriptor, &descriptor_info) == 0 && S_ISREG(path_info.st_mode) &&
         S_ISREG(descriptor_info.st_mode) &&
         same_file_identity(path_info, descriptor_info);
}

bool reset_partial_file(int descriptor) {
  return ftruncate(descriptor, 0) == 0 && fsync(descriptor) == 0;
}

bool has_available_storage(int directory, std::uint64_t bytes_needed, std::uint64_t reserve) {
  if (reserve > std::numeric_limits<std::uint64_t>::max() - bytes_needed) return false;
  struct statvfs filesystem {};
  if (fstatvfs(directory, &filesystem) != 0) return false;
  const std::uint64_t block_size = filesystem.f_frsize == 0 ? filesystem.f_bsize : filesystem.f_frsize;
  const std::uint64_t blocks = filesystem.f_bavail;
  const std::uint64_t available =
      block_size != 0 && blocks > std::numeric_limits<std::uint64_t>::max() / block_size
          ? std::numeric_limits<std::uint64_t>::max()
          : blocks * block_size;
  return available >= bytes_needed + reserve;
}

enum class PromotionResult {
  success,
  destination_exists,
  failed,
};

bool rollback_linked_destination(int directory, int descriptor,
                                 const std::string& destination_name,
                                 int& rollback_error) {
  struct stat descriptor_info {};
  struct stat named_info {};
  if (fstat(descriptor, &descriptor_info) != 0) {
    rollback_error = errno;
    return false;
  }
  if (fstatat(directory, destination_name.c_str(), &named_info,
              AT_SYMLINK_NOFOLLOW) != 0) {
    rollback_error = errno;
    return false;
  }
  if (!S_ISREG(descriptor_info.st_mode) || !S_ISREG(named_info.st_mode) ||
      !same_file_identity(descriptor_info, named_info)) {
    rollback_error = ESTALE;
    return false;
  }
  if (unlinkat(directory, destination_name.c_str(), 0) != 0) {
    rollback_error = errno;
    return false;
  }
  if (fsync(directory) != 0) {
    rollback_error = errno;
    return false;
  }
  struct stat after {};
  if (fstatat(directory, destination_name.c_str(), &after,
              AT_SYMLINK_NOFOLLOW) == 0) {
    rollback_error = EEXIST;
    return false;
  }
  if (errno != ENOENT) {
    rollback_error = errno;
    return false;
  }
  rollback_error = 0;
  return true;
}

PromotionResult promote_without_replace(int directory, int descriptor,
                                        const std::string& partial_name,
                                        const std::string& destination_name,
                                        int& platform_error) {
  ScopedFileLock directory_lock(directory);
  if (!directory_lock.locked()) {
    platform_error = errno;
    return PromotionResult::failed;
  }
  struct stat source_info {};
  if (fstat(descriptor, &source_info) != 0 || !regular_single_link_file(source_info)) {
    platform_error = errno;
    return PromotionResult::failed;
  }
  struct stat destination_info {};
  if (fstatat(directory, destination_name.c_str(), &destination_info,
              AT_SYMLINK_NOFOLLOW) == 0) {
    platform_error = EEXIST;
    return PromotionResult::destination_exists;
  }
  if (errno != ENOENT) {
    platform_error = errno;
    return PromotionResult::failed;
  }

  // AT_EMPTY_PATH links the held descriptor's inode rather than looking the
  // source up by name. linkat is also atomic and refuses to replace a
  // destination created by another worker.
  if (linkat(descriptor, "", directory, destination_name.c_str(), kAtEmptyPath) != 0) {
    platform_error = errno;
    return errno == EEXIST ? PromotionResult::destination_exists
                           : PromotionResult::failed;
  }
  auto fail_after_link = [&](int original_error) {
    int rollback_error = 0;
    if (!rollback_linked_destination(directory, descriptor, destination_name,
                                     rollback_error)) {
      platform_error = rollback_error;
    } else {
      platform_error = original_error;
    }
    return PromotionResult::failed;
  };
  if (fsync(directory) != 0) {
    return fail_after_link(errno);
  }

  ScopedDescriptor promoted(openat(directory, destination_name.c_str(),
                                   O_RDONLY | O_NOFOLLOW
#ifdef O_CLOEXEC
                                       | O_CLOEXEC
#endif
                                   ));
  struct stat promoted_info {};
  if (promoted.get() < 0) {
    return fail_after_link(errno);
  }
  if (fstat(promoted.get(), &promoted_info) != 0) {
    return fail_after_link(errno);
  }
  if (!S_ISREG(promoted_info.st_mode) ||
      !same_file_identity(source_info, promoted_info)) {
    return fail_after_link(ESTALE);
  }

  // The directory is application-private (0700). Remove the resume name only
  // when it still names the descriptor we promoted; never unlink a substituted
  // path.
  if (path_matches_descriptor(directory, partial_name, descriptor)) {
    if (unlinkat(directory, partial_name.c_str(), 0) != 0) {
      return fail_after_link(errno);
    }
  }
  struct stat final_info {};
  if (fstat(descriptor, &final_info) != 0) {
    return fail_after_link(errno);
  }
  if (!regular_single_link_file(final_info) ||
      !same_file_identity(source_info, final_info)) {
    return fail_after_link(ESTALE);
  }
  if (fsync(directory) != 0) {
    return fail_after_link(errno);
  }
  platform_error = 0;
  return PromotionResult::success;
}

bool parse_unsigned_decimal(const std::string& value, std::uint64_t& parsed) {
  if (value.empty()) return false;
  std::uint64_t result = 0;
  for (char current : value) {
    if (!is_decimal_digit(current)) return false;
    const std::uint64_t digit = static_cast<std::uint64_t>(current - '0');
    if (result > (std::numeric_limits<std::uint64_t>::max() - digit) / 10U) return false;
    result = (result * 10U) + digit;
  }
  parsed = result;
  return true;
}

std::string trim_optional_whitespace(const std::string& value) {
  std::size_t start = 0;
  while (start < value.size() && (value[start] == ' ' || value[start] == '\t')) ++start;
  std::size_t end = value.size();
  while (end > start && (value[end - 1] == ' ' || value[end - 1] == '\t')) --end;
  return value.substr(start, end - start);
}

struct ResponseHeaders {
  std::vector<std::pair<std::string, std::string>> fields;

  int values(const char* name, std::string& value) const {
    int count = 0;
    for (const auto& field : fields) {
      if (ascii_equal_ignore_case(field.first, name)) {
        value = field.second;
        ++count;
      }
    }
    return count;
  }
};

bool read_response_headers(std::int32_t request_id, ResponseHeaders& parsed) {
  char* raw = nullptr;
  std::size_t size = 0;
  if (sceHttpGetAllResponseHeaders(request_id, &raw, &size) < 0 || raw == nullptr ||
      size == 0 || size > kMaximumHeaderBytes) {
    return false;
  }
  while (size > 0 && raw[size - 1] == '\0') --size;
  const std::string headers(raw, size);
  if (headers.find('\0') != std::string::npos) return false;

  std::size_t start = 0;
  while (start < headers.size()) {
    const std::size_t newline = headers.find('\n', start);
    const std::size_t end = newline == std::string::npos ? headers.size() : newline;
    std::string line = headers.substr(start, end - start);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (!line.empty()) {
      if (line.front() == ' ' || line.front() == '\t') return false;
      const std::size_t colon = line.find(':');
      if (colon != std::string::npos) {
        const std::string name = line.substr(0, colon);
        if (name.empty()) return false;
        for (char value : name) {
          if (!is_ascii_alphanumeric(value) && value != '-') return false;
        }
        const std::string value = trim_optional_whitespace(line.substr(colon + 1));
        for (unsigned char character : value) {
          if (character < 0x20U && character != '\t') return false;
        }
        parsed.fields.emplace_back(name, value);
      } else if (line.compare(0, 5, "HTTP/") != 0) {
        return false;
      }
    }
    if (newline == std::string::npos) break;
    start = newline + 1;
  }
  return true;
}

bool valid_content_range(const std::string& value, std::uint64_t start, std::uint64_t expected_size) {
  if (value.size() < 10 || value.compare(0, 6, "bytes ") != 0 || start >= expected_size) return false;
  const std::size_t dash = value.find('-', 6);
  const std::size_t slash = value.find('/', dash == std::string::npos ? 6 : dash + 1);
  if (dash == std::string::npos || slash == std::string::npos || value.find(' ', 6) != std::string::npos) {
    return false;
  }
  std::uint64_t actual_start = 0;
  std::uint64_t actual_end = 0;
  std::uint64_t actual_total = 0;
  return parse_unsigned_decimal(value.substr(6, dash - 6), actual_start) &&
         parse_unsigned_decimal(value.substr(dash + 1, slash - dash - 1), actual_end) &&
         parse_unsigned_decimal(value.substr(slash + 1), actual_total) && actual_start == start &&
         actual_end == expected_size - 1 && actual_total == expected_size;
}

void lock_request_lifetime(Ps4DownloadControl* control) {
  if (control == nullptr) return;
  while (control->request_lifetime_guard.test_and_set(std::memory_order_acquire)) {
  }
}

void unlock_request_lifetime(Ps4DownloadControl* control) {
  if (control != nullptr) {
    control->request_lifetime_guard.clear(std::memory_order_release);
  }
}

bool publish_request(std::int32_t request_id, Ps4DownloadControl* control) {
  if (control == nullptr) return true;
  lock_request_lifetime(control);
  const bool publish =
      !cancelled(control) &&
      control->active_request_id.load(std::memory_order_relaxed) < 0;
  if (publish) {
    control->active_request_id.store(request_id, std::memory_order_release);
  }
  unlock_request_lifetime(control);
  return publish;
}

void close_request(std::int32_t& request_id, std::int32_t& connection_id,
                   Ps4DownloadControl* control) {
  lock_request_lifetime(control);
  if (control != nullptr &&
      control->active_request_id.load(std::memory_order_relaxed) == request_id) {
    control->active_request_id.store(-1, std::memory_order_release);
  }
  if (request_id >= 0) {
    sceHttpDeleteRequest(request_id);
    request_id = -1;
  }
  unlock_request_lifetime(control);
  if (connection_id >= 0) {
    sceHttpDeleteConnection(connection_id);
    connection_id = -1;
  }
}

Ps4DownloadResult result_for(Ps4DownloadCode code, std::int32_t platform_error = 0,
                             std::int32_t http_status = 0, std::uint64_t bytes = 0) {
  Ps4DownloadResult result;
  result.code = code;
  result.platform_error = platform_error;
  result.http_status = http_status;
  result.bytes_completed = bytes;
  return result;
}

}  // namespace

PLAYSTOREHB_RETAIN void request_ps4_download_cancel(Ps4DownloadControl* control) noexcept {
  if (control == nullptr) return;
  control->cancel_requested.store(true, std::memory_order_release);
  lock_request_lifetime(control);
  const std::int32_t request_id =
      control->active_request_id.load(std::memory_order_relaxed);
  if (request_id >= 0) sceHttpAbortRequest(request_id);
  unlock_request_lifetime(control);
}

PLAYSTOREHB_RETAIN bool sha256_ps4_file_descriptor(
    std::int32_t descriptor, char output[65], std::uint64_t* size) noexcept {
  if (descriptor < 0 || output == nullptr) return false;
  Sha256 hash;
  std::uint64_t actual_size = 0;
  if (hash_descriptor(descriptor, nullptr, hash, actual_size, output) !=
      Ps4DownloadCode::success) {
    return false;
  }
  if (size != nullptr) *size = actual_size;
  return true;
}

PLAYSTOREHB_RETAIN Ps4HttpsDownloader::~Ps4HttpsDownloader() { shutdown(); }

PLAYSTOREHB_RETAIN bool Ps4HttpsDownloader::initialize(std::int32_t* platform_error) {
  if (initialized_) return true;
  auto fail = [platform_error](std::int32_t error) {
    if (platform_error != nullptr) *platform_error = error;
    return false;
  };

  std::int32_t result =
      static_cast<std::int32_t>(sceSysmoduleLoadModuleInternal(ORBIS_SYSMODULE_INTERNAL_NET));
  if (result < 0) return fail(result);
  result = static_cast<std::int32_t>(sceSysmoduleLoadModuleInternal(ORBIS_SYSMODULE_INTERNAL_HTTP));
  if (result < 0) return fail(result);
  result = static_cast<std::int32_t>(sceSysmoduleLoadModuleInternal(ORBIS_SYSMODULE_INTERNAL_SSL));
  if (result < 0) return fail(result);

  // The official v0.5.4 sample permits sceNetInit to report an already-initialized
  // process and still creates an application-owned pool.
  sceNetInit();
  net_pool_id_ = sceNetPoolCreate("PlaystoreHB", kNetPoolBytes, 0);
  if (net_pool_id_ < 0) return fail(net_pool_id_);
  ssl_context_id_ = sceSslInit(kSslPoolBytes);
  if (ssl_context_id_ < 0) {
    const std::int32_t error = ssl_context_id_;
    sceNetPoolDestroy(net_pool_id_);
    net_pool_id_ = -1;
    return fail(error);
  }
  http_context_id_ = sceHttpInit(net_pool_id_, ssl_context_id_, kHttpPoolBytes);
  if (http_context_id_ < 0) {
    const std::int32_t error = http_context_id_;
    sceSslTerm();
    sceNetPoolDestroy(net_pool_id_);
    ssl_context_id_ = -1;
    net_pool_id_ = -1;
    return fail(error);
  }
  initialized_ = true;
  if (platform_error != nullptr) *platform_error = 0;
  return true;
}

PLAYSTOREHB_RETAIN void Ps4HttpsDownloader::shutdown() noexcept {
  if (http_context_id_ >= 0) {
    sceHttpTerm(http_context_id_);
    http_context_id_ = -1;
  }
  if (ssl_context_id_ >= 0) {
    sceSslTerm();
    ssl_context_id_ = -1;
  }
  if (net_pool_id_ >= 0) {
    sceNetPoolDestroy(net_pool_id_);
    net_pool_id_ = -1;
  }
  initialized_ = false;
}

PLAYSTOREHB_RETAIN Ps4DownloadResult Ps4HttpsDownloader::download(const Ps4DownloadRequest& request) {
  std::string destination_name;
  if (!safe_package_filename(request.destination_path, destination_name)) {
    return result_for(Ps4DownloadCode::unsafe_destination);
  }
  if (!valid_sha256(request.expected_sha256) || request.expected_size == 0 ||
      request.expected_size > kPs4MaximumPackageSize ||
      !safe_header_value(request.expected_etag, kMaximumEtagLength)) {
    return result_for(Ps4DownloadCode::invalid_argument);
  }
  ParsedUrl current_url;
  const Ps4DownloadCode url_result = parse_secure_url(request.url, request, current_url);
  if (url_result != Ps4DownloadCode::success) return result_for(url_result);
  if (cancelled(request.control)) return result_for(Ps4DownloadCode::cancelled);

  // v0.5.4 declares sceHttpSetRecvTimeOut as `void func()` and therefore does
  // not provide a callable typed ABI. Abort remains serialized below, but it is
  // not a substitute for a bounded receive timeout if the platform request
  // cannot be aborted. Do not begin a network request in this configuration.
  volatile bool typed_receive_timeout_available = false;
  if (!typed_receive_timeout_available) {
    return result_for(Ps4DownloadCode::receive_timeout_unavailable);
  }

  std::int32_t initialization_error = 0;
  if (!initialize(&initialization_error)) {
    return result_for(Ps4DownloadCode::initialization_failed, initialization_error);
  }
  ScopedDescriptor directory(open_download_directory());
  if (directory.get() < 0) {
    return result_for(Ps4DownloadCode::filesystem_error, errno);
  }

  int read_flags = O_RDONLY | O_NOFOLLOW;
#ifdef O_CLOEXEC
  read_flags |= O_CLOEXEC;
#endif
  ScopedDescriptor destination(
      openat(directory.get(), destination_name.c_str(), read_flags));
  if (destination.get() >= 0) {
    struct stat destination_info {};
    if (fstat(destination.get(), &destination_info) != 0 ||
        !regular_single_link_file(destination_info) ||
        static_cast<std::uint64_t>(destination_info.st_size) != request.expected_size ||
        !path_matches_descriptor(directory.get(), destination_name, destination.get())) {
      return result_for(Ps4DownloadCode::destination_conflict, errno);
    }
    Sha256 destination_hash;
    std::uint64_t destination_size = 0;
    Ps4DownloadResult existing = result_for(Ps4DownloadCode::already_complete);
    const Ps4DownloadCode hash_result =
        hash_descriptor(destination.get(), request.control, destination_hash,
                        destination_size, existing.actual_sha256);
    if (hash_result != Ps4DownloadCode::success) return result_for(hash_result);
    if (!path_matches_descriptor(directory.get(), destination_name,
                                 destination.get())) {
      return result_for(Ps4DownloadCode::destination_conflict);
    }
    if (std::strcmp(existing.actual_sha256, request.expected_sha256) != 0) {
      return result_for(Ps4DownloadCode::destination_conflict);
    }
    existing.bytes_completed = destination_size;
    return existing;
  }
  if (errno != ENOENT) {
    return result_for(errno == ELOOP ? Ps4DownloadCode::destination_conflict
                                    : Ps4DownloadCode::filesystem_error,
                      errno);
  }

  const std::string partial_name = destination_name + ".part";
  int partial_flags = O_RDWR | O_CREAT | O_NOFOLLOW;
#ifdef O_CLOEXEC
  partial_flags |= O_CLOEXEC;
#endif
  ScopedDescriptor partial(
      openat(directory.get(), partial_name.c_str(), partial_flags, 0600));
  if (partial.get() < 0) {
    return result_for(Ps4DownloadCode::filesystem_error, errno);
  }
  if (flock(partial.get(), LOCK_EX | LOCK_NB) != 0 ||
      fchmod(partial.get(), 0600) != 0) {
    return result_for(Ps4DownloadCode::destination_conflict, errno);
  }
  struct stat partial_info {};
  if (fstat(partial.get(), &partial_info) != 0 ||
      !regular_single_link_file(partial_info) ||
      !path_matches_descriptor(directory.get(), partial_name, partial.get())) {
    return result_for(Ps4DownloadCode::filesystem_error, errno);
  }

  std::uint64_t partial_size = 0;
  Sha256 hash;
  partial_size = static_cast<std::uint64_t>(partial_info.st_size);
  if (partial_size > request.expected_size) {
    if (!reset_partial_file(partial.get())) {
      return result_for(Ps4DownloadCode::filesystem_error);
    }
    partial_size = 0;
  } else if (partial_size > 0) {
    std::uint64_t hashed_size = 0;
    char completed_hash[65]{};
    const Ps4DownloadCode partial_hash_result =
        hash_descriptor(partial.get(), request.control, hash, hashed_size,
                        partial_size == request.expected_size ? completed_hash : nullptr);
    if (partial_hash_result != Ps4DownloadCode::success) {
      return result_for(partial_hash_result);
    }
    if (hashed_size != partial_size ||
        !path_matches_descriptor(directory.get(), partial_name, partial.get())) {
      return result_for(Ps4DownloadCode::filesystem_error);
    }
    if (partial_size == request.expected_size) {
      if (std::strcmp(completed_hash, request.expected_sha256) == 0) {
        int promotion_error = 0;
        const PromotionResult promotion =
            promote_without_replace(directory.get(), partial.get(), partial_name,
                                    destination_name, promotion_error);
        if (promotion != PromotionResult::success) {
          return result_for(
              promotion == PromotionResult::destination_exists
                  ? Ps4DownloadCode::destination_conflict
                  : Ps4DownloadCode::promotion_failed,
              promotion_error, 0, partial_size);
        }
        Ps4DownloadResult complete =
            result_for(Ps4DownloadCode::success, 0, 0, partial_size);
        complete.resumed = true;
        std::memcpy(complete.actual_sha256, completed_hash,
                    sizeof(completed_hash));
        return complete;
      }
      if (!reset_partial_file(partial.get())) {
        return result_for(Ps4DownloadCode::filesystem_error, errno);
      }
      partial_size = 0;
      hash.reset();
    }
  }

  if (!has_available_storage(directory.get(),
                             request.expected_size - partial_size,
                             request.free_space_reserve)) {
    return result_for(Ps4DownloadCode::insufficient_storage);
  }

  std::vector<std::string> visited;
  visited.push_back(current_url.normalized);
  int redirect_count = 0;
  for (;;) {
    if (cancelled(request.control)) {
      return result_for(Ps4DownloadCode::cancelled, 0, 0, partial_size);
    }

    std::int32_t template_id =
        sceHttpCreateTemplate(http_context_id_, kUserAgent, ORBIS_HTTP_VERSION_1_1, 0);
    if (template_id < 0) return result_for(Ps4DownloadCode::http_error, template_id, 0, partial_size);

    std::int32_t platform_result =
        sceHttpSetResolveTimeOut(template_id, kResolveTimeoutUsec);
    if (platform_result >= 0) {
      platform_result = sceHttpSetConnectTimeOut(template_id, kConnectTimeoutUsec);
    }
    if (platform_result >= 0) {
      platform_result = sceHttpSetSendTimeOut(template_id, kSendTimeoutUsec);
    }
    if (platform_result < 0) {
      sceHttpDeleteTemplate(template_id);
      return result_for(Ps4DownloadCode::http_error, platform_result, 0, partial_size);
    }

    std::int32_t auto_redirect = -1;
    platform_result = sceHttpGetAutoRedirect(template_id, &auto_redirect);
    if (platform_result < 0 || auto_redirect != 0) {
      sceHttpDeleteTemplate(template_id);
      return result_for(Ps4DownloadCode::redirect_rejected, platform_result, 0, partial_size);
    }
    std::int32_t connection_id =
        sceHttpCreateConnectionWithURL(template_id, current_url.normalized.c_str(), false);
    if (connection_id < 0) {
      sceHttpDeleteTemplate(template_id);
      return result_for(Ps4DownloadCode::tls_or_network_error, connection_id, 0, partial_size);
    }
    std::int32_t request_id =
        sceHttpCreateRequestWithURL(connection_id, ORBIS_METHOD_GET, current_url.normalized.c_str(), 0);
    if (request_id < 0) {
      close_request(request_id, connection_id, request.control);
      sceHttpDeleteTemplate(template_id);
      return result_for(Ps4DownloadCode::http_error, request_id, 0, partial_size);
    }
    if (!publish_request(request_id, request.control)) {
      close_request(request_id, connection_id, request.control);
      sceHttpDeleteTemplate(template_id);
      return result_for(Ps4DownloadCode::cancelled, 0, 0, partial_size);
    }

    platform_result =
        sceHttpAddRequestHeader(request_id, "Accept-Encoding", "identity", kRequestHeaderOverwrite);
    if (platform_result >= 0 && partial_size > 0) {
      char range[64]{};
      const int range_length =
          std::snprintf(range, sizeof(range), "bytes=%llu-",
                        static_cast<unsigned long long>(partial_size));
      if (range_length <= 0 || static_cast<std::size_t>(range_length) >= sizeof(range)) {
        platform_result = -1;
      } else {
        platform_result =
            sceHttpAddRequestHeader(request_id, "Range", range, kRequestHeaderOverwrite);
      }
      if (platform_result >= 0 && request.expected_etag != nullptr && request.expected_etag[0] != '\0') {
        platform_result = sceHttpAddRequestHeader(request_id, "If-Range", request.expected_etag,
                                                 kRequestHeaderOverwrite);
      }
    }
    if (platform_result < 0) {
      close_request(request_id, connection_id, request.control);
      sceHttpDeleteTemplate(template_id);
      return result_for(Ps4DownloadCode::http_error, platform_result, 0, partial_size);
    }
    if (cancelled(request.control)) {
      close_request(request_id, connection_id, request.control);
      sceHttpDeleteTemplate(template_id);
      return result_for(Ps4DownloadCode::cancelled, 0, 0, partial_size);
    }

    platform_result = sceHttpSendRequest(request_id, nullptr, 0);
    if (platform_result < 0) {
      const bool was_cancelled = cancelled(request.control);
      close_request(request_id, connection_id, request.control);
      sceHttpDeleteTemplate(template_id);
      return result_for(was_cancelled ? Ps4DownloadCode::cancelled
                                      : Ps4DownloadCode::tls_or_network_error,
                        platform_result, 0, partial_size);
    }

    std::int32_t status = 0;
    platform_result = sceHttpGetStatusCode(request_id, &status);
    if (platform_result < 0) {
      close_request(request_id, connection_id, request.control);
      sceHttpDeleteTemplate(template_id);
      return result_for(Ps4DownloadCode::http_error, platform_result, 0, partial_size);
    }
    ResponseHeaders headers;
    if (!read_response_headers(request_id, headers)) {
      close_request(request_id, connection_id, request.control);
      sceHttpDeleteTemplate(template_id);
      return result_for(Ps4DownloadCode::http_error, 0, status, partial_size);
    }

    if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
      std::string location;
      const int locations = headers.values("Location", location);
      close_request(request_id, connection_id, request.control);
      sceHttpDeleteTemplate(template_id);
      if (locations != 1 || redirect_count >= kMaximumRedirects) {
        return result_for(locations == 1 ? Ps4DownloadCode::redirect_limit
                                         : Ps4DownloadCode::redirect_rejected,
                          0, status, partial_size);
      }
      ParsedUrl redirect_url;
      const Ps4DownloadCode redirect_result =
          parse_secure_url(location.c_str(), request, redirect_url);
      if (redirect_result != Ps4DownloadCode::success) {
        return result_for(Ps4DownloadCode::redirect_rejected, 0, status, partial_size);
      }
      for (const std::string& previous : visited) {
        if (previous == redirect_url.normalized) {
          return result_for(Ps4DownloadCode::redirect_loop, 0, status, partial_size);
        }
      }
      visited.push_back(redirect_url.normalized);
      current_url = std::move(redirect_url);
      ++redirect_count;
      continue;
    }

    const std::uint64_t response_start = partial_size;
    if (partial_size == 0 && status != 200) {
      close_request(request_id, connection_id, request.control);
      sceHttpDeleteTemplate(template_id);
      return result_for(Ps4DownloadCode::http_error, 0, status, partial_size);
    }
    if (partial_size > 0 && status != 200 && status != 206) {
      close_request(request_id, connection_id, request.control);
      sceHttpDeleteTemplate(template_id);
      return result_for(Ps4DownloadCode::resume_rejected, 0, status, partial_size);
    }

    const bool resume_accepted = partial_size > 0 && status == 206;
    if (partial_size > 0 && status == 200) {
      if (!reset_partial_file(partial.get())) {
        const int error = errno;
        close_request(request_id, connection_id, request.control);
        sceHttpDeleteTemplate(template_id);
        return result_for(Ps4DownloadCode::filesystem_error, error, status,
                          partial_size);
      }
      partial_size = 0;
      hash.reset();
    }
    const std::uint64_t expected_response_bytes = request.expected_size - partial_size;
    std::int32_t length_type = 0;
    std::size_t response_length = 0;
    platform_result =
        sceHttpGetResponseContentLength(request_id, &length_type, &response_length);
    std::string raw_content_length;
    const int content_length_count = headers.values("Content-Length", raw_content_length);
    std::uint64_t parsed_content_length = 0;
    if (platform_result < 0 || length_type != ORBIS_HTTP_CONTENTLEN_EXIST ||
        static_cast<std::uint64_t>(response_length) != expected_response_bytes ||
        content_length_count > 1 ||
        (content_length_count == 1 &&
         (!parse_unsigned_decimal(raw_content_length, parsed_content_length) ||
          parsed_content_length != expected_response_bytes))) {
      close_request(request_id, connection_id, request.control);
      sceHttpDeleteTemplate(template_id);
      if (!reset_partial_file(partial.get())) {
        return result_for(Ps4DownloadCode::filesystem_error, errno, status,
                          partial_size);
      }
      return result_for(Ps4DownloadCode::response_length_mismatch, platform_result, status,
                        0);
    }
    std::string transfer_encoding;
    std::string content_encoding;
    if (headers.values("Transfer-Encoding", transfer_encoding) != 0 ||
        headers.values("Content-Encoding", content_encoding) > 1 ||
        (!content_encoding.empty() && !ascii_equal_ignore_case(content_encoding, "identity"))) {
      close_request(request_id, connection_id, request.control);
      sceHttpDeleteTemplate(template_id);
      if (!reset_partial_file(partial.get())) {
        return result_for(Ps4DownloadCode::filesystem_error, errno, status,
                          partial_size);
      }
      return result_for(Ps4DownloadCode::response_length_mismatch, 0, status, 0);
    }
    if (resume_accepted) {
      std::string content_range;
      if (headers.values("Content-Range", content_range) != 1 ||
          !valid_content_range(content_range, response_start, request.expected_size)) {
        close_request(request_id, connection_id, request.control);
        sceHttpDeleteTemplate(template_id);
        if (!reset_partial_file(partial.get())) {
          return result_for(Ps4DownloadCode::filesystem_error, errno, status,
                            partial_size);
        }
        return result_for(Ps4DownloadCode::resume_rejected, 0, status, 0);
      }
      if (request.expected_etag != nullptr && request.expected_etag[0] != '\0') {
        std::string response_etag;
        const int etags = headers.values("ETag", response_etag);
        if (etags > 1 || (etags == 1 && response_etag != request.expected_etag)) {
          close_request(request_id, connection_id, request.control);
          sceHttpDeleteTemplate(template_id);
          if (!reset_partial_file(partial.get())) {
            return result_for(Ps4DownloadCode::filesystem_error, errno, status,
                              partial_size);
          }
          return result_for(Ps4DownloadCode::resume_rejected, 0, status, 0);
        }
      }
    } else {
      std::string unexpected_range;
      if (headers.values("Content-Range", unexpected_range) != 0) {
        close_request(request_id, connection_id, request.control);
        sceHttpDeleteTemplate(template_id);
        if (!reset_partial_file(partial.get())) {
          return result_for(Ps4DownloadCode::filesystem_error, errno, status,
                            partial_size);
        }
        return result_for(Ps4DownloadCode::response_length_mismatch, 0, status, 0);
      }
    }
    struct stat opened_info {};
    if (fstat(partial.get(), &opened_info) != 0 ||
        !regular_single_link_file(opened_info) ||
        static_cast<std::uint64_t>(opened_info.st_size) != partial_size ||
        !path_matches_descriptor(directory.get(), partial_name, partial.get())) {
      const int error = errno;
      close_request(request_id, connection_id, request.control);
      sceHttpDeleteTemplate(template_id);
      reset_partial_file(partial.get());
      return result_for(Ps4DownloadCode::filesystem_error, error, status, partial_size);
    }

    std::uint8_t buffer[kIoBufferBytes];
    Ps4DownloadCode transfer_result = Ps4DownloadCode::success;
    std::int32_t transfer_error = 0;
    for (;;) {
      if (cancelled(request.control)) {
        transfer_result = Ps4DownloadCode::cancelled;
        break;
      }
      const std::int32_t received =
          sceHttpReadData(request_id, buffer, static_cast<std::uint32_t>(sizeof(buffer)));
      if (received < 0) {
        transfer_error = received;
        transfer_result = cancelled(request.control) ? Ps4DownloadCode::cancelled
                                                     : Ps4DownloadCode::tls_or_network_error;
        break;
      }
      if (received == 0) break;
      if (static_cast<std::uint64_t>(received) > request.expected_size - partial_size) {
        transfer_result = Ps4DownloadCode::response_length_mismatch;
        break;
      }
      std::size_t written = 0;
      while (written < static_cast<std::size_t>(received)) {
        const ssize_t count = pwrite(
            partial.get(), buffer + written,
            static_cast<std::size_t>(received) - written,
            static_cast<off_t>(partial_size + written));
        if (count < 0) {
          if (errno == EINTR) continue;
          transfer_error = errno;
          transfer_result = Ps4DownloadCode::filesystem_error;
          break;
        }
        if (count == 0) {
          transfer_result = Ps4DownloadCode::filesystem_error;
          break;
        }
        written += static_cast<std::size_t>(count);
      }
      if (transfer_result != Ps4DownloadCode::success) break;
      hash.update(buffer, static_cast<std::size_t>(received));
      partial_size += static_cast<std::uint64_t>(received);
    }
    if (transfer_result == Ps4DownloadCode::success && partial_size != request.expected_size) {
      transfer_result = Ps4DownloadCode::tls_or_network_error;
    }
    if (fsync(partial.get()) != 0) {
      transfer_error = errno;
      transfer_result = Ps4DownloadCode::filesystem_error;
    }
    close_request(request_id, connection_id, request.control);
    sceHttpDeleteTemplate(template_id);

    if (transfer_result != Ps4DownloadCode::success) {
      if (transfer_result == Ps4DownloadCode::response_length_mismatch ||
          transfer_result == Ps4DownloadCode::filesystem_error) {
        if (!reset_partial_file(partial.get())) {
          transfer_error = errno;
          transfer_result = Ps4DownloadCode::filesystem_error;
        }
      }
      return result_for(transfer_result, transfer_error, status, partial_size);
    }

    Ps4DownloadResult complete = result_for(Ps4DownloadCode::success, 0, status, partial_size);
    complete.resumed = resume_accepted;
    Sha256 completed_hash;
    std::uint64_t completed_size = 0;
    const Ps4DownloadCode completed_hash_result =
        hash_descriptor(partial.get(), request.control, completed_hash,
                        completed_size, complete.actual_sha256);
    if (completed_hash_result == Ps4DownloadCode::cancelled) {
      return result_for(Ps4DownloadCode::cancelled, 0, status, partial_size);
    }
    if (completed_hash_result != Ps4DownloadCode::success ||
        completed_size != request.expected_size ||
        !path_matches_descriptor(directory.get(), partial_name, partial.get())) {
      reset_partial_file(partial.get());
      return result_for(Ps4DownloadCode::filesystem_error, errno, status,
                        partial_size);
    }
    if (std::strcmp(complete.actual_sha256, request.expected_sha256) != 0) {
      if (!reset_partial_file(partial.get())) {
        return result_for(Ps4DownloadCode::filesystem_error, errno, status,
                          partial_size);
      }
      complete.code = Ps4DownloadCode::hash_mismatch;
      complete.bytes_completed = 0;
      return complete;
    }
    int promotion_error = 0;
    const PromotionResult promotion =
        promote_without_replace(directory.get(), partial.get(), partial_name,
                                destination_name, promotion_error);
    if (promotion != PromotionResult::success) {
      return result_for(promotion == PromotionResult::destination_exists
                            ? Ps4DownloadCode::destination_conflict
                            : Ps4DownloadCode::promotion_failed,
                        promotion_error, status, partial_size);
    }
    return complete;
  }
}

#undef PLAYSTOREHB_RETAIN

}  // namespace playstorehb
