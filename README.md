# 🎡 Ringwheel

Multi-ring classroom spinner for fair, fun randomization. Spins nested wheels (Region, Taxon, IUCN) at once, supports veto/re-spin, pair-cap rules, "Plantae Mercy," projector mode, ASMR audio + confetti, random events, and full logging to Google Sheets with an Admin editor. MVP uses a Google Apps Script Web App backend.

## Features

### Core Spinner
- **3 Concentric Wheels**: Region (8 options), Taxon (10 options), IUCN Status (7 options)
- **Cryptographic RNG**: Uses `crypto.getRandomValues()` for fair, secure randomization
- **Veto & Re-spin**: Block unwanted results and spin again
- **Pair Cap (12%)**: Prevents any Region+Taxon combination from exceeding 12% of total spins
- **No Exact Triple**: Prevents identical triple combinations in succession
- **Plantae Mercy**: When Taxon=Plantae and IUCN is NT/VU/EN, re-roll to safer status (optional manual Region selection)

### UI Features
- **Ticker Animation**: Visual spinning effect with synchronized audio ticks
- **Audio Effects**: ASMR-style tick sounds during spin, celebration sound on completion
- **Confetti Celebration**: Canvas confetti burst when spin completes
- **Responsive Design**: Built with Tailwind CSS for mobile and desktop

### Admin Panel
- **Settings Management**: Toggle audio, confetti, Plantae Mercy, adjust pair cap percentage and ticker speed
- **Ring Weight Editor**: Customize probability weights for each option in all three rings
- **API Status**: Visual indicator of backend connection status

### Backend Integration
- **Google Apps Script Web App**: Serverless backend using Google Sheets
- **GET Endpoints**: roster, rings, settings
- **POST Endpoints**: logSpin, writeRings, writeSettings, email
- **Token Authentication**: Secure API access with environment variables

## Tech Stack

- **Frontend**: Vite + React + TypeScript + Tailwind CSS
- **Routing**: React Router (routes: `/spin` and `/admin`)
- **Effects**: canvas-confetti for celebrations
- **Backend**: Google Apps Script Web App
- **Storage**: Google Sheets

## Getting Started

### Prerequisites
- Node.js 16+
- npm or yarn
- Google account (for backend setup)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/ricktron/ringwheel.git
cd ringwheel
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file (copy from `.env.example`):
```bash
cp .env.example .env
```

4. Configure environment variables in `.env`:
```env
VITE_WEB_APP_URL=https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec
VITE_API_TOKEN=your_secret_token_here
```

### Backend Setup

See [backend/README.md](./backend/README.md) for detailed Google Apps Script setup instructions.

### Development

Run the development server:
```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Build

Build for production:
```bash
npm run build
```

The built files will be in the `dist` directory.

## Routes

- `/spin` - Main spinner interface
- `/admin` - Admin panel for settings and ring weight management

## Project Structure

```
ringwheel/
├── backend/              # Google Apps Script code
│   ├── Code.gs          # Apps Script Web App
│   └── README.md        # Backend setup guide
├── src/
│   ├── components/      # React components
│   │   └── SpinnerWheels.tsx
│   ├── pages/          # Page components
│   │   ├── SpinPage.tsx
│   │   └── AdminPage.tsx
│   ├── services/       # API and audio services
│   │   ├── api.ts
│   │   └── audio.ts
│   ├── utils/          # Utilities
│   │   ├── crypto-rng.ts
│   │   └── spin-engine.ts
│   ├── types.ts        # TypeScript type definitions
│   ├── App.tsx         # Main app component with routing
│   └── main.tsx        # App entry point
├── .env.example        # Environment variables template
├── .gitignore
└── README.md
```

## Screenshots

### Spin Page
![Spin Page](https://github.com/user-attachments/assets/f8c31023-fd44-4494-9b6f-7a2299102f1a)

### Admin Panel
![Admin Panel](https://github.com/user-attachments/assets/04eda835-def4-4bbc-8478-56093247de09)

### Spin Result
![Spin Complete](https://github.com/user-attachments/assets/9dd60259-9d39-45ad-acdf-02d4b6dfee54)

## License

MIT
