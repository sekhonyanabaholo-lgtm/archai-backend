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
   PROGRAM EXTRACTION
========================= */

function normaliseSizeBand(size) {
  const s = String(size || '').toLowerCase();
  if (s.includes('small')) return 'small';
  if (s.includes('large')) return 'large';
  return 'medium';
}

async function generateProgram(fullContext, style, size) {
  const prompt = `You are an expert residential architect.

Convert this client brief into a simple architectural program.
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
  "sizeBand": "small" or "medium" or "large"
}`;

  const text = await callGroq([{ role: 'user', content: prompt }], 0.1, 300);
  const program = await parseJsonWithRepair(text);

  program.beds = Math.max(1, Math.min(8, Number(program.beds || 3)));
  program.baths = Math.max(1, Math.min(6, Number(program.baths || 2)));
  program.livingSpaces = Array.isArray(program.livingSpaces)
    ? program.livingSpaces
    : ['living', 'dining', 'kitchen'];
  program.extras = Array.isArray(program.extras)
    ? program.extras
    : ['patio', 'garden'];
  program.notes = typeof program.notes === 'object' && program.notes ? program.notes : {};
  program.masterEnsuite = !!program.masterEnsuite;
  program.sizeBand = program.sizeBand || normaliseSizeBand(size);
  program.storeyPreference = ['single', 'double', 'either'].includes(program.storeyPreference)
    ? program.storeyPreference
    : 'either';

  return program;
}

async function reviseProgram(existingProgram, request, description) {
  const prompt = `You are revising an architectural program.

ORIGINAL DESCRIPTION:
${description || ''}

CURRENT PROGRAM:
${JSON.stringify(existingProgram, null, 2)}

REVISION REQUEST:
${request}

Return only updated JSON in the same structure.`;

  const text = await callGroq([{ role: 'user', content: prompt }], 0.1, 300);
  const updated = await parseJsonWithRepair(text);

  updated.beds = Math.max(1, Math.min(8, Number(updated.beds || existingProgram.beds || 3)));
  updated.baths = Math.max(1, Math.min(6, Number(updated.baths || existingProgram.baths || 2)));
  updated.livingSpaces = Array.isArray(updated.livingSpaces)
    ? updated.livingSpaces
    : existingProgram.livingSpaces;
  updated.extras = Array.isArray(updated.extras)
    ? updated.extras
    : existingProgram.extras;
  updated.notes = typeof updated.notes === 'object' && updated.notes
    ? updated.notes
    : existingProgram.notes;
  updated.masterEnsuite = typeof updated.masterEnsuite === 'boolean'
    ? updated.masterEnsuite
    : existingProgram.masterEnsuite;
  updated.sizeBand = updated.sizeBand || existingProgram.sizeBand;
  updated.storeyPreference = ['single', 'double', 'either'].includes(updated.storeyPreference)
    ? updated.storeyPreference
    : existingProgram.storeyPreference;

  return updated;
}

/* =========================
   GEOMETRY HELPERS
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

function findFirstOverlap(rooms) {
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i];
      const b = rooms[j];
      if (a.t === 'garden' || a.t === 'patio' || b.t === 'garden' || b.t === 'patio') continue;
      if (rectsOverlap(a, b)) return { a, b };
    }
  }
  return null;
}

function countBedroomsFromRooms(rooms) {
  return rooms.filter(r => r.t === 'room').length;
}

function countBathroomsFromRooms(rooms) {
  return rooms.filter(r => r.t === 'bathroom' || r.t === 'ensuite').length;
}

function estimateHomeSize(program, floors) {
  const base = program.beds * 14 + program.baths * 5 + 35;
  const extras =
    (program.extras.includes('garage') ? 36 : 0) +
    (program.extras.includes('study') ? 10 : 0) +
    (program.extras.includes('scullery') ? 6 : 0) +
    (program.extras.includes('laundry') ? 6 : 0) +
    (program.extras.includes('patio') ? 18 : 0);

  const total = base + extras + (program.livingSpaces.includes('dining') ? 12 : 0);
  return `~${Math.round(floors === 2 ? total * 0.95 : total)}m²`;
}

/* =========================
   DETERMINISTIC FLOOR PLAN
========================= */

function chooseStorey(program) {
  if (program.storeyPreference === 'single') return 'single';
  if (program.storeyPreference === 'double') return 'double';
  if (program.beds >= 6) return 'double';
  return 'single';
}

