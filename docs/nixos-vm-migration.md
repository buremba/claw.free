# NixOS VM Migration Plan

This document describes migrating the deployed OpenClaw VM from Debian 12 + Docker to a fully NixOS-managed system. The goal is to reduce memory usage, provide declarative dependency management via Nix flakes, and enable future GitHub-linked customization.

## Current State

- **VM image**: `projects/debian-cloud/global/images/family/debian-12`
- **Startup**: Bash script installs Nix, apt-installs Docker, clones repos, runs `docker compose up`
- **Memory overhead**: ~400-500MB from Docker daemon + containerd + Nix daemon on top of Debian
- **Dependency management**: Mix of apt, nix profile install, and npm global installs

## Target State

- **VM image**: Custom NixOS GCP image (pre-built, uploaded to GCP)
- **Startup**: VM metadata passes config values, NixOS first-boot services write config and start services (no local `nixos-rebuild` on e2-micro)
- **Memory overhead**: ~100-150MB base NixOS + services running natively via systemd
- **Dependency and secrets model**: dual mode (`Local mode` by default, optional `GitHub mode` for declarative customization and rollback)

### Operating Modes

| Mode | GitHub login | Secrets | Dependency changes | Rollback |
|------|--------------|---------|--------------------|----------|
| Local mode (default) | Optional | Stored only on VM (root-only files) | Applied on VM / non-declarative | Limited (no repo history) |
| GitHub mode (optional) | Required | Encrypted `.age` files in user repo | Commit/PR to flake/module, CI applies | Full rollback via git + Nix generations |

---

## Phase 1: Build NixOS GCP Image

### Tool: nixos-generators

