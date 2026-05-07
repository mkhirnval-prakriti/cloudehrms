#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
# HRMS Portal — One-Command GitHub Setup & Push
# ═══════════════════════════════════════════════════════════════════
# Usage: bash GITHUB_SETUP.sh
# Requirements: git, curl (comes with macOS/Linux)
# ═══════════════════════════════════════════════════════════════════
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }
err()  { echo -e "${RED}❌ $1${NC}"; exit 1; }
info() { echo -e "${BLUE}ℹ️  $1${NC}"; }

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "       HRMS Portal — GitHub Repository Setup"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ── Pre-checks ────────────────────────────────────────────────────
command -v git  >/dev/null 2>&1 || err "git not found. Install git first."
command -v curl >/dev/null 2>&1 || err "curl not found."

# ── Get user input ─────────────────────────────────────────────────
echo "Please provide your GitHub details:"
echo ""
read -rp "  GitHub Username  : " GH_USER
read -rsp "  Personal Access Token (hidden): " GH_TOKEN
echo ""
read -rp "  Repository name  [hrms-portal-clone]: " REPO_NAME
REPO_NAME="${REPO_NAME:-hrms-portal-clone}"
read -rp "  Private repo? (y/n) [y]: " PRIVATE
PRIVATE="${PRIVATE:-y}"

echo ""
info "Setting up repository: github.com/$GH_USER/$REPO_NAME"

# ── Create GitHub repository via API ──────────────────────────────
echo ""
info "Creating GitHub repository..."

PRIVATE_FLAG="true"
[[ "$PRIVATE" =~ ^[Nn] ]] && PRIVATE_FLAG="false"

HTTP_CODE=$(curl -s -o /tmp/gh_create_resp.json -w "%{http_code}" \
  -X POST "https://api.github.com/user/repos" \
  -H "Authorization: token $GH_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"$REPO_NAME\",
    \"description\": \"HRMS Portal — Attendance, Payroll & HR Management System\",
    \"private\": $PRIVATE_FLAG,
    \"auto_init\": false
  }")

if [ "$HTTP_CODE" = "201" ]; then
  ok "Repository created: https://github.com/$GH_USER/$REPO_NAME"
elif [ "$HTTP_CODE" = "422" ]; then
  warn "Repository already exists — will push to existing repo"
else
  cat /tmp/gh_create_resp.json
  err "Failed to create repository (HTTP $HTTP_CODE)"
fi

# ── Configure remote ───────────────────────────────────────────────
echo ""
info "Configuring git remote..."

REMOTE_URL="https://$GH_USER:$GH_TOKEN@github.com/$GH_USER/$REPO_NAME.git"

if git remote get-url origin 2>/dev/null; then
  git remote set-url origin "$REMOTE_URL"
  ok "Updated remote URL"
else
  git remote add origin "$REMOTE_URL"
  ok "Added remote origin"
fi

# ── Push code ──────────────────────────────────────────────────────
echo ""
info "Pushing code to GitHub..."

git push -u origin main 2>&1 | while read -r line; do
  echo "  $line"
done

ok "Code pushed successfully!"

# ── Verify ────────────────────────────────────────────────────────
echo ""
info "Verifying repository..."

VERIFY=$(curl -s \
  -H "Authorization: token $GH_TOKEN" \
  "https://api.github.com/repos/$GH_USER/$REPO_NAME")

FILE_COUNT=$(echo "$VERIFY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('size','?'))" 2>/dev/null)

echo ""
echo "═══════════════════════════════════════════════════════════"
ok "GitHub Repository Ready!"
echo ""
echo "  🔗 Repository : https://github.com/$GH_USER/$REPO_NAME"
echo "  📦 Clone URL  : git clone https://github.com/$GH_USER/$REPO_NAME.git"
echo "  🔒 Visibility : $([ "$PRIVATE_FLAG" = "true" ] && echo "Private" || echo "Public")"
echo ""
echo "  📋 Next Steps:"
echo "  1. Set up Neon DB   → https://neon.tech (free)"
echo "  2. Deploy backend   → https://render.com (connect this repo)"  
echo "  3. Deploy frontend  → https://vercel.com (connect this repo)"
echo "  4. See DEPLOY.md for complete instructions"
echo "═══════════════════════════════════════════════════════════"

# ── Clean token from remote URL ───────────────────────────────────
git remote set-url origin "https://github.com/$GH_USER/$REPO_NAME.git"
ok "Token removed from git config (security)"
