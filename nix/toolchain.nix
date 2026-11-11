{ pkgs }:
let
  platform = pkgs.stdenv.hostPlatform.system;
  assets = {
    x86_64-linux = [ "linuxstatic-x64" "0a7287bbf5562610e1c4881b928037378c97b4ba7578694287b2ad3b7140b033" ];
    aarch64-linux = [ "linuxstatic-arm64" "0d565a91e2b1bf0e8ed0ab44cb22fad2aafc05259fe7d92eb40cafc41501ab59" ];
    x86_64-darwin = [ "macos-x64" "9b9bfa830d760dc757af3098d99efd5032b1fd7e492cffeae0794e56a32bdad1" ];
    aarch64-darwin = [ "macos-arm64" "f359f808e2fa8aec183f31795d1e34b10a9c08f8374d72d2747d577523dd1ee0" ];
  };
  asset = assets.${platform};
  safeChain = pkgs.stdenv.mkDerivation {
    pname = "safe-chain";
    version = "1.5.29";
    src = pkgs.fetchurl {
      url = "https://github.com/AikidoSec/safe-chain/releases/download/1.5.29/safe-chain-${builtins.elemAt asset 0}";
      sha256 = builtins.elemAt asset 1;
    };
    dontUnpack = true;
    dontStrip = true;
    dontPatchELF = true;
    # Outside bin/: Safe Chain falls back to writable ~/.safe-chain/certs.
    installPhase = "install -Dm755 $src $out/libexec/safe-chain";
  };
  safe = pkgs.writeShellScriptBin "safe-chain" ''
    case "''${1:-}" in
      setup|setup-ci|teardown) echo 'Safe Chain is managed by Nix in this project.' >&2; exit 1 ;;
    esac
    unset PKG_EXECPATH
    exec ${safeChain}/libexec/safe-chain "$@"
  '';
  npm = pkgs.writeShellScriptBin "npm" ''
    case "''${1:-}" in
      exec|x) echo 'Declare dependencies and use npm run instead of npm exec.' >&2; exit 1 ;;
      run|run-script|test|start|stop|restart)
        # Preserve the protected PATH for package scripts and their subprocesses.
        exec ${pkgs.nodejs_24}/bin/npm "$@" ;;
    esac
    export PATH="${pkgs.nodejs_24}/bin:$PATH"
    exec ${safe}/bin/safe-chain npm "$@"
  '';
  block = name: pkgs.writeShellScriptBin name ''
    echo '${name}: use declared dependencies through npm in this project.' >&2
    exit 1
  '';
in pkgs.symlinkJoin {
  name = "git-tree-compare-toolchain";
  paths = [ safe npm (pkgs.writeShellScriptBin "node" ''
    exec ${pkgs.nodejs_24}/bin/node "$@"
  '') ] ++ map block [ "npx" "pnpm" "pnpx" "yarn" "bun" "bunx" "deno" "corepack" ];
}
