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

async function callGroq(messages, temperature = 0.2, maxTokens = 1800) {
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

function extractJson(text) {
  const cleaned = String(text).replace(/```json/gi, '').replace(/```/g, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in model response');
  return JSON.parse(match[0]);
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
  program.livingSpaces = Array.isArray(program.livingSpaces)
    ? program.livingSpaces
    : ['living', 'kitchen', 'dining'];
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
    if (x > 300) throw new Error('Could not place block to the right without overlap');
  }

  return shifted;
}

function placeBlockBelow(blockRooms, placedRooms, x, startY, gap = 2) {
  let y = startY;
  let shifted = shiftRooms(blockRooms, x, y);

  while (overlapsAny(shifted, placedRooms)) {
    y += gap;
    shifted = shiftRooms(blockRooms, x, y);
    if (y > 300) throw new Error('Could not place block below without overlap');
  }

  return shifted;
}

function maxRight(rooms) {
  return rooms.length ? Math.max(...rooms.map(r => r.x + r.w)) : 0;
}

function maxBottom(rooms) {
  return rooms.length ? Math.max(...rooms.map(r => r.y + r.h)) : 0;
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
  const livingArea = 30 + Math.max(0, program.beds - 3) * 3;
  const kitchenArea = 14 + Math.max(0, program.beds - 4);
  const diningArea = program.livingSpaces.includes('dining') ? 12 : 0;
  const garageArea = program.extras.includes('garage') ? 36 : 0;
  const studyArea = program.extras.includes('study') ? 10 : 0;
  const sculleryArea = program.extras.includes('scullery') ? 6 : 0;
  const laundryArea = program.extras.includes('laundry') ? 6 : 0;
  const circulationArea = Math.max(10, program.beds * 3);
  const patioArea = program.extras.includes('patio') ? 18 : 0;
  const total = bedArea + bathArea + livingArea + kitchenArea + diningArea + garageArea + studyArea + sculleryArea + laundryArea + circulationArea + patioArea;
  return `~${Math.round(floors === 2 ? total * 0.95 : total)}m²`;
}

/* =========================
   ARCHETYPE CHOICE
========================= */

function chooseStorey(program) {
  if (program.storeyPreference === 'single') return 'single';
  if (program.storeyPreference === 'double') return 'double';
  if (program.beds >= 7) return 'double';
  if (program.beds >= 6 && program.sizeBand !== 'large') return 'double';
  return 'single';
}

function chooseArchetype(program) {
  const storey = chooseStorey(program);

  if (storey === 'double') return 'double_central_core';
  if (program.beds <= 5) return 'single_central_great_room';
  return 'single_central_great_room_large';
}

function buildDescription(program, storey, archetype) {
  let base = storey === 'double'
    ? 'A double-storey family home'
    : 'A single-storey family home';

  if (archetype.includes('central')) {
    base += ' organised around a central shared living core';
  }

  return `${base} with independent bedroom access, clear zoning, and a more natural architectural flow.`;
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
      if (r.t === 'room' && !isTarget) continue;

      visited.add(next);
      queue.push(next);
    }
  }

  return false;
}

function validateIndependentAccessSingle(rooms) {
  const bedrooms = rooms.filter(r => r.t === 'room');
  const starts = rooms
    .filter(r => ['living', 'dining', 'kitchen', 'passage'].includes(r.t))
    .map(r => r.name);

  for (const bedroom of bedrooms) {
    if (!accessibleWithoutCrossingBedrooms(rooms, starts, bedroom.name)) {
      throw new Error(`${bedroom.name} does not have independent access`);
    }
  }
}

function validateIndependentAccessDouble(_ground, first) {
  const bedrooms = first.filter(r => r.t === 'room');
  const starts = first
    .filter(r => ['passage', 'stairs'].includes(r.t))
    .map(r => r.name);

  for (const bedroom of bedrooms) {
    if (!accessibleWithoutCrossingBedrooms(first, starts, bedroom.name)) {
      throw new Error(`${bedroom.name} does not have independent upstairs access`);
    }
  }
}

