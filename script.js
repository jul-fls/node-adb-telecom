#!/usr/bin/env node
import balanced from 'balanced-match';
import adb from 'adbkit';
const client = adb.createClient();

let deviceId = null;

/**
 * Initialize (or re-init) the ADB device connection.
 */
async function initDevice() {
  const devices = await client.listDevices();
  if (devices.length === 0) {
    throw new Error('No ADB devices found');
  }
  deviceId = devices[0].id;
}

/**
 * Returns the full dumpsys telecom output as a string,
 * reusing the same adb connection. If it fails, we'll
 * re-init the device and retry once.
 */
async function getTelephoneDump() {
  if (!deviceId) {
    await initDevice();
  }
  try {
    const output = await client
      .shell(deviceId, 'dumpsys telecom')
      .then(adb.util.readAll);
    return output.toString('utf8').trim();
  } catch (err) {
    // Connection may have dropped—try one re-init & retry
    deviceId = null;
    await initDevice();
    const output = await client
      .shell(deviceId, 'dumpsys telecom')
      .then(adb.util.readAll);
    return output.toString('utf8').trim();
  }
}

/**
 * Parse a dumpsys-style indented block into a nested JS object.
 */
function parseDump(input) {
  const lines = input.split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, container: root }];

  for (let raw of lines) {
    if (!raw.trim()) continue;
    const indent = raw.search(/\S/);
    const text   = raw.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].container;

    const m = text.match(/^([^:]+):\s*(.*)$/);
    if (m) {
      const [_, key, value] = m;
      if (value !== '') {
        addField(parent, key, parsePrimitive(value));
      } else {
        // peek next non-blank line to see if nested
        let j = lines.indexOf(raw) + 1, nextRaw;
        while (j < lines.length && !(nextRaw = lines[j].trim())) j++;
        const nextIndent = j < lines.length ? lines[j].search(/\S/) : -1;
        if (nextIndent > indent) {
          const obj = {};
          addField(parent, key, obj);
          stack.push({ indent, container: obj });
        } else {
          addField(parent, key, null);
        }
      }
    } else {
      addField(parent, '_items', text);
    }
  }
  return root;
}

function addField(obj, key, val) {
  if (!(key in obj))             obj[key] = val;
  else if (Array.isArray(obj[key])) obj[key].push(val);
  else                            obj[key] = [obj[key], val];
}

function parsePrimitive(str) {
  if (/^(?:true|false)$/i.test(str)) return str.toLowerCase() === 'true';
  if (!isNaN(str) && str.trim() !== '') return Number(str);
  return str;
}

/**
 * Returns the current call ID (e.g. "TC@56") or null if idle.
 */
function getAllCalls(dump) {
  const state = parseDump(dump);
  const allCalls = state.CallsManager
                     && state.CallsManager.mCallAudioManager
                     && state.CallsManager.mCallAudioManager['All calls'];
  if (!allCalls) return null;
  const items = Array.isArray(allCalls._items)
    ? allCalls._items
    : [allCalls._items];
  return items[0] || null;
}

/**
 * Extract analytics for a given callId.
 */
function extractAnalytics(dump, callId) {
  const startToken = `Call ${callId}:`;
  const idx        = dump.indexOf(startToken);
  if (idx === -1) return {};
  const tail  = dump.slice(idx + startToken.length - 1);
  const match = balanced('{', '}', tail);
  if (!match) return {};
  const block  = startToken + match.body + '}';
  const parsed = parseDump(block);
  return parsed[`Call ${callId}`] || {};
}

/**
 * Find the CALL_HANDLE (tel:+...) for a given callId.
 */
function getCallerNumber(dump, callId) {
  const startToken  = `Call${callId}`;
  const handleToken = 'CALL_HANDLE (tel:';
  const startIdx    = dump.indexOf(startToken);
  if (startIdx === -1) return '';
  const handleIdx = dump.indexOf(handleToken, startIdx);
  if (handleIdx === -1) return '';
  const numStart = handleIdx + handleToken.length;
  const commaIdx = dump.indexOf(',', numStart);
  return commaIdx === -1
    ? dump.slice(numStart).trim()
    : dump.slice(numStart, commaIdx).trim();
}

/**
 * Extract the telecom-reported state string for a given callId by
 * scanning for "Call id=<callId>, state=<STATE>,".
 */
function getCallState(dump, callId) {
  const stateToken = `Call id=${callId}, state=`;
  const idx        = dump.indexOf(stateToken);
  if (idx === -1) return '';
  const start = idx + stateToken.length;
  const end   = dump.indexOf(',', start);
  return end === -1
    ? dump.slice(start).trim()
    : dump.slice(start, end).trim();
}

// ————— Poller & Console Table —————
let prevPhoneState  = 'IDLE';
let inCallStartTime = null;

setInterval(async () => {
  let dump;
  try {
    dump = await getTelephoneDump();
  } catch (err) {
    console.error('adb failed:', err.message);
    return;
  }

  const currCall = getAllCalls(dump);
  const analytics = currCall ? extractAnalytics(dump, currCall) : {};
  const direction = analytics.direction || '';
  const rawState  = currCall ? getCallState(dump, currCall) : '';

  // Map to a simpler phoneState
  let phoneState;
  if (!currCall)                                   phoneState = 'IDLE';
  else if (rawState === 'RINGING')                 phoneState = 'RINGING';
  else if (rawState === 'DIALING')                 phoneState = 'DIALING';
  else if (direction === 'OUTGOING' && !rawState)  phoneState = 'DIALING';
  else                                             phoneState = 'IN_CALL';

  // Start timer when we first enter "IN_CALL"
  if (phoneState === 'IN_CALL' && prevPhoneState !== 'IN_CALL') {
    inCallStartTime = Date.now();
  }
  // Reset when call goes idle
  if (phoneState === 'IDLE') {
    inCallStartTime = null;
  }

  // Calculate elapsed duration since in-call began
  let duration = '00:00:00';
  if (inCallStartTime) {
    let diff = Date.now() - inCallStartTime;
    const h = String(Math.floor(diff / 3_600_000)).padStart(2, '0');
    diff %= 3_600_000;
    const m = String(Math.floor(diff /    60_000)).padStart(2, '0');
    diff %=    60_000;
    const s = String(Math.floor(diff /     1_000)).padStart(2, '0');
    duration = `${h}:${m}:${s}`;
  }

  console.clear();
  console.table([{
    phoneState,
    direction,
    callerID: currCall ? getCallerNumber(dump, currCall) : '',
    duration
  }]);

  prevPhoneState = phoneState;
}, 400);
