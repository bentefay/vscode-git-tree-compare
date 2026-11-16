{ pkgs, lib, ... }:
{
  packages = [ (import ./nix/toolchain.nix { inherit pkgs; }) ] ++ (with pkgs; [
    git gh curl jq unzip zip ripgrep shellcheck shfmt
  ]) ++ lib.optionals pkgs.stdenv.isLinux (with pkgs; [
    xvfb-run xorg.xauth openbox dbus glibcLocales patchelf
  ]);
  # optionalAttrs, not mkIf: devenv reads every env name, and mkIf false leaves a name with no value.
  env = {
    GTC_DEVENV = "1";
    SAFE_CHAIN_MINIMUM_PACKAGE_AGE_HOURS = "48";
  } // lib.optionalAttrs pkgs.stdenv.isLinux {
    # No host service directories: a private test bus must not start user keyrings.
    GTC_DBUS_CONFIG = toString (pkgs.writeText "test-session.conf" ''
      <!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
        "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
      <busconfig>
        <type>session</type><listen>unix:tmpdir=/tmp</listen><auth>EXTERNAL</auth>
        <policy context="default">
          <allow send_destination="*" eavesdrop="true"/>
          <allow eavesdrop="true"/><allow own="*"/>
        </policy>
      </busconfig>
    '');
    GTC_LINUX_LOADER = "${pkgs.stdenv.cc.bintools.dynamicLinker}";
    # Runtime dependencies for checksum-pinned upstream VS Code / ChromeDriver.
    GTC_RUNTIME_LIBRARY_PATH = lib.makeLibraryPath (with pkgs; [
      glibc stdenv.cc.cc glib nss nspr atk at-spi2-atk libdrm libxkbcommon
      xorg.libX11 xorg.libXcomposite xorg.libXdamage xorg.libXext xorg.libXfixes
      xorg.libXrandr xorg.libxcb xorg.libxkbfile systemd libsecret mesa libgbm expat alsa-lib cups dbus gtk3 pango cairo
    ]);
  };
  enterShell = ''
    export PATH="$DEVENV_ROOT/cli/bin:$PATH"
  '';
  cachix.enable = false;
  devenv.warnOnNewVersion = false;
}