/* =========================
   ROOM BLOCK BUILDERS
========================= */

function buildFoyerBlock() {
  return [room('Foyer', 'passage', 0, 0, 4, 3)];
}

function buildGreatRoomBlock(program) {
  const w = program.beds >= 6 ? 8 : 7;
  const h = program.beds >= 6 ? 6 : 5;
  return [room('Great room', 'living', 0, 0, w, h)];
}

function buildKitchenDiningBlock(program) {
  const rooms = [];
  const kitchenW = program.beds >= 6 ? 6 : 5;
  const kitchenH = 4;

  rooms.push(room('Kitchen', 'kitchen', 0, 0, kitchenW, kitchenH));

  if (program.livingSpaces.includes('dining')) {
    rooms.push(room('Dining', 'dining', 0, kitchenH, kitchenW, 3));
  }

  if (program.extras.includes('scullery')) {
    rooms.push(room('Scullery', 'scullery', kitchenW, 0, 3, 2));
  }

  if (program.extras.includes('laundry')) {
    rooms.push(room('Laundry', 'laundry', kitchenW, 2, 3, 2));
  }

  return rooms;
}

function buildGarageServiceBlock(program) {
  const rooms = [];
  let y = 0;

  if (program.extras.includes('study')) {
    rooms.push(room('Study', 'study', 0, y, 4, 3));
    y += 3;
  }

  rooms.push(room('Guest bath', 'bathroom', 0, y, 3, 2));
  y += 2;

  if (program.extras.includes('garage')) {
    rooms.push(room('Garage', 'garage', 0, y, program.beds >= 6 ? 7 : 6, 6));
  }

  return rooms;
}

function buildMasterSuiteBlock(program) {
  const rooms = [];
  const masterW = program.notes?.premiumMainSuite ? 6 : 5;

  rooms.push(room('Master bed', 'room', 0, 0, masterW, 4));

  if (program.masterEnsuite) {
    rooms.push(room('En-suite', 'ensuite', masterW, 0, 3, 2));
    rooms.push(room('Master bath', 'bathroom', masterW, 2, 3, 2));
  }

  return rooms;
}

function buildSecondaryBedroomWing(program, count) {
  const rooms = [];
  let y = 0;

  for (let i = 0; i < count; i++) {
    rooms.push(room(`Bedroom ${i + 2}`, 'room', 0, y, 4, 3));
    y += 3;
  }

  const extraBaths = Math.max(1, program.baths - (program.masterEnsuite ? 1 : 0));
  for (let i = 0; i < extraBaths; i++) {
    rooms.push(room(i === 0 ? 'Main bath' : `Bathroom ${i + 1}`, 'bathroom', 4, i * 2, 3, 2));
  }

  return rooms;
}

function buildUpperBedroomCluster(program, names, includeMaster) {
  const rooms = [];
  let x = 0;

  names.forEach((name) => {
    if (/master/i.test(name) && includeMaster) {
      const masterW = program.notes?.premiumMainSuite ? 6 : 5;
      rooms.push(room(name, 'room', x, 0, masterW, 4));
      if (program.masterEnsuite) {
        rooms.push(room('En-suite', 'ensuite', x + masterW, 0, 3, 2));
        rooms.push(room('Master bath', 'bathroom', x + masterW, 2, 3, 2));
        x += masterW + 3;
      } else {
        x += masterW;
      }
    } else {
      rooms.push(room(name, 'room', x, 0, 4, 3));
      x += 4;
    }
  });

  return rooms;
}

/* =========================
   BUILDERS
========================= */

