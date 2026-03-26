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
   AI HELPERS
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
      max_tokens: 1400,
      temperature
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || 'Groq request failed');
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content returned from Groq');

  return content.trim();
}

function extractJson(text) {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in model response');
  return JSON.parse(match[0]);
}

function normaliseSizeBand(size) {
  const s = String(size || '').toLowerCase();
  if (s.includes('small')) return 'small';
  if (s.includes('large')) return 'large';
  return 'medium';
}

/* =========================
   PROGRAM EXTRACTION
========================= */

async function generateProgram(fullContext, style, size) {
  const prompt = `You are an expert South African residential architect.

Read the client brief and convert it into a clean architectural program.
Do NOT produce coordinates.
Do NOT produce a floor plan.
Do NOT explain anything.

CLIENT BRIEF:
${fullContext}

Style preference: ${style}
Size preference: ${size}

Return ONLY JSON in this exact structure:
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
    "premiumMainSuite": true
  },
  "sizeBand": "small" or "medium" or "large"
}

Rules:
- Infer likely requirements from the brief
- Always include living and kitchen
- Include dining unless clearly unnecessary
- Include patio and garden unless clearly unnecessary
- Include garage, study, scullery, laundry only if requested or strongly implied
- beds must be between 1 and 8
- baths must be between 1 and 6
- Return ONLY raw JSON`;

  const text = await callGroq([{ role: 'user', content: prompt }], 0.1);
  const program = extractJson(text);

  program.beds = Math.max(1, Math.min(8, Number(program.beds || 3)));
  program.baths = Math.max(1, Math.min(6, Number(program.baths || 2)));
  program.livingSpaces = Array.isArray(program.livingSpaces) ? program.livingSpaces : ['living', 'kitchen', 'dining'];
  program.extras = Array.isArray(program.extras) ? program.extras : ['patio', 'garden'];
  program.notes = typeof program.notes === 'object' && program.notes ? program.notes : {};
  program.masterEnsuite = !!program.masterEnsuite;
  program.sizeBand = program.sizeBand || normaliseSizeBand(size);
  program.storeyPreference = ['single', 'double', 'either'].includes(program.storeyPreference)
    ? program.storeyPreference
    : 'either';

  return program;
}

async function reviseProgram(existingProgram, request, description) {
  const prompt = `You are an expert South African residential architect.

You are revising an existing architectural program.

ORIGINAL CLIENT DESCRIPTION:
${description || ''}

CURRENT PROGRAM:
${JSON.stringify(existingProgram, null, 2)}

REVISION REQUEST:
${request}

Update the program to reflect the new request.

Return ONLY JSON in this exact structure:
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
    "premiumMainSuite": true
  },
  "sizeBand": "small" or "medium" or "large"
}

Rules:
- Keep the existing program unless the revision clearly changes it
- If the user asks for a room to be bigger, do NOT change bedroom counts unless explicitly requested
- Return ONLY raw JSON`;

  const text = await callGroq([{ role: 'user', content: prompt }], 0.1);
  const updated = extractJson(text);

  updated.beds = Math.max(1, Math.min(8, Number(updated.beds || existingProgram.beds || 3)));
  updated.baths = Math.max(1, Math.min(6, Number(updated.baths || existingProgram.baths || 2)));
  updated.livingSpaces = Array.isArray(updated.livingSpaces) ? updated.livingSpaces : existingProgram.livingSpaces;
  updated.extras = Array.isArray(updated.extras) ? updated.extras : existingProgram.extras;
  updated.notes = typeof updated.notes === 'object' && updated.notes ? updated.notes : existingProgram.notes;
  updated.masterEnsuite = typeof updated.masterEnsuite === 'boolean' ? updated.masterEnsuite : existingProgram.masterEnsuite;
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

function validateNoOverlap(rooms) {
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i];
      const b = rooms[j];
      if (a.t === 'garden' || a.t === 'patio' || b.t === 'garden' || b.t === 'patio') continue;

      if (rectsOverlap(a, b)) {
        throw new Error(
          `Overlap detected between "${a.name}" (${a.x},${a.y},${a.w},${a.h}) and "${b.name}" (${b.x},${b.y},${b.w},${b.h})`
        );
      }
    }
  }
}

