#include "playstorehb/screens.hpp"
#include <iostream>
int main(){std::cout<<"Playstore HB platform contract: "<<playstorehb::screen_names.size()<<" screens registered\n";return playstorehb::screen_names.size()==20?0:1;}