function buildSingleCentralGreatRoom(program) {
  const rooms = [];

  const foyer = buildFoyerBlock();
  const greatRoom = buildGreatRoomBlock(program);
  const kitchenDining = buildKitchenDiningBlock(program);
  const masterSuite = buildMasterSuiteBlock(program);
  const secondaryWing = buildSecondaryBedroomWing(program, Math.max(1, program.beds - 1));
  const garageService = buildGarageServiceBlock(program);

  rooms.push(...foyer);

  const greatPlaced = placeBlockBelow(greatRoom, rooms, 4, 0, 1);
  rooms.push(...greatPlaced);

  const kitchenPlaced = placeBlockToRight(kitchenDining, rooms, boundsOf(greatPlaced).right + 1, 0, 1);
  rooms.push(...kitchenPlaced);

  const masterPlaced = placeBlockToRight(masterSuite, rooms, boundsOf(greatPlaced).right + 2, boundsOf(greatPlaced).bottom + 1, 1);
  rooms.push(...masterPlaced);

  const secWingPlaced = placeBlockToRight(secondaryWing, rooms, 0, boundsOf(greatPlaced).bottom + 1, 1);
  rooms.push(...secWingPlaced);

  const servicePlaced = garageService.length
    ? placeBlockBelow(garageService, rooms, 0, boundsOf(secWingPlaced).bottom + 1, 1)
    : [];
  rooms.push(...servicePlaced);

  const connectorY = boundsOf(greatPlaced).bottom;
  const connectorWidth = Math.max(boundsOf(masterPlaced).right, boundsOf(secWingPlaced).right);
  rooms.push(room('Private connector', 'passage', 0, connectorY, connectorWidth, 2));

  const sideLinkX = boundsOf(greatPlaced).right - 1;
  const sideLinkY = 2;
  const sideLinkH = Math.max(3, boundsOf(masterPlaced).y - sideLinkY);
  rooms.push(room('Gallery', 'passage', sideLinkX, sideLinkY, 2, sideLinkH));

  const width = Math.max(maxRight(rooms), 18);
  const outdoorY = maxBottom(rooms);

  if (program.extras.includes('patio')) {
    rooms.push(room('Patio', 'patio', 0, outdoorY, width, 3));
  }
  if (program.extras.includes('garden')) {
    rooms.push(room('Garden', 'garden', 0, outdoorY + (program.extras.includes('patio') ? 3 : 0), width, 5));
  }

  return {
    storey: 'single',
    desc: buildDescription(program, 'single', 'single_central_great_room'),
    rooms,
    sum: {
      beds: countBedroomsFromRooms(rooms),
      baths: countBathroomsFromRooms(rooms),
      size: estimateHomeSize(program, 1),
      floors: 1
    }
  };
}

