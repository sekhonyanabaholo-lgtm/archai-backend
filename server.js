const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { jsonrepair } = require('jsonrepair');
const path = require('path');

const app = express();

const allowedOrigins = [
  'https://web-sandbox.oaiusercontent.com',
  'https://dashboard.salesflow.co.za',
  'https://www.dashboard.salesflow.co.za',
  'https://app.gohighlevel.com',
  'https://preview.msgsndr.com',
  'https://app.msgsndr.com'
];

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: false,
  optionsSuccessStatus: 204
};

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  } else {
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

app.use(cors(corsOptions));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GROQ_KEY = process.env.GROQ_KEY;
if (!GROQ_KEY) {
  throw new Error('Missing GROQ_KEY environment variable');
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function toBool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'room';
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function callGroq(messages, temperature = 0.2, maxTokens = 1600) {
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

function extractJsonBlock(textValue) {
  const cleaned = String(textValue || '')
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

const ROOM_SPECS = {
  bedroom: { w: 4.0, h: 3.7, zone: 'private', furniture: 'bed' },
  primary_bedroom: { w: 4.8, h: 4.3, zone: 'private', furniture: 'primary-bed' },
  bathroom: { w: 2.4, h: 2.6, zone: 'private', furniture: 'bath' },
  ensuite: { w: 2.3, h: 2.2, zone: 'private', furniture: 'bath' },
  closet: { w: 2.2, h: 2.0, zone: 'private', furniture: 'closet' },
  study: { w: 4.0, h: 3.2, zone: 'service', furniture: 'desk' },
  living: { w: 6.6, h: 5.0, zone: 'public', furniture: 'sofa' },
  dining: { w: 4.0, h: 3.0, zone: 'public', furniture: 'dining' },
  kitchen: { w: 5.0, h: 3.9, zone: 'public', furniture: 'kitchen' },
  pantry: { w: 2.2, h: 1.8, zone: 'service', furniture: 'counter' },
  scullery: { w: 2.8, h: 2.2, zone: 'service', furniture: 'counter' },
  laundry: { w: 3.0, h: 2.3, zone: 'service', furniture: 'laundry' },
  garage: { w: 6.2, h: 5.8, zone: 'service', furniture: 'car' },
  foyer: { w: 2.0, h: 2.3, zone: 'entry', furniture: 'entry' },
  entry: { w: 2.0, h: 2.3, zone: 'entry', furniture: 'entry' },
  hallway: { w: 1.6, h: 6.0, zone: 'circulation', furniture: 'hall' },
  patio: { w: 6.0, h: 2.0, zone: 'outdoor', furniture: 'outdoor' },
  garden: { w: 12.0, h: 2.8, zone: 'outdoor', furniture: 'garden' },
  wc: { w: 1.8, h: 1.8, zone: 'service', furniture: 'bath' },
  service: { w: 2.6, h: 2.2, zone: 'service', furniture: 'counter' }
};

function defaultRoomSpec(type) {
  const spec = ROOM_SPECS[type] || ROOM_SPECS.service;
  return { ...spec };
}

function normalizeRoom(room, index) {
  const requestedType = slugify(room?.type || room?.name || `room-${index}`).replace(/-/g, '_');
  const canonicalType = ROOM_SPECS[requestedType] ? requestedType : (
    requestedType.includes('primary') || requestedType.includes('master') ? 'primary_bedroom' :
    requestedType.includes('bed') ? 'bedroom' :
    requestedType.includes('ensuite') ? 'ensuite' :
    requestedType.includes('bath') ? 'bathroom' :
    requestedType.includes('closet') || requestedType.includes('wardrobe') ? 'closet' :
    requestedType.includes('living') || requestedType.includes('lounge') ? 'living' :
    requestedType.includes('dining') ? 'dining' :
    requestedType.includes('kitchen') ? 'kitchen' :
    requestedType.includes('laundry') ? 'laundry' :
    requestedType.includes('scullery') ? 'scullery' :
    requestedType.includes('pantry') ? 'pantry' :
    requestedType.includes('garage') ? 'garage' :
    requestedType.includes('study') || requestedType.includes('office') ? 'study' :
    requestedType.includes('foyer') || requestedType.includes('entry') ? 'foyer' :
    requestedType.includes('patio') ? 'patio' :
    requestedType.includes('garden') ? 'garden' :
    'service'
  );

  const spec = defaultRoomSpec(canonicalType);
  const width = clamp(Number(room?.width || spec.w), 1.6, 8.5);
  const height = clamp(Number(room?.height || spec.h), 1.6, 8.5);
  const zone = text(room?.zone, spec.zone);
  const label = text(room?.name, canonicalType.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));

  return {
    id: text(room?.id, `r${index + 1}`),
    name: label,
    type: canonicalType,
    zone,
    width,
    height,
    priority: clamp(Number(room?.priority || index + 1), 1, 50),
    preferredSide: text(room?.preferredSide, ''),
    adjacentTo: Array.isArray(room?.adjacentTo) ? room.adjacentTo.map(v => text(v)).filter(Boolean) : [],
    separatedFrom: Array.isArray(room?.separatedFrom) ? room.separatedFrom.map(v => text(v)).filter(Boolean) : [],
    furniture: spec.furniture
  };
}

function countByType(rooms, type) {
  return rooms.filter(r => r.type === type).length;
}

function ensureMinimumRooms(rooms, schema) {
  const output = [...rooms];

  if (!output.some(r => r.type === 'living')) output.push(normalizeRoom({ type: 'living', name: 'Living room' }, output.length));
  if (!output.some(r => r.type === 'kitchen')) output.push(normalizeRoom({ type: 'kitchen', name: 'Kitchen' }, output.length));
  if (schema.dining !== false && !output.some(r => r.type === 'dining')) output.push(normalizeRoom({ type: 'dining', name: 'Dining' }, output.length));
  if (!output.some(r => r.type === 'foyer')) output.push(normalizeRoom({ type: 'foyer', name: 'Entry foyer', zone: 'entry' }, output.length));
  if (!output.some(r => r.type === 'patio') && schema.patio !== false) output.push(normalizeRoom({ type: 'patio', name: 'Covered patio', zone: 'outdoor' }, output.length));
  if (!output.some(r => r.type === 'garden')) output.push(normalizeRoom({ type: 'garden', name: 'Garden', zone: 'outdoor' }, output.length));

  const targetBedrooms = clamp(Number(schema.bedrooms || 3), 1, 6);
  if (!output.some(r => r.type === 'primary_bedroom')) {
    output.push(normalizeRoom({ type: 'primary_bedroom', name: 'Primary bedroom', zone: 'private' }, output.length));
  }
  let currentBedrooms = countByType(output, 'bedroom') + countByType(output, 'primary_bedroom');
  while (currentBedrooms < targetBedrooms) {
    output.push(normalizeRoom({ type: 'bedroom', name: `Bedroom ${currentBedrooms + 1}`, zone: 'private' }, output.length));
    currentBedrooms += 1;
  }

  const targetBathrooms = clamp(Number(schema.bathrooms || 2), 1, 5);
  let currentBaths = countByType(output, 'bathroom') + countByType(output, 'ensuite');
  if (schema.masterEnsuite !== false && !output.some(r => r.type === 'ensuite')) {
    output.push(normalizeRoom({ type: 'ensuite', name: 'En-suite', zone: 'private' }, output.length));
    currentBaths += 1;
  }
  while (currentBaths < targetBathrooms) {
    output.push(normalizeRoom({ type: 'bathroom', name: currentBaths === 0 ? 'Bathroom' : `Bathroom ${currentBaths + 1}`, zone: 'private' }, output.length));
    currentBaths += 1;
  }

  if (schema.study && !output.some(r => r.type === 'study')) output.push(normalizeRoom({ type: 'study', name: 'Study', zone: 'service' }, output.length));
  if (schema.garage && !output.some(r => r.type === 'garage')) output.push(normalizeRoom({ type: 'garage', name: 'Garage', zone: 'service' }, output.length));
  if (schema.laundry && !output.some(r => r.type === 'laundry')) output.push(normalizeRoom({ type: 'laundry', name: 'Laundry', zone: 'service' }, output.length));
  if (schema.scullery && !output.some(r => r.type === 'scullery')) output.push(normalizeRoom({ type: 'scullery', name: 'Scullery', zone: 'service' }, output.length));
  if (schema.walkInCloset && !output.some(r => r.type === 'closet')) output.push(normalizeRoom({ type: 'closet', name: 'Walk-in closet', zone: 'private' }, output.length));

  return output;
}

function normalizeSchema(schema) {
  const base = schema || {};
  const rooms = Array.isArray(base.rooms) ? base.rooms.map(normalizeRoom) : [];
  const normalized = {
    title: text(base.title, 'Custom Family Home'),
    style: text(base.style, 'modern'),
    floors: clamp(Number(base.floors || 1), 1, 2),
    bedrooms: clamp(Number(base.bedrooms || 3), 1, 6),
    bathrooms: clamp(Number(base.bathrooms || 2), 1, 5),
    garage: toBool(base.garage, true),
    study: toBool(base.study, false),
    patio: toBool(base.patio, true),
    laundry: toBool(base.laundry, true),
    scullery: toBool(base.scullery, false),
    dining: toBool(base.dining, true),
    lounge: toBool(base.lounge, true),
    walkInCloset: toBool(base.walkInCloset, false),
    masterEnsuite: toBool(base.masterEnsuite, true),
    priorities: Array.isArray(base.priorities) ? base.priorities.map(v => text(v)).filter(Boolean).slice(0, 8) : ['good flow', 'natural light', 'practical storage'],
    notes: text(base.notes),
    adjacencyNotes: Array.isArray(base.adjacencyNotes) ? base.adjacencyNotes.map(v => text(v)).filter(Boolean) : [],
    zoning: {
      publicSide: text(base?.zoning?.publicSide, 'center'),
      privateSide: text(base?.zoning?.privateSide, 'left'),
      serviceSide: text(base?.zoning?.serviceSide, 'right'),
      outdoorSide: text(base?.zoning?.outdoorSide, 'top'),
      entrySide: text(base?.zoning?.entrySide, 'bottom')
    },
    rooms: []
  };

  normalized.rooms = ensureMinimumRooms(rooms, normalized)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

  return normalized;
}

async function generateSchema(description) {
  const prompt = `You are an expert residential architect.

Return a clean JSON floor-plan schema for a family house.
The schema should describe the design logic, not final SVG coordinates.

Return JSON only in this exact shape:
{
  "title": "string",
  "style": "modern|contemporary|minimal|classic|farmhouse|luxury|scandinavian",
  "floors": 1,
  "bedrooms": 4,
  "bathrooms": 2,
  "garage": true,
  "study": false,
  "patio": true,
  "laundry": true,
  "scullery": false,
  "dining": true,
  "lounge": true,
  "walkInCloset": false,
  "masterEnsuite": true,
  "priorities": ["string"],
  "notes": "string",
  "zoning": {
    "publicSide": "center|left|right",
    "privateSide": "left|right|rear",
    "serviceSide": "left|right|rear",
    "outdoorSide": "top|rear|left|right",
    "entrySide": "bottom|left|right"
  },
  "adjacencyNotes": ["string"],
  "rooms": [
    {
      "id": "living",
      "name": "Living room",
      "type": "living|dining|kitchen|primary_bedroom|bedroom|bathroom|ensuite|closet|study|garage|laundry|scullery|foyer|patio|garden",
      "zone": "public|private|service|entry|outdoor",
      "width": 4.5,
      "height": 3.8,
      "priority": 1,
      "preferredSide": "left|right|center|top|bottom",
      "adjacentTo": ["kitchen"],
      "separatedFrom": ["garage"]
    }
  ]
}

Rules:
- Make the design realistic for a family house
- Keep room sizes practical
- Put living, dining and kitchen near each other
- Put patio next to living or dining
- Put bedrooms in a coherent private zone
- Put garage near service spaces
- Put foyer near the front entry and main circulation
- Do not output coordinates
- Do not use markdown

USER REQUEST:
${description}`;

  const raw = await callGroq([
    { role: 'system', content: 'You design residential floor-plan schemas and return only JSON.' },
    { role: 'user', content: prompt }
  ], 0.15, 1400);

  return normalizeSchema(await parseJsonWithRepair(raw));
}

async function reviseSchema(currentSchema, revisionRequest) {
  const prompt = `You are revising a residential floor-plan schema.

CURRENT SCHEMA:
${JSON.stringify(currentSchema, null, 2)}

REVISION REQUEST:
${revisionRequest}

Return updated JSON only in the same exact schema shape.
Do not output coordinates.
Keep the design realistic.`;

  const raw = await callGroq([
    { role: 'system', content: 'You revise residential floor-plan schemas and return only JSON.' },
    { role: 'user', content: prompt }
  ], 0.15, 1400);

  return normalizeSchema(await parseJsonWithRepair(raw));
}

function room(name, type, x, y, w, h, meta = {}) {
  return { name, type, x, y, w, h, ...meta };
}

function getBounds(rooms) {
  return rooms.reduce((acc, r) => {
    acc.right = Math.max(acc.right, r.x + r.w);
    acc.bottom = Math.max(acc.bottom, r.y + r.h);
    acc.left = Math.min(acc.left, r.x);
    acc.top = Math.min(acc.top, r.y);
    return acc;
  }, { left: 0, top: 0, right: 0, bottom: 0 });
}

function summarizePlan(program, rooms) {
  const interiorRooms = rooms.filter(r => !['garden', 'patio'].includes(r.type));
  const area = interiorRooms.reduce((sum, r) => sum + (r.w * r.h), 0);
  return {
    title: program.title,
    bedrooms: program.bedrooms,
    bathrooms: program.bathrooms,
    estimatedArea: `${Math.round(area)} m²`,
    style: program.style,
    floors: program.floors
  };
}

function generateOpenings(rooms) {
  const windows = [];
  const doors = [];

  rooms.forEach(r => {
    if (['garden', 'patio', 'garage'].includes(r.type)) return;

    if (r.type === 'living') {
      windows.push({ x1: r.x + 0.8, y1: r.y, x2: r.x + r.w - 0.8, y2: r.y });
      doors.push({ x: r.x + r.w / 2, y: r.y, side: 'top', swing: 'out' });
    }

    if (r.type === 'bedroom') {
      windows.push({ x1: r.x, y1: r.y + 0.7, x2: r.x, y2: r.y + r.h - 0.7 });
      doors.push({ x: r.x + r.w, y: r.y + r.h - 0.8, side: 'right', swing: 'in' });
    }

    if (r.type === 'bathroom' || r.type === 'closet') {
      windows.push({ x1: r.x + r.w / 2 - 0.45, y1: r.y, x2: r.x + r.w / 2 + 0.45, y2: r.y });
      doors.push({ x: r.x, y: r.y + r.h / 2, side: 'left', swing: 'in' });
    }

    if (r.type === 'kitchen') {
      windows.push({ x1: r.x + 0.8, y1: r.y + r.h, x2: r.x + r.w - 0.8, y2: r.y + r.h });
      doors.push({ x: r.x + 0.9, y: r.y, side: 'top', swing: 'in' });
    }

    if (r.type === 'dining') {
      doors.push({ x: r.x + r.w / 2, y: r.y, side: 'top', swing: 'in' });
    }

    if (r.type === 'study') {
      windows.push({ x1: r.x + r.w, y1: r.y + 0.6, x2: r.x + r.w, y2: r.y + r.h - 0.6 });
      doors.push({ x: r.x, y: r.y + r.h / 2, side: 'left', swing: 'in' });
    }

    if (r.type === 'entry') {
      doors.push({ x: r.x, y: r.y + r.h / 2, side: 'left', swing: 'out', main: true });
    }
  });

  const garage = rooms.find(r => r.type === 'garage');
  if (garage) {
    doors.push({ x: garage.x + garage.w / 2, y: garage.y + garage.h, side: 'bottom', swing: 'out', garage: true });
  }

  return { windows, doors };
}

function placePrivateRooms(schema) {
  const privateRooms = schema.rooms.filter(r => r.zone === 'private' && ['primary_bedroom', 'bedroom', 'bathroom', 'ensuite', 'closet'].includes(r.type));
  const bedrooms = privateRooms.filter(r => r.type === 'primary_bedroom' || r.type === 'bedroom');
  const others = privateRooms.filter(r => !bedrooms.includes(r));

  const rooms = [];
  let y = 0;
  const gutter = 0.28;
  const hallW = bedrooms.length >= 4 ? 1.45 : 1.3;
  const bedroomColumnW = Math.max(...bedrooms.map(r => r.width), 4.0);
  const bathColumnW = others.length ? Math.max(...others.map(r => r.width), 2.2) : 0;

  const primary = bedrooms.find(r => r.type === 'primary_bedroom');
  const secondaries = bedrooms.filter(r => r !== primary);

  if (primary) {
    rooms.push(room(primary.name, 'bedroom', 0, y, primary.width, primary.height, { sourceId: primary.id, furniture: primary.furniture }));
    let sideY = y;
    const ensuite = others.find(r => r.type === 'ensuite');
    const closet = others.find(r => r.type === 'closet');
    if (ensuite) {
      rooms.push(room(ensuite.name, 'bathroom', bedroomColumnW + hallW, sideY, ensuite.width, ensuite.height, { sourceId: ensuite.id, furniture: ensuite.furniture }));
      sideY += ensuite.height + gutter;
    }
    if (closet) {
      rooms.push(room(closet.name, 'closet', bedroomColumnW + hallW, sideY, closet.width, closet.height, { sourceId: closet.id, furniture: closet.furniture }));
    }
    y += primary.height + gutter;
  }

  secondaries.forEach((bed) => {
    rooms.push(room(bed.name, 'bedroom', 0, y, bed.width, bed.height, { sourceId: bed.id, furniture: bed.furniture }));
    y += bed.height + gutter;
  });

  const remainingBaths = others.filter(r => r.type === 'bathroom');
  let bathY = primary ? primary.height + 0.8 : 0.8;
  remainingBaths.forEach((bath, idx) => {
    rooms.push(room(bath.name, 'bathroom', bedroomColumnW + hallW, bathY, bath.width, bath.height, { sourceId: bath.id, furniture: bath.furniture }));
    bathY += bath.height + (idx === 0 ? 0.9 : gutter);
  });

  const hallHeight = Math.max(y - gutter, bathY);
  rooms.push(room('Bedroom hall', 'hall', bedroomColumnW, 0, hallW, Math.max(7.2, hallHeight), { furniture: 'hall' }));

  return { rooms, width: bedroomColumnW + hallW + bathColumnW, height: Math.max(hallHeight, bathY) };
}

function placePublicRooms(schema, privateBlock) {
  const living = schema.rooms.find(r => r.type === 'living');
  const dining = schema.rooms.find(r => r.type === 'dining');
  const kitchen = schema.rooms.find(r => r.type === 'kitchen');
  const foyer = schema.rooms.find(r => r.type === 'foyer' || r.type === 'entry');

  const startX = privateBlock.width + 0.25;
  const rooms = [];
  const livingW = living ? Math.max(living.width, 6.2) : 6.2;
  const livingH = living ? Math.max(living.height, 4.8) : 4.8;
  const diningW = dining ? Math.max(dining.width, 3.8) : 3.8;
  const diningH = dining ? Math.max(dining.height, 2.8) : 2.8;
  const kitchenW = kitchen ? Math.max(kitchen.width, 4.6) : 4.6;
  const kitchenH = kitchen ? Math.max(kitchen.height, 3.6) : 3.6;

  const publicW = Math.max(livingW, diningW + kitchenW + 0.2);
  rooms.push(room(living?.name || 'Living room', 'living', startX, 0, publicW, livingH, { sourceId: living?.id, furniture: 'sofa' }));

  const lowerY = livingH;
  if (dining) {
    rooms.push(room(dining.name, 'dining', startX, lowerY, diningW, diningH, { sourceId: dining.id, furniture: 'dining' }));
  }
  rooms.push(room(kitchen?.name || 'Kitchen', 'kitchen', startX + (dining ? diningW + 0.2 : 0), lowerY, kitchenW, kitchenH, { sourceId: kitchen?.id, furniture: 'kitchen' }));

  const publicBottom = lowerY + Math.max(dining ? diningH : 0, kitchenH);
  const foyerX = startX + 0.6;
  const foyerY = publicBottom + 0.9;
  rooms.push(room(foyer?.name || 'Entry foyer', 'entry', foyerX, foyerY, Math.max(foyer?.width || 1.9, 1.8), Math.max(foyer?.height || 2.2, 2.1), { sourceId: foyer?.id, furniture: 'entry' }));

  return { rooms, startX, width: publicW, height: foyerY + Math.max(foyer?.height || 2.2, 2.1) };
}

function placeServiceRooms(schema, publicBlock) {
  const serviceRooms = schema.rooms.filter(r => r.zone === 'service' && ['study', 'garage', 'laundry', 'scullery', 'pantry', 'wc'].includes(r.type));
  const study = serviceRooms.find(r => r.type === 'study');
  const garage = serviceRooms.find(r => r.type === 'garage');
  const utility = serviceRooms.filter(r => ['laundry', 'scullery', 'pantry', 'wc'].includes(r.type));

  const startX = publicBlock.startX + publicBlock.width + 0.25;
  const rooms = [];
  let y = 0;

  if (study) {
    rooms.push(room(study.name, 'study', startX, y, study.width, study.height, { sourceId: study.id, furniture: 'desk' }));
    y += study.height + 0.2;
  }
  if (garage) {
    rooms.push(room(garage.name, 'garage', startX, y, garage.width, garage.height, { sourceId: garage.id, furniture: 'car' }));
  }

  let utilityX = publicBlock.startX + 0.15;
  const utilityY = publicBlock.rooms.find(r => r.type === 'kitchen')?.y + (publicBlock.rooms.find(r => r.type === 'kitchen')?.h || 0) + 0.22;
  utility.forEach((u) => {
    rooms.push(room(u.name, u.type === 'pantry' ? 'service' : u.type, utilityX, utilityY, u.width, u.height, { sourceId: u.id, furniture: u.furniture }));
    utilityX += u.width + 0.18;
  });

  return { rooms, startX };
}

function placeOutdoorRooms(schema, houseBounds, publicBlock) {
  const patio = schema.rooms.find(r => r.type === 'patio');
  const garden = schema.rooms.find(r => r.type === 'garden');
  const rooms = [];

  if (patio) {
    rooms.push(room(patio.name, 'patio', publicBlock.startX + 0.5, -2.05, Math.min(Math.max(patio.width, 5.8), houseBounds.right - publicBlock.startX - 0.7), 1.8, { sourceId: patio.id, furniture: 'outdoor' }));
  }
  if (garden) {
    rooms.push(room(garden.name, 'garden', -0.35, -4.85, houseBounds.right + 0.7, 2.6, { sourceId: garden.id, furniture: 'garden' }));
  }

  return rooms;
}

function buildDynamicLayout(schema) {
  const privateBlock = placePrivateRooms(schema);
  const publicBlock = placePublicRooms(schema, privateBlock);
  const serviceBlock = placeServiceRooms(schema, publicBlock);

  const rooms = [
    ...privateBlock.rooms,
    ...publicBlock.rooms,
    ...serviceBlock.rooms
  ];

  const bounds = getBounds(rooms);
  rooms.push(...placeOutdoorRooms(schema, bounds, publicBlock));

  return {
    program: schema,
    rooms,
    openings: generateOpenings(rooms),
    summary: summarizePlan(schema, rooms)
  };
}

function roomFill(type) {
  if (type === 'garden') return '#dcead9';
  if (type === 'patio') return '#ece7db';
  if (type === 'garage') return '#edf1f5';
  if (type === 'bathroom') return '#eef7ff';
  if (type === 'kitchen') return '#faf5ec';
  if (type === 'living') return '#fbfaf6';
  if (type === 'dining') return '#fcf7ee';
  if (type === 'closet') return '#f6f6f7';
  if (type === 'study') return '#f7f3ff';
  if (type === 'hall') return '#f7f7f8';
  if (type === 'service') return '#f7fbfc';
  return '#ffffff';
}

function renderFurniture(roomItem, scale) {
  const x = roomItem.x * scale;
  const y = roomItem.y * scale;
  const w = roomItem.w * scale;
  const h = roomItem.h * scale;

  if (roomItem.furniture === 'bed' || roomItem.furniture === 'primary-bed') {
    const bw = Math.min(w - 26, roomItem.furniture === 'primary-bed' ? 92 : 80);
    const bh = roomItem.furniture === 'primary-bed' ? 54 : 46;
    return `<rect x="${x + 14}" y="${y + 14}" width="${bw}" height="${bh}" rx="10" fill="#f1f1f2" stroke="#6b7280" stroke-width="1.6"/><rect x="${x + 20}" y="${y + 20}" width="${bw - 12}" height="14" rx="5" fill="#dbdde2"/>`;
  }
  if (roomItem.furniture === 'sofa') {
    return `<rect x="${x + 18}" y="${y + 26}" width="${Math.min(114, w * 0.36)}" height="34" rx="10" fill="#ece9ff" stroke="#7c3aed" stroke-width="1.4"/><rect x="${x + 26}" y="${y + 68}" width="${Math.min(86, w * 0.25)}" height="28" rx="9" fill="#f7f5ff" stroke="#7c3aed" stroke-width="1.4"/><circle cx="${x + Math.min(156, w - 34)}" cy="${y + 62}" r="18" fill="#f5f5f4" stroke="#64748b" stroke-width="1.4"/>`;
  }
  if (roomItem.furniture === 'dining') {
    const tableW = Math.min(90, w - 38);
    const tableH = Math.min(40, h - 32);
    const tx = x + 18;
    const ty = y + 18;
    return `<rect x="${tx}" y="${ty}" width="${tableW}" height="${tableH}" rx="8" fill="#f5e8bf" stroke="#b45309" stroke-width="1.4"/><circle cx="${tx + 8}" cy="${ty - 6}" r="7" fill="#fff7ed" stroke="#b45309" stroke-width="1.2"/><circle cx="${tx + tableW + 8}" cy="${ty - 6}" r="7" fill="#fff7ed" stroke="#b45309" stroke-width="1.2"/><circle cx="${tx + 8}" cy="${ty + tableH + 6}" r="7" fill="#fff7ed" stroke="#b45309" stroke-width="1.2"/><circle cx="${tx + tableW + 8}" cy="${ty + tableH + 6}" r="7" fill="#fff7ed" stroke="#b45309" stroke-width="1.2"/>`;
  }
  if (roomItem.furniture === 'kitchen' || roomItem.furniture === 'counter') {
    return `<rect x="${x + 12}" y="${y + 12}" width="${w - 24}" height="14" rx="5" fill="#dfe3e8"/><rect x="${x + w - 36}" y="${y + 34}" width="18" height="${Math.max(26, h - 48)}" rx="5" fill="#dfe3e8"/><rect x="${x + 22}" y="${y + h - 30}" width="${Math.max(40, w * 0.24)}" height="18" rx="5" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.2"/>`;
  }
  if (roomItem.furniture === 'bath') {
    return `<rect x="${x + 12}" y="${y + 14}" width="38" height="20" rx="8" fill="#ffffff" stroke="#0ea5e9" stroke-width="1.3"/><circle cx="${x + w - 24}" cy="${y + 28}" r="11" fill="#ffffff" stroke="#0ea5e9" stroke-width="1.3"/><rect x="${x + 12}" y="${y + h - 28}" width="42" height="16" rx="5" fill="#ffffff" stroke="#0ea5e9" stroke-width="1.3"/>`;
  }
  if (roomItem.furniture === 'desk') {
    return `<rect x="${x + 18}" y="${y + 22}" width="${Math.max(62, w * 0.34)}" height="24" rx="7" fill="#ece9ff" stroke="#6366f1" stroke-width="1.3"/><rect x="${x + 28}" y="${y + 56}" width="22" height="22" rx="6" fill="#f8fafc" stroke="#6366f1" stroke-width="1.2"/>`;
  }
  if (roomItem.furniture === 'car') {
    return `<rect x="${x + 16}" y="${y + 18}" width="${w - 32}" height="${Math.min(70, h - 34)}" rx="16" fill="#dbe7f7" stroke="#2563eb" stroke-width="1.8"/><circle cx="${x + 40}" cy="${y + h - 18}" r="9" fill="#0f172a"/><circle cx="${x + w - 40}" cy="${y + h - 18}" r="9" fill="#0f172a"/>`;
  }
  if (roomItem.furniture === 'laundry') {
    return `<circle cx="${x + 28}" cy="${y + 26}" r="14" fill="#ffffff" stroke="#0f766e" stroke-width="1.3"/><rect x="${x + 50}" y="${y + 12}" width="26" height="26" rx="6" fill="#ffffff" stroke="#0f766e" stroke-width="1.3"/>`;
  }
  return '';
}

function renderDoor(door, scale) {
  const x = door.x * scale;
  const y = door.y * scale;
  const radius = door.garage ? 34 : 20;
  if (door.side === 'right') return `<path d="M ${x} ${y - radius} A ${radius} ${radius} 0 0 1 ${x - radius} ${y}" fill="none" stroke="#334155" stroke-width="1.5"/><line x1="${x}" y1="${y - radius}" x2="${x}" y2="${y}" stroke="#334155" stroke-width="2.2"/>`;
  if (door.side === 'left') return `<path d="M ${x} ${y} A ${radius} ${radius} 0 0 1 ${x + radius} ${y - radius}" fill="none" stroke="#334155" stroke-width="1.5"/><line x1="${x}" y1="${y}" x2="${x}" y2="${y - radius}" stroke="#334155" stroke-width="2.2"/>`;
  if (door.side === 'top') return `<path d="M ${x - radius} ${y} A ${radius} ${radius} 0 0 1 ${x} ${y + radius}" fill="none" stroke="#334155" stroke-width="1.5"/><line x1="${x - radius}" y1="${y}" x2="${x}" y2="${y}" stroke="#334155" stroke-width="2.2"/>`;
  return `<path d="M ${x} ${y - radius} A ${radius} ${radius} 0 0 0 ${x + radius} ${y}" fill="none" stroke="#334155" stroke-width="1.5"/><line x1="${x}" y1="${y}" x2="${x + radius}" y2="${y}" stroke="#334155" stroke-width="2.2"/>`;
}

function renderWindow(windowItem, scale) {
  return `<line x1="${windowItem.x1 * scale}" y1="${windowItem.y1 * scale}" x2="${windowItem.x2 * scale}" y2="${windowItem.y2 * scale}" stroke="#38bdf8" stroke-width="6" stroke-linecap="round"/>`;
}

function renderSvg(plan) {
  const scale = 36;
  const padding = 56;
  const bounds = getBounds(plan.rooms);
  const width = (bounds.right - bounds.left) * scale + padding * 2;
  const height = (bounds.bottom - bounds.top) * scale + padding * 2;
  const shiftX = padding / scale - bounds.left;
  const shiftY = padding / scale - bounds.top;

  const translated = plan.rooms.map(r => ({ ...r, x: r.x + shiftX, y: r.y + shiftY }));
  const translatedWindows = plan.openings.windows.map(w => ({ x1: w.x1 + shiftX, y1: w.y1 + shiftY, x2: w.x2 + shiftX, y2: w.y2 + shiftY }));
  const translatedDoors = plan.openings.doors.map(d => ({ ...d, x: d.x + shiftX, y: d.y + shiftY }));

  const roomSvg = translated.map(r => {
    const x = r.x * scale;
    const y = r.y * scale;
    const w = r.w * scale;
    const h = r.h * scale;
    const isOutdoor = ['garden', 'patio'].includes(r.type);
    const wallStroke = r.type === 'garden' ? '#9fb5ad' : '#111827';
    const strokeWidth = r.type === 'garden' ? 1.8 : 4.6;
    const dash = r.type === 'patio' ? '8 5' : '';
    const labelSize = isOutdoor ? 13 : 11;
    const titleSize = isOutdoor ? 14 : 12;
    const showArea = w > 90 && h > 45;
    const titleY = y + 22;

    return `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${isOutdoor ? 14 : 12}" fill="${roomFill(r.type)}" stroke="${wallStroke}" stroke-width="${strokeWidth}" ${dash ? `stroke-dasharray="${dash}"` : ''}/><text x="${x + 10}" y="${titleY}" font-size="${titleSize}" font-family="Inter, Arial, sans-serif" font-weight="700" fill="#0f172a">${escapeXml(r.name)}</text>${showArea ? `<text x="${x + 10}" y="${titleY + 16}" font-size="${labelSize}" font-family="Inter, Arial, sans-serif" fill="#64748b">${Math.round(r.w * r.h)} m²</text>` : ''}${renderFurniture(r, scale)}</g>`;
  }).join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}"><defs><filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#0f172a" flood-opacity="0.08"/></filter><pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse"><path d="M 24 0 L 0 0 0 24" fill="none" stroke="#edf0f3" stroke-width="1"/></pattern></defs><rect width="100%" height="100%" rx="28" fill="#f6f7f8"/><rect x="14" y="14" width="${Math.round(width - 28)}" height="${Math.round(height - 28)}" rx="26" fill="url(#grid)"/><g filter="url(#shadow)">${roomSvg}</g><g>${translatedWindows.map(w => renderWindow(w, scale)).join('')}${translatedDoors.map(d => renderDoor(d, scale)).join('')}</g><g><rect x="18" y="18" width="320" height="64" rx="16" fill="#ffffff" fill-opacity="0.96" stroke="#e5e7eb"/><text x="36" y="45" font-size="22" font-family="Inter, Arial, sans-serif" font-weight="800" fill="#0f172a">${escapeXml(plan.summary.title)}</text><text x="36" y="64" font-size="12" font-family="Inter, Arial, sans-serif" fill="#475569">${escapeXml(`${plan.summary.bedrooms} bed • ${plan.summary.bathrooms} bath • ${plan.summary.estimatedArea} • ${plan.summary.style}`)}</text><text x="36" y="78" font-size="10" font-family="Inter, Arial, sans-serif" fill="#94a3b8">Rendered floor plan preview</text></g></svg>`;

  return {
    svg,
    dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  };
}

async function buildPlanFromDescription(description) {
  const program = await generateSchema(description);
  const layout = buildDynamicLayout(program);
  const image = renderSvg(layout);
  return { ...layout, ...image };
}

async function buildPlanFromRevision(currentProgram, revisionRequest) {
  const program = await reviseSchema(currentProgram, revisionRequest);
  const layout = buildDynamicLayout(program);
  const image = renderSvg(layout);
  return { ...layout, ...image };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, app: 'archai-floorplan-renderer' });
});

