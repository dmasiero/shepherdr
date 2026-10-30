{
  # The fork's dev shell (FORK.md): what scripts/sync-upstream.sh needs (tsc and vite are Node scripts), which renix
  # runs in it, and tea for the Gitea pull requests the fork adds.
  description = "Shepherdr (the dmasiero fork, 2.1 line)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { nixpkgs, ... }:
    let
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
    in
    {
      devShells.x86_64-linux.default = pkgs.mkShell {
        packages = [ pkgs.bun pkgs.nodejs pkgs.gh pkgs.git pkgs.tea ];
      };
    };
}