function maxBottom(rooms) {
  if (!rooms.length) return 0;
  return Math.max(...rooms.map(r => r.y + r.h));
}

function maxRight(rooms) {
  if (!rooms.length) return 0;
  return Math.max(...rooms.map(r => r.x + r.w));
}

function countBedroomsFromRooms(rooms) {
  return rooms.filter(r => r.t === 'room').length;
}

function countBathroomsFromRooms(rooms) {
  return rooms.filter(r => r.t === 'bathroom' || r.t === 'ensuite').length;
}

function estimateHomeSize(program, floors) {
  const bedArea = program.beds * 14;
  const bathArea = program.baths * 5;
  const livingArea = 28 + Math.max(0, program.beds - 3) * 2;
  const kitchenArea = 12 + Math.max(0, program.beds - 4);
  const diningArea = program.livingSpaces.includes('dining') ? 12 + Math.max(0, program.beds - 4) : 0;
  const garageArea = program.extras.includes('garage') ? 36 : 0;
  const studyArea = program.extras.includes('study') ? 10 : 0;
  const sculleryArea = program.extras.includes('scullery') ? 6 : 0;
  const laundryArea = program.extras.includes('laundry') ? 6 : 0;
  const circulationArea = Math.max(8, program.beds * 3);
  const patioArea = program.extras.includes('patio') ? 18 : 0;
  const total = bedArea + bathArea + livingArea + kitchenArea + diningArea + garageArea + studyArea + sculleryArea + laundryArea + circulationArea + patioArea;
  const adjusted = floors === 2 ? total * 0.95 : total;
  return `~${Math.round(adjusted)}m²`;
}

function buildDescription(program, storey) {
  const parts = [];
  parts.push(storey === 'double' ? 'A practical double-storey home' : 'A practical single-storey home');
  if (program.notes?.openPlan) parts.push('with an open-plan living core');
  if (program.extras.includes('study')) parts.push('a dedicated study');
  if (program.extras.includes('garage')) parts.push('integrated parking');
  return `${parts.join(' ')} designed around open shared spaces and independent private-room access.`;
}

function chooseStorey(program) {
  if (program.storeyPreference === 'single') return 'single';
  if (program.storeyPreference === 'double') return 'double';
  if (program.beds >= 7) return 'double';
  if (program.beds >= 6 && program.sizeBand !== 'large') return 'double';
  return 'single';
}

/* =========================
   PACKING HELPERS
========================= */

function boundsOf(rooms) {
  if (!rooms.length) return { x: 0, y: 0, w: 0, h: 0, right: 0, bottom: 0 };
  const minX = Math.min(...rooms.map(r => r.x));
  const minY = Math.min(...rooms.map(r => r.y));
  const maxX = Math.max(...rooms.map(r => r.x + r.w));
  const maxY = Math.max(...rooms.map(r => r.y + r.h));
  return {
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
    right: maxX,
    bottom: maxY
  };
}

function shiftRooms(rooms, dx, dy) {
  return rooms.map(r => ({ ...r, x: r.x + dx, y: r.y + dy }));
}

function overlapsAny(candidateRooms, placedRooms) {
  for (const a of candidateRooms) {
    for (const b of placedRooms) {
      if (a.t === 'garden' || a.t === 'patio' || b.t === 'garden' || b.t === 'patio') continue;
      if (rectsOverlap(a, b)) return true;
    }
  }
  return false;
}

function placeBlockToRight(blockRooms, placedRooms, startX, y, gap = 2) {
  let x = startX;
  let shifted = shiftRooms(blockRooms, x, y);

  while (overlapsAny(shifted, placedRooms)) {
    x += gap;
    shifted = shiftRooms(blockRooms, x, y);
    if (x > 200) {
      throw new Error('Could not place block to the right without overlap');
    }
  }

  return shifted;
}

function placeBlockBelow(blockRooms, placedRooms, x, startY, gap = 2) {
  let y = startY;
  let shifted = shiftRooms(blockRooms, x, y);

  while (overlapsAny(shifted, placedRooms)) {
    y += gap;
    shifted = shiftRooms(blockRooms, x, y);
    if (y > 200) {
      throw new Error('Could not place block below without overlap');
    }
  }

  return shifted;
}

/* =========================
   PUBLIC ZONE
========================= */

