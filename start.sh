#!/bin/bash

# Ensure script runs from project root
cd "$(dirname "$0")"

echo "🚀 Starting MinIO..."
docker compose up -d

echo "⏳ Waiting for MinIO to be ready..."
sleep 3

echo "🚀 Starting Node.js..."
cd backend

# Open browser automatically
if command -v xdg-open >/dev/null; then
  xdg-open http://localhost:4000 &
elif command -v gnome-open >/dev/null; then
  gnome-open http://localhost:4000 &
elif command -v open >/dev/null; then
  open http://localhost:4000 &
fi

node server.js