app.get('/api/meta', (_req, res) => {
  res.json({ ok: true, features: ['generate-floor-plan-image', 'revise-floor-plan-image'], version: '3.0.0' });
});

app.post('/api/floor-plans/generate', async (req, res) => {
  const description = text(req.body?.description);
  if (!description) {
    return res.status(400).json({ error: 'Missing description' });
  }
  try {
    const plan = await buildPlanFromDescription(description);
    res.json({ ok: true, plan });
  } catch (err) {
    console.error('GENERATE ERROR:', err);
    res.status(500).json({ error: err?.message || 'Could not generate floor plan right now.' });
  }
});

app.post('/api/floor-plans/revise', async (req, res) => {
  const revisionRequest = text(req.body?.revisionRequest);
  const currentProgram = normalizeSchema(req.body?.currentProgram || req.body?.plan?.program || {});
  if (!revisionRequest) {
    return res.status(400).json({ error: 'Missing revisionRequest' });
  }
  try {
    const plan = await buildPlanFromRevision(currentProgram, revisionRequest);
    res.json({ ok: true, plan });
  } catch (err) {
    console.error('REVISE ERROR:', err);
    res.status(500).json({ error: err?.message || 'Could not revise floor plan right now.' });
  }
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ArchAI floor plan renderer running on port ${PORT}`);
});