Use [nixos-generators](https://github.com/nix-community/nixos-generators) to produce a GCP-compatible image.

```nix
# image/flake.nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    nixos-generators.url = "github:nix-community/nixos-generators";
    nixos-generators.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, nixos-generators, ... }: {
    packages.x86_64-linux.gcp-image = nixos-generators.nixosGenerate {
      system = "x86_64-linux";
      format = "gce";  # Google Compute Engine image
      modules = [ ./configuration.nix ];
    };
  };
}
```

### Base NixOS Configuration

```nix
# image/configuration.nix
{ pkgs, ... }:

{
  # GCP guest agent for metadata, networking, SSH
  imports = [ ];

  # Enable GCP guest services
  services.google-guest-agent.enable = true;
  services.google-oslogin.enable = true;

  # Flakes support
  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  # Allow unfree packages (for some CLIs)
  nixpkgs.config.allowUnfree = true;

  # Pre-installed system packages (baked into image)
  environment.systemPackages = with pkgs; [
    # Core tools
    git
    jq
    curl
    wget
    htop
    tmux
    neovim

    # Node.js ecosystem
    nodejs_22
    nodePackages.npm

    # AI CLI tools (see Phase 2 for details)
    # Bake these into the image build (preferred), or install once via systemd oneshot

    # Python (for some AI tools)
    python312
    python312Packages.pip

    # Build essentials (for native npm modules)
    gcc
    gnumake
    pkg-config
    openssl
  ];

  # Firewall
  networking.firewall.allowedTCPPorts = [ 22 18789 ];

  # Auto-upgrade nix store garbage collection
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 7d";
  };

  # Minimal memory usage settings
  zramSwap.enable = true;  # Compressed swap — critical for 1GB e2-micro
  zramSwap.memoryPercent = 50;

  system.stateVersion = "24.11";
}
```

### Build and Upload

```bash
# Build the image
nix build .#gcp-image

# Upload to GCP (owletto project)
gcloud compute images create nixos-openclaw-v1 \
  --project=owletto \
  --source-uri=gs://YOUR_BUCKET/nixos-image.raw.tar.gz \
  --family=nixos-openclaw
```

This should be automated in CI (GitHub Actions) so new image versions are built on push.

---

## Phase 2: AI CLI Tools

These tools should be pre-installed on the VM so users can use them immediately.

### Tools to include

| Tool | Install method | Notes |
|------|---------------|-------|
| `@anthropic-ai/claude-code` | npm global | Claude Code CLI |
| `@openai/codex` | npm global | OpenAI Codex CLI |
| `google-gemini-cli` | npm global | Gemini CLI (`@latest`) |
| `aider` | pip / nixpkgs | AI pair programming |
| `gh` | nixpkgs | GitHub CLI — needed for future GitHub linking |

### Installation approach

Install `claude`, `codex`, and `gemini` in the base image so they are available immediately after boot. Use `@latest` for these CLIs in v1. For npm/pip tools not in nixpkgs, either bake them into the image build or install once via a systemd oneshot:

```nix
# modules/ai-tools.nix
{ pkgs, ... }:

let
  npmGlobalInstall = pkgs.writeShellScript "install-ai-tools" ''
    export PATH="${pkgs.nodejs_22}/bin:$PATH"
    npm install -g @anthropic-ai/claude-code@latest @openai/codex@latest google-gemini-cli@latest 2>/dev/null || true
  '';
in {
  systemd.services.install-ai-tools = {
    description = "Install AI CLI tools via npm";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = npmGlobalInstall;
    };
  };
}
```

For long-term reproducibility, package these CLIs as Nix derivations instead of runtime npm installs:

```nix
# packages/claude-code.nix
{ pkgs, ... }:

pkgs.buildNpmPackage {
  pname = "claude-code";
  version = "latest";
  src = pkgs.fetchFromGitHub { /* ... */ };
  # or use npmDepsHash for lockfile-based builds
}
```

### Libraries and runtimes to pre-install

For users who want to write custom skills or tools:

```nix
environment.systemPackages = with pkgs; [
  # Runtimes (minimal base)
  nodejs_22
  python312

  # Common libraries / tools
  sqlite
  redis
  ripgrep
  fd
  tree
  unzip
  zip

  # AI/ML common deps
  python312Packages.requests
  python312Packages.httpx
];
```

---

## Phase 3: Activation Script (replaces startup-script.sh)

Instead of a bash startup script, the VM uses a NixOS activation module that reads GCP metadata and configures the system.

### VM metadata keys (set by deploy/start.ts)

| Key | Value |
|-----|-------|
| `LLM_PROVIDER` | `kimi`, `claude`, or `openai` |
| `OPENCLAW_FLAKE` | (future) GitHub flake URL + path, e.g. `github:user/my-bot?dir=nixos` |
| `BOT_NAME` | User-provided bot/VM name (used as instance name) |

### Activation module

```nix
# modules/openclaw.nix
{ pkgs, lib, ... }:

{
  # OpenClaw application service
  systemd.services.openclaw = {
    description = "OpenClaw AI Assistant";
    after = [ "network-online.target" "openclaw-setup.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "simple";
      WorkingDirectory = "/opt/openclaw/app";
      ExecStart = "${pkgs.nodejs_22}/bin/node dist/main.js";
      Restart = "on-failure";
      RestartSec = 5;
      Environment = [
        "OPENCLAW_CONFIG_PATH=/opt/openclaw/openclaw.json"
        "PATH=${lib.makeBinPath [ pkgs.nodejs_22 pkgs.git pkgs.curl ]}"
      ];
    };
  };

  # Bootstrap provider service
  systemd.services.claw-free-provider = {
    description = "claw-free bootstrap LLM provider";
    after = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "simple";
      WorkingDirectory = "/opt/openclaw/claw-free/provider";
      ExecStart = "${pkgs.nodejs_22}/bin/node server.js";
      Restart = "on-failure";
      RestartSec = 5;
    };
  };

  # First-boot setup
  systemd.services.openclaw-setup = {
    description = "OpenClaw first-boot setup";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = pkgs.writeShellScript "openclaw-setup" ''
        set -euo pipefail

        if [ -f /opt/openclaw/.setup-complete ]; then
          exit 0
        fi

        # Read metadata and local secrets
        LLM_PROVIDER=$(curl -sf "http://metadata.google.internal/computeMetadata/v1/instance/attributes/LLM_PROVIDER" -H "Metadata-Flavor: Google" || echo "kimi")
        SECRET_DIR=/var/lib/openclaw/secrets
        TELEGRAM_TOKEN_FILE="$SECRET_DIR/telegram-token"
        mkdir -p "$SECRET_DIR"
        chmod 700 "$SECRET_DIR"
        TELEGRAM_TOKEN=$(cat "$TELEGRAM_TOKEN_FILE" 2>/dev/null || echo "")

        # Clone repos
        ${pkgs.git}/bin/git clone https://github.com/buremba/openclaw.git /opt/openclaw/app || true
        ${pkgs.git}/bin/git clone https://github.com/buremba/claw.free.git /opt/openclaw/claw-free || true

        # Install provider deps
        cd /opt/openclaw/claw-free/provider
        ${pkgs.nodejs_22}/bin/npm install --production

        # Write config
        cat > /opt/openclaw/openclaw.json <<CONF
        {
          "channels": {
            "telegram": { "token": "$TELEGRAM_TOKEN", "allowedUsers": [] }
          },
          "models": {
            "providers": {
              "claw-free": {
                "baseUrl": "http://localhost:3456/v1",
                "apiKey": "local",
                "api": "openai-completions",
                "models": [{ "id": "setup", "name": "claw.free Setup" }]
              }
            },
            "primaryModel": "claw-free/setup"
          }
        }
        CONF

        touch /opt/openclaw/.setup-complete
      '';
    };
  };
}
```

---

## Phase 4: Changes to claw.free (this repo)

### `functions/api/deploy/start.ts`

Change the VM creation to use the custom NixOS image instead of Debian:

```diff
- sourceImage: "projects/debian-cloud/global/images/family/debian-12",
+ sourceImage: "projects/owletto/global/images/family/nixos-openclaw",
```

Remove `startup-script-url` metadata. Instead, pass non-secret config directly as metadata keys (including `LLM_PROVIDER` and `BOT_NAME`). Secrets are managed either locally on the instance (default) or via encrypted GitHub files in optional GitHub mode.

```diff
  metadata: {
    items: [
-     { key: "startup-script-url", value: startupScriptUrl },
      { key: "LLM_PROVIDER", value: provider },
      { key: "BOT_NAME", value: botName },
    ],
  },
```

### VM naming (`BOT_NAME`)

Allow multiple bots per project by making VM name user-defined instead of fixed `openclaw-vm`:

```diff
- const vmName = "openclaw-vm"
+ const vmName = sanitizeBotName(botName) // e.g. "support-bot-7f3a"
```

Rules:
- Lowercase letters, numbers, and `-` only
- Slug length 3-40 characters from user input, then append `-` + 6-char random hex suffix
- Final VM name max length 63 (GCE instance naming rule)

### Bot list presentation

In the existing bot list UI, show machine type as read-only text (for example `e2-micro`). Do not add in-app resize controls in v1.

### Memory savings

| Component | Debian + Docker | NixOS native |
|-----------|----------------|--------------|
| Base OS | ~150MB | ~80MB |
| Docker daemon | ~200MB | 0 |
| Nix daemon | ~50MB | ~30MB (optimized) |
| OpenClaw app | ~100MB | ~100MB |
| **Total** | **~500MB** | **~210MB** |

On a 1GB e2-micro, this frees ~300MB for actual workloads.

---

## Phase 4.5: CPU and Memory Optimizations for e2-micro

An e2-micro has 1GB RAM and 0.25 vCPU (burstable to 2 vCPU). Every MB counts. These optimizations should be applied in the base NixOS image configuration.

### Kernel and memory tuning

```nix
# In configuration.nix
boot.kernel.sysctl = {
  # Aggressive swap to zram — keeps more in compressed memory
  "vm.swappiness" = 150;  # >100 enables zram preference over disk

  # Allow overcommit — Node.js forks benefit from copy-on-write
  "vm.overcommit_memory" = 1;

  # Reduce minimum free memory requirement
  "vm.min_free_kbytes" = 8192;  # 8MB instead of default ~67MB

  # Reduce inode/dentry cache pressure
  "vm.vfs_cache_pressure" = 200;

  # Disable transparent huge pages — wastes memory on small VMs
  "vm.nr_hugepages" = 0;
};

boot.kernelParams = [ "transparent_hugepage=never" ];
```

### zram swap (compressed RAM swap)

```nix
zramSwap = {
  enable = true;
  memoryPercent = 50;      # Use up to 50% of RAM for compressed swap
  algorithm = "zstd";      # Best compression ratio
  priority = 100;          # Prefer zram over disk swap
};

# No disk swap — zram is faster and sufficient
swapDevices = [];
```

This effectively gives ~1.3-1.5GB usable memory from 1GB physical RAM.

### Disable unnecessary NixOS services

```nix
# Disable services that eat memory on a headless server
documentation.enable = false;        # No man pages in image (~30MB saved)
documentation.man.enable = false;
documentation.doc.enable = false;
documentation.info.enable = false;
documentation.nixos.enable = false;

services.udisks2.enable = false;     # No disk automounting
services.xserver.enable = false;     # No GUI
sound.enable = false;                # No audio
hardware.pulseaudio.enable = false;

# Minimal logging
services.journald.extraConfig = ''
  SystemMaxUse=50M
  RuntimeMaxUse=20M
  MaxRetentionSec=3day
  MaxFileSec=1day
  Compress=yes
  Storage=volatile
'';

# Disable nix daemon when not needed (saves ~30MB)
# Users rebuild via a systemd oneshot that starts nix-daemon temporarily
nix.daemonCPUSchedPolicy = "idle";   # Don't compete with app
nix.daemonIOSchedClass = "idle";
```

### Node.js memory limits

Critical for e2-micro — Node.js V8 defaults to using 1.5GB+ heap which immediately triggers OOM.

```nix
# In service definitions, constrain Node.js heap
systemd.services.openclaw.serviceConfig = {
  Environment = [
    "NODE_OPTIONS=--max-old-space-size=256"
    # ... other env vars
  ];
  # Systemd memory limit as safety net
  MemoryMax = "400M";
  MemoryHigh = "350M";  # Triggers memory pressure before hard limit
};

systemd.services.claw-free-provider.serviceConfig = {
  Environment = [
    "NODE_OPTIONS=--max-old-space-size=128"
  ];
  MemoryMax = "200M";
  MemoryHigh = "150M";
};
```

### OOM killer protection

Protect the main application, sacrifice less important services first:

```nix
systemd.services.openclaw.serviceConfig.OOMScoreAdjust = -500;
systemd.services.claw-free-provider.serviceConfig.OOMScoreAdjust = -300;

# AI CLI tools are expendable — let OOM killer take them first
# (they're interactive, not long-running)
```

### Nix store optimization

```nix
# In configuration.nix
nix.settings = {
  auto-optimise-store = true;  # Hardlink identical files in /nix/store

  # Don't keep build deps around
  keep-outputs = false;
  keep-derivations = false;
};

# Aggressive garbage collection
nix.gc = {
  automatic = true;
  dates = "daily";
  options = "--delete-older-than 3d";
};
```

### Avoid building on the VM

The e2-micro cannot handle `nixos-rebuild` — it will OOM or take 30+ minutes. Two approaches:

**Option A: Push pre-built closures (recommended)**

Build on CI, push the closure to the VM:

```bash
# On CI (GitHub Actions with Nix)
nix build .#nixosConfigurations.default.config.system.build.toplevel
nix copy --to ssh://root@VM_IP ./result

# On VM
nix-env -p /nix/var/nix/profiles/system --set ./result
./result/bin/switch-to-configuration switch
```

**Option B: Use a remote builder**

Configure the VM to delegate builds to a more powerful machine:

```nix
nix.buildMachines = [{
  hostName = "builder.example.com";
  system = "x86_64-linux";
  maxJobs = 4;
  speedFactor = 2;
}];
nix.distributedBuilds = true;
```

### Minimal image closure

Reduce the image size (and therefore the Nix store footprint on disk):

```nix
# Strip everything unnecessary
environment.noXlibs = true;

# Use musl-based packages where possible for smaller binaries
# (not always compatible — test carefully)

# Exclude locale data except en_US
i18n.supportedLocales = [ "en_US.UTF-8/UTF-8" ];

# No fonts
fonts.fontconfig.enable = false;
```

### tmpfs for transient data

```nix
# /tmp in RAM — auto-cleaned, no disk I/O
boot.tmp.useTmpfs = true;
boot.tmp.tmpfsSize = "100M";  # Limit to prevent memory exhaustion
```

### Network optimizations

```nix
# Use systemd-resolved for DNS caching (avoids repeated DNS lookups)
services.resolved = {
  enable = true;
  dnssec = "false";  # Saves CPU on a small VM
};

# TCP tuning for API server
boot.kernel.sysctl = {
  "net.core.somaxconn" = 128;
  "net.ipv4.tcp_fastopen" = 3;
  "net.ipv4.tcp_keepalive_time" = 60;
  "net.ipv4.tcp_keepalive_intvl" = 10;
  "net.ipv4.tcp_keepalive_probes" = 3;
};
```

### Expected memory budget after optimizations

| Component | RSS |
|-----------|-----|
| Kernel + base NixOS | ~60MB |
| systemd + journald (volatile) | ~15MB |
| google-guest-agent | ~15MB |
| sshd | ~5MB |
| OpenClaw (Node, capped) | ~250MB |
| claw-free-provider (Node, capped) | ~120MB |
| zram overhead | ~20MB |
| **Total used** | **~485MB** |
| **Available for workloads/cache** | **~515MB** |
| **Effective with zram** | **~800MB usable** |

This leaves meaningful headroom for user CLI tool invocations (claude, codex, etc.), git operations, and temporary build tasks.

---

## Phase 5: Optional GitHub Mode (Customization + Rollback)

GitHub login is optional overall, but required for GitHub mode features.

### Local mode (default)

- User can deploy and run without GitHub.
- Secrets are set by the agent on the VM and stored as root-only files (e.g. `/var/lib/openclaw/secrets/telegram-token`).
- Platform does not store or read plaintext secrets.
- Dependency/runtime changes are local and not declaratively reproducible.

### GitHub mode (optional)

- User links a GitHub repo and extends the base config at `infra/nixos/base`.
- Dependency changes are implemented by agent commits/PRs to `flake.nix` or modules.
- Secret changes are written as encrypted `.age` files and committed to the repo.
- CI builds and ships the resulting system; VM applies it and can rollback by git revision/Nix generation.

### Agent flow in GitHub mode

When user asks to add a dependency:
1. Agent edits repo flake/module.
2. Agent opens PR or commits.
3. CI builds and publishes closure.
4. VM switches to the new generation and health check verifies rollout.

When user asks to add/rotate a secret:
1. Agent encrypts value to `secrets/<botName>/telegram-token.age`.
2. Agent commits the encrypted file update.
3. VM pulls, decrypts via `agenix`, and reloads the service.
4. Rollback includes previous encrypted secret state.

### Example user flake

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    openclaw.url = "github:buremba/claw.free?dir=infra/nixos/base";
    agenix.url = "github:ryantm/agenix";
  };

  outputs = { self, nixpkgs, openclaw, agenix, ... }: {
    nixosConfigurations.default = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        openclaw.nixosModules.default
        agenix.nixosModules.default
        ({ config, ... }: {
          # User customizations
          age.identityPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
          age.secrets.telegramToken.file = ./secrets/my-bot/telegram-token.age;
          openclaw.telegramTokenFile = config.age.secrets.telegramToken.path;
          openclaw.provider = "claude";
          openclaw.skills = [
            ./skills/my-custom-skill
          ];

          # Additional user packages
          environment.systemPackages = with nixpkgs.legacyPackages.x86_64-linux; [
            ffmpeg
            imagemagick
          ];
        })
      ];
    };
  };
}
```

---

## Implementation Order

1. **Image build pipeline** — Create `nixos-generators` flake, build GCP image, upload to `owletto` image family. Set up GitHub Actions to rebuild on push.
2. **NixOS modules** — Write `openclaw.nix` activation module and `ai-tools.nix` with base-installed Claude/Codex/Gemini CLIs. Test on a manual GCP VM.
3. **Update deploy/start.ts** — Switch image reference from Debian to NixOS, remove startup-script-url, add `BOT_NAME` metadata and dynamic VM naming. Test full deploy flow.
4. **Deploy status + health** — Update deploy polling to mark success only when app health endpoint is reachable.
5. **Local secrets workflow** — Add agent command flow for setting/rotating local VM secrets (no platform secret persistence).
6. **Remove startup-script.sh** — No longer needed for new deploys.
7. **Optional GitHub mode** — Add GitHub linking and expose base flake/module path (`infra/nixos/base`) so user repos can extend config and support declarative rollback.

## Gaps, Risks, and Open Questions

### Security

- **Secrets handling**: In local mode, secrets are stored only on VM (not in platform storage). In optional GitHub mode, only encrypted `.age` files are committed.
- **SSH hardening**: Disable password auth, root login. Use OS Login only (`services.google-oslogin.enable = true` handles this). Consider `fail2ban` but it adds memory overhead — may not be worth it on e2-micro.
- **Firewall**: Currently only ports 22 and 18789 are open. Port 18789 (OpenClaw API) is open to `0.0.0.0/0` — consider whether this needs auth or IP allowlisting.
- **Auto security updates**: NixOS doesn't auto-update by default. Add `system.autoUpgrade` for security patches, but this requires rebuilds which the e2-micro can't do (see "Avoid building on the VM"). Solution: push updated closures from CI on a schedule.

### Secrets management

This project supports two secret modes:

- **Local mode (default)**: secret is created/rotated by the agent on the VM and stored in root-only files under `/var/lib/openclaw/secrets`.
- **GitHub mode (optional)**: secret is committed as an encrypted `agenix` `.age` file per bot instance.

What is an `.age` file:
- An `.age` file is an encrypted file format produced by `age`/`agenix`.
- Example: `telegram-token.age` contains the encrypted Telegram token.
- Only holders of the matching private key can decrypt it at runtime.

GitHub mode flow:
1. Agent encrypts secret to `secrets/<botName>/telegram-token.age`.
2. Agent commits the encrypted file in the user's repo.
3. VM fetches the repo revision and decrypts with `agenix`.
4. Decrypted secret is written to root-only runtime file and injected into service config.

This keeps secrets scoped per bot while staying Nix-native with `agenix`.

Current preference:
- Start with SSH host key recipients for simplicity.
- Known drawback: if host keys rotate or VM is replaced, secrets must be re-encrypted for the new recipient.

Chosen defaults:
- Secret rotation entrypoint: from the bot list UI.
- Health readiness timeout: 5 minutes.

### Monitoring and health checks

The deploy page currently polls `deploy/[id].ts` for VM creation status, but has no insight into whether the app actually started successfully.

- **Startup health probe**: After VM reports RUNNING, poll `http://VM_IP:18789/health` to confirm OpenClaw is actually serving. Only show "Done!" when the health check passes.
- **Systemd watchdog**: Add `WatchdogSec=60` to the OpenClaw service so systemd restarts it if it becomes unresponsive.
- **Simple uptime endpoint**: The landing page could show a green/red dot next to existing VMs by pinging their API endpoints.