function validatePlan(plan) {
  const rooms = plan.storey === 'double'
    ? [...plan.ground, ...plan.first]
    : plan.rooms;

  if (!rooms || rooms.length === 0) {
    throw new Error('No rooms generated');
  }

  const overlap = findFirstOverlap(rooms);
  if (overlap) {
    throw new Error(`Overlap detected between "${overlap.a.name}" and "${overlap.b.name}"`);
  }

  for (const r of rooms) {
    if (r.w <= 0 || r.h <= 0) {
      throw new Error(`Invalid room size for ${r.name}`);
    }
    if (r.t === 'room') {
      if (/master/i.test(r.name) && area(r.w, r.h) < 16) {
        throw new Error(`Master bedroom too small: ${r.name}`);
      }
      if (!/master/i.test(r.name) && area(r.w, r.h) < 9) {
        throw new Error(`Bedroom too small: ${r.name}`);
      }
    }
    if ((r.t === 'bathroom' || r.t === 'ensuite') && area(r.w, r.h) < 4) {
      throw new Error(`Bathroom too small: ${r.name}`);
    }
  }
}

function buildSinglePlan(program) {
  const rooms = [];

  const livingW = program.notes.openPlan ? 7 : 6;
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

  if (program.extras.includes('laundry')) {
    rooms.push(room('Laundry', 'laundry', livingW + 3, 4, 3, 2));
  }

  rooms.push(room('Hall', 'passage', 0, 6, Math.max(topWidth, 14), 2));

  let x = 0;
  let y = 8;

  const masterW = program.notes.premiumMainSuite ? 5 : 4;
  rooms.push(room('Master bed', 'room', x, y, masterW, 4));

  if (program.masterEnsuite) {
    rooms.push(room('En-suite', 'ensuite', x + masterW, y, 3, 2));
    x += masterW + 3;
  } else {
    x += masterW;
  }

  for (let i = 2; i <= program.beds; i++) {
    rooms.push(room(`Bedroom ${i}`, 'room', x, y, 4, 3));
    x += 4;
    if (x + 4 > Math.max(topWidth, 16)) {
      x = 0;
      y += 4;
    }
  }

  rooms.push(room('Main bath', 'bathroom', 0, y + 4, 3, 2));

  let serviceX = 4;
  const serviceY = y + 4;

  if (program.extras.includes('study')) {
    rooms.push(room('Study', 'study', serviceX, serviceY, 4, 3));
    serviceX += 4;
  }

  if (program.extras.includes('garage')) {
    rooms.push(room('Garage', 'garage', serviceX, serviceY, 6, 6));
  }

  const bottom = Math.max(...rooms.map(r => r.y + r.h));

  if (program.extras.includes('patio')) {
    rooms.push(room('Patio', 'patio', 0, bottom + 1, Math.max(topWidth, 16), 3));
  }

  if (program.extras.includes('garden')) {
    rooms.push(room('Garden', 'garden', 0, bottom + (program.extras.includes('patio') ? 4 : 1), Math.max(topWidth, 16), 5));
  }

  return {
    storey: 'single',
    desc: 'A single-storey family layout with simple zoning and clear circulation.',
    rooms,
    sum: {
      beds: countBedroomsFromRooms(rooms),
      baths: countBathroomsFromRooms(rooms),
      size: estimateHomeSize(program, 1),
      floors: 1
    }
  };
}

function buildDoublePlan(program) {
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

  const groundBottom = Math.max(...ground.map(r => r.y + r.h));

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

  if (program.masterEnsuite) {
    first.push(room('En-suite', 'ensuite', x + masterW, y, 3, 2));
    x += masterW + 3;
  } else {
    x += masterW;
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
    desc: 'A double-storey family layout with shared spaces downstairs and bedrooms upstairs.',
    ground,
    first,
    sum: {
      beds: countBedroomsFromRooms([...ground, ...first]),
      baths: countBathroomsFromRooms([...ground, ...first]),
      size: estimateHomeSize(program, 2),
      floors: 2
    }
  };
}

function buildPlanDeterministically(program) {
  return chooseStorey(program) === 'double'
    ? buildDoublePlan(program)
    : buildSinglePlan(program);
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

Ask exactly 4 short clarifying questions before designing the floor plan.
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
    validatePlan(plan);

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
    const baseProgram = currentProgram && typeof currentProgram === 'object'
      ? currentProgram
      : {
          storeyPreference: 'either',
          beds: 3,
          baths: 2,
          livingSpaces: ['living', 'dining', 'kitchen'],
          extras: ['patio', 'garden'],
          masterEnsuite: true,
          notes: { openPlan: true, entertainmentFocus: false, premiumMainSuite: false },
          sizeBand: 'medium'
        };

    const revisedProgram = await reviseProgram(baseProgram, request, description || '');
    const revisedPlan = buildPlanDeterministically(revisedProgram);
    validatePlan(revisedPlan);

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