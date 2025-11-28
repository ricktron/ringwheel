# Legacy Backend Code (DEPRECATED)

> ⚠️ **IMPORTANT**: This folder contains **legacy/experimental** backend code that is **NOT** used by the current Ringwheel deployment.

## Canonical Backend

**The canonical backend is located in `gas/`** (at the repository root).

- The `gas/Code.gs` file contains the current Apps Script Web App implementation.
- It uses the correct API contract with `type` parameter (not `action`).
- It uses the correct sheet names: `Roster`, `Rings`, `Settings`, `SpinsLog`.

## Why This Folder Exists

This folder contains an earlier/experimental version of the backend that:
- Uses `action` query parameter instead of `type`
- Uses different sheet names (`SpinLog`, `RingWeights`)
- Uses a different API response structure

It is kept for historical reference but should **not** be deployed or used.

## If You Need to Update the Backend

1. Make changes in `gas/Code.gs`
2. Follow the deployment instructions in `gas/` or the main project README
3. Do NOT modify files in this `backend/` folder

---

<details>
<summary>Original README (for reference only)</summary>

## Setup (Legacy)

1. Create a new Google Sheet
2. Go to Extensions > Apps Script
3. Copy the code from `Code.gs` into the script editor
4. Deploy as Web App:
   - Click "Deploy" > "New deployment"
   - Select type: "Web app"
   - Execute as: "Me"
   - Who has access: "Anyone"
   - Click "Deploy"
5. Copy the deployment URL
6. Generate a secret API token
7. Add both to your `.env` file:
   ```
   VITE_WEB_APP_URL=https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec
   VITE_API_TOKEN=your_secret_token_here
   ```

## API Endpoints (Legacy)

The Web App accepts the following actions via GET/POST with `action` and `token` query parameters:

### GET Endpoints
- `roster` - Get roster entries
- `rings` - Get ring weights
- `settings` - Get app settings

### POST Endpoints
- `logSpin` - Log a spin result
- `writeRings` - Update ring weights
- `writeSettings` - Update app settings
- `email` - Send email notification

## Sheet Structure (Legacy)

The Google Sheet should have the following sheets:

1. **Roster** - Student roster
   - Columns: ID, Name, Region, Taxon, IUCN, Timestamp

2. **SpinLog** - Log of all spins
   - Columns: Timestamp, Region, Taxon, IUCN, Vetoed, PlantaeMercy, ManualRegion

3. **RingWeights** - Weights for each ring option
   - Columns: Category, Option, Weight

4. **Settings** - App settings
   - Columns: Key, Value

</details>
