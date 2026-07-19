#pragma once
#include <array>
#include <string_view>
namespace playstorehb {
enum class Screen { splash, first_run, home, browse, categories, search, search_results, game_details, screenshots, download_queue, download_details, installed, updates, storage, settings, network_diagnostics, repository_status, about, error_details, offline };
inline constexpr std::array<std::string_view,20> screen_names={"Splash","First run","Home","Browse","Categories","Search","Search results","Game details","Screenshots","Download queue","Download details","Installed","Updates","Storage","Settings","Network diagnostics","Repository status","About","Error details","Offline"};
enum class Action { up,down,left,right,select,back,search,secondary,previous_category,next_category,previous_page,next_page,menu,quick_search };
struct InputState { Action action{}; std::uint64_t timestamp_ms{}; bool long_press{}; };
class InputDebouncer { public: bool accept(const InputState& input){if(input.timestamp_ms-last_ms_<120)return false;last_ms_=input.timestamp_ms;return true;} private:std::uint64_t last_ms_{}; };
}