function publicZoneMetrics(program) {
  const bedFactor = Math.max(0, program.beds - 3);

  return {
    livingW: Math.min(10, 7 + Math.floor(bedFactor / 2)),
    livingH: 5 + (program.beds >= 7 ? 1 : 0),
    kitchenW: Math.min(7, 5 + Math.floor(bedFactor / 3)),
    kitchenH: program.extras.includes('scullery') ? 3 : 4,
    diningW: program.livingSpaces.includes('dining') ? Math.min(7, 5 + Math.floor(bedFactor / 3)) : 0,
    diningH: program.livingSpaces.includes('dining') ? 2 + (program.beds >= 7 ? 1 : 0) : 0
  };
}

function buildPublicZone(program) {
  const rooms = [];
  const hasDining = program.livingSpaces.includes('dining');
  const hasGarage = program.extras.includes('garage');
  const hasStudy = program.extras.includes('study');
  const hasScullery = program.extras.includes('scullery');
  const hasLaundry = program.extras.includes('laundry');

  const m = publicZoneMetrics(program);

  rooms.push(room('Living room', 'living', 0, 0, m.livingW, m.livingH));
  rooms.push(room('Kitchen', 'kitchen', m.livingW, 0, m.kitchenW, m.kitchenH));

  let serviceWidth = m.kitchenW;

  if (hasDining) {
    rooms.push(room('Dining', 'dining', m.livingW, m.kitchenH, m.diningW, m.diningH));
    serviceWidth = Math.max(serviceWidth, m.diningW);
  }

  if (hasScullery) {
    rooms.push(room('Scullery', 'scullery', m.livingW + m.kitchenW, 0, 4, 2));
    serviceWidth = Math.max(serviceWidth, m.kitchenW + 4);
  }

  if (hasLaundry) {
    rooms.push(room('Laundry', 'laundry', m.livingW + m.kitchenW, hasScullery ? 2 : 0, 3, 2));
    serviceWidth = Math.max(serviceWidth, m.kitchenW + 3);
  }

  let x = m.livingW + serviceWidth;

  if (hasStudy) {
    rooms.push(room('Study', 'study', x, 0, 4, 3));
    x += 4;
  }

  rooms.push(room('Guest bath', 'bathroom', Math.max(0, x - 4), 3, 3, 2));

  if (hasGarage) {
    const garageW = program.beds >= 6 ? 7 : 6;
    rooms.push(room('Garage', 'garage', x, 0, garageW, 6));
  }

  return rooms;
}

/* =========================
   PRIVATE ACCESS SPACES
========================= */

function buildLanding(x, y, w = 4, h = 2) {
  return room('Landing', 'passage', x, y, w, h);
}

function buildPrivateAccessHall(x, y, w, h = 2, label = 'Private hall') {
  return room(label, 'passage', x, y, w, h);
}

function buildBedroomRow(names, x, y, program, includeMasterEnsuite) {
  const rooms = [];
  let cursorX = x;

  names.forEach((name) => {
    const isMaster = /master/i.test(name);

    if (isMaster) {
      const masterW = program.notes?.premiumMainSuite ? 6 : 5;
      const masterH = 4;
      rooms.push(room(name, 'room', cursorX, y, masterW, masterH));

      if (includeMasterEnsuite) {
        rooms.push(room('En-suite', 'ensuite', cursorX + masterW, y, 3, 2));
        cursorX += masterW + 3;
      } else {
        cursorX += masterW;
      }
    } else {
      rooms.push(room(name, 'room', cursorX, y, 4, 3));
      cursorX += 4;
    }
  });

  return rooms;
}

function buildSideBedroomColumn(names, x, y, program, side, includeMasterEnsuite) {
  const rooms = [];
  let cursorY = y;

  names.forEach((name) => {
    const isMaster = /master/i.test(name);

    if (isMaster) {
      const masterW = program.notes?.premiumMainSuite ? 6 : 5;
      rooms.push(room(name, 'room', x, cursorY, masterW, 4));

      if (includeMasterEnsuite) {
        const ensuiteX = side === 'left' ? x + masterW : x - 3;
        rooms.push(room('En-suite', 'ensuite', ensuiteX, cursorY, 3, 2));
      }

      cursorY += 4;
    } else {
      rooms.push(room(name, 'room', x, cursorY, 4, 3));
      cursorY += 3;
    }
  });

  return rooms;
}

