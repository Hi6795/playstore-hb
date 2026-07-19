#include "playstorehb/ps4_shell.hpp"

#if !defined(PLAYSTOREHB_PS4)
#error "ps4_shell.cpp is only for an OpenOrbis target"
#endif

#include <orbis/Pad.h>
#include <orbis/SystemService.h>
#include <orbis/UserService.h>
#include <orbis/VideoOut.h>
#include <orbis/libkernel.h>

#include <cstddef>
#include <cstdint>
#include <cstring>

namespace playstorehb {
namespace {

constexpr int kWidth = 1920;
constexpr int kHeight = 1080;
constexpr int kBufferCount = 2;
constexpr std::size_t kFrameBytes = static_cast<std::size_t>(kWidth) * kHeight * sizeof(std::uint32_t);
constexpr std::size_t kDirectAlignment = 0x200000;

struct Color {
  std::uint8_t red;
  std::uint8_t green;
  std::uint8_t blue;
};

// A deliberately cinematic palette: deep ink, cool mist, and restrained neon.
// Keeping the brightest colors sparse makes the interface feel like a console
// launcher instead of a grid of toy-like store tiles.
constexpr Color kBackgroundTop{7, 11, 23};
constexpr Color kBackgroundBottom{18, 12, 31};
constexpr Color kSurface{20, 27, 43};
constexpr Color kSurfaceRaised{32, 36, 57};
constexpr Color kHairline{52, 61, 82};
constexpr Color kWhite{243, 247, 255};
constexpr Color kMuted{137, 151, 176};
constexpr Color kCyan{76, 222, 232};
constexpr Color kBlue{87, 117, 255};
constexpr Color kPurple{190, 91, 239};
constexpr Color kRose{255, 102, 143};
constexpr Color kGreen{92, 226, 174};
constexpr Color kWarning{255, 194, 100};

std::uint32_t encode(Color color) {
  return 0x80000000U | (static_cast<std::uint32_t>(color.red) << 16U) |
         (static_cast<std::uint32_t>(color.green) << 8U) | static_cast<std::uint32_t>(color.blue);
}

Color blend(Color from, Color to, int amount, int maximum) {
  return {
      static_cast<std::uint8_t>((from.red * (maximum - amount) + to.red * amount) / maximum),
      static_cast<std::uint8_t>((from.green * (maximum - amount) + to.green * amount) / maximum),
      static_cast<std::uint8_t>((from.blue * (maximum - amount) + to.blue * amount) / maximum),
  };
}

std::uint64_t integer_sqrt(std::uint64_t value) {
  std::uint64_t result = 0;
  std::uint64_t bit = static_cast<std::uint64_t>(1) << 62U;
  while (bit > value) bit >>= 2U;
  while (bit != 0U) {
    if (value >= result + bit) {
      value -= result + bit;
      result = (result >> 1U) + bit;
    } else {
      result >>= 1U;
    }
    bit >>= 2U;
  }
  return result;
}

class Framebuffer final {
 public:
  Framebuffer() = default;
  Framebuffer(const Framebuffer&) = delete;
  Framebuffer& operator=(const Framebuffer&) = delete;

  ~Framebuffer() { shutdown(); }

  bool initialize() {
    video_handle_ = sceVideoOutOpen(ORBIS_VIDEO_USER_MAIN, ORBIS_VIDEO_OUT_BUS_MAIN, 0, nullptr);
    if (video_handle_ < 0) return false;
    if (sceKernelCreateEqueue(&flip_queue_, "playstore-hb-flips") < 0) return false;
    if (sceVideoOutAddFlipEvent(flip_queue_, video_handle_, nullptr) < 0) return false;

    allocation_size_ = ((kFrameBytes * kBufferCount + kDirectAlignment - 1U) / kDirectAlignment) * kDirectAlignment;
    if (sceKernelAllocateDirectMemory(0, sceKernelGetDirectMemorySize(), allocation_size_, kDirectAlignment, 3,
                                      &direct_offset_) < 0) {
      return false;
    }
    if (sceKernelMapDirectMemory(&mapped_memory_, allocation_size_, 0x33, 0, direct_offset_, kDirectAlignment) < 0) {
      return false;
    }

    auto* bytes = static_cast<std::uint8_t*>(mapped_memory_);
    for (int index = 0; index < kBufferCount; ++index) {
      buffers_[index] = reinterpret_cast<std::uint32_t*>(bytes + (kFrameBytes * index));
    }

    OrbisVideoOutBufferAttribute attribute{};
    sceVideoOutSetBufferAttribute(&attribute, ORBIS_VIDEO_OUT_PIXEL_FORMAT_A8B8G8R8_SRGB,
                                  ORBIS_VIDEO_OUT_TILING_MODE_LINEAR, ORBIS_VIDEO_OUT_ASPECT_RATIO_16_9, kWidth,
                                  kHeight, kWidth);
    if (sceVideoOutRegisterBuffers(video_handle_, 0, reinterpret_cast<void* const*>(buffers_), kBufferCount,
                                   &attribute) < 0) {
      return false;
    }
    buffers_registered_ = true;
    if (sceVideoOutSetFlipRate(video_handle_, ORBIS_VIDEO_OUT_FLIP_60HZ) < 0) return false;
    clear(kBackgroundTop);
    return true;
  }

