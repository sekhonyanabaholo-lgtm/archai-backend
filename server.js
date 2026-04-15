const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { jsonrepair } = require('jsonrepair');

const app = express();
app.use(cors());
app.use(express.json());

const GROQ_KEY = process.env.GROQ_KEY;
if (!GROQ_KEY) {
  throw new Error('Missing GROQ_KEY environment variable');
}

/* =========================
   BASIC ROUTES
========================= */

app.get('/', (_req, res) => {
  res.send('ArchAI backend is live');
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

/* =========================
   LLM
========================= */

async function callGroq(messages, temperature = 0.1, maxTokens = 420) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      temperature,
      max_tokens: maxTokens
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || 'Groq request failed');
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('No content returned from Groq');
  }

  return content.trim();
}

function extractJsonBlock(text) {
  const cleaned = String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in model response');
  }

  return cleaned.slice(start, end + 1);
}

async function parseJsonWithRepair(rawText) {
  const block = extractJsonBlock(rawText);

  try {
    return JSON.parse(block);
  } catch (_err) {
    try {
      return JSON.parse(jsonrepair(block));
    } catch (_err2) {
      throw new Error('Could not parse model JSON');
    }
  }
}

/* =========================
   PROGRAM
========================= */

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normaliseSizeBand(size) {
  const s = String(size || '').toLowerCase();
  if (s.includes('small')) return 'small';
  if (s.includes('large')) return 'large';
  return 'medium';
}

function ensureProgram(program, fallbackSize = 'medium') {
  program = program || {};

  program.storeyPreference = ['single', 'double', 'either'].includes(program.storeyPreference)
    ? program.storeyPreference
    : 'either';

  program.beds = clamp(Number(program.beds || 3), 1, 8);
  program.baths = clamp(Number(program.baths || 2), 1, 6);

  program.livingSpaces = Array.isArray(program.livingSpaces) && program.livingSpaces.length
    ? program.livingSpaces
    : ['living', 'dining', 'kitchen'];

  program.extras = Array.isArray(program.extras) ? program.extras : ['patio', 'garden'];

  program.masterEnsuite = !!program.masterEnsuite;

  program.notes = typeof program.notes === 'object' && program.notes ? program.notes : {};
  program.notes.openPlan = !!program.notes.openPlan;
  program.notes.entertainmentFocus = !!program.notes.entertainmentFocus;
  program.notes.premiumMainSuite = !!program.notes.premiumMainSuite;

  program.zoning = typeof program.zoning === 'object' && program.zoning ? program.zoning : {};
  program.zoning.publicFront = program.zoning.publicFront !== false;
  program.zoning.privateRear = program.zoning.privateRear !== false;

  program.circulation = typeof program.circulation === 'object' && program.circulation ? program.circulation : {};
  program.circulation.type = ['spine', 'gallery', 'landing_hall'].includes(program.circulation.type)
    ? program.circulation.type
    : 'spine';

  program.archetypePreference = ['single_core', 'single_wing', 'double_split', 'auto'].includes(program.archetypePreference)
    ? program.archetypePreference
    : 'auto';

  program.sizeBand = ['small', 'medium', 'large'].includes(program.sizeBand)
    ? program.sizeBand
    : fallbackSize;

  return program;
}

async function generateProgram(fullContext, style, size) {
  const prompt = `You are an expert residential architect.

Turn the client brief into a structured architectural program.
Do NOT generate coordinates.
Do NOT generate a floor plan.
Return JSON only.

CLIENT BRIEF:
${fullContext}

Style preference: ${style}
Size preference: ${size}

Return exactly:
{
  "storeyPreference": "single" or "double" or "either",
  "beds": 4,
  "baths": 3,
  "livingSpaces": ["living", "dining", "kitchen"],
  "extras": ["garage", "study", "scullery", "laundry", "patio", "garden"],
  "masterEnsuite": true,
  "notes": {
    "openPlan": true,
    "entertainmentFocus": false,
    "premiumMainSuite": false
  },
  "zoning": {
    "publicFront": true,
    "privateRear": true
  },
  "circulation": {
    "type": "spine" or "gallery" or "landing_hall"
  },
  "archetypePreference": "single_core" or "single_wing" or "double_split" or "auto",
  "sizeBand": "small" or "medium" or "large"
}`;

  const text = await callGroq([{ role: 'user', content: prompt }], 0.1, 320);
  return ensureProgram(await parseJsonWithRepair(text), normaliseSizeBand(size));
}