function buildBathroomCluster(count, x, y) {
  const rooms = [];
  for (let i = 0; i < count; i++) {
    rooms.push(room(i === 0 ? 'Main bath' : `Bathroom ${i + 1}`, 'bathroom', x + (i * 3), y, 3, 2));
  }
  return rooms;
}

/* =========================
   SINGLE STOREY
========================= */

function buildSingleStorey(program) {
  const rooms = [];
  const publicRooms = buildPublicZone(program);
  rooms.push(...publicRooms);

  const publicBottom = maxBottom(publicRooms);
  const publicWidth = Math.max(16, maxRight(publicRooms));

  const bedroomNames = ['Master bed'];
  for (let i = 2; i <= program.beds; i++) bedroomNames.push(`Bedroom ${i}`);

  if (program.beds <= 4) {
    const privateHall = buildPrivateAccessHall(0, publicBottom, publicWidth, 2, 'Private hall');
    rooms.push(privateHall);

    const bedRowRaw = buildBedroomRow(
      bedroomNames,
      0,
      0,
      program,
      program.masterEnsuite
    );
    const bedRow = placeBlockBelow(bedRowRaw, rooms, 0, privateHall.y + privateHall.h, 1);
    rooms.push(...bedRow);

    const bathsNeeded = Math.max(1, program.baths - (program.masterEnsuite ? 1 : 0));
    const bathsRaw = buildBathroomCluster(bathsNeeded, 0, 0);
    const baths = placeBlockBelow(bathsRaw, rooms, 0, boundsOf(bedRow).bottom + 1, 1);
    rooms.push(...baths);
  } else if (program.beds <= 6) {
    const landing = buildLanding(6, publicBottom, 4, 2);
    rooms.push(landing);

    const leftNames = [];
    const rightNames = [];

    bedroomNames.forEach((name, i) => {
      if (i === 0 || i % 2 === 1) leftNames.push(name);
      else rightNames.push(name);
    });

    const leftWingRaw = buildSideBedroomColumn(
      leftNames,
      0,
      0,
      program,
      'left',
      program.masterEnsuite
    );

    const rightWingRaw = buildSideBedroomColumn(
      rightNames,
      0,
      0,
      program,
      'right',
      false
    );

    const leftWing = placeBlockBelow(leftWingRaw, rooms, 0, landing.y + landing.h, 1);
    rooms.push(...leftWing);

    const leftBounds = boundsOf(leftWing);
    const rightWing = placeBlockToRight(
      rightWingRaw,
      rooms,
      leftBounds.right + 2,
      landing.y + landing.h,
      1
    );
    rooms.push(...rightWing);

    const bathsNeeded = Math.max(1, program.baths - (program.masterEnsuite ? 1 : 0));
    const bathsRaw = buildBathroomCluster(bathsNeeded, 0, 0);
    const bathStartY = Math.max(boundsOf(leftWing).bottom, boundsOf(rightWing).bottom) + 1;
    const baths = placeBlockBelow(bathsRaw, rooms, 6, bathStartY, 1);
    rooms.push(...baths);
  } else {
    const landing = buildLanding(8, publicBottom, 4, 2);
    rooms.push(landing);

    const leftNames = [];
    const rightNames = [];
    const lowerNames = [];

    bedroomNames.forEach((name, i) => {
      if (i === 0) leftNames.push(name);
      else if (i % 3 === 1) leftNames.push(name);
      else if (i % 3 === 2) rightNames.push(name);
      else lowerNames.push(name);
    });

    const leftWingRaw = buildSideBedroomColumn(
      leftNames,
      0,
      0,
      program,
      'left',
      program.masterEnsuite
    );

    const rightWingRaw = buildSideBedroomColumn(
      rightNames,
      0,
      0,
      program,
      'right',
      false
    );

    const leftWing = placeBlockBelow(leftWingRaw, rooms, 0, landing.y + landing.h, 1);
    rooms.push(...leftWing);

    const rightWing = placeBlockToRight(
      rightWingRaw,
      rooms,
      14,
      landing.y + landing.h,
      1
    );
    rooms.push(...rightWing);

    const lowerHallY = Math.max(boundsOf(leftWing).bottom, boundsOf(rightWing).bottom) + 1;
    const lowerHall = buildPrivateAccessHall(
      0,
      lowerHallY,
      Math.max(boundsOf(rightWing).right, 18),
      2,
      'Secondary hall'
    );
    rooms.push(lowerHall);

    const lowerRowRaw = buildBedroomRow(
      lowerNames,
      0,
      0,
      program,
      false
    );

    const lowerRow = placeBlockBelow(lowerRowRaw, rooms, 2, lowerHall.y + lowerHall.h, 1);
    rooms.push(...lowerRow);

    const bathsNeeded = Math.max(1, program.baths - (program.masterEnsuite ? 1 : 0));
    const bathsRaw = buildBathroomCluster(bathsNeeded, 0, 0);
    const baths = placeBlockBelow(bathsRaw, rooms, 8, boundsOf(lowerRow).bottom + 1, 1);
    rooms.push(...baths);
  }

  const width = Math.max(publicWidth, maxRight(rooms));
  const outdoorY = maxBottom(rooms);

  if (program.extras.includes('patio')) {
    rooms.push(room('Patio', 'patio', 0, outdoorY, width, 3));
  }
  if (program.extras.includes('garden')) {
    rooms.push(room('Garden', 'garden', 0, outdoorY + (program.extras.includes('patio') ? 3 : 0), width, 5));
  }

  validateNoOverlap(rooms);

  return {
    storey: 'single',
    desc: buildDescription(program, 'single'),
    rooms,
    sum: {
      beds: countBedroomsFromRooms(rooms),
      baths: countBathroomsFromRooms(rooms),
      size: estimateHomeSize(program, 1),
      floors: 1
    }
  };
}

