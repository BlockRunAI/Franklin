#!/bin/bash
# franklin — installer
# One-line install: curl -fsSL https://franklin.run/install.sh | bash
#
# Installs: Node.js (if missing) + Anthropic CLI (optional) + franklin
# Creates wallet and shows funding instructions

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo ""
echo -e "${BOLD}franklin — the AI agent with a wallet${NC}"
echo -e "Spends USDC autonomously across 55+ models. Pay per outcome."
echo ""

# ======================================================================
# 1. Check/install Node.js
# ======================================================================
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version | sed 's/v//')
  NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 20 ]; then
    echo -e "${GREEN}✓${NC} Node.js v${NODE_VERSION}"
  else
    echo -e "${YELLOW}Node.js v${NODE_VERSION} found but v20+ required${NC}"
    echo "Installing Node.js 22..."
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v yum &>/dev/null; then
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
      sudo yum install -y nodejs
    elif command -v brew &>/dev/null; then
      brew install node@22
    else
      echo -e "${RED}Cannot auto-install Node.js. Install manually: https://nodejs.org${NC}"
      exit 1
    fi
    echo -e "${GREEN}✓${NC} Node.js $(node --version) installed"
  fi
else
  echo "Installing Node.js 22..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    if command -v brew &>/dev/null; then
      brew install node@22
    else
      echo -e "${RED}Install Homebrew first: https://brew.sh${NC}"
      exit 1
    fi
  elif command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif command -v yum &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
    sudo yum install -y nodejs
  else
    echo -e "${RED}Cannot auto-install Node.js. Install manually: https://nodejs.org${NC}"
    exit 1
  fi
  echo -e "${GREEN}✓${NC} Node.js $(node --version) installed"
fi

# ======================================================================
# 2. Install Anthropic CLI (optional — only needed for proxy mode)
# ======================================================================
if command -v claude &>/dev/null; then
  echo -e "${GREEN}✓${NC} Anthropic CLI $(claude --version 2>/dev/null || echo 'installed')"
else
  echo "Installing Anthropic CLI (for proxy mode)..."
  curl -fsSL https://claude.ai/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
  echo -e "${GREEN}✓${NC} Anthropic CLI installed"
fi

# ======================================================================
# 3. Install runcode
# ======================================================================
echo "Installing franklin..."
if [[ "$EUID" -eq 0 ]]; then
  npm install -g @blockrun/franklin@latest 2>/dev/null
else
  sudo npm install -g @blockrun/franklin@latest 2>/dev/null || npm install -g @blockrun/franklin@latest 2>/dev/null
fi
echo -e "${GREEN}✓${NC} franklin $(franklin --version 2>/dev/null || echo 'installed')"

# ======================================================================
# 4. Setup wallet
# ======================================================================
echo ""
franklin setup base

# ======================================================================
# 5. Done
# ======================================================================
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}Installation complete!${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo ""
echo -e "  1. Fund your wallet with USDC on Base"
echo -e "     (or use free models without funding)"
echo ""
echo -e "  2. Start franklin:"
echo -e "     ${CYAN}franklin start${NC}                              # default model"
echo -e "     ${CYAN}franklin start --model nvidia/nemotron-ultra-253b${NC}  # free model"
echo -e "     ${CYAN}franklin start --model openai/gpt-5.4${NC}          # GPT-5.4"
echo ""
echo -e "  3. Useful commands:"
echo -e "     ${CYAN}franklin models${NC}    — list all models + pricing"
echo -e "     ${CYAN}franklin balance${NC}   — check wallet balance"
echo -e "     ${CYAN}franklin config list${NC} — view settings"
echo ""
echo -e "  ${BOLD}Docs:${NC} https://Franklin.run"
echo ""