  void shutdown() {
    if (buffers_registered_ && video_handle_ >= 0) {
      sceVideoOutUnregisterBuffers(video_handle_, 0);
      buffers_registered_ = false;
    }
    if (mapped_memory_ != nullptr) {
      sceKernelMunmap(mapped_memory_, allocation_size_);
      mapped_memory_ = nullptr;
    }
    if (allocation_size_ != 0U) {
      sceKernelReleaseDirectMemory(direct_offset_, allocation_size_);
      allocation_size_ = 0U;
    }
    if (flip_queue_ != 0U) {
      sceKernelDeleteEqueue(flip_queue_);
      flip_queue_ = 0U;
    }
    if (video_handle_ >= 0) {
      sceVideoOutClose(video_handle_);
      video_handle_ = -1;
    }
  }

  void clear(Color color) {
    auto* target = buffers_[active_buffer_];
    const std::uint32_t value = encode(color);
    for (std::size_t pixel = 0; pixel < static_cast<std::size_t>(kWidth) * kHeight; ++pixel) target[pixel] = value;
  }

  void rectangle(int x, int y, int width, int height, Color color) {
    if (width <= 0 || height <= 0 || x >= kWidth || y >= kHeight || x + width <= 0 || y + height <= 0) return;
    const int start_x = x < 0 ? 0 : x;
    const int start_y = y < 0 ? 0 : y;
    const int end_x = x + width > kWidth ? kWidth : x + width;
    const int end_y = y + height > kHeight ? kHeight : y + height;
    const std::uint32_t value = encode(color);
    auto* target = buffers_[active_buffer_];
    for (int row = start_y; row < end_y; ++row) {
      auto* output = target + (static_cast<std::size_t>(row) * kWidth) + start_x;
      for (int column = start_x; column < end_x; ++column) *output++ = value;
    }
  }

  void outline(int x, int y, int width, int height, int thickness, Color color) {
    rectangle(x, y, width, thickness, color);
    rectangle(x, y + height - thickness, width, thickness, color);
    rectangle(x, y, thickness, height, color);
    rectangle(x + width - thickness, y, thickness, height, color);
  }

  void diagonal_band(int x, int y, int width, int height, int shift, Color color) {
    if (height <= 0) return;
    for (int row = 0; row < height; ++row) {
      rectangle(x + (shift * row) / height, y + row, width, 1, color);
    }
  }

  void line(int start_x, int start_y, int end_x, int end_y, int thickness, Color color) {
    int x = start_x;
    int y = start_y;
    const int delta_x = end_x >= start_x ? end_x - start_x : start_x - end_x;
    const int step_x = start_x < end_x ? 1 : -1;
    const int delta_y_abs = end_y >= start_y ? end_y - start_y : start_y - end_y;
    const int delta_y = -delta_y_abs;
    const int step_y = start_y < end_y ? 1 : -1;
    int error = delta_x + delta_y;
    for (;;) {
      rectangle(x - thickness / 2, y - thickness / 2, thickness, thickness, color);
      if (x == end_x && y == end_y) break;
      const int doubled_error = error * 2;
      if (doubled_error >= delta_y) {
        error += delta_y;
        x += step_x;
      }
      if (doubled_error <= delta_x) {
        error += delta_x;
        y += step_y;
      }
    }
  }

  void ellipse(int center_x, int center_y, int radius_x, int radius_y, Color color) {
    if (radius_x <= 0 || radius_y <= 0) return;
    const std::uint64_t radius_y_squared = static_cast<std::uint64_t>(radius_y) * radius_y;
    for (int offset_y = -radius_y; offset_y <= radius_y; ++offset_y) {
      const std::uint64_t offset_squared = static_cast<std::uint64_t>(offset_y * offset_y);
      const std::uint64_t inside = radius_y_squared - offset_squared;
      const int extent = static_cast<int>((static_cast<std::uint64_t>(radius_x) * integer_sqrt(inside)) / radius_y);
      rectangle(center_x - extent, center_y + offset_y, extent * 2 + 1, 1, color);
    }
  }