/* =========================
   DOUBLE STOREY
========================= */

function buildDoubleStorey(program) {
  const ground = [];
  const first = [];

  const publicRooms = buildPublicZone(program);
  ground.push(...publicRooms);

  const publicBottom = maxBottom(publicRooms);
  const stairX = Math.max(7, maxRight(publicRooms) - 2);
  ground.push(room('Stairs', 'stairs', stairX, Math.max(2, publicBottom - 3), 2, 3));

  const groundWidth = Math.max(16, maxRight(ground));

  if (program.extras.includes('patio')) {
    ground.push(room('Patio', 'patio', 0, maxBottom(ground), groundWidth, 3));
  }
  if (program.extras.includes('garden')) {
    ground.push(room('Garden', 'garden', 0, maxBottom(ground), groundWidth, 5));
  }

  const landing = buildLanding(6, 0, 4, 2);
  first.push(landing);
  first.push(room('Stairs', 'stairs', 6, 2, 2, 3));

  const bedroomNames = ['Master bed'];
  for (let i = 2; i <= program.beds; i++) bedroomNames.push(`Bedroom ${i}`);

  if (program.beds <= 5) {
    const leftNames = bedroomNames.filter((_, i) => i % 2 === 0);
    const rightNames = bedroomNames.filter((_, i) => i % 2 === 1);

    const leftWingRaw = buildSideBedroomColumn(leftNames, 0, 0, program, 'left', false);
    const rightWingRaw = buildSideBedroomColumn(rightNames, 0, 0, program, 'right', true);

    const leftWing = placeBlockBelow(leftWingRaw, first, 0, landing.y + landing.h, 1);
    first.push(...leftWing);

    const rightWing = placeBlockToRight(rightWingRaw, first, 10, landing.y + landing.h, 1);
    first.push(...rightWing);

    const bathsNeeded = Math.max(1, program.baths - (program.masterEnsuite ? 1 : 0) - 1);
    const bathsRaw = buildBathroomCluster(bathsNeeded, 0, 0);
    const bathY = Math.max(boundsOf(leftWing).bottom, boundsOf(rightWing).bottom) + 1;
    const baths = placeBlockBelow(bathsRaw, first, 6, bathY, 1);
    first.push(...baths);
  } else {
    const leftNames = [];
    const rightNames = [];
    const lowerNames = [];

    bedroomNames.forEach((name, i) => {
      if (i === 0) rightNames.push(name);
      else if (i % 3 === 1) leftNames.push(name);
      else if (i % 3 === 2) rightNames.push(name);
      else lowerNames.push(name);
    });

    const leftWingRaw = buildSideBedroomColumn(leftNames, 0, 0, program, 'left', false);
    const rightWingRaw = buildSideBedroomColumn(rightNames, 0, 0, program, 'right', true);

    const leftWing = placeBlockBelow(leftWingRaw, first, 0, landing.y + landing.h, 1);
    first.push(...leftWing);

    const rightWing = placeBlockToRight(rightWingRaw, first, 14, landing.y + landing.h, 1);
    first.push(...rightWing);

    const lowerHallY = Math.max(boundsOf(leftWing).bottom, boundsOf(rightWing).bottom) + 1;
    const lowerHall = buildPrivateAccessHall(2, lowerHallY, 16, 2, 'Upper hall');
    first.push(lowerHall);

    const lowerRowRaw = buildBedroomRow(lowerNames, 0, 0, program, false);
    const lowerRow = placeBlockBelow(lowerRowRaw, first, 4, lowerHall.y + lowerHall.h, 1);
    first.push(...lowerRow);

    const bathsNeeded = Math.max(1, program.baths - (program.masterEnsuite ? 1 : 0) - 1);
    const bathsRaw = buildBathroomCluster(bathsNeeded, 0, 0);
    const baths = placeBlockBelow(bathsRaw, first, 8, boundsOf(lowerRow).bottom + 1, 1);
    first.push(...baths);
  }

  validateNoOverlap(ground);
  validateNoOverlap(first);

  return {
    storey: 'double',
    desc: buildDescription(program, 'double'),
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

/* =========================
   ACCESS VALIDATION
========================= */

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

function accessibleWithoutCrossingBedrooms(rooms, startNames, targetName) {
  const graph = buildAdjacencyGraph(rooms);
  const roomMap = new Map(rooms.map(r => [r.name, r]));
  const queue = [...startNames];
  const visited = new Set(queue);

  while (queue.length) {
    const current = queue.shift();
    if (current === targetName) return true;

    for (const next of graph.get(current) || []) {
      if (visited.has(next)) continue;
      const r = roomMap.get(next);
      if (!r) continue;

      const isTarget = next === targetName;
      const blocked = r.t === 'room' && !isTarget;

      if (blocked) continue;

      visited.add(next);
      queue.push(next);
    }
  }

  return false;
}

function validateIndependentAccessSingle(rooms) {
  const bedrooms = rooms.filter(r => r.t === 'room');
  const starts = rooms
    .filter(r => ['living', 'dining', 'kitchen', 'passage', 'stairs'].includes(r.t))
    .map(r => r.name);

  for (const bedroom of bedrooms) {
    if (!accessibleWithoutCrossingBedrooms(rooms, starts, bedroom.name)) {
      throw new Error(`${bedroom.name} does not have independent access`);
    }
  }
}

function validateIndependentAccessDouble(_ground, first) {
  const firstBedrooms = first.filter(r => r.t === 'room');
  const starts = first
    .filter(r => r.t === 'passage' || r.t === 'stairs')
    .map(r => r.name);

  for (const bedroom of firstBedrooms) {
    if (!accessibleWithoutCrossingBedrooms(first, starts, bedroom.name)) {
      throw new Error(`${bedroom.name} does not have independent upstairs access`);
    }
  }
}

/* =========================
   DOORS AND WINDOWS
========================= */

function isRoomInterior(t) {
  return !['garden', 'patio'].includes(t);
}

function hasAdjacentRoom(rooms, roomObj, side) {
  return rooms.some(other => {
    if (other === roomObj) return false;
    if (!isRoomInterior(other.t)) return false;

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
      return;
    }

    if (!hasAdjacentRoom(rooms, r, 'right')) {
      doors.push({
        from: r.name,
        to: 'exterior',
        x: r.x + r.w,
        y: r.y + Math.max(1, Math.floor(r.h / 2) - 0.5),
        width: 1,
        side: 'right'
      });
    }
  });

  return dedupeDoors(doors);
}

function generateWindowsForFloor(rooms) {
  const windows = [];

  rooms.forEach(r => {
    if (!isRoomInterior(r.t) || r.t === 'passage') return;

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
   FULL VALIDATION
========================= */

function validatePlan(plan) {
  const errors = [];

  if (!plan || typeof plan !== 'object') errors.push('Plan is invalid');
  if (!plan.desc || typeof plan.desc !== 'string') errors.push('Missing description');
  if (!plan.sum || typeof plan.sum !== 'object') errors.push('Missing summary');
  if (!plan.storey) errors.push('Missing storey');

  const allRooms = plan.storey === 'double'
    ? [...(plan.ground || []), ...(plan.first || [])]
    : (plan.rooms || []);

  if (!Array.isArray(allRooms) || allRooms.length === 0) {
    errors.push('No rooms returned');
    return errors;
  }

  for (const r of allRooms) {
    if (typeof r.name !== 'string') errors.push('Room missing name');
    if (typeof r.t !== 'string') errors.push(`Room ${r.name || ''} missing type`);
    if (![r.x, r.y, r.w, r.h].every(v => typeof v === 'number')) {
      errors.push(`Room ${r.name || ''} has invalid geometry`);
      continue;
    }
    if (r.w <= 0 || r.h <= 0) errors.push(`Room ${r.name} has invalid dimensions`);

    if (r.t === 'room') {
      if (/master/i.test(r.name) && area(r.w, r.h) < 16) errors.push(`Master bedroom too small: ${r.name}`);
      if (!/master/i.test(r.name) && area(r.w, r.h) < 9) errors.push(`Bedroom too small: ${r.name}`);
    }
    if ((r.t === 'bathroom' || r.t === 'ensuite') && area(r.w, r.h) < 4) {
      errors.push(`Bathroom too small: ${r.name}`);
    }
    if (r.t === 'kitchen' && area(r.w, r.h) < 6) {
      errors.push('Kitchen too small');
    }
  }

  try {
    if (plan.storey === 'double') {
      validateNoOverlap(plan.ground || []);
      validateNoOverlap(plan.first || []);
      validateIndependentAccessDouble(plan.ground || [], plan.first || []);
    } else {
      validateNoOverlap(plan.rooms || []);
      validateIndependentAccessSingle(plan.rooms || []);
    }
  } catch (err) {
    errors.push(err.message);
  }

  return errors;
}

/* =========================
   MAIN BUILDER
========================= */

function buildPlanDeterministically(program) {
  const storey = chooseStorey(program);
  const basePlan = storey === 'double' ? buildDoubleStorey(program) : buildSingleStorey(program);
  return attachDoorsAndWindows(basePlan);
}

/* =========================
   ENDPOINTS
========================= */

app.post('/ask', async (req, res) => {
  const { description } = req.body;

  try {
    const text = await callGroq([{
      role: 'user',
      content: `You are a friendly South African architect assistant. A client just said: "${description}".

Ask them exactly 4 short clarifying questions to better understand their needs before designing their floor plan.

The questions should cover things you dont know yet from their description such as:
- Number of bedrooms or bathrooms if not mentioned
- Single or double storey
- Do they need a garage or carport
- Any special rooms like study, scullery, outside room, laundry
- Plot size or any site constraints
- Budget tier (basic, mid-range, luxury)
- Garden size or outdoor entertainment area needs

Format your response as a friendly short intro sentence then exactly 4 questions numbered 1 to 4. Keep it conversational and South African. Do not generate a floor plan yet.`
    }], 0.3);

    res.json({ questions: text });
  } catch (err) {
    console.error('ASK ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/generate', async (req, res) => {
  const { description, answers, style, size } = req.body;
  const fullContext = `Original description: ${description}\nClient answers: ${answers}`;

  try {
    const program = await generateProgram(fullContext, style, size);
    const plan = buildPlanDeterministically(program);
    const errors = validatePlan(plan);

    if (errors.length > 0) {
      return res.status(422).json({
        error: 'Generated plan failed validation',
        validationErrors: errors,
        program
      });
    }

    res.json({
      ...plan,
      program
    });
  } catch (err) {
    console.error('GENERATE ERROR:', err.message);
    res.status(500).json({ error: err.message });
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
    const errors = validatePlan(revisedPlan);

    if (errors.length > 0) {
      return res.status(422).json({
        error: 'Revised plan failed validation',
        validationErrors: errors,
        program: revisedProgram
      });
    }

    res.json({
      ...revisedPlan,
      program: revisedProgram
    });
  } catch (err) {
    console.error('REVISE ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ArchAI backend running on port ${PORT}`);
});