async function reviseProgram(existingProgram, request, description) {
  const prompt = `You are revising an architectural program.

ORIGINAL CLIENT DESCRIPTION:
${description || ''}

CURRENT PROGRAM:
${JSON.stringify(existingProgram, null, 2)}

REVISION REQUEST:
${request}

Return updated JSON in the exact same structure only.`;

  const text = await callGroq([{ role: 'user', content: prompt }], 0.1, 320);
  return ensureProgram(await parseJsonWithRepair(text), existingProgram.sizeBand || 'medium');
}

/* =========================
   GEOMETRY
========================= */

function room(name, t, x, y, w, h) {
  return { name, t, x, y, w, h };
}

function area(w, h) {
  return w * h;
}

function rectsOverlap(a, b) {
  return !(
    a.x + a.w <= b.x ||
    b.x + b.w <= a.x ||
    a.y + a.h <= b.y ||
    b.y + b.h <= a.y
  );
}

function rangesOverlap(a1, a2, b1, b2) {
  return a1 < b2 && a2 > b1;
}

function shareEdge(a, b) {
  if (a.x + a.w === b.x && rangesOverlap(a.y, a.y + a.h, b.y, b.y + b.h)) return true;
  if (b.x + b.w === a.x && rangesOverlap(a.y, a.y + a.h, b.y, b.y + b.h)) return true;
  if (a.y + a.h === b.y && rangesOverlap(a.x, a.x + a.w, b.x, b.x + b.w)) return true;
  if (b.y + b.h === a.y && rangesOverlap(a.x, a.x + a.w, b.x, b.x + b.w)) return true;
  return false;
}

function getBounds(rooms) {
  if (!rooms.length) return { right: 0, bottom: 0, width: 0, height: 0 };
  const maxX = Math.max(...rooms.map(r => r.x + r.w));
  const maxY = Math.max(...rooms.map(r => r.y + r.h));
  return { right: maxX, bottom: maxY, width: maxX, height: maxY };
}

function countBedrooms(rooms) {
  return rooms.filter(r => r.t === 'room').length;
}

function countBathrooms(rooms) {
  return rooms.filter(r => r.t === 'bathroom' || r.t === 'ensuite').length;
}

function estimateHomeSize(program, floors) {
  const total =
    program.beds * 14 +
    program.baths * 5 +
    35 +
    (program.livingSpaces.includes('dining') ? 12 : 0) +
    (program.extras.includes('garage') ? 36 : 0) +
    (program.extras.includes('study') ? 10 : 0) +
    (program.extras.includes('scullery') ? 6 : 0) +
    (program.extras.includes('laundry') ? 6 : 0) +
    (program.extras.includes('patio') ? 18 : 0);

  return `~${Math.round(floors === 2 ? total * 0.95 : total)}m²`;
}

/* =========================
   VALIDATION
========================= */

function getAllRooms(plan) {
  return plan.storey === 'double'
    ? [...(plan.ground || []), ...(plan.first || [])]
    : (plan.rooms || []);
}

function validateNoOverlap(rooms) {
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i];
      const b = rooms[j];
      if (a.t === 'garden' || a.t === 'patio' || b.t === 'garden' || b.t === 'patio') continue;
      if (rectsOverlap(a, b)) {
        throw new Error(`Overlap detected between "${a.name}" and "${b.name}"`);
      }
    }
  }
}

function buildAdjacencyGraph(rooms) {
  const graph = new Map();
  rooms.forEach(r => graph.set(r.name, new Set()));

  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      if (shareEdge(rooms[i], rooms[j])) {
        graph.get(rooms[i].name).add(rooms[j].name);
        graph.get(rooms[j].name).add(rooms[i].name);
      }
    }
  }

  return graph;
}

