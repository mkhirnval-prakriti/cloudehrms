#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# GitHub Repository Setup & Push Script
# Run this on your local machine after extracting the ZIP
# ─────────────────────────────────────────────────────────────────────────────
set -e

echo "═══════════════════════════════════════════════"
echo "  HRMS Portal — GitHub Push Script"
echo "═══════════════════════════════════════════════"
echo ""

# ── Configuration ─────────────────────────────────────────────────────────────
GITHUB_USERNAME="${1:-YOUR_GITHUB_USERNAME}"
REPO_NAME="hrms-portal-clone"
REPO_DESC="HRMS Portal — Attendance, Payroll & HR Management System"

if [ "$GITHUB_USERNAME" = "YOUR_GITHUB_USERNAME" ]; then
  echo "Usage: bash GITHUB_PUSH.sh YOUR_GITHUB_USERNAME"
  echo ""
  echo "Example: bash GITHUB_PUSH.sh mandeepkumar"
  exit 1
fi

echo "GitHub Username : $GITHUB_USERNAME"
echo "Repository Name : $REPO_NAME"
echo ""

# ── Step 1: Create GitHub repository via API ──────────────────────────────────
echo "Step 1: Creating GitHub repository..."
echo ""
echo "  Option A — GitHub CLI (if installed):"
echo "    gh repo create $REPO_NAME --public --description \"$REPO_DESC\""
echo ""
echo "  Option B — Manual:"
echo "    1. Open: https://github.com/new"
echo "    2. Repository name: $REPO_NAME"
echo "    3. Description: $REPO_DESC"
echo "    4. Visibility: Private (recommended for business use)"
echo "    5. Do NOT initialize with README"
echo "    6. Click Create repository"
echo ""
read -p "Press ENTER after creating the GitHub repository..."

# ── Step 2: Add remote and push ───────────────────────────────────────────────
echo ""
echo "Step 2: Configuring remote and pushing..."

# Check if remote already exists
if git remote get-url origin 2>/dev/null; then
  git remote set-url origin "https://github.com/$GITHUB_USERNAME/$REPO_NAME.git"
  echo "Updated existing remote"
else
  git remote add origin "https://github.com/$GITHUB_USERNAME/$REPO_NAME.git"
  echo "Added remote: https://github.com/$GITHUB_USERNAME/$REPO_NAME.git"
fi

echo ""
echo "Pushing to GitHub..."
echo "(You will be prompted for GitHub credentials)"
echo "  Username: your GitHub username"
echo "  Password: your GitHub Personal Access Token (NOT your GitHub password)"
echo "  Create token at: https://github.com/settings/tokens/new"
echo "  Scopes needed: repo (full)"
echo ""

git push -u origin main

echo ""
echo "═══════════════════════════════════════════════"
echo "✅ SUCCESS! Repository pushed to GitHub"
echo ""
echo "Repository URL:"
echo "  https://github.com/$GITHUB_USERNAME/$REPO_NAME"
echo ""
echo "Next steps:"
echo "  1. Set up Neon database: https://neon.tech"
echo "  2. Deploy backend to Render: https://render.com"
echo "  3. Deploy frontend to Vercel: https://vercel.com"
echo "  4. See DEPLOY.md for full instructions"
echo "═══════════════════════════════════════════════"