  void ellipse_outline(int center_x, int center_y, int radius_x, int radius_y, int thickness, Color color) {
    if (radius_x <= 0 || radius_y <= 0 || thickness <= 0) return;
    const int inner_x = radius_x > thickness ? radius_x - thickness : 0;
    const int inner_y = radius_y > thickness ? radius_y - thickness : 0;
    const std::uint64_t outer_y_squared = static_cast<std::uint64_t>(radius_y) * radius_y;
    const std::uint64_t inner_y_squared = static_cast<std::uint64_t>(inner_y) * inner_y;
    for (int offset_y = -radius_y; offset_y <= radius_y; ++offset_y) {
      const std::uint64_t offset_squared = static_cast<std::uint64_t>(offset_y * offset_y);
      const int outer_extent = static_cast<int>(
          (static_cast<std::uint64_t>(radius_x) * integer_sqrt(outer_y_squared - offset_squared)) / radius_y);
      if (inner_x == 0 || inner_y == 0 || offset_y <= -inner_y || offset_y >= inner_y) {
        rectangle(center_x - outer_extent, center_y + offset_y, outer_extent * 2 + 1, 1, color);
        continue;
      }
      const int inner_extent = static_cast<int>(
          (static_cast<std::uint64_t>(inner_x) * integer_sqrt(inner_y_squared - offset_squared)) / inner_y);
      const int edge_width = outer_extent - inner_extent;
      rectangle(center_x - outer_extent, center_y + offset_y, edge_width, 1, color);
      rectangle(center_x + inner_extent + 1, center_y + offset_y, edge_width, 1, color);
    }
  }

  void gradient_background() {
    constexpr int kBands = 48;
    for (int band = 0; band < kBands; ++band) {
      const int top = (kHeight * band) / kBands;
      const int bottom = (kHeight * (band + 1)) / kBands;
      rectangle(0, top, kWidth, bottom - top, blend(kBackgroundTop, kBackgroundBottom, band, kBands - 1));
    }

    // Off-screen ellipses and diagonal veils form an ambient, asymmetric
    // composition without relying on bitmap artwork or rectangular cards.
    ellipse(1660, 318, 610, 610, blend(kBackgroundBottom, kPurple, 1, 8));
    ellipse(1660, 318, 470, 470, blend(kBackgroundBottom, kBlue, 1, 10));
    diagonal_band(1410, -180, 250, 1280, -330, blend(kPurple, kBackgroundBottom, 1, 7));
    diagonal_band(1785, -120, 72, 1260, -330, blend(kCyan, kBackgroundBottom, 1, 8));
    ellipse_outline(1660, 318, 530, 530, 2, blend(kPurple, kHairline, 1, 3));
    ellipse_outline(1660, 318, 390, 390, 1, blend(kBlue, kHairline, 1, 3));

    constexpr int kStarX[] = {114, 294, 504, 746, 918, 1126, 1338, 1514, 1780, 1862};
    constexpr int kStarY[] = {322, 856, 612, 270, 918, 414, 846, 176, 748, 506};
    for (int index = 0; index < 10; ++index) {
      rectangle(kStarX[index], kStarY[index], index % 3 == 0 ? 3 : 2, index % 3 == 0 ? 3 : 2,
                blend(kMuted, kBackgroundTop, 1, 2));
    }
  }

  bool present(std::int64_t frame_id) {
    if (sceVideoOutSubmitFlip(video_handle_, active_buffer_, ORBIS_VIDEO_OUT_FLIP_VSYNC, frame_id) < 0) return false;
    for (;;) {
      OrbisVideoOutFlipStatus status{};
      if (sceVideoOutGetFlipStatus(video_handle_, &status) < 0) return false;
      if (status.flipArg == frame_id) break;
      OrbisKernelEvent event{};
      int event_count = 0;
      if (sceKernelWaitEqueue(flip_queue_, &event, 1, &event_count, nullptr) < 0) return false;
    }
    active_buffer_ = (active_buffer_ + 1) % kBufferCount;
    return true;
  }