function ensureIndependentBedroomAccess(rooms, startTypes) {
  const graph = buildAdjacencyGraph(rooms);
  const byName = new Map(rooms.map(r => [r.name, r]));
  const starts = rooms.filter(r => startTypes.includes(r.t)).map(r => r.name);
  const bedrooms = rooms.filter(r => r.t === 'room');

  for (const bedroom of bedrooms) {
    const queue = [...starts];
    const visited = new Set(queue);
    let found = false;

    while (queue.length) {
      const current = queue.shift();
      if (current === bedroom.name) {
        found = true;
        break;
      }

      for (const next of graph.get(current) || []) {
        if (visited.has(next)) continue;
        const roomObj = byName.get(next);
        if (!roomObj) continue;
        if (roomObj.t === 'room' && next !== bedroom.name) continue;

        visited.add(next);
        queue.push(next);
      }
    }

    if (!found) {
      throw new Error(`${bedroom.name} does not have independent access`);
    }
  }
}

function validatePlan(plan) {
  const rooms = getAllRooms(plan);
  if (!rooms.length) throw new Error('No rooms generated');

  for (const r of rooms) {
    if (![r.x, r.y, r.w, r.h].every(v => typeof v === 'number')) {
      throw new Error(`Invalid geometry on ${r.name}`);
    }
    if (r.w <= 0 || r.h <= 0) {
      throw new Error(`Invalid room size for ${r.name}`);
    }
    if (r.t === 'room') {
      if (/master/i.test(r.name) && area(r.w, r.h) < 16) throw new Error(`Master bedroom too small: ${r.name}`);
      if (!/master/i.test(r.name) && area(r.w, r.h) < 9) throw new Error(`Bedroom too small: ${r.name}`);
    }
    if ((r.t === 'bathroom' || r.t === 'ensuite') && area(r.w, r.h) < 4) {
      throw new Error(`Bathroom too small: ${r.name}`);
    }
    if (r.t === 'kitchen' && area(r.w, r.h) < 6) {
      throw new Error(`Kitchen too small: ${r.name}`);
    }
  }

  if (plan.storey === 'double') {
    validateNoOverlap(plan.ground || []);
    validateNoOverlap(plan.first || []);
    ensureIndependentBedroomAccess(plan.first || [], ['passage', 'stairs']);
  } else {
    validateNoOverlap(plan.rooms || []);
    ensureIndependentBedroomAccess(plan.rooms || [], ['living', 'dining', 'kitchen', 'passage']);
  }
}

/* =========================
   ARCHETYPE CHOICE
========================= */

function chooseStorey(program) {
  if (program.storeyPreference === 'single') return 'single';
  if (program.storeyPreference === 'double') return 'double';
  if (program.beds >= 6) return 'double';
  return 'single';
}

function chooseArchetype(program) {
  const storey = chooseStorey(program);

  if (storey === 'double') return 'double_split';
  if (program.archetypePreference === 'single_wing') return 'single_wing';
  if (program.beds >= 5) return 'single_wing';
  return 'single_core';
}

/* =========================
   OPENINGS
========================= */

function sharedSideBetweenRooms(a, b) {
  if (a.x + a.w === b.x && rangesOverlap(a.y, a.y + a.h, b.y, b.y + b.h)) {
    const start = Math.max(a.y, b.y);
    const end = Math.min(a.y + a.h, b.y + b.h);
    return { sideA: 'right', x: a.x + a.w, y: start + Math.max(0.5, (end - start) / 2 - 0.5), width: 1 };
  }
  if (b.x + b.w === a.x && rangesOverlap(a.y, a.y + a.h, b.y, b.y + b.h)) {
    const start = Math.max(a.y, b.y);
    const end = Math.min(a.y + a.h, b.y + b.h);
    return { sideA: 'left', x: a.x, y: start + Math.max(0.5, (end - start) / 2 - 0.5), width: 1 };
  }
  if (a.y + a.h === b.y && rangesOverlap(a.x, a.x + a.w, b.x, b.x + b.w)) {
    const start = Math.max(a.x, b.x);
    const end = Math.min(a.x + a.w, b.x + b.w);
    return { sideA: 'bottom', x: start + Math.max(0.5, (end - start) / 2 - 0.5), y: a.y + a.h, width: 1 };
  }
  if (b.y + b.h === a.y && rangesOverlap(a.x, a.x + a.w, b.x, b.x + b.w)) {
    const start = Math.max(a.x, b.x);
    const end = Math.min(a.x + a.w, b.x + b.w);
    return { sideA: 'top', x: start + Math.max(0.5, (end - start) / 2 - 0.5), y: a.y, width: 1 };
  }
  return null;
}

