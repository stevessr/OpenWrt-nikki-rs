include $(TOPDIR)/rules.mk

PKG_NAME:=clash-rs
PKG_VERSION:=0.20.23_alpha
PKG_RELEASE:=1

# 架构映射与 SHA256 校验码
ifneq ($(findstring x86_64,$(ARCH)),)
  CLASH_TARGET:=x86_64-unknown-linux-musl
  CLASH_HASH:=50ba876081c35a2f3d4936ad370e64631c5a20a4e0c8af991bc310caaf8960b9
else ifneq ($(findstring aarch64,$(ARCH)),)
  CLASH_TARGET:=aarch64-unknown-linux-musl
  CLASH_HASH:=f5a6143dc46e29a4668d111f229a7eaf55c4348979817e05b7d2e1cb541eb199
else ifneq ($(findstring arm,$(ARCH)),)
  CLASH_TARGET:=armv7-unknown-linux-musleabihf
  CLASH_HASH:=938d196fb00edbfd9e5c9145334caf20f189b916bd873f07c7bd26da9a5f3213
else ifneq ($(findstring riscv64,$(ARCH)),)
  CLASH_TARGET:=riscv64gc-unknown-linux-musl
  CLASH_HASH:=0b3bf62f216b6503b7d5c6a322c1a072c8ee598c11f8218d7d09bc87bc91a6d3
else ifneq ($(findstring i386,$(ARCH)),)
  CLASH_TARGET:=i686-unknown-linux-musl
  CLASH_HASH:=c7e30586bb14e1816caa0011d4e2c74111c74dc9ea4a8b37cf7da458e9420153
else ifneq ($(findstring i686,$(ARCH)),)
  CLASH_TARGET:=i686-unknown-linux-musl
  CLASH_HASH:=c7e30586bb14e1816caa0011d4e2c74111c74dc9ea4a8b37cf7da458e9420153
endif


PKG_HASH:=$(CLASH_HASH)

PKG_SOURCE:=clash-rs-minimal-$(CLASH_TARGET).tar.gz
PKG_SOURCE_URL:=https://github.com/CHKayanami/clash-rs/releases/download/v0.20.23-alpha/
PKG_BUILD_DIR:=$(BUILD_DIR)/clash-rs-minimal-$(CLASH_TARGET)

include $(INCLUDE_DIR)/package.mk

define Package/clash-rs
  SECTION:=net
  CATEGORY:=Network
  TITLE:=clash-rs proxy core (Latest Prebuilt from CHKayanami/clash-rs)
  URL:=https://github.com/CHKayanami/clash-rs
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(TAR) -xzf $(DL_DIR)/$(PKG_SOURCE) --strip-components=1 -C $(PKG_BUILD_DIR)
endef

define Build/Compile
	true
endef

define Package/clash-rs/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/clash-rs $(1)/usr/bin/clash-rs
endef

$(eval $(call BuildPackage,clash-rs))
