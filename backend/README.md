# Google Apps Script Backend

This directory contains the Google Apps Script code for the Ringwheel backend.

## Setup

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

## API Endpoints

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

## Sheet Structure

The Google Sheet should have the following sheets:

1. **Roster** - Student roster
   - Columns: ID, Name, Region, Taxon, IUCN, Timestamp

2. **SpinLog** - Log of all spins
   - Columns: Timestamp, Region, Taxon, IUCN, Vetoed, PlantaeMercy, ManualRegion

3. **RingWeights** - Weights for each ring option
   - Columns: Category, Option, Weight

4. **Settings** - App settings
   - Columns: Key, Value

## Security

- Always validate the API token on every request
- Use the token stored in Script Properties
- Never expose the token in client-side code
