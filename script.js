#!/usr/bin/env node
import { execSync } from 'child_process';
import balanced from 'balanced-match';

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
      const key   = m[1], value = m[2];
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

/**
 * Add a field to an object, creating an array if necessary.
 *  If the field already exists, append to it or convert to an array.
 * */
function addField(obj, key, val) {
  if (!(key in obj))             obj[key] = val;
  else if (Array.isArray(obj[key])) obj[key].push(val);
  else                            obj[key] = [obj[key], val];
}

/**
 * Parse a string into a primitive value (number, boolean, or string).
 *  This is a simplified version of JSON.parse().
 */
function parsePrimitive(str) {
  if (/^(?:true|false)$/i.test(str)) return str.toLowerCase() === 'true';
  if (!isNaN(str) && str.trim() !== '') return Number(str);
  return str;
}

/**
 * Returns the current call ID (e.g. "TC@56") or null if idle.
 */
function getTelephoneDump() {
    const dump = execSync('adb shell dumpsys telecom', { encoding: 'utf8' });
    return dump;
}

/**
 * Process the dumpsys telecom output and return all calls.
 * This is a simplified version of the original function.
 * It assumes the input is a string and parses it into an object.
 * */
function getAllCalls(dump) {
  const state = parseDump(dump);
  const allCalls = state.CallsManager
                     && state.CallsManager.mCallAudioManager
                     && state.CallsManager.mCallAudioManager['All calls'];
  if (!allCalls) return null;
  const items = Array.isArray(allCalls._items)
    ? allCalls._items
    : [allCalls._items];
  return items.length ? items[0] : null;
}

/**
 * Extract the full analytics block for a given callId and parse it.
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
  const startToken   = `Call${callId}`;          // e.g. "CallTC@8"
  const handleToken  = 'CALL_HANDLE (tel:';      // prefix before the number
  const startIdx     = dump.indexOf(startToken);
  if (startIdx === -1) return '';
  const handleIdx = dump.indexOf(handleToken, startIdx);
  if (handleIdx === -1) return '';
  const numStart = handleIdx + handleToken.length;
  const commaIdx = dump.indexOf(',', numStart);
  if (commaIdx === -1) return dump.slice(numStart).trim();
  return dump.slice(numStart, commaIdx).trim();
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
  if (end === -1) return dump.slice(start).trim();
  return dump.slice(start, end).trim();
}

// ——————— Poller & Console Table ———————
let prevCallId      = null;
let prevPhoneState  = 'IDLE';
let inCallStartTime = null;

setInterval(() => {
  const dump = getTelephoneDump();
  let currCall = null;
  try {
    currCall = getAllCalls(dump);
  } catch (e) {
    console.error('adb failed:', e.message);
    return;
  }

  // Gather analytics & telecom-reported state
  const analytics = currCall ? extractAnalytics(dump, currCall) : {};
  const direction = analytics.direction || '';
  const rawState  = currCall ? getCallState(dump, currCall) : '';

  // Map to a simpler phoneState
  let phoneState;
  if (!currCall)                            phoneState = 'IDLE';
  else if (rawState === 'RINGING')          phoneState = 'RINGING';
  else if (rawState === 'DIALING')          phoneState = 'DIALING';
  else if (direction === 'OUTGOING' && !rawState) phoneState = 'DIALING';
  else                                      phoneState = 'IN_CALL';

  // Start timer when we first enter "in call"
  if (phoneState === 'IN_CALL' && prevPhoneState !== 'IN_CALL') {
    inCallStartTime = Date.now();
  }
  // Reset when call ends
  if (phoneState === 'IDLE' && prevPhoneState === 'IN_CALL') {
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

  // Refresh the console table
  console.clear();
  console.table([{
    phoneState,
    direction,
    callerID: currCall ? getCallerNumber(dump, currCall) : '',
    duration
  }]);

  prevCallId     = currCall;
  prevPhoneState = phoneState;
}, 100);