function buildSingleCentralGreatRoomLarge(program) {
  const rooms = [];

  const foyer = buildFoyerBlock();
  const greatRoom = buildGreatRoomBlock(program);
  const kitchenDining = buildKitchenDiningBlock(program);
  const masterSuite = buildMasterSuiteBlock(program);
  const garageService = buildGarageServiceBlock(program);

  const secondaryNamesA = [];
  const secondaryNamesB = [];

  for (let i = 2; i <= program.beds; i++) {
    if (i % 2 === 0) secondaryNamesA.push(`Bedroom ${i}`);
    else secondaryNamesB.push(`Bedroom ${i}`);
  }

  const wingA = buildSecondaryBedroomWing(
    { ...program, baths: Math.max(1, Math.ceil((program.baths - (program.masterEnsuite ? 1 : 0)) / 2)) },
    secondaryNamesA.length
  );

  const wingB = buildSecondaryBedroomWing(
    { ...program, baths: Math.max(1, Math.floor((program.baths - (program.masterEnsuite ? 1 : 0)) / 2) || 1) },
    secondaryNamesB.length
  );

  rooms.push(...foyer);

  const greatPlaced = placeBlockBelow(greatRoom, rooms, 5, 0, 1);
  rooms.push(...greatPlaced);

  const kitchenPlaced = placeBlockToRight(kitchenDining, rooms, boundsOf(greatPlaced).right + 1, 0, 1);
  rooms.push(...kitchenPlaced);

  const wingAPlaced = placeBlockBelow(wingA, rooms, 0, boundsOf(greatPlaced).bottom + 2, 1);
  rooms.push(...wingAPlaced);

  const masterPlaced = placeBlockToRight(masterSuite, rooms, boundsOf(greatPlaced).right + 2, boundsOf(greatPlaced).bottom + 2, 1);
  rooms.push(...masterPlaced);

  const wingBPlaced = placeBlockBelow(wingB, rooms, boundsOf(masterPlaced).right + 2, boundsOf(greatPlaced).bottom + 2, 1);
  rooms.push(...wingBPlaced);

  const servicePlaced = garageService.length
    ? placeBlockBelow(
        garageService,
        rooms,
        0,
        Math.max(boundsOf(wingAPlaced).bottom, boundsOf(masterPlaced).bottom, boundsOf(wingBPlaced).bottom) + 1,
        1
      )
    : [];
  rooms.push(...servicePlaced);

  const hallY = boundsOf(greatPlaced).bottom;
  const hallW = Math.max(boundsOf(wingBPlaced).right, boundsOf(masterPlaced).right);
  rooms.push(room('Private hall', 'passage', 0, hallY, hallW, 2));

  const centralSpineX = boundsOf(greatPlaced).x + 2;
  rooms.push(room('Link hall', 'passage', centralSpineX, 2, 2, hallY));

  const width = Math.max(maxRight(rooms), 24);
  const outdoorY = maxBottom(rooms);

  if (program.extras.includes('patio')) {
    rooms.push(room('Patio', 'patio', 0, outdoorY, width, 3));
  }
  if (program.extras.includes('garden')) {
    rooms.push(room('Garden', 'garden', 0, outdoorY + (program.extras.includes('patio') ? 3 : 0), width, 5));
  }

  return {
    storey: 'single',
    desc: buildDescription(program, 'single', 'single_central_great_room_large'),
    rooms,
    sum: {
      beds: countBedroomsFromRooms(rooms),
      baths: countBathroomsFromRooms(rooms),
      size: estimateHomeSize(program, 1),
      floors: 1
    }
  };
}

