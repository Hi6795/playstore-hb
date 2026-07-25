TITLE       := Playstore HB
VERSION     := 01.00
APP_VERSION := 0.1.0
TITLE_ID    := PSTB00001
CONTENT_ID  := IV0000-PSTB00001_00-PLAYSTOREHB00000

TOOLCHAIN   := $(OO_PS4_TOOLCHAIN)
ROOT        := ../..
BUILD       := $(ROOT)/build/ps4-posix
OBJECTS     := $(BUILD)/obj/main.o $(BUILD)/obj/ps4_shell.o $(BUILD)/obj/application.o $(BUILD)/obj/ps4_download.o $(BUILD)/obj/openorbis_platform.o
ELF         := $(BUILD)/artifacts/playstore-hb.elf
OELF        := $(BUILD)/artifacts/playstore-hb.oelf
PACKAGE     := $(BUILD)/package
EBOOT       := $(PACKAGE)/eboot.bin
PKG         := $(BUILD)/artifacts/Playstore-HB-v$(APP_VERSION)-$(TITLE_ID).pkg

UNAME       := $(shell uname -s)
PLATFORM_BIN := $(if $(filter Darwin,$(UNAME)),macos,linux)
CXX         := clang++
LD          := ld.lld
CREATE_FSELF := $(TOOLCHAIN)/bin/$(PLATFORM_BIN)/create-fself
CREATE_GP4   := $(TOOLCHAIN)/bin/$(PLATFORM_BIN)/create-gp4
PKGTOOL      := $(TOOLCHAIN)/bin/$(PLATFORM_BIN)/PkgTool.Core

CPPFLAGS := -DPLAYSTOREHB_PS4=1 -Iinclude -isysroot $(TOOLCHAIN) -isystem $(TOOLCHAIN)/include -isystem $(TOOLCHAIN)/include/c++/v1
CXXFLAGS := --target=x86_64-pc-freebsd12-elf -std=c++17 -fPIC -funwind-tables -ffunction-sections -fdata-sections -O2 -DNDEBUG -Wall -Wextra -Wpedantic -Werror
LDFLAGS  := -m elf_x86_64 -pie --script $(TOOLCHAIN)/link.x --eh-frame-hdr --gc-sections -L$(TOOLCHAIN)/lib
LIBS     := -lc -lkernel -lc++ -lSceSystemService -lSceVideoOut -lScePad -lSceUserService -lSceNet -lSceSsl -lSceHttp -lSceSysmodule -lSceAppInstUtil

.PHONY: all verify-env clean
all: verify-env $(PKG)

verify-env:
	@test -n "$(TOOLCHAIN)" || (echo "OO_PS4_TOOLCHAIN is required" >&2; exit 1)
	@test -f "$(TOOLCHAIN)/link.x" || (echo "Invalid OpenOrbis root: $(TOOLCHAIN)" >&2; exit 1)
	@command -v $(CXX) >/dev/null
	@command -v $(LD) >/dev/null

$(BUILD)/obj/%.o: src/%.cpp
	@mkdir -p "$(BUILD)/obj"
	$(CXX) $(CPPFLAGS) $(CXXFLAGS) -c -o "$@" "$<"

$(ELF): $(OBJECTS)
	@mkdir -p "$(BUILD)/artifacts"
	$(LD) $(LDFLAGS) -o "$@" $(LIBS) "$(TOOLCHAIN)/lib/crt1.o" $(OBJECTS)

$(EBOOT): $(ELF)
	@mkdir -p "$(PACKAGE)/sce_sys/about" "$(PACKAGE)/sce_module"
	OO_PS4_TOOLCHAIN="$(TOOLCHAIN)" "$(CREATE_FSELF)" -in "$(ELF)" --out "$(OELF)" --eboot "$@" --paid 0x3800000000000011
	cp "sce_sys/icon0.png" "$(PACKAGE)/sce_sys/icon0.png"
	cp "$(TOOLCHAIN)/samples/hello_world/sce_sys/about/right.sprx" "$(PACKAGE)/sce_sys/about/right.sprx"
	cp "$(TOOLCHAIN)/samples/hello_world/sce_module/libc.prx" "$(PACKAGE)/sce_module/libc.prx"
	cp "$(TOOLCHAIN)/samples/hello_world/sce_module/libSceFios2.prx" "$(PACKAGE)/sce_module/libSceFios2.prx"

$(PACKAGE)/sce_sys/param.sfo: Makefile
	@mkdir -p "$(PACKAGE)/sce_sys"
	"$(PKGTOOL)" sfo_new "$@"
	"$(PKGTOOL)" sfo_setentry "$@" APP_TYPE --type Integer --maxsize 4 --value 1
	"$(PKGTOOL)" sfo_setentry "$@" APP_VER --type Utf8 --maxsize 8 --value "$(VERSION)"
	"$(PKGTOOL)" sfo_setentry "$@" ATTRIBUTE --type Integer --maxsize 4 --value 0
	"$(PKGTOOL)" sfo_setentry "$@" CATEGORY --type Utf8 --maxsize 4 --value gd
	"$(PKGTOOL)" sfo_setentry "$@" CONTENT_ID --type Utf8 --maxsize 48 --value "$(CONTENT_ID)"
	"$(PKGTOOL)" sfo_setentry "$@" DOWNLOAD_DATA_SIZE --type Integer --maxsize 4 --value 0
	"$(PKGTOOL)" sfo_setentry "$@" SYSTEM_VER --type Integer --maxsize 4 --value 0
	"$(PKGTOOL)" sfo_setentry "$@" TITLE --type Utf8 --maxsize 128 --value "$(TITLE)"
	"$(PKGTOOL)" sfo_setentry "$@" TITLE_ID --type Utf8 --maxsize 12 --value "$(TITLE_ID)"
	"$(PKGTOOL)" sfo_setentry "$@" VERSION --type Utf8 --maxsize 8 --value "$(VERSION)"

$(PACKAGE)/pkg.gp4: $(EBOOT) $(PACKAGE)/sce_sys/param.sfo
	cd "$(PACKAGE)" && "$(CREATE_GP4)" -out pkg.gp4 --content-id="$(CONTENT_ID)" --files "eboot.bin sce_sys/about/right.sprx sce_sys/param.sfo sce_sys/icon0.png sce_module/libc.prx sce_module/libSceFios2.prx"

$(PKG): $(PACKAGE)/pkg.gp4
	cd "$(PACKAGE)" && "$(PKGTOOL)" pkg_build pkg.gp4 .
	@mkdir -p "$(BUILD)/artifacts" "$(ROOT)/outputs"
	cp "$(PACKAGE)/$(CONTENT_ID).pkg" "$@"
	"$(PKGTOOL)" pkg_validate --verbose "$@" > "$(BUILD)/artifacts/pkg-validation.txt"
	"$(PKGTOOL)" pkg_listentries "$@" > "$(BUILD)/artifacts/pkg-entries.txt"
	cp "$@" "$(ROOT)/outputs/$(notdir $(PKG))"
	@echo "PS4 PKG produced but not hardware tested: $(PKG)"

clean:
	rm -rf "$(BUILD)"
