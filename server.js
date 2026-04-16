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
   GROQ
========================= */

async function callGroq(messages, temperature = 0.1, maxTokens = 350) {
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
    } catch (_repairErr) {
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
  const p = program || {};

  return {
    storeyPreference: ['single', 'double', 'either'].includes(p.storeyPreference) ? p.storeyPreference : 'single',
    beds: clamp(Number(p.beds || 3), 2, 6),
    baths: clamp(Number(p.baths || 2), 1, 4),
    livingSpaces: Array.isArray(p.livingSpaces) && p.livingSpaces.length ? p.livingSpaces : ['living', 'dining', 'kitchen'],
    extras: Array.isArray(p.extras) ? p.extras : ['garage', 'study', 'patio', 'garden'],
    masterEnsuite: p.masterEnsuite !== false,
    notes: {
      openPlan: !!(p.notes && p.notes.openPlan),
      entertainmentFocus: !!(p.notes && p.notes.entertainmentFocus),
      premiumMainSuite: !!(p.notes && p.notes.premiumMainSuite)
    },
    sizeBand: ['small', 'medium', 'large'].includes(p.sizeBand) ? p.sizeBand : fallbackSize
  };
}

async function generateProgram(fullContext, style, size) {
  const prompt = `You are an expert residential architect.

Extract a clean program for a house planner based on this reference style:
- single storey by default
- left bedroom wing
- central open-plan living/dining/kitchen
- bathroom near entry/bedrooms
- study and garage on the right
- patio behind the living zone
- garden beyond patio

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
  "baths": 2,
  "livingSpaces": ["living", "dining", "kitchen"],
  "extras": ["garage", "study", "scullery", "laundry", "patio", "garden"],
  "masterEnsuite": true,
  "notes": {
    "openPlan": true,
    "entertainmentFocus": false,
    "premiumMainSuite": false
  },
  "sizeBand": "small" or "medium" or "large"
}`;

  const text = await callGroq([{ role: 'user', content: prompt }], 0.1, 280);
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

Keep the same overall reference style:
- left bedroom wing
- central open-plan core
- bathroom near entry/bedrooms
- study and garage on the right
- patio behind living

Return updated JSON only in the exact same structure.`;

  const text = await callGroq([{ role: 'user', content: prompt }], 0.1, 280);
  return ensureProgram(await parseJsonWithRepair(text), existingProgram.sizeBand || 'medium');
}

/* =========================
   GEOMETRY HELPERS
========================= */

function room(name, t, x, y, w, h) {
  return { name, t, x, y, w, h };
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

function area(w, h) {
  return w * h;
}

function getBounds(rooms) {
  if (!rooms.length) return { right: 0, bottom: 0 };
  return {
    right: Math.max(...rooms.map(r => r.x + r.w)),
    bottom: Math.max(...rooms.map(r => r.y + r.h))
  };
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
    40 +
    (program.extras.includes('garage') ? 36 : 0) +
    (program.extras.includes('study') ? 10 : 0) +
    (program.extras.includes('scullery') ? 6 : 0) +
    (program.extras.includes('laundry') ? 6 : 0) +
    (program.extras.includes('patio') ? 20 : 0);

  return `~${Math.round(floors === 2 ? total * 0.95 : total)}m²`;
}

/* =========================
   VALIDATION
========================= */

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

function ensureIndependentBedroomAccess(rooms) {
  const graph = buildAdjacencyGraph(rooms);
  const byName = new Map(rooms.map(r => [r.name, r]));
  const starts = rooms.filter(r => ['living', 'dining', 'kitchen', 'passage'].includes(r.t)).map(r => r.name);
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
        const nextRoom = byName.get(next);
        if (!nextRoom) continue;
        if (nextRoom.t === 'room' && next !== bedroom.name) continue;

        visited.add(next);
        queue.push(next);
      }
    }

    if (!found) {
      throw new Error(`${bedroom.name} does not have independent access`);
    }
  }
}

function ensureKeyAdjacency(rooms) {
  const living = rooms.find(r => r.t === 'living');
  const dining = rooms.find(r => r.t === 'dining');
  const kitchen = rooms.find(r => r.t === 'kitchen');
  const patio = rooms.find(r => r.t === 'patio');

  if (living && dining && !shareEdge(living, dining) && !shareEdge(living, kitchen)) {
    throw new Error('Living must connect to dining or kitchen');
  }

  if (kitchen && dining && !shareEdge(kitchen, dining) && !shareEdge(kitchen, living)) {
    throw new Error('Kitchen must connect to dining or living');
  }

  if (patio && ![living, dining, kitchen].some(r => r && shareEdge(r, patio))) {
    throw new Error('Patio must connect to the open-plan core');
  }
}

function validatePlan(plan) {
  const rooms = plan.rooms || [];
  if (!rooms.length) throw new Error('No rooms generated');

  validateNoOverlap(rooms);
  ensureIndependentBedroomAccess(rooms);
  ensureKeyAdjacency(rooms);

  for (const r of rooms) {
    if (![r.x, r.y, r.w, r.h].every(v => typeof v === 'number')) {
      throw new Error(`Invalid geometry on ${r.name}`);
    }
    if (r.w <= 0 || r.h <= 0) {
      throw new Error(`Invalid room size for ${r.name}`);
    }
    if (r.t === 'room') {
      if (/primary/i.test(r.name) && area(r.w, r.h) < 16) throw new Error(`Primary bedroom too small: ${r.name}`);
      if (!/primary/i.test(r.name) && area(r.w, r.h) < 9) throw new Error(`Bedroom too small: ${r.name}`);
    }
    if ((r.t === 'bathroom' || r.t === 'ensuite') && area(r.w, r.h) < 4) {
      throw new Error(`Bathroom too small: ${r.name}`);
    }
  }
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
  const accessTypes = new Set(['passage', 'living', 'dining', 'kitchen']);

  rooms.forEach(a => {
    if (!accessTypes.has(a.t)) return;

    rooms.forEach(b => {
      if (a === b) return;
      if (!['room', 'bathroom', 'ensuite', 'study', 'garage', 'kitchen', 'living', 'dining', 'scullery', 'laundry'].includes(b.t)) return;

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
  const priorities = ['living', 'garage', 'passage'];

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
  return {
    ...plan,
    doors: [
      ...generateInteriorDoorsForFloor(plan.rooms),
      ...generateExteriorDoorsForFloor(plan.rooms)
    ],
    windows: generateWindowsForFloor(plan.rooms)
  };
}

/* =========================
   REFERENCE STYLE PLANNER
========================= */

function buildReferenceStyleSingle(program) {
  const rooms = [];

  const primaryW = program.notes.premiumMainSuite ? 5 : 4;
  const primaryH = 4;
  const secondaryW = 4;
  const secondaryH = 3;
  const hallW = 2;
  const ensuiteW = program.masterEnsuite ? 3 : 0;

  const leftBlockW = Math.max(primaryW + ensuiteW, secondaryW) + hallW;

  let y = 0;
  rooms.push(room('Primary bedroom', 'room', 0, y, primaryW, primaryH));

  if (program.masterEnsuite) {
    rooms.push(room('En-suite', 'ensuite', primaryW, y, 3, 2));
    rooms.push(room('Wardrobe hall', 'passage', primaryW, y + 2, 3, 2));
  }

  const secondaryCount = Math.max(0, program.beds - 1);
  y = 4;
  for (let i = 0; i < secondaryCount; i++) {
    rooms.push(room(`Bedroom ${i + 2}`, 'room', 0, y, secondaryW, secondaryH));
    y += 4;
  }

  rooms.push(room('Bedroom hall', 'passage', leftBlockW - hallW, 4, hallW, Math.max(6, y - 4)));

  const entryX = leftBlockW;
  const entryY = 7;
  rooms.push(room('Entry', 'passage', entryX, entryY, 3, 3));

  const bathX = entryX + 3;
  const bathY = entryY + 2;
  rooms.push(room('Bathroom', 'bathroom', bathX, bathY, 4, 3));

  const coreX = leftBlockW + 3;
  const coreY = 0;
  const coreW = 11;
  const coreH = 11;

  rooms.push(room('Open plan living', 'living', coreX, coreY, 5, 5));
  rooms.push(room('Dining', 'dining', coreX + 5, coreY + 4, 6, 3));
  rooms.push(room('Kitchen', 'kitchen', coreX + 6, coreY + 7, 5, 4));

  if (program.extras.includes('scullery')) {
    rooms.push(room('Scullery', 'scullery', coreX + 11, coreY + 7, 3, 2));
  }

  if (program.extras.includes('laundry')) {
    rooms.push(room('Laundry', 'laundry', coreX + 11, coreY + 9, 3, 2));
  }

  if (program.extras.includes('study')) {
    rooms.push(room('Study', 'study', coreX + coreW, 4, 4, 3));
  }

  if (program.extras.includes('garage')) {
    const garageX = coreX + coreW + (program.extras.includes('study') ? 4 : 0);
    rooms.push(room('Garage', 'garage', garageX, 0, 6, 8));
  }

  if (program.extras.includes('patio')) {
    rooms.push(room(
      'Patio',
      'patio',
      coreX,
      -3,
      coreW + (program.extras.includes('study') ? 4 : 0),
      3
    ));
  }

  if (program.extras.includes('garden')) {
    const totalWidth = getBounds(rooms).right;
    rooms.push(room('Garden', 'garden', 0, -8, totalWidth, 5));
  }

  return {
    storey: 'single',
    desc: 'A reference-style family house with a left bedroom wing, central open-plan core, side study and garage, plus patio and garden at the rear.',
    rooms,
    sum: {
      beds: countBedrooms(rooms),
      baths: countBathrooms(rooms),
      size: estimateHomeSize(program, 1),
      floors: 1
    }
  };
}

function buildPlanDeterministically(program) {
  const base = buildReferenceStyleSingle(program);
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
      content: `You are a friendly architect assistant. A client said: "${description}"

Ask exactly 4 short clarifying questions before designing the house.
Keep it conversational.
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
            storeyPreference: 'single',
            beds: 3,
            baths: 2,
            livingSpaces: ['living', 'dining', 'kitchen'],
            extras: ['garage', 'study', 'patio', 'garden'],
            masterEnsuite: true,
            notes: { openPlan: true, entertainmentFocus: false, premiumMainSuite: false },
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