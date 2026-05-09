#!/bin/bash

# Wallet Compromise Checker - Quick Start Script

echo "🔒 Wallet Compromise Checker"
echo "============================"
echo ""

# Check if node is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 16+ first."
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

# Check Node version
NODE_VERSION=$(node -v | sed 's/v//')
REQUIRED_VERSION="16.0.0"

if ! [ "$(printf '%s\n' "$REQUIRED_VERSION" "$NODE_VERSION" | sort -V | head -n1)" = "$REQUIRED_VERSION" ]; then
    echo "❌ Node.js $REQUIRED_VERSION or higher is required. You have $NODE_VERSION."
    exit 1
fi

echo "✅ Node.js $NODE_VERSION detected"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo ""
    echo "📦 Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ Failed to install dependencies"
        exit 1
    fi
    echo "✅ Dependencies installed"
fi

echo ""
echo "🚀 Starting Wallet Compromise Checker..."
echo "   Open http://localhost:3000 in your browser"
echo ""
echo "   Press Ctrl+C to stop the server"
echo ""

# Start the server
npm start