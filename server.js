const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const GROQ_KEY = process.env.GROQ_KEY;
if (!GROQ_KEY) {
  throw new Error('Missing GROQ_KEY environment variable');
}

/* =========================
   GROQ CALL
========================= */

async function callGroq(messages, temperature = 0.2) {
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
      max_tokens: 1500
    })
  });

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

function extractJson(text) {
  const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
  const match = clean.match(/\{[\s\S]*\}/);
  return JSON.parse(match[0]);
}

/* =========================
   BASIC HELPERS
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

function findOverlap(rooms) {
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      if (rectsOverlap(rooms[i], rooms[j])) {
        return { a: rooms[i], b: rooms[j] };
      }
    }
  }
  return null;
}

/* =========================
   VALIDATION
========================= */

function validatePlan(plan) {
  const errors = [];
  const rooms = plan.storey === 'double'
    ? [...plan.ground, ...plan.first]
    : plan.rooms;

  if (!rooms || rooms.length === 0) {
    errors.push('No rooms');
    return errors;
  }

  const overlap = findOverlap(rooms);
  if (overlap) {
    errors.push(
      `Overlap detected between "${overlap.a.name}" (${overlap.a.x},${overlap.a.y},${overlap.a.w},${overlap.a.h}) and "${overlap.b.name}" (${overlap.b.x},${overlap.b.y},${overlap.b.w},${overlap.b.h})`
    );
  }

  return errors;
}

/* =========================
   CODE REPAIR
========================= */

function fixOverlap(plan) {
  const rooms = plan.storey === 'double'
    ? [...plan.ground, ...plan.first]
    : plan.rooms;

  let overlap = findOverlap(rooms);
  let attempts = 0;

  while (overlap && attempts < 10) {
    overlap.b.y += 2; // push down
    overlap = findOverlap(rooms);
    attempts++;
  }

  return plan;
}

/* =========================
   AI REPAIR
========================= */

async function repairWithAI(plan, errors, context) {
  const prompt = `
Fix this floor plan.

CONTEXT:
${context}

PLAN:
${JSON.stringify(plan)}

ERRORS:
${errors.join('\n')}

Rules:
- Do NOT change layout concept
- ONLY fix overlaps
- Keep all rooms
- Return JSON only
`;

  const text = await callGroq([{ role: 'user', content: prompt }], 0.1);
  return extractJson(text);
}

/* =========================
   SIMPLE BUILDER (FIXED)
========================= */

function buildPlan(program) {
  // SIMPLE CLEAN LAYOUT — no overlaps by design
  const rooms = [];

  // core
  rooms.push(room('Living', 'living', 0, 0, 6, 5));
  rooms.push(room('Kitchen', 'kitchen', 6, 0, 4, 5));

  // circulation
  rooms.push(room('Hall', 'passage', 0, 5, 10, 2));

  // bedrooms
  for (let i = 0; i < program.beds; i++) {
    rooms.push(room(`Bedroom ${i + 1}`, 'room', i * 4, 7, 4, 3));
  }

  // bathrooms
  rooms.push(room('Bathroom', 'bathroom', 0, 10, 3, 2));

  // outdoor
  rooms.push(room('Garden', 'garden', 0, 12, 12, 5));

  return {
    storey: 'single',
    desc: 'Clean layout with central circulation',
    rooms,
    sum: {
      beds: program.beds,
      baths: 1,
      size: '~180m²',
      floors: 1
    }
  };
}

/* =========================
   GENERATE WITH REPAIR LOOP
========================= */

async function generateWithRepair(context) {
  const program = { beds: 4 };

  let plan = buildPlan(program);
  let errors = validatePlan(plan);

  if (errors.length === 0) return plan;

  // STEP 1: code repair
  plan = fixOverlap(plan);
  errors = validatePlan(plan);

  if (errors.length === 0) return plan;

  // STEP 2: AI repair
  plan = await repairWithAI(plan, errors, context);
  errors = validatePlan(plan);

  if (errors.length > 0) {
    throw new Error(errors.join(' | '));
  }

  return plan;
}

/* =========================
   ROUTES
========================= */

app.post('/generate', async (req, res) => {
  const { description } = req.body;

  try {
    const plan = await generateWithRepair(description);
    res.json(plan);
  } catch (err) {
    console.error('GENERATE ERROR:', err.message);
    res.status(500).json({
      error: 'Could not generate a valid floor plan right now.'
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

/* =========================
   START
========================= */

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`ArchAI backend running on port ${PORT}`);
});