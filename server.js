import express from 'express';
import bodyParser from 'body-parser';
import balanced from 'balanced-match';
import adb from 'adbkit';
import dotenv from 'dotenv';
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
const port = process.env.PORT || 3000;
dotenv.config();

const client = adb.createClient();
let deviceId = null;

/**
 * Initialize (or re-init) the ADB device connection.
 */
async function initDevice() {
  try {
    // 1) ask the local ADB server to connect to your network device
    await client.connect(`${process.env.ADB_DEVICE_IP}:${process.env.ADB_DEVICE_PORT}`);
    console.log("Connected to device!");

    // 2) list all known devices (including the one we just tcp/ip‑connected)
    const devices = await client.listDevices();
    if (devices.length === 0) {
      throw new Error("No ADB devices found");
    }

    // 3) grab the first device's id as a raw string
    deviceId = devices[0].id;
    console.log("Found device:", deviceId);
  } catch (err) {
    console.error("initDevice failed:", err.message);
    // re‑throw so that callers can retry or bail
    throw err;
  }
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
 * Make a phone call to the given number.
 * Returns the output of the adb shell command.
 * If the device is not connected, it will attempt to re-init the connection.
 */
async function callPhoneNumber(phoneNumber) {
  if (!deviceId) {
    await initDevice();
  }
  const command = `am start -a android.intent.action.CALL -d tel:${phoneNumber}`;
  try {
    const output = await client
      .shell(deviceId, command);
  } catch (err) {
    // Connection may have dropped—try one re-init & retry
    deviceId = null;
    await initDevice();
    const output = await client
      .shell(deviceId, command);
  }
}

/**
 * Hang up the current call.
 * Returns the output of the adb shell command.
 * If the device is not connected, it will attempt to re-init the connection.
 * */
async function endCall() {
  if (!deviceId) {
    await initDevice();
  }
  const command = 'input keyevent KEYCODE_ENDCALL';
  try {
    const output = await client
      .shell(deviceId, command);
  } catch (err) {
    // Connection may have dropped—try one re-init & retry
    deviceId = null;
    await initDevice();
    const output = await client
      .shell(deviceId, command);
  }
}

/**
 * Accept the current incoming call.
 * Returns the output of the adb shell command.
 * If the device is not connected, it will attempt to re-init the connection.
 * */
async function acceptCall() {
  if (!deviceId) {
    await initDevice();
  }
  const command = 'input keyevent KEYCODE_CALL';
  try {
    const output = await client
      .shell(deviceId, command);
  } catch (err) {
    // Connection may have dropped—try one re-init & retry
    deviceId = null;
    await initDevice();
    const output = await client
      .shell(deviceId, command);
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

app.post('/api/startcall', (req, res) => {
    const phoneNumber = req.body.phoneNumber;
    if (!phoneNumber) {
      return res.status(400).json({ error: 'Phone number is required.' });
    }
    if (callStatus && callStatus.phoneState !== 'IDLE') {
        return res.status(400).json({ error: 'A call is already in progress.' });
    }
    callPhoneNumber(phoneNumber);
    res.json({ message: `Call started to phone number ${phoneNumber}.` });
});

app.post('/api/stopcall', (req, res) => {
    const phoneNumber = callStatus.callerID;
    if (!phoneNumber || callStatus.phoneState === 'IDLE') {
        return res.status(400).json({ error: 'No call in progress.' });
    }
    const duration = callStatus.duration;
    endCall();
    res.json({ message: `Call with phone number ${phoneNumber} ended after ${duration}.` });
});

app.post('/api/rejectcall', (req, res) => {
    const phoneNumber = callStatus.callerID;
    if (!phoneNumber || callStatus.phoneState !== 'RINGING') {
        return res.status(400).json({ error: 'No incoming call to reject.' });
    }
    endCall();
    res.json({ message: `Call rejected from phone number ${phoneNumber}.` });
});

app.post('/api/acceptcall', (req, res) => {
    if(!callStatus || callStatus.phoneState !== 'RINGING') {
        return res.status(400).json({ error: 'No incoming call to accept.' });
    }
    acceptCall();
    const phoneNumber = callStatus.callerID;
    res.json({ message: `Call answered from phone number ${phoneNumber}.` });
});
  
app.get('/api/getcallstatus', (req, res) => {
    res.json({ status: callStatus });
});
  
app.listen(port, () => {
    console.log(`Call server is running on http://localhost:${port}`);
});

let callStatus = null;
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
  
    callStatus = {
        phoneState,
        direction,
        callerID: currCall ? getCallerNumber(dump, currCall) : '',
        duration
    };
  
    prevPhoneState = phoneState;
  }, process.env.POLL_INTERVAL || 1000);