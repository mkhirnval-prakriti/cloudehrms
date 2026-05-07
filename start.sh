#!/usr/bin/env bash
# HRMS Portal — Start script
# Simple startup for Render/Railway/Koyeb free tier
set -e

# Create uploads directory if not exists
mkdir -p uploads

# Start Node.js server
exec node server.js
