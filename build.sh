#!/usr/bin/env bash
# HRMS Portal — Build script
set -e

echo "[build] Installing root dependencies..."
npm install
echo "[build] Installing client dependencies..."
npm install --include=dev --prefix client

echo "[build] Building React frontend..."
npm run build --prefix client

echo "[build] ✓ Done"
ls -lh dist/index.html 2>/dev/null || echo "[build] Note: dist/index.html not found — check client build"