function buildDoubleCentralCore(program) {
  const ground = [];
  const first = [];

  const foyer = buildFoyerBlock();
  const greatRoom = buildGreatRoomBlock(program);
  const kitchenDining = buildKitchenDiningBlock(program);
  const garageService = buildGarageServiceBlock(program);

  ground.push(...foyer);

  const greatPlaced = placeBlockBelow(greatRoom, ground, 4, 0, 1);
  ground.push(...greatPlaced);

  const kitchenPlaced = placeBlockToRight(kitchenDining, ground, boundsOf(greatPlaced).right + 1, 0, 1);
  ground.push(...kitchenPlaced);

  const greatBounds = boundsOf(greatPlaced);
  const kitchenBounds = boundsOf(kitchenPlaced);
  const stairX = Math.max(greatBounds.right + 1, kitchenBounds.x + 1);
  const stairY = greatBounds.bottom + 1;

  ground.push(room('Stairs', 'stairs', stairX, stairY, 2, 3));
  ground.push(room('Powder', 'bathroom', stairX + 2, stairY, 3, 2));

  const servicePlaced = garageService.length
    ? placeBlockBelow(garageService, ground, 0, Math.max(greatBounds.bottom, stairY + 3) + 1, 1)
    : [];
  ground.push(...servicePlaced);

  const groundWidth = Math.max(maxRight(ground), 18);
  if (program.extras.includes('patio')) {
    ground.push(room('Patio', 'patio', 0, maxBottom(ground), groundWidth, 3));
  }
  if (program.extras.includes('garden')) {
    ground.push(room('Garden', 'garden', 0, maxBottom(ground), groundWidth, 5));
  }

  first.push(room('Landing', 'passage', 6, 0, 4, 2));
  first.push(room('Stairs', 'stairs', 6, 2, 2, 3));
  first.push(room('Upper hall', 'passage', 2, 5, 14, 2));

  const names = ['Master bed'];
  for (let i = 2; i <= program.beds; i++) names.push(`Bedroom ${i}`);

  const leftNames = [];
  const rightNames = [];

  names.forEach((name, i) => {
    if (i === 0 || i % 2 === 0) rightNames.push(name);
    else leftNames.push(name);
  });

  const leftBlock = buildUpperBedroomCluster(program, leftNames, false);
  const rightBlock = buildUpperBedroomCluster(program, rightNames, true);

  const leftPlaced = placeBlockBelow(leftBlock, first, 0, 7, 1);
  first.push(...leftPlaced);

  const rightPlaced = placeBlockToRight(rightBlock, first, 10, 7, 1);
  first.push(...rightPlaced);

  const bathsNeeded = Math.max(1, program.baths - (program.masterEnsuite ? 1 : 0) - 1);
  const bathBlock = [];
  for (let i = 0; i < bathsNeeded; i++) {
    bathBlock.push(room(i === 0 ? 'Main bath' : `Bathroom ${i + 1}`, 'bathroom', i * 3, 0, 3, 2));
  }

  const bathsPlaced = placeBlockBelow(
    bathBlock,
    first,
    6,
    Math.max(boundsOf(leftPlaced).bottom, boundsOf(rightPlaced).bottom) + 1,
    1
  );
  first.push(...bathsPlaced);

  return {
    storey: 'double',
    desc: buildDescription(program, 'double', 'double_central_core'),
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
   OPENINGS
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
   VALIDATION + REPAIR
========================= */

function getAllRooms(plan) {
  return plan.storey === 'double'
    ? [...(plan.ground || []), ...(plan.first || [])]
    : (plan.rooms || []);
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

function validateNoOverlap(rooms) {
  const overlap = findFirstOverlap(rooms);
  if (overlap) {
    throw new Error(
      `Overlap detected between "${overlap.a.name}" (${overlap.a.x},${overlap.a.y},${overlap.a.w},${overlap.a.h}) and "${overlap.b.name}" (${overlap.b.x},${overlap.b.y},${overlap.b.w},${overlap.b.h})`
    );
  }
}

function validatePlan(plan) {
  const errors = [];

  if (!plan || typeof plan !== 'object') errors.push('Plan is invalid');
  if (!plan.desc || typeof plan.desc !== 'string') errors.push('Missing description');
  if (!plan.sum || typeof plan.sum !== 'object') errors.push('Missing summary');
  if (!plan.storey) errors.push('Missing storey');

  const allRooms = getAllRooms(plan);

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

  if (plan.doors && !Array.isArray(plan.doors)) errors.push('Doors must be an array');
  if (plan.windows && !Array.isArray(plan.windows)) errors.push('Windows must be an array');

  return errors;
}

function roomPriority(t) {
  const priorities = {
    garden: 100,
    patio: 90,
    passage: 80,
    bathroom: 70,
    ensuite: 65,
    laundry: 60,
    scullery: 58,
    study: 55,
    garage: 50,
    stairs: 45,
    kitchen: 40,
    dining: 35,
    living: 30,
    room: 20
  };
  return priorities[t] ?? 10;
}

function fixOverlapsOnFloor(rooms) {
  let working = rooms.map(r => ({ ...r }));
  let safety = 0;

  while (safety < 60) {
    const overlap = findFirstOverlap(working);
    if (!overlap) return working;

    const { a, b } = overlap;
    const moveA = roomPriority(a.t) > roomPriority(b.t);

    const blocker = moveA ? b : a;
    const target = moveA ? a : b;
    const idx = working.findIndex(r => r.name === target.name);

    const overlapWidth = Math.min(target.x + target.w, blocker.x + blocker.w) - Math.max(target.x, blocker.x);
    const overlapHeight = Math.min(target.y + target.h, blocker.y + blocker.h) - Math.max(target.y, blocker.y);

    if (overlapHeight >= overlapWidth) {
      working[idx] = { ...target, y: blocker.y + blocker.h + 1 };
    } else {
      working[idx] = { ...target, x: blocker.x + blocker.w + 1 };
    }

    safety++;
  }

  throw new Error('Code repair could not resolve overlaps');
}

function codeBasedRepair(plan) {
  const clone = JSON.parse(JSON.stringify(plan));

  if (clone.storey === 'double') {
    clone.ground = fixOverlapsOnFloor(clone.ground || []);
    clone.first = fixOverlapsOnFloor(clone.first || []);
  } else {
    clone.rooms = fixOverlapsOnFloor(clone.rooms || []);
  }

  return clone;
}

async function repairPlanWithAI({ description, program, plan, errors }) {
  const prompt = `You are correcting a floor plan JSON.

ORIGINAL CLIENT DESCRIPTION:
${description}

PROGRAM:
${JSON.stringify(program, null, 2)}

BROKEN PLAN:
${JSON.stringify(plan, null, 2)}

VALIDATION ERRORS:
${errors.map((e, i) => `${i + 1}. ${e}`).join('\n')}

Your task:
- Fix the plan
- Keep the same overall design intent
- Do not remove required rooms
- Do not change the storey unless absolutely necessary
- Resolve overlaps and access issues
- Keep room types the same
- Use whole-number coordinates and dimensions
- Return only valid JSON
- Return no markdown
- Return no explanation

If single storey, return:
{
  "storey": "single",
  "desc": "...",
  "rooms": [...],
  "sum": {"beds": 4, "baths": 3, "size": "~220m²", "floors": 1}
}

If double storey, return:
{
  "storey": "double",
  "desc": "...",
  "ground": [...],
  "first": [...],
  "sum": {"beds": 6, "baths": 4, "size": "~320m²", "floors": 2}
}`;

  const text = await callGroq([{ role: 'user', content: prompt }], 0.1, 2200);
  return extractJson(text);
}

/* =========================
   MAIN BUILD FLOW
========================= */

function buildBasePlanFromArchetype(program) {
  const archetype = chooseArchetype(program);

  if (archetype === 'single_central_great_room') return buildSingleCentralGreatRoom(program);
  if (archetype === 'single_central_great_room_large') return buildSingleCentralGreatRoomLarge(program);
  if (archetype === 'double_central_core') return buildDoubleCentralCore(program);

  throw new Error(`Unknown archetype: ${archetype}`);
}

function withFreshDoorsAndWindows(plan) {
  return attachDoorsAndWindows({
    ...plan,
    doors: [],
    windows: []
  });
}

async function buildPlanWithRepair(fullContext, program) {
  let plan = withFreshDoorsAndWindows(buildBasePlanFromArchetype(program));
  let errors = validatePlan(plan);

  if (errors.length === 0) return plan;

  try {
    plan = withFreshDoorsAndWindows(codeBasedRepair(plan));
    errors = validatePlan(plan);
    if (errors.length === 0) return plan;
  } catch (_err) {
    // continue to AI repair
  }

  let attempts = 0;
  while (errors.length > 0 && attempts < 2) {
    const repaired = await repairPlanWithAI({
      description: fullContext,
      program,
      plan,
      errors
    });

    plan = withFreshDoorsAndWindows(repaired);
    errors = validatePlan(plan);
    attempts++;
  }

  if (errors.length > 0) {
    throw new Error(`Plan failed after repair attempts: ${errors.join(' | ')}`);
  }

  return plan;
}

/* =========================
   ROUTES
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
    res.status(500).json({ error: 'Could not generate clarifying questions right now.' });
  }
});

app.post('/generate', async (req, res) => {
  const { description, answers, style, size } = req.body;
  const fullContext = `Original description: ${description}\nClient answers: ${answers}`;

  try {
    const program = await generateProgram(fullContext, style, size);
    const plan = await buildPlanWithRepair(fullContext, program);

    res.json({
      ...plan,
      program
    });
  } catch (err) {
    console.error('GENERATE ERROR:', err.message);
    res.status(500).json({ error: 'Could not generate a valid floor plan right now.' });
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
    const revisedPlan = await buildPlanWithRepair(description || '', revisedProgram);

    res.json({
      ...revisedPlan,
      program: revisedProgram
    });
  } catch (err) {
    console.error('REVISE ERROR:', err.message);
    res.status(500).json({ error: 'Could not revise the floor plan right now.' });
  }
});

/* =========================
   START
========================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ArchAI backend running on port ${PORT}`);
});