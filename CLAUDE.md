# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**wasapi-grupo** is a Node.js tool that adds contacts from Excel files to WhatsApp groups using `whatsapp-web.js`. It provides a REST API to manage WhatsApp group operations.

## Development Commands

```bash
# Install dependencies
pnpm install

# Run in development (auto-reload)
pnpm dev

# Run in production
pnpm start
```

First run displays a QR code in terminal - scan with WhatsApp to authenticate. Session persists in `.wwebjs_auth/`.

## Architecture

```
src/
├── server.js         # Express REST API - all endpoints defined here
├── WhatsAppClient.js # Singleton wrapper around whatsapp-web.js
└── excelReader.js    # XLSX parser with auto-detection of phone columns
```

### Key Components

**WhatsAppClient** (`src/WhatsAppClient.js`):
- Singleton pattern: `whatsappClient` instance exported
- Manages Puppeteer/Chrome via whatsapp-web.js
- Handles QR generation, session persistence, group operations
- `_modalInterval` closes WhatsApp Web popups that block the `ready` event
- 45-second timeout forces `connected` state if `ready` event doesn't fire (Windows bug)
- `normalizePhone()` standardizes phone numbers (removes +, adds country code)

**Excel Reader** (`src/excelReader.js`):
- Auto-detects phone column by keywords: `telefono`, `phone`, `celular`, `whatsapp`, etc.
- Falls back to first column if no match

**Server** (`src/server.js`):
- Express 5 with ESM modules (`"type": "module"`)
- Multer handles file uploads to `uploads/` (10MB limit, .xlsx/.xls only)
- Graceful shutdown with 6s timeout for Chrome cleanup

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/status` | Connection status |
| GET | `/qr` | Current QR code (base64) |
| GET | `/grupos` | List all WhatsApp groups |
| POST | `/grupos/:groupId/agregar` | Add phones from JSON body |
| POST | `/grupos/:groupId/agregar-excel` | Upload Excel and add contacts |
| POST | `/grupos/:groupId/inspeccionar-excel` | Preview Excel before adding |

## Environment Variables

```env
PORT=3030                           # Server port
DEFAULT_COUNTRY_CODE=51             # Country code for local numbers (51=Peru)
WHATSAPP_SESSION_PATH=./.wwebjs_auth # Session storage path
```

## Important Considerations

- User must be **group admin** to add participants
- `ADD_DELAY_MS = 1500` delay between each participant add to avoid blocks
- `whatsapp-web.js` is pulled from GitHub (`git+https://...`), not npm
- Session data in `.wwebjs_auth/` - delete to force re-scan of QR
- Puppeteer cache in `.cache/puppeteer/` - managed by `.puppeteerrc.cjs`
