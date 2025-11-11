/**
 * Google Apps Script Web App for Ringwheel Backend
 * 
 * Setup:
 * 1. Set the API_TOKEN in Script Properties (Project Settings > Script Properties)
 * 2. Deploy as Web App with access set to "Anyone"
 * 3. Ensure the Google Sheet has sheets: Roster, SpinLog, RingWeights, Settings
 */

const SHEET_NAME_ROSTER = 'Roster';
const SHEET_NAME_SPIN_LOG = 'SpinLog';
const SHEET_NAME_WEIGHTS = 'RingWeights';
const SHEET_NAME_SETTINGS = 'Settings';

/**
 * Handle GET requests
 */
function doGet(e) {
  try {
    const token = e.parameter.token;
    if (!validateToken(token)) {
      return jsonResponse({ success: false, error: 'Invalid token' }, 401);
    }

    const action = e.parameter.action;
    
    switch (action) {
      case 'roster':
        return jsonResponse({ success: true, data: getRoster() });
      case 'rings':
        return jsonResponse({ success: true, data: getRingWeights() });
      case 'settings':
        return jsonResponse({ success: true, data: getSettings() });
      default:
        return jsonResponse({ success: false, error: 'Unknown action' }, 400);
    }
  } catch (error) {
    return jsonResponse({ success: false, error: error.toString() }, 500);
  }
}

/**
 * Handle POST requests
 */
function doPost(e) {
  try {
    const token = e.parameter.token;
    if (!validateToken(token)) {
      return jsonResponse({ success: false, error: 'Invalid token' }, 401);
    }

    const action = e.parameter.action;
    const data = JSON.parse(e.postData.contents);
    
    switch (action) {
      case 'logSpin':
        logSpin(data);
        return jsonResponse({ success: true });
      case 'writeRings':
        writeRingWeights(data);
        return jsonResponse({ success: true });
      case 'writeSettings':
        writeSettings(data);
        return jsonResponse({ success: true });
      case 'email':
        sendEmail(data);
        return jsonResponse({ success: true });
      default:
        return jsonResponse({ success: false, error: 'Unknown action' }, 400);
    }
  } catch (error) {
    return jsonResponse({ success: false, error: error.toString() }, 500);
  }
}

/**
 * Validate API token
 */
function validateToken(token) {
  const validToken = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  return token === validToken;
}

/**
 * Create JSON response
 */
function jsonResponse(data, statusCode = 200) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Get roster entries
 */
function getRoster() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_ROSTER);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const rows = data.slice(1);
  
  return rows.map(row => {
    const entry = {};
    headers.forEach((header, index) => {
      entry[header.toLowerCase()] = row[index];
    });
    return entry;
  });
}

/**
 * Get ring weights
 */
function getRingWeights() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_WEIGHTS);
  const data = sheet.getDataRange().getValues();
  
  const weights = {
    regions: {},
    taxa: {},
    iucn: {}
  };
  
  for (let i = 1; i < data.length; i++) {
    const [category, option, weight] = data[i];
    const key = category.toLowerCase();
    weights[key][option] = weight;
  }
  
  return weights;
}

/**
 * Get settings
 */
function getSettings() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_SETTINGS);
  const data = sheet.getDataRange().getValues();
  
  const settings = {};
  for (let i = 1; i < data.length; i++) {
    const [key, value] = data[i];
    settings[key] = value;
  }
  
  return settings;
}

/**
 * Log a spin result
 */
function logSpin(spinData) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_SPIN_LOG);
  sheet.appendRow([
    new Date(spinData.timestamp),
    spinData.region,
    spinData.taxon,
    spinData.iucn,
    spinData.wasVetoed || false,
    spinData.plantaeMercyApplied || false,
    spinData.manualRegion || ''
  ]);
}

/**
 * Write ring weights
 */
function writeRingWeights(weights) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_WEIGHTS);
  sheet.clear();
  sheet.appendRow(['Category', 'Option', 'Weight']);
  
  Object.entries(weights.regions).forEach(([region, weight]) => {
    sheet.appendRow(['regions', region, weight]);
  });
  
  Object.entries(weights.taxa).forEach(([taxon, weight]) => {
    sheet.appendRow(['taxa', taxon, weight]);
  });
  
  Object.entries(weights.iucn).forEach(([status, weight]) => {
    sheet.appendRow(['iucn', status, weight]);
  });
}

/**
 * Write settings
 */
function writeSettings(settings) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME_SETTINGS);
  sheet.clear();
  sheet.appendRow(['Key', 'Value']);
  
  Object.entries(settings).forEach(([key, value]) => {
    sheet.appendRow([key, value]);
  });
}

/**
 * Send email notification
 */
function sendEmail(emailData) {
  MailApp.sendEmail({
    to: emailData.recipient,
    subject: emailData.subject,
    body: emailData.body
  });
}