 private:
  int video_handle_{-1};
  int active_buffer_{0};
  bool buffers_registered_{false};
  OrbisKernelEqueue flip_queue_{0};
  off_t direct_offset_{0};
  std::size_t allocation_size_{0};
  void* mapped_memory_{nullptr};
  std::uint32_t* buffers_[kBufferCount]{nullptr, nullptr};
};

const std::uint8_t* glyph(char character) {
  static constexpr std::uint8_t kBlank[7] = {0, 0, 0, 0, 0, 0, 0};
  static constexpr std::uint8_t kGlyphs[][7] = {
      {14, 17, 19, 21, 25, 17, 14}, {4, 12, 4, 4, 4, 4, 14},       {14, 17, 1, 2, 4, 8, 31},
      {30, 1, 1, 14, 1, 1, 30},  {2, 6, 10, 18, 31, 2, 2},        {31, 16, 16, 30, 1, 1, 30},
      {14, 16, 16, 30, 17, 17, 14}, {31, 1, 2, 4, 8, 8, 8},       {14, 17, 17, 14, 17, 17, 14},
      {14, 17, 17, 15, 1, 1, 14}, {14, 17, 17, 31, 17, 17, 17},  {30, 17, 17, 30, 17, 17, 30},
      {14, 17, 16, 16, 16, 17, 14}, {30, 17, 17, 17, 17, 17, 30}, {31, 16, 16, 30, 16, 16, 31},
      {31, 16, 16, 30, 16, 16, 16}, {14, 17, 16, 23, 17, 17, 15}, {17, 17, 17, 31, 17, 17, 17},
      {14, 4, 4, 4, 4, 4, 14},    {7, 2, 2, 2, 2, 18, 12},       {17, 18, 20, 24, 20, 18, 17},
      {16, 16, 16, 16, 16, 16, 31}, {17, 27, 21, 21, 17, 17, 17}, {17, 25, 21, 19, 17, 17, 17},
      {14, 17, 17, 17, 17, 17, 14}, {30, 17, 17, 30, 16, 16, 16}, {14, 17, 17, 17, 21, 18, 13},
      {30, 17, 17, 30, 20, 18, 17}, {15, 16, 16, 14, 1, 1, 30},  {31, 4, 4, 4, 4, 4, 4},
      {17, 17, 17, 17, 17, 17, 14}, {17, 17, 17, 17, 17, 10, 4}, {17, 17, 17, 21, 21, 21, 10},
      {17, 17, 10, 4, 10, 17, 17}, {17, 17, 10, 4, 4, 4, 4},    {31, 1, 2, 4, 8, 16, 31},
  };
  if (character >= 'a' && character <= 'z') character = static_cast<char>(character - ('a' - 'A'));
  if (character >= '0' && character <= '9') return kGlyphs[character - '0'];
  if (character >= 'A' && character <= 'Z') return kGlyphs[10 + (character - 'A')];
  static constexpr std::uint8_t kPeriod[7] = {0, 0, 0, 0, 0, 6, 6};
  static constexpr std::uint8_t kColon[7] = {0, 6, 6, 0, 6, 6, 0};
  static constexpr std::uint8_t kDash[7] = {0, 0, 0, 31, 0, 0, 0};
  static constexpr std::uint8_t kSlash[7] = {1, 2, 2, 4, 8, 8, 16};
  static constexpr std::uint8_t kApostrophe[7] = {6, 6, 4, 0, 0, 0, 0};
  static constexpr std::uint8_t kOpenParen[7] = {2, 4, 8, 8, 8, 4, 2};
  static constexpr std::uint8_t kCloseParen[7] = {8, 4, 2, 2, 2, 4, 8};
  switch (character) {
    case '.': return kPeriod;
    case ':': return kColon;
    case '-': return kDash;
    case '/': return kSlash;
    case '\'': return kApostrophe;
    case '(': return kOpenParen;
    case ')': return kCloseParen;
    default: return kBlank;
  }
}

void draw_text(Framebuffer& frame, int x, int y, const char* text, int scale, Color color, int tracking = 0) {
  int cursor_x = x;
  int cursor_y = y;
  const int advance = 6 * scale + tracking;
  for (const char* current = text; *current != '\0'; ++current) {
    if (*current == '\n') {
      cursor_x = x;
      cursor_y += 9 * scale;
      continue;
    }
    const auto* rows = glyph(*current);
    for (int row = 0; row < 7; ++row) {
      for (int column = 0; column < 5; ++column) {
        if ((rows[row] & (1U << (4 - column))) != 0U) {
          frame.rectangle(cursor_x + column * scale, cursor_y + row * scale, scale, scale, color);
        }
      }
    }
    cursor_x += advance;
  }
}

// Hero copy uses a monoline interpretation of the bitmap glyphs. Connecting
// neighboring glyph points produces airy geometric letterforms while retaining
// a dependency-free framebuffer renderer. Compact labels keep the denser font
// above for readability at TV distance.
void draw_headline(Framebuffer& frame, int x, int y, const char* text, int unit, Color color, int tracking = 0) {
  int cursor_x = x;
  int cursor_y = y;
  const int radius = unit >= 6 ? 2 : 1;
  const int thickness = radius * 2 + 1;
  for (const char* current = text; *current != '\0'; ++current) {
    if (*current == '\n') {
      cursor_x = x;
      cursor_y += 9 * unit;
      continue;
    }
    const auto* rows = glyph(*current);
    for (int row = 0; row < 7; ++row) {
      for (int column = 0; column < 5; ++column) {
        const std::uint8_t mask = static_cast<std::uint8_t>(1U << (4 - column));
        if ((rows[row] & mask) == 0U) continue;
        const int point_x = cursor_x + column * unit;
        const int point_y = cursor_y + row * unit;
        frame.ellipse(point_x, point_y, radius, radius, color);
        if (column < 4 && (rows[row] & (1U << (3 - column))) != 0U) {
          frame.line(point_x, point_y, point_x + unit, point_y, thickness, color);
        }
        if (row < 6) {
          if ((rows[row + 1] & mask) != 0U) {
            frame.line(point_x, point_y, point_x, point_y + unit, thickness, color);
          } else {
            if (column > 0 && (rows[row + 1] & (1U << (5 - column))) != 0U) {
              frame.line(point_x, point_y, point_x - unit, point_y + unit, thickness, color);
            }
            if (column < 4 && (rows[row + 1] & (1U << (3 - column))) != 0U) {
              frame.line(point_x, point_y, point_x + unit, point_y + unit, thickness, color);
            }
          }
        }
      }
    }
    cursor_x += 6 * unit + tracking;
  }
}

int text_width(const char* text, int scale, int tracking = 0) {
  const int length = static_cast<int>(std::strlen(text));
  return length == 0 ? 0 : length * (6 * scale + tracking) - tracking;
}

void draw_logo(Framebuffer& frame) {
  frame.ellipse_outline(124, 91, 32, 32, 2, blend(kCyan, kBlue, 1, 2));
  frame.diagonal_band(105, 69, 9, 44, 22, kCyan);
  frame.diagonal_band(123, 69, 9, 44, 22, kBlue);
  frame.diagonal_band(141, 69, 9, 44, 22, kPurple);
  draw_text(frame, 181, 64, "PLAYSTORE HB", 4, kWhite, 2);
  draw_text(frame, 183, 113, "INDEPENDENT HOMEBREW DISCOVERY", 2, kMuted, 2);
}

constexpr const char* kTabs[] = {"HOME", "BROWSE", "QUEUE", "INSTALLED", "SETTINGS", "ABOUT"};
constexpr int kTabCount = static_cast<int>(sizeof(kTabs) / sizeof(kTabs[0]));

void draw_navigation(Framebuffer& frame, int selected) {
  int x = 1110;
  for (int index = 0; index < kTabCount; ++index) {
    const int width = text_width(kTabs[index], 2, 2);
    if (index == selected) {
      draw_text(frame, x, 82, kTabs[index], 2, kWhite, 2);
      frame.rectangle(x, 118, width, 2, blend(kCyan, kPurple, index, kTabCount - 1));
    } else {
      draw_text(frame, x, 82, kTabs[index], 2, kMuted, 2);
    }
    x += width + 28;
  }
  frame.rectangle(96, 164, 1728, 1, kHairline);
}

void draw_kicker(Framebuffer& frame, int x, int y, const char* label, Color color) {
  frame.rectangle(x, y + 7, 40, 2, color);
  draw_text(frame, x + 58, y, label, 2, color, 3);
}

void draw_status(Framebuffer& frame, int x, int y, const char* label, Color color) {
  frame.ellipse(x + 6, y + 7, 6, 6, blend(color, kWhite, 1, 6));
  frame.ellipse_outline(x + 6, y + 7, 10, 10, 1, blend(color, kSurface, 1, 3));
  draw_text(frame, x + 28, y, label, 2, kWhite, 2);
}

void draw_metric(Framebuffer& frame, int x, int y, const char* label, const char* value, Color accent) {
  draw_text(frame, x, y, label, 2, kMuted, 2);
  draw_text(frame, x, y + 40, value, 3, accent, 2);
}

void draw_empty_catalog(Framebuffer& frame) {
  frame.line(96, 246, 96, 624, 2, blend(kCyan, kBlue, 1, 2));
  draw_kicker(frame, 116, 228, "CURATED FOR THE HOMEBREW SCENE", kCyan);
  draw_headline(frame, 112, 284, "DISCOVER\nHOMEBREW\nWITHOUT LIMITS.", 5, kWhite, 3);
  draw_text(frame, 114, 448,
            "A QUIET, VERIFIED LIBRARY BUILT FOR ORIGINAL\nCREATORS AND CURIOUS PLAYERS.",
            3, kMuted, 1);
  draw_status(frame, 116, 552, "CATALOG ONLINE", kGreen);

  // The empty count is treated as an elegant data state, not an empty tile.
  frame.ellipse(1488, 442, 246, 246, blend(kSurface, kPurple, 1, 14));
  frame.ellipse_outline(1488, 442, 246, 246, 2, blend(kPurple, kHairline, 1, 3));
  frame.ellipse_outline(1488, 442, 196, 196, 1, blend(kBlue, kHairline, 1, 2));
  frame.diagonal_band(1270, 424, 438, 18, -92, blend(kRose, kPurple, 1, 2));
  draw_headline(frame, 1438, 358, "00", 7, kWhite, 5);
  draw_text(frame, 1398, 468, "RELEASES READY", 2, kCyan, 3);
  draw_text(frame, 1360, 520, "CURATION IN PROGRESS", 2, kMuted, 2);

  frame.rectangle(112, 700, 1696, 1, kHairline);
  draw_metric(frame, 112, 728, "CATALOG", "ONLINE", kGreen);
  frame.rectangle(462, 726, 1, 82, kHairline);
  draw_metric(frame, 504, 728, "APPROVED", "0 RELEASES", kWhite);
  frame.rectangle(874, 726, 1, 82, kHairline);
  draw_metric(frame, 916, 728, "SOURCE", "VERIFIED ONLY", kCyan);
  frame.rectangle(1342, 726, 1, 82, kHairline);
  draw_metric(frame, 1384, 728, "INSTALL", "CONFIRM FIRST", kPurple);
  draw_text(frame, 112, 852,
            "THE LIBRARY OPENS AS SOON AS REVIEWED, REDISTRIBUTABLE HOMEBREW IS PUBLISHED.",
            2, kMuted, 2);
}

void draw_browse(Framebuffer& frame) {
  draw_kicker(frame, 112, 228, "CURATED LIBRARY", kBlue);
  draw_headline(frame, 110, 284, "EXPLORE THE\nUNCOMMON.", 6, kWhite, 3);
  draw_text(frame, 112, 424,
            "EVERY RELEASE MUST CLEAR PACKAGE, LICENSE,\nREDISTRIBUTION, MEDIA, AND REAL-HARDWARE REVIEW.",
            3, kMuted, 1);
  draw_status(frame, 114, 540, "PRODUCTION DATA ONLY", kGreen);

  frame.ellipse_outline(1470, 480, 214, 214, 2, blend(kBlue, kPurple, 1, 2));
  frame.ellipse_outline(1470, 480, 154, 154, 1, kHairline);
  frame.line(1582, 630, 1698, 746, 12, blend(kBlue, kPurple, 1, 2));
  draw_headline(frame, 1435, 410, "0", 8, kWhite, 2);
  draw_text(frame, 1375, 528, "TITLES FOUND", 2, kCyan, 3);

  frame.rectangle(112, 788, 1696, 1, kHairline);
  draw_text(frame, 112, 824, "NO APPROVED RELEASES YET", 4, kWhite, 2);
  draw_text(frame, 112, 878, "CHECK BACK WHEN THE FIRST CURATED DROP GOES LIVE.", 2, kMuted, 2);
}

void draw_queue(Framebuffer& frame) {
  draw_kicker(frame, 112, 228, "TRANSFER PIPELINE", kPurple);
  draw_headline(frame, 110, 284, "READY WHEN\nYOU ARE.", 6, kWhite, 3);
  draw_text(frame, 112, 428, "NO PACKAGES ARE DOWNLOADING.", 3, kMuted, 2);
  draw_status(frame, 114, 492, "0 ACTIVE TRANSFERS", kCyan);

  frame.line(278, 676, 824, 604, 3, kHairline);
  frame.line(824, 604, 1356, 680, 3, kHairline);
  frame.line(1356, 680, 1682, 580, 3, kHairline);
  const int node_x[] = {278, 824, 1356, 1682};
  const int node_y[] = {676, 604, 680, 580};
  const char* node_label[] = {"RECEIVE", "RESUME", "VERIFY", "INSTALL"};
  for (int index = 0; index < 4; ++index) {
    frame.ellipse(node_x[index], node_y[index], 12, 12, index == 0 ? kPurple : kSurfaceRaised);
    frame.ellipse_outline(node_x[index], node_y[index], 20, 20, 2, index == 0 ? kPurple : kHairline);
    draw_text(frame, node_x[index] - 42, node_y[index] + 44, node_label[index], 2,
              index == 0 ? kWhite : kMuted, 2);
  }
  frame.rectangle(112, 814, 1696, 1, kHairline);
  draw_text(frame, 112, 850,
            "PARTIAL FILES, RESUME CHECKS, SIZE VALIDATION, AND STREAMING SHA-256 ARE BUILT IN.",
            2, kMuted, 2);
}

void draw_installed(Framebuffer& frame) {
  draw_kicker(frame, 112, 228, "YOUR COLLECTION", kCyan);
  draw_headline(frame, 110, 284, "MAKE IT\nYOUR OWN.", 6, kWhite, 3);
  draw_text(frame, 112, 430, "NO PLAYSTORE HB INSTALL RECORDS", 3, kMuted, 2);
  draw_status(frame, 114, 494, "COLLECTION READY", kGreen);

  frame.ellipse(1506, 492, 230, 230, blend(kSurface, kCyan, 1, 16));
  frame.ellipse_outline(1506, 492, 230, 230, 2, blend(kCyan, kHairline, 1, 3));
  frame.diagonal_band(1298, 474, 416, 20, -86, blend(kCyan, kBlue, 1, 2));
  draw_headline(frame, 1472, 420, "0", 8, kWhite, 2);
  draw_text(frame, 1424, 540, "INSTALLED", 2, kCyan, 3);

  frame.rectangle(112, 790, 1696, 1, kHairline);
  draw_text(frame, 112, 826,
            "GAME ID   TITLE ID   VERSION   PACKAGE HASH   INSTALL DATE   CATALOG SOURCE",
            2, kMuted, 2);
  draw_text(frame, 112, 874, "INSTALL HISTORY WILL APPEAR HERE.", 3, kWhite, 1);
}

void draw_settings(Framebuffer& frame) {
  draw_kicker(frame, 112, 228, "SYSTEM PREFERENCES", kBlue);
  draw_headline(frame, 110, 284, "SETTINGS", 6, kWhite, 3);
  const char* labels[] = {"CONFIRM BUTTON", "DOWNLOAD CONCURRENCY", "KEEP DOWNLOADED PKGS", "HIGH CONTRAST", "REDUCED MOTION"};
  const char* values[] = {"CROSS", "1", "ASK", "ON", "ON"};
  for (int row = 0; row < 5; ++row) {
    const int y = 404 + row * 78;
    draw_text(frame, 112, y, labels[row], 2, kMuted, 2);
    draw_text(frame, 760, y, values[row], 3, row >= 3 ? kGreen : kWhite, 2);
    frame.rectangle(112, y + 47, 948, 1, kHairline);
  }
  frame.line(1162, 378, 1162, 804, 1, kHairline);
  draw_text(frame, 1230, 404, "RELEASE CHANNEL", 2, kMuted, 2);
  draw_text(frame, 1230, 452, "PRODUCTION", 4, kWhite, 2);
  frame.rectangle(1230, 516, 400, 2, blend(kWarning, kRose, 1, 3));
  draw_text(frame, 1230, 558, "CUSTOM REPOSITORY URLS", 2, kMuted, 2);
  draw_text(frame, 1230, 608, "DISABLED", 4, kWarning, 2);
  draw_text(frame, 1230, 684, "ONLY THE SIGNED RELEASE\nCATALOG IS ACCEPTED.", 3, kMuted, 1);
}

void draw_about(Framebuffer& frame) {
  draw_kicker(frame, 112, 228, "ABOUT THIS PROJECT", kPurple);
  draw_headline(frame, 110, 284, "INDEPENDENT.\nOPEN. ORIGINAL.", 6, kWhite, 3);
  draw_status(frame, 114, 456, "VERSION 0.1.0", kCyan);
  draw_status(frame, 114, 506, "NO TELEMETRY", kGreen);

  frame.line(1000, 286, 1000, 810, 1, kHairline);
  draw_text(frame, 1070, 290,
            "PLAYSTORE HB IS AN INDEPENDENT\nHOMEBREW PROJECT.",
            4, kWhite, 1);
  draw_text(frame, 1070, 410,
            "IT IS NOT AFFILIATED WITH OR ENDORSED BY\nSONY INTERACTIVE ENTERTAINMENT, GOOGLE, OR\nANY COMMERCIAL GAME PUBLISHER.",
            3, kMuted, 1);
  frame.rectangle(1070, 558, 520, 2, blend(kPurple, kBlue, 1, 2));
  draw_text(frame, 1070, 606,
            "BUILT WITH THE OPEN-SOURCE\nOPENORBIS TOOLCHAIN.",
            3, kWhite, 1);
  draw_text(frame, 1070, 720, "TITLE ID  PSTB00001", 2, kMuted, 2);
}

void draw_footer(Framebuffer& frame, bool exit_prompt) {
  frame.rectangle(96, 948, 1728, 1, kHairline);
  if (exit_prompt) {
    draw_text(frame, 112, 978, "EXIT PLAYSTORE HB? HOLD OPTIONS", 3, kWarning, 2);
  } else {
    draw_text(frame, 112, 978, "D-PAD  NAVIGATE     CONFIRM  SELECT     BACK  HOME", 2, kWhite, 2);
    draw_text(frame, 930, 978, "L1 / R1  SECTION     TRIANGLE  BROWSE     SQUARE  QUEUE", 2, kMuted, 1);
  }
  draw_text(frame, 1676, 1020, "PSTB00001", 1, kMuted, 1);
}

void render(Framebuffer& frame, int selected, bool exit_prompt) {
  frame.gradient_background();
  draw_logo(frame);
  draw_navigation(frame, selected);
  switch (selected) {
    case 0: draw_empty_catalog(frame); break;
    case 1: draw_browse(frame); break;
    case 2: draw_queue(frame); break;
    case 3: draw_installed(frame); break;
    case 4: draw_settings(frame); break;
    default: draw_about(frame); break;
  }
  draw_footer(frame, exit_prompt);
}

class Controller final {
 public:
  ~Controller() {
    if (handle_ >= 0) scePadClose(handle_);
    if (user_service_initialized_) sceUserServiceTerminate();
  }