function isInterior(t) {
  return !['garden', 'patio'].includes(t);
}

function hasAdjacentRoom(rooms, roomObj, side) {
  return rooms.some(other => {
    if (other === roomObj) return false;
    if (!isInterior(other.t)) return false;

    if (side === 'top') {
      return other.y + other.h === roomObj.y &&
        rangesOverlap(roomObj.x, roomObj.x + roomObj.w, other.x, other.x + other.w);
    }
    if (side === 'bottom') {
      return other.y === roomObj.y + roomObj.h &&
        rangesOverlap(roomObj.x, roomObj.x + roomObj.w, other.x, other.x + other.w);
    }
    if (side === 'left') {
      return other.x + other.w === roomObj.x &&
        rangesOverlap(roomObj.y, roomObj.y + roomObj.h, other.y, other.y + other.h);
    }
    if (side === 'right') {
      return other.x === roomObj.x + roomObj.w &&
        rangesOverlap(roomObj.y, roomObj.y + roomObj.h, other.y, other.y + other.h);
    }
    return false;
  });
}

function dedupeDoors(doors) {
  const seen = new Set();
  return doors.filter(d => {
    const key = `${d.from}|${d.to}|${d.x}|${d.y}|${d.side}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeWindows(windows) {
  const seen = new Set();
  return windows.filter(w => {
    const key = `${w.room}|${w.side}|${w.x}|${w.y}|${w.width}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function generateInteriorDoorsForFloor(rooms) {
  const doors = [];
  const accessTypes = new Set(['passage', 'living', 'dining', 'kitchen', 'stairs']);

  rooms.forEach(a => {
    if (!accessTypes.has(a.t)) return;

    rooms.forEach(b => {
      if (a === b) return;
      if (!['room', 'bathroom', 'ensuite', 'study', 'garage', 'kitchen', 'living', 'dining', 'scullery', 'laundry', 'stairs'].includes(b.t)) return;

      const shared = sharedSideBetweenRooms(a, b);
      if (!shared) return;

      doors.push({
        from: a.name,
        to: b.name,
        x: shared.x,
        y: shared.y,
        width: 1,
        side: shared.sideA
      });
    });
  });

  return dedupeDoors(doors);
}

function generateExteriorDoorsForFloor(rooms) {
  const doors = [];
  const priorities = ['living', 'dining', 'kitchen', 'garage'];

  priorities.forEach(type => {
    const r = rooms.find(x => x.t === type);
    if (!r) return;

    if (!hasAdjacentRoom(rooms, r, 'bottom')) {
      doors.push({
        from: r.name,
        to: 'exterior',
        x: r.x + Math.max(1, Math.floor(r.w / 2) - 0.5),
        y: r.y + r.h,
        width: 1,
        side: 'bottom'
      });
    }
  });

  return dedupeDoors(doors);
}

function generateWindowsForFloor(rooms) {
  const windows = [];

  rooms.forEach(r => {
    if (!isInterior(r.t) || r.t === 'passage') return;

    ['top', 'bottom', 'left', 'right'].forEach(side => {
      if (hasAdjacentRoom(rooms, r, side)) return;

      if (side === 'top' || side === 'bottom') {
        if (r.w < 2) return;
        const width = Math.min(2, r.w - 1);
        windows.push({
          room: r.name,
          side,
          x: r.x + Math.max(0.5, (r.w - width) / 2),
          y: side === 'top' ? r.y : r.y + r.h,
          width
        });
      } else {
        if (r.h < 2) return;
        const width = Math.min(2, r.h - 1);
        windows.push({
          room: r.name,
          side,
          x: side === 'left' ? r.x : r.x + r.w,
          y: r.y + Math.max(0.5, (r.h - width) / 2),
          width
        });
      }
    });
  });

  return dedupeWindows(windows);
}

function attachDoorsAndWindows(plan) {
  if (plan.storey === 'single') {
    return {
      ...plan,
      doors: [
        ...generateInteriorDoorsForFloor(plan.rooms),
        ...generateExteriorDoorsForFloor(plan.rooms)
      ],
      windows: generateWindowsForFloor(plan.rooms)
    };
  }

  return {
    ...plan,
    doors: [
      ...generateInteriorDoorsForFloor(plan.ground),
      ...generateExteriorDoorsForFloor(plan.ground),
      ...generateInteriorDoorsForFloor(plan.first)
    ],
    windows: [
      ...generateWindowsForFloor(plan.ground),
      ...generateWindowsForFloor(plan.first)
    ]
  };
}

/* =========================
   ARCHETYPES
========================= */

function buildSingleCorePlan(program) {
  const rooms = [];

  const livingW = program.notes.openPlan ? 7 : 6;
  const kitchenW = 5;
  const diningW = program.livingSpaces.includes('dining') ? 4 : 0;
  const publicWidth = livingW + kitchenW + diningW;

  rooms.push(room('Living room', 'living', 0, 0, livingW, 5));
  rooms.push(room('Kitchen', 'kitchen', livingW, 0, kitchenW, 4));

  if (diningW > 0) {
    rooms.push(room('Dining', 'dining', livingW + kitchenW, 0, diningW, 4));
  }

  let serviceX = livingW;
  if (program.extras.includes('scullery')) {
    rooms.push(room('Scullery', 'scullery', serviceX, 4, 3, 2));
    serviceX += 3;
  }
  if (program.extras.includes('laundry')) {
    rooms.push(room('Laundry', 'laundry', serviceX, 4, 3, 2));
  }

  const hallW = Math.max(publicWidth, 16);
  rooms.push(room('Hall', 'passage', 0, 6, hallW, 2));

  let x = 0;
  let y = 8;

  const masterW = program.notes.premiumMainSuite ? 5 : 4;
  rooms.push(room('Master bed', 'room', x, y, masterW, 4));
  x += masterW;

  if (program.masterEnsuite) {
    rooms.push(room('En-suite', 'ensuite', x, y, 3, 2));
    x += 3;
  }

  for (let i = 2; i <= program.beds; i++) {
    rooms.push(room(`Bedroom ${i}`, 'room', x, y, 4, 3));
    x += 4;
    if (x + 4 > hallW) {
      x = 0;
      y += 4;
    }
  }

  rooms.push(room('Main bath', 'bathroom', 0, y + 4, 3, 2));

  let supportX = 4;
  const supportY = y + 4;

  if (program.extras.includes('study')) {
    rooms.push(room('Study', 'study', supportX, supportY, 4, 3));
    supportX += 4;
  }

  if (program.extras.includes('garage')) {
    rooms.push(room('Garage', 'garage', supportX, supportY, 6, 6));
  }

  const bottom = getBounds(rooms).bottom;

  if (program.extras.includes('patio')) {
    rooms.push(room('Patio', 'patio', 0, bottom + 1, hallW, 3));
  }

  if (program.extras.includes('garden')) {
    rooms.push(room('Garden', 'garden', 0, bottom + (program.extras.includes('patio') ? 4 : 1), hallW, 5));
  }

  return {
    storey: 'single',
    desc: 'A single-storey home organised around a central shared living core.',
    rooms,
    sum: {
      beds: countBedrooms(rooms),
      baths: countBathrooms(rooms),
      size: estimateHomeSize(program, 1),
      floors: 1
    }
  };
}

function buildSingleWingPlan(program) {
  const rooms = [];

  const livingW = 7;
  const kitchenW = 5;
  const diningW = program.livingSpaces.includes('dining') ? 4 : 0;
  const topWidth = livingW + kitchenW + diningW;

  rooms.push(room('Living room', 'living', 0, 0, livingW, 5));
  rooms.push(room('Kitchen', 'kitchen', livingW, 0, kitchenW, 4));

  if (diningW > 0) {
    rooms.push(room('Dining', 'dining', livingW + kitchenW, 0, diningW, 4));
  }

  if (program.extras.includes('scullery')) {
    rooms.push(room('Scullery', 'scullery', livingW, 4, 3, 2));
  }

  const hallX = topWidth;
  const hallHeight = Math.max(10, program.beds * 3);
  rooms.push(room('Bedroom hall', 'passage', hallX, 0, 2, hallHeight));

  let y = 0;
  rooms.push(room('Master bed', 'room', hallX + 2, y, program.notes.premiumMainSuite ? 5 : 4, 4));

  if (program.masterEnsuite) {
    rooms.push(room('En-suite', 'ensuite', hallX + 6, y, 3, 2));
  }

  y += 4;

  for (let i = 2; i <= program.beds; i++) {
    rooms.push(room(`Bedroom ${i}`, 'room', hallX + 2, y, 4, 3));
    y += 3;
  }

  rooms.push(room('Main bath', 'bathroom', hallX + 6, 4, 3, 2));

  let bottom = Math.max(getBounds(rooms).bottom, hallHeight);

  let serviceX = 0;
  if (program.extras.includes('study')) {
    rooms.push(room('Study', 'study', serviceX, bottom + 1, 4, 3));
    serviceX += 4;
  }

  if (program.extras.includes('garage')) {
    rooms.push(room('Garage', 'garage', serviceX, bottom + 1, 6, 6));
  }

  bottom = getBounds(rooms).bottom;

  if (program.extras.includes('patio')) {
    rooms.push(room('Patio', 'patio', 0, bottom + 1, hallX + 9, 3));
  }

  if (program.extras.includes('garden')) {
    rooms.push(room('Garden', 'garden', 0, bottom + (program.extras.includes('patio') ? 4 : 1), hallX + 9, 5));
  }

  return {
    storey: 'single',
    desc: 'A single-storey home with a shared public zone and a dedicated private bedroom wing.',
    rooms,
    sum: {
      beds: countBedrooms(rooms),
      baths: countBathrooms(rooms),
      size: estimateHomeSize(program, 1),
      floors: 1
    }
  };
}

function buildDoubleSplitPlan(program) {
  const ground = [];
  const first = [];

  ground.push(room('Living room', 'living', 0, 0, 7, 5));
  ground.push(room('Kitchen', 'kitchen', 7, 0, 5, 4));

  if (program.livingSpaces.includes('dining')) {
    ground.push(room('Dining', 'dining', 12, 0, 4, 4));
  }

  if (program.extras.includes('scullery')) {
    ground.push(room('Scullery', 'scullery', 7, 4, 3, 2));
  }

  if (program.extras.includes('laundry')) {
    ground.push(room('Laundry', 'laundry', 10, 4, 3, 2));
  }

  ground.push(room('Foyer', 'passage', 0, 5, 4, 2));
  ground.push(room('Stairs', 'stairs', 4, 5, 2, 3));
  ground.push(room('Powder', 'bathroom', 6, 5, 3, 2));

  let gx = 9;
  if (program.extras.includes('study')) {
    ground.push(room('Study', 'study', gx, 5, 4, 3));
  }

  if (program.extras.includes('garage')) {
    ground.push(room('Garage', 'garage', 0, 8, 6, 6));
  }

  const groundBottom = getBounds(ground).bottom;

  if (program.extras.includes('patio')) {
    ground.push(room('Patio', 'patio', 0, groundBottom + 1, 16, 3));
  }

  if (program.extras.includes('garden')) {
    ground.push(room('Garden', 'garden', 0, groundBottom + (program.extras.includes('patio') ? 4 : 1), 16, 5));
  }

  first.push(room('Landing', 'passage', 0, 0, 6, 2));
  first.push(room('Upper hall', 'passage', 0, 2, 16, 2));
  first.push(room('Stairs', 'stairs', 0, 4, 2, 3));

  let x = 2;
  let y = 4;

  const masterW = program.notes.premiumMainSuite ? 5 : 4;
  first.push(room('Master bed', 'room', x, y, masterW, 4));
  x += masterW;

  if (program.masterEnsuite) {
    first.push(room('En-suite', 'ensuite', x, y, 3, 2));
    x += 3;
  }

  for (let i = 2; i <= program.beds; i++) {
    first.push(room(`Bedroom ${i}`, 'room', x, y, 4, 3));
    x += 4;
    if (x + 4 > 16) {
      x = 2;
      y += 4;
    }
  }

  first.push(room('Main bath', 'bathroom', 2, y + 4, 3, 2));

  return {
    storey: 'double',
    desc: 'A double-storey home with public spaces downstairs and private rooms upstairs.',
    ground,
    first,
    sum: {
      beds: countBedrooms([...ground, ...first]),
      baths: countBathrooms([...ground, ...first]),
      size: estimateHomeSize(program, 2),
      floors: 2
    }
  };
}

/* =========================
   MAIN BUILD
========================= */

function buildPlanDeterministically(program) {
  const archetype = chooseArchetype(program);

  let base;
  if (archetype === 'single_wing') base = buildSingleWingPlan(program);
  else if (archetype === 'double_split') base = buildDoubleSplitPlan(program);
  else base = buildSingleCorePlan(program);

  const withOpenings = attachDoorsAndWindows(base);
  validatePlan(withOpenings);
  return withOpenings;
}

/* =========================
   ROUTES
========================= */

app.post('/ask', async (req, res) => {
  const { description } = req.body;

  try {
    const text = await callGroq([{
      role: 'user',
      content: `You are a friendly South African architect assistant. A client said: "${description}"

Ask exactly 4 short clarifying questions before designing the floor plan.
Keep it conversational and natural.
Number them 1 to 4.
Do not generate the plan yet.`
    }], 0.3, 220);

    res.json({ questions: text });
  } catch (err) {
    console.error('ASK ERROR:', err);
    res.status(500).json({ error: 'Could not generate clarifying questions right now.' });
  }
});

app.post('/generate', async (req, res) => {
  const { description, answers, style, size } = req.body;
  const fullContext = `Original description: ${description}\nClient answers: ${answers}`;

  try {
    const program = await generateProgram(fullContext, style, size);
    const plan = buildPlanDeterministically(program);

    res.json({
      ...plan,
      program
    });
  } catch (err) {
    console.error('GENERATE ERROR:', err);
    const msg = String(err?.message || err);

    if (msg.toLowerCase().includes('rate limit')) {
      return res.status(429).json({
        error: 'The AI is busy right now. Please wait 10 seconds and try again.'
      });
    }

    res.status(500).json({
      error: err?.message || 'Could not generate a valid floor plan right now.'
    });
  }
});

app.post('/revise', async (req, res) => {
  const { request, description, currentProgram } = req.body;

  if (!request) {
    return res.status(400).json({ error: 'Missing revision request' });
  }

  try {
    const baseProgram = ensureProgram(
      currentProgram && typeof currentProgram === 'object'
        ? currentProgram
        : {
            storeyPreference: 'either',
            beds: 3,
            baths: 2,
            livingSpaces: ['living', 'dining', 'kitchen'],
            extras: ['patio', 'garden'],
            masterEnsuite: true,
            notes: { openPlan: true, entertainmentFocus: false, premiumMainSuite: false },
            zoning: { publicFront: true, privateRear: true },
            circulation: { type: 'spine' },
            archetypePreference: 'auto',
            sizeBand: 'medium'
          }
    );

    const revisedProgram = await reviseProgram(baseProgram, request, description || '');
    const revisedPlan = buildPlanDeterministically(revisedProgram);

    res.json({
      ...revisedPlan,
      program: revisedProgram
    });
  } catch (err) {
    console.error('REVISE ERROR:', err);
    const msg = String(err?.message || err);

    if (msg.toLowerCase().includes('rate limit')) {
      return res.status(429).json({
        error: 'The AI is busy right now. Please wait 10 seconds and try again.'
      });
    }

    res.status(500).json({
      error: err?.message || 'Could not revise the floor plan right now.'
    });
  }
});

/* =========================
   START
========================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ArchAI backend running on port ${PORT}`);
});