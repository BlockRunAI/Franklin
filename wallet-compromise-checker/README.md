# 🔒 Wallet Compromise Checker

A sophisticated web application for analyzing cryptocurrency wallet security. Detect compromise indicators, permission issues, and potential security threats in your Ethereum, Base, Arbitrum, and Solana wallets.

**Deployed URL:** https://blockrunai.github.io/Franklin

## ✨ Features

- **🔍 Comprehensive Security Analysis**: Checks address format, entropy, weak patterns, and network consistency
- **🧭 Address-Only Input**: Analyze public wallet addresses without requiring private keys or files
- **🔐 Local Processing**: All analysis happens in your browser - no sensitive data leaves your device
- **🎨 Smart UI**: Modern, responsive design with real-time feedback
- **⛓️ Multi-Chain Support**: Ethereum/Base and Solana address validation
- **📊 Detailed Reports**: Clear security findings with actionable recommendations

## 🚀 Quick Start

### Option 1: Run Locally

```bash
# Clone or download the wallet-compromise-checker directory
cd wallet-compromise-checker

# Install dependencies
npm install

# Start the development server
npm start
```

Then open http://localhost:3000 in your browser.

### Option 2: Open Directly

Simply open `index.html` in your web browser. No server required!

## 🔧 How to Use

1. **Enter Your Public Address**: Paste your wallet address in the input field
2. **Select Network**: Choose Ethereum/Base or Solana
3. **Run Check**: Click "Run Security Check" to analyze
4. **Review Results**: Examine the detailed security report

## 🛡️ Security Checks Performed

- ✅ **Format Validation**: Ensures public address matches the selected network format
- ✅ **Length Verification**: Confirms address length is valid for Ethereum/Base or Solana
- ✅ **Entropy Analysis**: Measures address character distribution and pattern strength
- ✅ **Pattern Detection**: Identifies repeated or predictable address patterns
- ✅ **Checksum Validation**: Validates Ethereum address checksum where applicable

## 🎯 Security Best Practices

- **Never share private keys** with anyone or any service
- **Only share public addresses** in trusted contexts
- **Regular audits** help catch issues early
- **Confirm the network** before sending funds to an address
- **Multiple backups** ensure you never lose access to your wallet
- **Rotate keys** if compromise is suspected

## 🔒 Privacy & Security

- **100% Client-Side**: All processing happens in your browser
- **No Data Transmission**: Keys never leave your device
- **No External Dependencies**: Works offline once loaded
- **Open Source**: Transparent security analysis

## 🛠️ Technical Details

- **Pure JavaScript**: No frameworks, fast loading
- **Responsive Design**: Works on desktop and mobile
- **Modern CSS**: Uses CSS custom properties and grid/flexbox
- **Accessibility**: Screen reader friendly with proper ARIA labels

## 🤝 Contributing

This is part of the Franklin AI Agent project. Contributions welcome!

## 📄 License

MIT License - see Franklin project for details.

---

**Built with ❤️ by Franklin AI Agent**