  bool initialize() {
    OrbisUserServiceInitializeParams user_params{};
    user_params.priority = ORBIS_KERNEL_PRIO_FIFO_LOWEST;
    if (sceUserServiceInitialize(&user_params) >= 0) user_service_initialized_ = true;
    int user_id = ORBIS_VIDEO_USER_MAIN;
    if (sceUserServiceGetInitialUser(&user_id) < 0) return false;
    if (scePadInit() < 0) return false;
    handle_ = scePadOpen(user_id, ORBIS_PAD_PORT_TYPE_STANDARD, 0, nullptr);
    return handle_ >= 0;
  }

  bool poll(std::uint32_t& buttons, std::uint32_t& pressed) {
    OrbisPadData data{};
    if (scePadReadState(handle_, &data) < 0) return false;
    buttons = data.buttons;
    if (data.leftStick.x < 55U) buttons |= ORBIS_PAD_BUTTON_LEFT;
    if (data.leftStick.x > 200U) buttons |= ORBIS_PAD_BUTTON_RIGHT;
    if (data.leftStick.y < 55U) buttons |= ORBIS_PAD_BUTTON_UP;
    if (data.leftStick.y > 200U) buttons |= ORBIS_PAD_BUTTON_DOWN;
    pressed = buttons & ~previous_buttons_;
    previous_buttons_ = buttons;
    return true;
  }