```nix
systemd.services.openclaw.serviceConfig = {
  WatchdogSec = 60;
  Restart = "on-failure";
  RestartSec = 5;
  StartLimitBurst = 5;
  StartLimitIntervalSec = 300;
};
```

### First-boot timing

Users are watching the deploy progress spinner. Current timings:
- VM creation: ~30-60s
- Debian startup + Docker pull + npm install: ~3-5min

With NixOS (everything pre-baked in image):
- VM creation: ~30-60s
- NixOS boot + clone repos + npm install provider deps: ~1-2min

To minimize further: pre-bake the provider deps into the image so first boot only needs to clone and write config (~30s). The tradeoff is the image needs rebuilding when provider deps change.

### Disk usage on 30GB pd-standard

| Item | Estimated size |
|------|---------------|
| NixOS base system | ~2GB |
| Pre-installed tools (Node, Python, AI CLIs) | ~2-3GB |
| OpenClaw app + provider | ~200MB |
| Nix store overhead | ~1GB |
| npm global packages (AI CLIs) | ~500MB |
| **Total used** | **~7-8GB** |
| **Free** | **~22GB** |

Plenty of room. But if users start installing packages or cloning large repos, monitor with `nix.gc` and disk usage alerts.

### Image versioning and rollout

- Use GCP image families (`--family=nixos-openclaw`). New deploys automatically get the latest image in the family.
- Existing VMs are NOT affected by new images — they keep running their current image.
- This migration targets **new deploys only**; no backward-compat migration path is required in v1.
- Keep the previous 2-3 images for rollback: `gcloud compute images deprecate`.

