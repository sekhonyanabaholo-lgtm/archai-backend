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

const DEFAULT_PROGRAM = {
  style: 'modern',
  floors: 1,
  bedrooms: 3,
  bathrooms: 2,
  garage: true,
  study: false,
  patio: true,
  laundry: true,
  scullery: false,
  dining: true,
  lounge: true,
  walkInCloset: false,
  masterEnsuite: true,
  priorities: ['good flow', 'natural light', 'practical storage']
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function toBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function callGroq(messages, temperature = 0.2, maxTokens = 1200) {
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

function normalizeProgram(program) {
  const p = program || {};
  return {
    title: text(p.title, 'Custom Family Home'),
    style: text(p.style, 'modern'),
    floors: clamp(Number(p.floors || 1), 1, 2),
    bedrooms: clamp(Number(p.bedrooms || 3), 1, 6),
    bathrooms: clamp(Number(p.bathrooms || 2), 1, 5),
    garage: toBool(p.garage, true),
    study: toBool(p.study, false),
    patio: toBool(p.patio, true),
    laundry: toBool(p.laundry, true),
    scullery: toBool(p.scullery, false),
    dining: toBool(p.dining, true),
    lounge: toBool(p.lounge, true),
    walkInCloset: toBool(p.walkInCloset, false),
    masterEnsuite: toBool(p.masterEnsuite, true),
    priorities: Array.isArray(p.priorities) ? p.priorities.map(x => text(x)).filter(Boolean).slice(0, 8) : DEFAULT_PROGRAM.priorities,
    notes: text(p.notes),
    imageMood: text(p.imageMood, 'clean rendered architectural floor plan')
  };
}

async function generateProgram(description) {
  const prompt = `You are an expert residential architect.

Convert the user's plain-English request into a practical residential brief.

Return JSON only in this exact shape:
{
  "title": "string",
  "style": "modern|contemporary|minimal|classic|farmhouse|luxury|scandinavian",
  "floors": 1,
  "bedrooms": 3,
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
  "imageMood": "string"
}

Interpret vague requests intelligently.
Prefer realistic family-home defaults.
Do not include coordinates.
Do not include markdown.

USER REQUEST:
${description}`;

  const raw = await callGroq([
    { role: 'system', content: 'You turn housing requests into clean architectural JSON briefs.' },
    { role: 'user', content: prompt }
  ], 0.1, 700);

  return normalizeProgram(await parseJsonWithRepair(raw));
}

async function reviseProgram(currentProgram, revisionRequest) {
  const prompt = `You are revising a house design brief.

CURRENT PROGRAM:
${JSON.stringify(currentProgram, null, 2)}

REVISION REQUEST:
${revisionRequest}

Return updated JSON only in the same exact structure.
Keep the house coherent and realistic.`;

  const raw = await callGroq([
    { role: 'system', content: 'You revise residential architectural briefs and return only JSON.' },
    { role: 'user', content: prompt }
  ], 0.1, 700);

  return normalizeProgram(await parseJsonWithRepair(raw));
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
      windows.push({ x1: r.x + 1.0, y1: r.y, x2: r.x + r.w - 1.0, y2: r.y });
      doors.push({ x: r.x + r.w / 2, y: r.y, side: 'top', swing: 'out' });
    }

    if (r.type === 'bedroom') {
      windows.push({ x1: r.x, y1: r.y + 0.8, x2: r.x, y2: r.y + r.h - 0.8 });
      doors.push({ x: r.x + r.w, y: r.y + r.h - 0.9, side: 'right', swing: 'in' });
    }

    if (r.type === 'bathroom') {
      windows.push({ x1: r.x + r.w / 2 - 0.6, y1: r.y, x2: r.x + r.w / 2 + 0.6, y2: r.y });
      doors.push({ x: r.x, y: r.y + r.h / 2, side: 'left', swing: 'in' });
    }

    if (r.type === 'kitchen') {
      windows.push({ x1: r.x + 0.8, y1: r.y + r.h, x2: r.x + r.w - 0.8, y2: r.y + r.h });
      doors.push({ x: r.x + 0.8, y: r.y, side: 'top', swing: 'in' });
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

function buildLayout(program) {
  const rooms = [];
  const bedWidth = 4.2;
  const bedHeight = 3.8;
  const hallWidth = 1.8;
  const bathWidth = 2.4;
  const bathHeight = 2.6;
  const serviceWidth = 4.2;
  const livingWidth = program.garage ? 8.8 : 9.8;
  const garageWidth = program.garage ? 6.4 : 0;
  const garageHeight = 6.4;

  const leftWingWidth = bedWidth + hallWidth + bathWidth;
  let yCursor = 0;

  rooms.push(room('Primary bedroom', 'bedroom', 0, yCursor, bedWidth, 4.4, { furniture: 'primary-bed' }));

  if (program.masterEnsuite) {
    rooms.push(room('En-suite', 'bathroom', bedWidth + hallWidth, yCursor, bathWidth, 2.4, { furniture: 'bath' }));
    if (program.walkInCloset) {
      rooms.push(room('Walk-in closet', 'closet', bedWidth + hallWidth, yCursor + 2.4, bathWidth, 2.0, { furniture: 'closet' }));
    }
  } else if (program.walkInCloset) {
    rooms.push(room('Walk-in closet', 'closet', bedWidth + hallWidth, yCursor, bathWidth, 2.3, { furniture: 'closet' }));
  }

  yCursor += 4.8;

  const secondaryBedrooms = Math.max(0, program.bedrooms - 1);
  for (let i = 0; i < secondaryBedrooms; i++) {
    rooms.push(room(`Bedroom ${i + 2}`, 'bedroom', 0, yCursor, bedWidth, bedHeight, { furniture: 'bed' }));
    yCursor += 4.2;
  }

  const leftWingHeight = Math.max(yCursor, 10.8);
  rooms.push(room('Bedroom hall', 'hall', bedWidth, 0, hallWidth, leftWingHeight, { furniture: 'hall' }));

  const sharedBathY = Math.min(leftWingHeight - bathHeight, secondaryBedrooms > 0 ? 5.2 : 4.8);
  rooms.push(room('Shared bathroom', 'bathroom', bedWidth + hallWidth, sharedBathY, bathWidth, bathHeight, { furniture: 'bath' }));

  const coreX = leftWingWidth;

  rooms.push(room('Living room', 'living', coreX, 0, livingWidth, 4.6, { furniture: 'sofa' }));

  if (program.dining) {
    rooms.push(room('Dining', 'dining', coreX, 4.6, 4.2, 3.0, { furniture: 'dining' }));
  }

  rooms.push(room('Kitchen', 'kitchen', coreX + 4.2, 4.6, livingWidth - 4.2, 3.8, { furniture: 'kitchen' }));

  if (program.scullery) {
    rooms.push(room('Scullery', 'service', coreX + livingWidth - 2.8, 8.4, 2.8, 2.4, { furniture: 'counter' }));
  }

  if (program.laundry) {
    rooms.push(room('Laundry', 'service', coreX, 8.4, 3.2, 2.4, { furniture: 'laundry' }));
  }

  const serviceX = coreX + livingWidth;
  if (program.study) {
    rooms.push(room('Study', 'study', serviceX, 0, serviceWidth, 3.6, { furniture: 'desk' }));
  }

  if (program.garage) {
    rooms.push(room('Garage', 'garage', serviceX, program.study ? 3.6 : 0, garageWidth, garageHeight, { furniture: 'car' }));
  }

  const bounds = getBounds(rooms);
  const houseWidth = bounds.right;
  const houseHeight = bounds.bottom;

  rooms.push(room('Entry foyer', 'entry', coreX - 1.8, Math.max(5.0, houseHeight - 5.2), 1.8, 2.8, { furniture: 'entry' }));

  if (program.patio) {
    rooms.push(room('Covered patio', 'patio', coreX + 0.8, -2.8, Math.min(livingWidth + (program.study ? serviceWidth : 0) - 1.2, houseWidth - coreX), 2.4, { furniture: 'outdoor' }));
  }

  rooms.push(room('Garden', 'garden', -1.2, -7.2, houseWidth + 2.4, 4.0, { furniture: 'garden' }));

  const openings = generateOpenings(rooms);
  const summary = summarizePlan(program, rooms);

  return { program, rooms, openings, summary };
}

function roomFill(type) {
  if (type === 'garden') return '#dff3df';
  if (type === 'patio') return '#efe8db';
  if (type === 'garage') return '#f2f4f7';
  if (type === 'bathroom') return '#eef7ff';
  if (type === 'kitchen') return '#fcf5ea';
  if (type === 'living') return '#fffdf8';
  if (type === 'dining') return '#fffaf2';
  if (type === 'bedroom') return '#ffffff';
  return '#ffffff';
}

function renderFurniture(roomItem, scale) {
  const x = roomItem.x * scale;
  const y = roomItem.y * scale;
  const w = roomItem.w * scale;
  const h = roomItem.h * scale;

  if (roomItem.furniture === 'bed' || roomItem.furniture === 'primary-bed') {
    const bw = Math.min(110, w - 22);
    const bh = roomItem.furniture === 'primary-bed' ? 70 : 58;
    const bx = x + 16;
    const by = y + 16;
    return `
      <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="10" fill="#f4f4f5" stroke="#6b7280" stroke-width="2"/>
      <rect x="${bx + 8}" y="${by + 8}" width="${bw - 16}" height="18" rx="6" fill="#e5e7eb"/>
      <rect x="${bx + 8}" y="${by + 30}" width="${bw - 16}" height="${bh - 38}" rx="6" fill="#fafafa"/>
    `;
  }

  if (roomItem.furniture === 'sofa') {
    return `
      <rect x="${x + 24}" y="${y + 28}" width="${Math.max(120, w * 0.45)}" height="40" rx="12" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
      <rect x="${x + 36}" y="${y + 78}" width="${Math.max(90, w * 0.28)}" height="44" rx="10" fill="#faf5ff" stroke="#7c3aed" stroke-width="2"/>
      <rect x="${x + 170}" y="${y + 48}" width="56" height="56" rx="28" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
    `;
  }

  if (roomItem.furniture === 'dining') {
    return `
      <rect x="${x + 36}" y="${y + 24}" width="${Math.min(120, w - 72)}" height="${Math.min(64, h - 48)}" rx="10" fill="#fef3c7" stroke="#b45309" stroke-width="2"/>
      <circle cx="${x + 48}" cy="${y + 20}" r="10" fill="#fff7ed" stroke="#b45309" stroke-width="2"/>
      <circle cx="${x + 150}" cy="${y + 20}" r="10" fill="#fff7ed" stroke="#b45309" stroke-width="2"/>
      <circle cx="${x + 48}" cy="${y + 96}" r="10" fill="#fff7ed" stroke="#b45309" stroke-width="2"/>
      <circle cx="${x + 150}" cy="${y + 96}" r="10" fill="#fff7ed" stroke="#b45309" stroke-width="2"/>
    `;
  }

  if (roomItem.furniture === 'kitchen' || roomItem.furniture === 'counter') {
    return `
      <rect x="${x + 14}" y="${y + 14}" width="${w - 28}" height="18" rx="6" fill="#e5e7eb"/>
      <rect x="${x + w - 44}" y="${y + 42}" width="24" height="${Math.max(32, h - 56)}" rx="6" fill="#e5e7eb"/>
      <rect x="${x + 28}" y="${y + h - 40}" width="${Math.max(50, w * 0.32)}" height="24" rx="6" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
    `;
  }

  if (roomItem.furniture === 'bath') {
    return `
      <rect x="${x + 14}" y="${y + 18}" width="48" height="28" rx="10" fill="#ffffff" stroke="#0ea5e9" stroke-width="2"/>
      <circle cx="${x + w - 32}" cy="${y + 34}" r="14" fill="#ffffff" stroke="#0ea5e9" stroke-width="2"/>
      <rect x="${x + 16}" y="${y + h - 34}" width="${Math.min(54, w - 24)}" height="20" rx="6" fill="#ffffff" stroke="#0ea5e9" stroke-width="2"/>
    `;
  }

  if (roomItem.furniture === 'desk') {
    return `
      <rect x="${x + 22}" y="${y + 26}" width="${Math.max(80, w * 0.42)}" height="34" rx="8" fill="#ede9fe" stroke="#6366f1" stroke-width="2"/>
      <rect x="${x + 52}" y="${y + 78}" width="32" height="32" rx="8" fill="#f8fafc" stroke="#6366f1" stroke-width="2"/>
    `;
  }

  if (roomItem.furniture === 'car') {
    return `
      <rect x="${x + 20}" y="${y + 28}" width="${w - 40}" height="${Math.min(96, h - 56)}" rx="18" fill="#dbeafe" stroke="#2563eb" stroke-width="3"/>
      <circle cx="${x + 56}" cy="${y + h - 28}" r="12" fill="#111827"/>
      <circle cx="${x + w - 56}" cy="${y + h - 28}" r="12" fill="#111827"/>
    `;
  }

  if (roomItem.furniture === 'laundry') {
    return `
      <circle cx="${x + 34}" cy="${y + 32}" r="18" fill="#ffffff" stroke="#0f766e" stroke-width="2"/>
      <rect x="${x + 64}" y="${y + 16}" width="38" height="38" rx="8" fill="#ffffff" stroke="#0f766e" stroke-width="2"/>
    `;
  }

  return '';
}

function renderDoor(door, scale) {
  const x = door.x * scale;
  const y = door.y * scale;
  const radius = door.garage ? 40 : 26;

  if (door.side === 'right') {
    return `<path d="M ${x} ${y - radius} A ${radius} ${radius} 0 0 1 ${x - radius} ${y}" fill="none" stroke="#111827" stroke-width="2"/><line x1="${x}" y1="${y - radius}" x2="${x}" y2="${y}" stroke="#111827" stroke-width="3"/>`;
  }

  if (door.side === 'left') {
    return `<path d="M ${x} ${y} A ${radius} ${radius} 0 0 1 ${x + radius} ${y - radius}" fill="none" stroke="#111827" stroke-width="2"/><line x1="${x}" y1="${y}" x2="${x}" y2="${y - radius}" stroke="#111827" stroke-width="3"/>`;
  }

  if (door.side === 'top') {
    return `<path d="M ${x - radius} ${y} A ${radius} ${radius} 0 0 1 ${x} ${y + radius}" fill="none" stroke="#111827" stroke-width="2"/><line x1="${x - radius}" y1="${y}" x2="${x}" y2="${y}" stroke="#111827" stroke-width="3"/>`;
  }

  return `<path d="M ${x} ${y - radius} A ${radius} ${radius} 0 0 0 ${x + radius} ${y}" fill="none" stroke="#111827" stroke-width="2"/><line x1="${x}" y1="${y}" x2="${x + radius}" y2="${y}" stroke="#111827" stroke-width="3"/>`;
}

function renderWindow(windowItem, scale) {
  return `<line x1="${windowItem.x1 * scale}" y1="${windowItem.y1 * scale}" x2="${windowItem.x2 * scale}" y2="${windowItem.y2 * scale}" stroke="#38bdf8" stroke-width="8" stroke-linecap="round"/>`;
}

function renderSvg(plan) {
  const scale = 34;
  const padding = 90;
  const bounds = getBounds(plan.rooms);

  const width = (bounds.right - bounds.left) * scale + padding * 2;
  const height = (bounds.bottom - bounds.top) * scale + padding * 2;

  const translated = plan.rooms.map(r => ({
    ...r,
    x: r.x - bounds.left + (padding / scale),
    y: r.y - bounds.top + (padding / scale)
  }));

  const translatedWindows = plan.openings.windows.map(w => ({
    x1: w.x1 - bounds.left + (padding / scale),
    y1: w.y1 - bounds.top + (padding / scale),
    x2: w.x2 - bounds.left + (padding / scale),
    y2: w.y2 - bounds.top + (padding / scale)
  }));

  const translatedDoors = plan.openings.doors.map(d => ({
    ...d,
    x: d.x - bounds.left + (padding / scale),
    y: d.y - bounds.top + (padding / scale)
  }));

  const roomSvg = translated.map(r => {
    const x = r.x * scale;
    const y = r.y * scale;
    const w = r.w * scale;
    const h = r.h * scale;
    const stroke = r.type === 'garden' ? '#94a3b8' : '#111827';
    const strokeWidth = r.type === 'garden' ? 2 : 6;
    const dash = r.type === 'patio' ? '10 7' : 'none';
    const labelY = y + 30;

    return `
      <g>
        <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r.type === 'garden' ? 22 : 14}" fill="${roomFill(r.type)}" stroke="${stroke}" stroke-width="${strokeWidth}" ${dash !== 'none' ? `stroke-dasharray="${dash}"` : ''}/>
        <text x="${x + 16}" y="${labelY}" font-size="18" font-family="Inter, Arial, sans-serif" font-weight="700" fill="#0f172a">${escapeXml(r.name)}</text>
        <text x="${x + 16}" y="${labelY + 22}" font-size="12" font-family="Inter, Arial, sans-serif" fill="#475569">${Math.round(r.w * r.h)} m²</text>
        ${renderFurniture(r, scale)}
      </g>
    `;
  }).join('');

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#0f172a" flood-opacity="0.12"/>
        </filter>
        <pattern id="grid" width="34" height="34" patternUnits="userSpaceOnUse">
          <path d="M 34 0 L 0 0 0 34" fill="none" stroke="#e5e7eb" stroke-width="1"/>
        </pattern>
      </defs>

      <rect width="100%" height="100%" fill="#f8fafc"/>
      <rect width="100%" height="100%" fill="url(#grid)" opacity="0.5"/>
      <g filter="url(#shadow)">
        ${roomSvg}
      </g>
      <g>
        ${translatedWindows.map(w => renderWindow(w, scale)).join('')}
        ${translatedDoors.map(d => renderDoor(d, scale)).join('')}
      </g>
      <g>
        <rect x="24" y="22" width="380" height="86" rx="20" fill="#ffffff" fill-opacity="0.9" stroke="#e2e8f0"/>
        <text x="42" y="52" font-size="26" font-family="Inter, Arial, sans-serif" font-weight="800" fill="#0f172a">${escapeXml(plan.summary.title)}</text>
        <text x="42" y="79" font-size="14" font-family="Inter, Arial, sans-serif" fill="#475569">${escapeXml(`${plan.summary.bedrooms} bed • ${plan.summary.bathrooms} bath • ${plan.summary.estimatedArea} • ${plan.summary.style}`)}</text>
        <text x="42" y="99" font-size="12" font-family="Inter, Arial, sans-serif" fill="#64748b">Rendered floor plan preview</text>
      </g>
    </svg>
  `;

  const compactSvg = svg.replace(/\n\s+/g, ' ').trim();
  return {
    svg: compactSvg,
    dataUrl: `data:image/svg+xml;base64,${Buffer.from(compactSvg).toString('base64')}`
  };
}

async function buildPlanFromDescription(description) {
  const program = await generateProgram(description);
  const layout = buildLayout(program);
  const image = renderSvg(layout);
  return {
    ...layout,
    ...image
  };
}

async function buildPlanFromRevision(currentProgram, revisionRequest) {
  const program = await reviseProgram(currentProgram, revisionRequest);
  const layout = buildLayout(program);
  const image = renderSvg(layout);
  return {
    ...layout,
    ...image
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, app: 'archai-floorplan-renderer' });
});

app.get('/api/meta', (_req, res) => {
  res.json({
    ok: true,
    features: ['generate-floor-plan-image', 'revise-floor-plan-image'],
    version: '2.0.0'
  });
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
    res.status(500).json({
      error: err?.message || 'Could not generate floor plan right now.'
    });
  }
});

app.post('/api/floor-plans/revise', async (req, res) => {
  const revisionRequest = text(req.body?.revisionRequest);
  const currentProgram = normalizeProgram(req.body?.currentProgram || req.body?.plan?.program || DEFAULT_PROGRAM);

  if (!revisionRequest) {
    return res.status(400).json({ error: 'Missing revisionRequest' });
  }

  try {
    const plan = await buildPlanFromRevision(currentProgram, revisionRequest);
    res.json({ ok: true, plan });
  } catch (err) {
    console.error('REVISE ERROR:', err);
    res.status(500).json({
      error: err?.message || 'Could not revise floor plan right now.'
    });
  }
});

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ArchAI floor plan renderer running on port ${PORT}`);
});