 private:
  int handle_{-1};
  bool user_service_initialized_{false};
  std::uint32_t previous_buttons_{0};
};

}  // namespace

int run_ps4_shell() {
  Framebuffer frame;
  if (!frame.initialize()) return 10;
  Controller controller;
  if (!controller.initialize()) return 20;
  sceSystemServiceHideSplashScreen();

  int selected = 0;
  bool exit_prompt = false;
  int options_hold_frames = 0;
  std::int64_t frame_id = 1;
  for (;;) {
    std::uint32_t buttons = 0;
    std::uint32_t pressed = 0;
    if (controller.poll(buttons, pressed)) {
      if ((pressed & (ORBIS_PAD_BUTTON_RIGHT | ORBIS_PAD_BUTTON_R1)) != 0U) {
        selected = (selected + 1) % kTabCount;
        exit_prompt = false;
      }
      if ((pressed & (ORBIS_PAD_BUTTON_LEFT | ORBIS_PAD_BUTTON_L1)) != 0U) {
        selected = (selected + kTabCount - 1) % kTabCount;
        exit_prompt = false;
      }
      if ((pressed & ORBIS_PAD_BUTTON_TRIANGLE) != 0U) {
        selected = 1;
        exit_prompt = false;
      }
      if ((pressed & ORBIS_PAD_BUTTON_SQUARE) != 0U) {
        selected = 2;
        exit_prompt = false;
      }
      if ((pressed & ORBIS_PAD_BUTTON_OPTIONS) != 0U && !exit_prompt) {
        selected = 5;
      }
      if ((pressed & ORBIS_PAD_BUTTON_CIRCLE) != 0U) {
        if (selected != 0) {
          selected = 0;
          exit_prompt = false;
        } else {
          exit_prompt = !exit_prompt;
        }
      }
      if (exit_prompt && (buttons & ORBIS_PAD_BUTTON_OPTIONS) != 0U) {
        ++options_hold_frames;
        if (options_hold_frames >= 75) break;
      } else {
        options_hold_frames = 0;
      }
    }

    render(frame, selected, exit_prompt);
    if (!frame.present(frame_id++)) return 30;
  }
  return 0;
}

}  // namespace playstorehb
