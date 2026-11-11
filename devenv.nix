{ pkgs, lib, ... }:
{
  packages = [ (import ./nix/toolchain.nix { inherit pkgs; }) ] ++ (with pkgs; [
    git gh curl jq unzip zip ripgrep shellcheck shfmt
  ]) ++ lib.optionals pkgs.stdenv.isLinux (with pkgs; [
    xvfb-run xorg.xauth openbox dbus glibcLocales patchelf
  ]);
  env.GTC_DEVENV = "1";
  # No host service directories: a private test bus must not start user keyrings.
  env.GTC_DBUS_CONFIG = lib.mkIf pkgs.stdenv.isLinux (toString (pkgs.writeText "test-session.conf" ''
    <!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
      "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
    <busconfig>
      <type>session</type><listen>unix:tmpdir=/tmp</listen><auth>EXTERNAL</auth>
      <policy context="default">
        <allow send_destination="*" eavesdrop="true"/>
        <allow eavesdrop="true"/><allow own="*"/>
      </policy>
    </busconfig>
  ''));
  enterShell = ''
    export PATH="$DEVENV_ROOT/cli/bin:$PATH"
  '';
  env.GTC_LINUX_LOADER = lib.mkIf pkgs.stdenv.isLinux "${pkgs.stdenv.cc.bintools.dynamicLinker}";
  env.SAFE_CHAIN_MINIMUM_PACKAGE_AGE_HOURS = "48";
  # Runtime dependencies for checksum-pinned upstream VS Code / ChromeDriver.
  env.GTC_RUNTIME_LIBRARY_PATH = lib.mkIf pkgs.stdenv.isLinux (lib.makeLibraryPath (with pkgs; [
    glibc stdenv.cc.cc glib nss nspr atk at-spi2-atk libdrm libxkbcommon
    xorg.libX11 xorg.libXcomposite xorg.libXdamage xorg.libXext xorg.libXfixes
    xorg.libXrandr xorg.libxcb xorg.libxkbfile systemd libsecret mesa libgbm expat alsa-lib cups dbus gtk3 pango cairo
  ]));
  cachix.enable = false;
  devenv.warnOnNewVersion = false;
}