### Testing the NixOS image locally

Before uploading to GCP:

```bash
# Build a QEMU image for local testing
nix build .#packages.x86_64-linux.qemu-image

# Run it
qemu-system-x86_64 -m 1024 -drive file=result/nixos.qcow2,format=qcow2 \
  -net nic -net user,hostfwd=tcp::2222-:22,hostfwd=tcp::18789-:18789
```

Or use `nixos-rebuild build-vm` for quick iteration:

```bash
nixos-rebuild build-vm --flake .#default
./result/bin/run-nixos-vm
```

Mock the GCP metadata server for testing: run a simple HTTP server that serves fake metadata on `169.254.169.254`.

### Abuse prevention

Multiple VMs per project are allowed. Add guardrails:

- **Unique VM names per project**: User supplies `BOT_NAME`; sanitize and append a short suffix when needed to avoid collisions.
- **Rate limiting**: Track deploys per session/IP in KV with TTL.
- **Cleanup**: VMs in stopped/terminated state should be deletable from the landing page to free quota.

### Nix binary cache (Cachix)

Building the image in CI is slow without a cache. Set up [Cachix](https://www.cachix.org/) or use GitHub Actions cache:

```yaml
# In .github/workflows/build-image.yml
- uses: cachix/install-nix-action@v22
- uses: cachix/cachix-action@v12
  with:
    name: openclaw
    authToken: '${{ secrets.CACHIX_AUTH_TOKEN }}'
- run: nix build .#gcp-image
```

The VMs can also pull from the cache instead of building locally:

```nix
nix.settings.substituters = [
  "https://cache.nixos.org"
  "https://openclaw.cachix.org"
];
nix.settings.trusted-public-keys = [
  "openclaw.cachix.org-1:XXXX="
];
```

### Error recovery

- **Setup fails mid-way**: The `.setup-complete` sentinel file prevents re-running. If setup fails, the file doesn't exist, so a reboot retries. But partial state (half-cloned repos) can cause issues. Solution: use a staging directory and atomically move on success.
- **VM created but app never starts**: The deploy polling endpoint should timeout after 5 minutes and report an error with a "View logs" link (SSH or serial console output).
- **Session expiry during long deploys**: The session KV has a 600s TTL. If Compute API enablement + VM creation takes longer, the `[id].ts` polling endpoint can't read the access token. Increase TTL to 3600s for deploy sessions, or store the access token in the deploy record itself.

### Open questions for the implementing agent

1. `agenix` identity strategy: use SSH host key recipients (simpler) or dedicated age keypair per bot (better portability).
2. Bootstrap path for GitHub mode: how does VM publish recipient public key so first encrypted secret can be committed without exposing private key.

---

## Where the work lives

| Scope | Repo |
|-------|------|
| NixOS image + modules | `buremba/claw.free` (base path: `infra/nixos/base`) |
| Image build CI | `buremba/claw.free` (GitHub Actions) |
| VM image reference + metadata changes | `buremba/claw.free` (`functions/api/deploy/start.ts`) |
| GitHub linking UI + API | `buremba/claw.free` (frontend + new API endpoints) |
