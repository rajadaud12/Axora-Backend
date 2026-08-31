# 🚀 Axora Backend

> **Next-Generation Financial Infrastructure** bridging **ERC-4337 Account Abstraction**, **Real-World Assets (RWA tokenized US equities)**, **DeFi High-Yield Savings (Aave V3)**, and **Enterprise Compliance (Persona KYC)** for the Axora Mobile Application.

---

## 📑 Table of Contents

- [Overview](#-overview)
- [Architecture & Key Features](#-architecture--key-features)
  - [1. ERC-4337 Account Abstraction Engine](#1-erc-4337-account-abstraction-engine)
  - [2. Dinari RWA & Omnibus Stock Trading](#2-dinari-rwa--omnibus-stock-trading)
  - [3. Aave V3 DeFi Yield Generation](#3-aave-v3-defi-yield-generation)
  - [4. Persona Identity & KYC Verification](#4-persona-identity--kyc-verification)
  - [5. Live Market Data & Charting Proxy](#5-live-market-data--charting-proxy)
- [System Architecture](#-system-architecture)
- [Project Structure](#-project-structure)
- [API Reference](#-api-reference)
  - [Market Data (`/api/market`)](#market-data-apimarket)
  - [DeFi Earn & Yield (`/api/earn`)](#defi-earn--yield-apiearn)
  - [Dinari RWA Equities (`/api/dinari`)](#dinari-rwa-equities-apidinari)
  - [KYC & Compliance (`/api/kyc`)](#kyc--compliance-apikyc)
  - [Health Checks (`/health`)](#health-checks-health)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Environment Setup](#environment-setup)
  - [Running the Server](#running-the-server)
  - [Building for Production](#building-for-production)
  - [Testing & Verification](#testing--verification)
- [Security & Design Patterns](#-security--design-patterns)
- [License](#-license)

---

## 🌟 Overview

**Axora Backend** is the high-performance orchestration layer for the **Axora Mobile App**. It abstracts Web3 complexities away from the end user, delivering a Web2-like fintech experience powered by on-chain rails:

* ⛽ **Zero-Gas Experience**: Leverages ERC-4337 Account Abstraction and Alchemy Gas Manager to sponsor gas across multi-chain operations.
* 📈 **Tokenized Equities (dShares)**: Integrated with the **Dinari Enterprise SDK** using a scalable **Omnibus Managed Wallet Architecture** for gasless fractional equity trading.
* 🏦 **High-Yield Dollar Savings**: Automated Aave V3 liquidity supply/withdrawal with real-time APY tracking via DefiLlama.
* 🪪 **Compliant KYC**: Seamless integration with **Persona** for mobile-embedded and hosted identity verification workflows.
* ⚡ **High Concurrency & Low Latency**: Powered by **Node.js, TypeScript, Express, Viem, Permissionless.js**, and an embedded **SQLite (WAL Mode)** database.

---

## 🏛 Architecture & Key Features

```
                                  ┌────────────────────────┐
                                  │    Axora Mobile App    │
                                  │   (Flutter / Privy)    │
                                  └───────────┬────────────┘
                                              │ HTTP / JSON
                                              ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                   AXORA BACKEND API                                     │
├───────────────────┬───────────────────┬───────────────────┬─────────────────────────────┤
│   ERC-4337 AA     │    Dinari RWA     │      Aave V3      │         Persona KYC         │
│  UserOp Builder   │  Omnibus Trading  │   Yield Manager   │     Identity Compliance     │
└─────────┬─────────┴─────────┬─────────┴─────────┬─────────┴──────────────┬──────────────┘
          │                   │                   │                        │
          ▼                   ▼                   ▼                        ▼
  ┌───────────────┐   ┌───────────────┐   ┌───────────────┐        ┌───────────────┐
  │ Alchemy AA    │   │ Dinari API &  │   │ Aave V3 Pool  │        │  Persona API  │
  │ Bundler &     │   │ dShares Smart │   │ (Arbitrum     │        │  Verification │
  │ Paymaster     │   │ Contracts     │   │  Sepolia)     │        │  Engine       │
  └───────────────┘   └───────────────┘   └───────────────┘        └───────────────┘
```

### 1. ERC-4337 Account Abstraction Engine
* **Deterministic Smart Contract Accounts**: Derives counterfactual `SimpleAccount` contract addresses from a user's EOA (Privy embedded wallet) using `signerToSimpleSmartAccount`.
* **Server-Side UserOp Construction**: Prepares, gas-estimates, and sponsors `UserOperation` structs on the backend (`buildUserOperation`). The mobile app signs the hash using device keys, and the backend relays the signed operation to the bundler.
* **Multi-Chain Bundler Dispatch**: Supports both **Arbitrum Sepolia** (Aave DeFi & general txs) and **Ethereum Sepolia** (Dinari sandbox dShares).

### 2. Dinari RWA & Omnibus Stock Trading
* **Omnibus Model**: Provides institutional-grade fractional stock execution where trades are deposited into an omnibus managed wallet (`OMNIBUS_MANAGED_WALLET`) and processed via Dinari Enterprise SDK.
* **Full Order Lifecycle Management**:
  - `prepare-buy` / `prepare-sell`: Registers pending orders in SQLite.
  - `transfer-userop` / `sell-transfer-userop`: Generates sponsored token transfer operations.
  - `confirm-buy` / `confirm-sell`: Verifies on-chain deposit settlement, executes order via Dinari API, handles fill reconciliation, and initiates user payouts.
* **Automated Portfolio Aggregator**: Merges on-chain ERC-20 dShare balances with Dinari custody holdings, calculates market values, cost basis, and performance metrics.
* **Sandbox Faucet Automation**: Seamlessly interacts with Dinari sandbox faucets to fund test wallets with mockUSD.

### 3. Aave V3 DeFi Yield Generation
* **Atomic Batch Operations**: Compiles ERC-20 `approve` and Aave Pool `supply`/`withdraw` actions into a single atomic sponsored UserOp.
* **Dynamic APY Monitoring**: Automatically fetches and caches live Aave APYs via DefiLlama chart endpoints with graceful fallback mechanisms.
* **Account Balances**: Dual-layer balance inspection tracking both spendable USDC and interest-bearing aUSDC for both EOAs and Smart Accounts.

### 4. Persona Identity & KYC Verification
* **Server-Side Inquiry Creation**: Dispatches KYC inquiries linked to the user's DID/reference ID (`reference-id`).
* **Session Token Extraction**: Handles session token retrieval and inquiry resumption for Flutter Persona SDK compatibility.
* **Status Synchronization**: Inquiries and verification statuses are cached locally and refreshed on-demand.

### 5. Live Market Data & Charting Proxy
* **Yahoo Finance Integration**: Proxies real-time quotes, company details, sparkline mini-charts, and interactive historical charting data across configurable timeframes (`1d`, `1mo`, `1y`).

---

## 📂 Project Structure

```
backend/
├── dist/                          # Compiled JavaScript build artifacts
├── scripts/
│   ├── list-dshares-421614.cjs    # Script to inspect dShares on Arbitrum Sepolia
│   └── test-portfolio-math.ts     # Portfolio balance merge & share math test suite
├── src/
│   ├── routes/
│   │   ├── dinari.ts              # Dinari RWA equities, orders, omnibus & portfolio
│   │   ├── earn.ts                # Aave V3 deposit, withdraw, APY & balances
│   │   ├── kyc.ts                 # Persona KYC verification & inquiry flows
│   │   └── market.ts              # Yahoo Finance market data, quotes & charts
│   ├── services/
│   │   └── aaService.ts           # ERC-4337 Account Abstraction, bundler & paymaster
│   ├── db.ts                      # SQLite schema, queries & WAL configuration
│   └── server.ts                  # Express application entrypoint & middleware
├── .env.example                   # Template for environment variables
├── .gitignore                     # Git ignore rules (node_modules, .env, DBs)
├── package.json                   # Project metadata, dependencies & scripts
├── test_tx.js                     # On-chain contract test script
└── tsconfig.json                  # TypeScript compiler configuration
```

---

## 🔌 API Reference

### Market Data (`/api/market`)

| Method | Endpoint | Description | Query / Params |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/market/assets` | Batch quote sparklines | `?symbols=AAPL,TSLA,NVDA` |
| `GET` | `/api/market/details/:ticker` | Detailed asset quote & metrics | `ticker` (e.g. `AAPL`) |
| `GET` | `/api/market/chart/:ticker` | Historical chart data | `?range=1mo&interval=1d` |

---

### DeFi Earn & Yield (`/api/earn`)

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/earn/balances/:address` | Fetch USDC & aUSDC balances for EOA and Smart Account |
| `GET` | `/api/earn/transactions/deposit` | Build UserOp for Aave V3 USDC deposit (`?user=0x...&amount=100`) |
| `GET` | `/api/earn/transactions/withdraw` | Build UserOp for Aave V3 USDC withdrawal (`?user=0x...&amount=100`) |
| `POST` | `/api/earn/transactions/execute-userop` | Broadcast signed UserOp to the bundler |
| `GET` | `/api/earn/transactions/receipt/:hash` | Poll UserOperation receipt status (`?chainId=...`) |

---

### Dinari RWA Equities (`/api/dinari`)

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/dinari/setup` | Register/retrieve Dinari entity and user account |
| `GET` | `/api/dinari/stocks` | List available tokenized stocks (dShares) |
| `GET` | `/api/dinari/stocks/check/:ticker` | Check dShare availability and token contract |
| `GET` | `/api/dinari/stocks/:id/quote` | Fetch real-time buy/sell quote from Dinari |
| `POST` | `/api/dinari/order/omnibus/prepare-buy` | Prepare omnibus fractional stock purchase |
| `GET` | `/api/dinari/order/omnibus/transfer-userop`| Build transfer UserOp for payment deposit |
| `POST` | `/api/dinari/order/omnibus/confirm-buy` | Verify deposit & trigger Dinari execution |
| `POST` | `/api/dinari/order/omnibus/prepare-sell`| Prepare omnibus stock sell order |
| `GET` | `/api/dinari/order/omnibus/sell-transfer-userop` | Build dShare transfer UserOp for sell deposit |
| `POST` | `/api/dinari/order/omnibus/confirm-sell`| Settle sell order and record accounting |
| `GET` | `/api/dinari/portfolio/:walletAddress` | Consolidated RWA stock portfolio & valuations |
| `GET` | `/api/dinari/orders/:walletAddress` | Fetch order history |
| `POST` | `/api/dinari/faucet/:walletAddress` | Fund linked wallet with test mockUSD |

---

### KYC & Compliance (`/api/kyc`)

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/kyc/persona/inquiry` | Create or resume a Persona KYC inquiry |
| `GET` | `/api/kyc/persona/inquiry/:inquiryId` | Retrieve inquiry status directly from Persona |
| `GET` | `/api/kyc/persona/status` | Query KYC verification status by `referenceId` |

---

### Health Checks (`/health`)

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Server liveness probe (`{ "status": "ok" }`) |
| `GET` | `/api/dinari/debug/health` | Inspect Dinari API connectivity & accounts |

---

## 🛠 Getting Started

### Prerequisites
* **Node.js**: `v18.x` or `v20.x`+
* **npm** or **yarn** / **pnpm**
* **Alchemy Account**: API Key and Gas Policy ID for ERC-4337 Paymaster.
* **Dinari Enterprise API Credentials**: API ID, Secret, and Entity ID.
* **Persona API Key**: Inquiry Template ID for KYC onboarding.

### Installation

1. Clone the repository and navigate to the `backend` directory:
```bash
git clone https://github.com/rajadaud12/Axora-Backend.git
cd Axora-Backend
```

2. Install dependencies:
```bash
npm install
```

### Environment Setup

Copy the example environment file and configure your API keys:
```bash
cp .env.example .env
```

Edit `.env` with your credentials:
```ini
PORT=3000
NODE_ENV=development

# Privy Configuration
PRIVY_APP_ID=your_privy_app_id
PRIVY_CLIENT_ID=your_privy_client_id

# Alchemy & Account Abstraction (ERC-4337)
ALCHEMY_API_KEY=your_alchemy_api_key
ALCHEMY_RPC_URL=https://arb-sepolia.g.alchemy.com/v2/your_alchemy_api_key
ARB_SEPOLIA_RPC_URL=https://arbitrum-sepolia.publicnode.com
ALCHEMY_SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/your_alchemy_api_key
ALCHEMY_GAS_POLICY_ID=your_alchemy_gas_policy_id

# Aave V3 Arbitrum Sepolia
USDC_ARB_SEPOLIA_ADDRESS=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
AUSDC_ARB_SEPOLIA_ADDRESS=0x460b97BD498E1157530AEb3086301d5225b91216
AAVE_ARB_SEPOLIA_POOL_ADDRESS=0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff

# Dinari Enterprise API
DINARI_API_ID=your_dinari_api_id
DINARI_API_SECRET=your_dinari_api_secret
DINARI_ENTITY_ID=your_dinari_entity_id
DINARI_ENVIRONMENT=sandbox
DINARI_ORDER_CHAIN_ID=eip155:11155111
DINARI_WALLET_CHAIN_ID=eip155:11155111

# Dinari Omnibus Configuration
OMNIBUS_ACCOUNT_ID=your_dinari_omnibus_account_id
OMNIBUS_MANAGED_WALLET=0xYourOmnibusManagedWalletAddress

# Persona KYC
PERSONA_API_KEY=your_persona_api_key
PERSONA_INQUIRY_TEMPLATE_ID=itmpl_your_inquiry_template_id
PERSONA_API_VERSION=2025-10-27
```

### Running the Server

* **Development Mode (ts-node)**:
```bash
npm run dev
```

* **Production Mode**:
```bash
npm run build
npm start
```

Server will be running at `http://localhost:3000`.

### Testing & Verification

Run the portfolio math validation tests:
```bash
npm run test:portfolio-math
```

---

## 🔒 Security & Design Patterns

* **Non-Custodial Key Architecture**: Private keys remain solely on the client device (Privy secure enclave). The backend acts as an orchestration engine building unsigned UserOperations and gas-sponsoring paymaster data.
* **Idempotency & Accounting**: Pending orders and accounting settlements utilize unique `client_order_id` UUIDs with transactional upserts in SQLite.
* **WAL Mode SQLite**: High-speed concurrent reads and writes with minimal lock contention (`journal_mode = WAL`).
* **Environment Segregation**: Sandbox and production modes for both Dinari and Persona APIs are isolated via environment variables.

---

## 📄 License

This project is licensed under the **ISC License**.
