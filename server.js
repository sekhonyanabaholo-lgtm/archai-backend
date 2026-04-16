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
    .replace(/\"/g, '&quot;')
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
      windows.push({ x1: r.x + 0.8, y1: r.y, x2: r.x + r.w - 0.8, y2: r.y });
      doors.push({ x: r.x + r.w / 2, y: r.y, side: 'top', swing: 'out' });
    }

    if (r.type === 'bedroom') {
      windows.push({ x1: r.x, y1: r.y + 0.7, x2: r.x, y2: r.y + r.h - 0.7 });
      doors.push({ x: r.x + r.w, y: r.y + r.h - 0.8, side: 'right', swing: 'in' });
    }

    if (r.type === 'bathroom') {
      windows.push({ x1: r.x + r.w / 2 - 0.5, y1: r.y, x2: r.x + r.w / 2 + 0.5, y2: r.y });
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

function buildLayout(program) {
  const rooms = [];
  const bedW = 4.1;
  const bedH = 3.7;
  const primaryW = 4.8;
  const primaryH = 4.4;
  const hallW = 1.6;
  const bathW = 2.4;
  const bathH = 2.6;
  const leftWingW = primaryW + hallW + bathW;

  const coreX = leftWingW;
  const coreW = program.garage ? 9.2 : 10.6;
  const livingH = 5.2;
  const diningH = program.dining ? 3.1 : 0;
  const kitchenH = 4.0;

  const serviceX = coreX + coreW;
  const studyW = 4.2;
  const studyH = 3.6;
  const garageW = program.garage ? 6.3 : 0;
  const garageH = 5.8;

  let y = 0;
  rooms.push(room('Primary bedroom', 'bedroom', 0, y, primaryW, primaryH, { furniture: 'primary-bed' }));

  if (program.masterEnsuite) {
    rooms.push(room('En-suite', 'bathroom', primaryW + hallW, y, bathW, 2.2, { furniture: 'bath' }));
    if (program.walkInCloset) {
      rooms.push(room('Walk-in closet', 'closet', primaryW + hallW, y + 2.2, bathW, 2.2, { furniture: 'closet' }));
    }
  } else if (program.walkInCloset) {
    rooms.push(room('Walk-in closet', 'closet', primaryW + hallW, y, bathW, 2.8, { furniture: 'closet' }));
  }

  y += primaryH + 0.3;
  const secondaryBedrooms = Math.max(0, program.bedrooms - 1);
  for (let i = 0; i < secondaryBedrooms; i++) {
    rooms.push(room(`Bedroom ${i + 2}`, 'bedroom', 0, y, bedW, bedH, { furniture: 'bed' }));
    y += bedH + 0.25;
  }

  const leftWingH = Math.max(y - 0.25, 11.8);
  rooms.push(room('Bedroom hall', 'hall', primaryW, 0, hallW, leftWingH, { furniture: 'hall' }));
  rooms.push(room('Shared bathroom', 'bathroom', primaryW + hallW, Math.min(5.2, leftWingH - bathH - 0.4), bathW, bathH, { furniture: 'bath' }));

  rooms.push(room('Living room', 'living', coreX, 0, coreW, livingH, { furniture: 'sofa' }));

  if (program.dining) {
    rooms.push(room('Dining', 'dining', coreX, livingH, 4.4, diningH, { furniture: 'dining' }));
  }

  rooms.push(room('Kitchen', 'kitchen', coreX + (program.dining ? 4.4 : 0), livingH, coreW - (program.dining ? 4.4 : 0), kitchenH, { furniture: 'kitchen' }));

  const serviceBaseY = livingH + kitchenH;
  if (program.laundry) {
    rooms.push(room('Laundry', 'service', coreX, serviceBaseY, 3.1, 2.4, { furniture: 'laundry' }));
  }
  if (program.scullery) {
    rooms.push(room('Scullery', 'service', coreX + 3.25, serviceBaseY, 2.8, 2.4, { furniture: 'counter' }));
  }

  if (program.study) {
    rooms.push(room('Study', 'study', serviceX, 0, studyW, studyH, { furniture: 'desk' }));
  }

  if (program.garage) {
    rooms.push(room('Garage', 'garage', serviceX, program.study ? studyH + 0.2 : 0, garageW, garageH, { furniture: 'car' }));
  }

  const interiorBounds = getBounds(rooms.filter(r => !['garden', 'patio'].includes(r.type)));
  const houseW = interiorBounds.right;
  const houseH = interiorBounds.bottom;
  rooms.push(room('Entry foyer', 'entry', coreX + 0.5, Math.max(serviceBaseY + 3.0, houseH - 2.9), 1.9, 2.3, { furniture: 'entry' }));

  if (program.patio) {
    rooms.push(room('Covered patio', 'patio', coreX + 0.8, -2.3, Math.min(coreW + (program.study ? 3.0 : 0), houseW - coreX - 0.8), 1.9, { furniture: 'outdoor' }));
  }

  rooms.push(room('Garden', 'garden', -0.6, -5.0, houseW + 1.2, 2.8, { furniture: 'garden' }));

  const openings = generateOpenings(rooms);
  const summary = summarizePlan(program, rooms);
  return { program, rooms, openings, summary };
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
    return `
      <rect x="${x + 14}" y="${y + 14}" width="${bw}" height="${bh}" rx="10" fill="#f1f1f2" stroke="#6b7280" stroke-width="1.6"/>
      <rect x="${x + 20}" y="${y + 20}" width="${bw - 12}" height="14" rx="5" fill="#dbdde2"/>
    `;
  }

  if (roomItem.furniture === 'sofa') {
    return `
      <rect x="${x + 18}" y="${y + 26}" width="${Math.min(114, w * 0.36)}" height="34" rx="10" fill="#ece9ff" stroke="#7c3aed" stroke-width="1.4"/>
      <rect x="${x + 26}" y="${y + 68}" width="${Math.min(86, w * 0.25)}" height="28" rx="9" fill="#f7f5ff" stroke="#7c3aed" stroke-width="1.4"/>
      <circle cx="${x + Math.min(156, w - 34)}" cy="${y + 62}" r="18" fill="#f5f5f4" stroke="#64748b" stroke-width="1.4"/>
    `;
  }

  if (roomItem.furniture === 'dining') {
    const tableW = Math.min(90, w - 38);
    const tableH = Math.min(40, h - 32);
    const tx = x + 18;
    const ty = y + 18;
    return `
      <rect x="${tx}" y="${ty}" width="${tableW}" height="${tableH}" rx="8" fill="#f5e8bf" stroke="#b45309" stroke-width="1.4"/>
      <circle cx="${tx + 8}" cy="${ty - 6}" r="7" fill="#fff7ed" stroke="#b45309" stroke-width="1.2"/>
      <circle cx="${tx + tableW + 8}" cy="${ty - 6}" r="7" fill="#fff7ed" stroke="#b45309" stroke-width="1.2"/>
      <circle cx="${tx + 8}" cy="${ty + tableH + 6}" r="7" fill="#fff7ed" stroke="#b45309" stroke-width="1.2"/>
      <circle cx="${tx + tableW + 8}" cy="${ty + tableH + 6}" r="7" fill="#fff7ed" stroke="#b45309" stroke-width="1.2"/>
    `;
  }

  if (roomItem.furniture === 'kitchen' || roomItem.furniture === 'counter') {
    return `
      <rect x="${x + 12}" y="${y + 12}" width="${w - 24}" height="14" rx="5" fill="#dfe3e8"/>
      <rect x="${x + w - 36}" y="${y + 34}" width="18" height="${Math.max(26, h - 48)}" rx="5" fill="#dfe3e8"/>
      <rect x="${x + 22}" y="${y + h - 30}" width="${Math.max(40, w * 0.24)}" height="18" rx="5" fill="#f8fafc" stroke="#94a3b8" stroke-width="1.2"/>
    `;
  }

  if (roomItem.furniture === 'bath') {
    return `
      <rect x="${x + 12}" y="${y + 14}" width="38" height="20" rx="8" fill="#ffffff" stroke="#0ea5e9" stroke-width="1.3"/>
      <circle cx="${x + w - 24}" cy="${y + 28}" r="11" fill="#ffffff" stroke="#0ea5e9" stroke-width="1.3"/>
      <rect x="${x + 12}" y="${y + h - 28}" width="42" height="16" rx="5" fill="#ffffff" stroke="#0ea5e9" stroke-width="1.3"/>
    `;
  }

  if (roomItem.furniture === 'desk') {
    return `
      <rect x="${x + 18}" y="${y + 22}" width="${Math.max(62, w * 0.34)}" height="24" rx="7" fill="#ece9ff" stroke="#6366f1" stroke-width="1.3"/>
      <rect x="${x + 28}" y="${y + 56}" width="22" height="22" rx="6" fill="#f8fafc" stroke="#6366f1" stroke-width="1.2"/>
    `;
  }

  if (roomItem.furniture === 'car') {
    return `
      <rect x="${x + 16}" y="${y + 18}" width="${w - 32}" height="${Math.min(70, h - 34)}" rx="16" fill="#dbe7f7" stroke="#2563eb" stroke-width="1.8"/>
      <circle cx="${x + 40}" cy="${y + h - 18}" r="9" fill="#0f172a"/>
      <circle cx="${x + w - 40}" cy="${y + h - 18}" r="9" fill="#0f172a"/>
    `;
  }

  if (roomItem.furniture === 'laundry') {
    return `
      <circle cx="${x + 28}" cy="${y + 26}" r="14" fill="#ffffff" stroke="#0f766e" stroke-width="1.3"/>
      <rect x="${x + 50}" y="${y + 12}" width="26" height="26" rx="6" fill="#ffffff" stroke="#0f766e" stroke-width="1.3"/>
    `;
  }

  return '';
}

function renderDoor(door, scale) {
  const x = door.x * scale;
  const y = door.y * scale;
  const radius = door.garage ? 34 : 20;

  if (door.side === 'right') {
    return `<path d="M ${x} ${y - radius} A ${radius} ${radius} 0 0 1 ${x - radius} ${y}" fill="none" stroke="#334155" stroke-width="1.5"/><line x1="${x}" y1="${y - radius}" x2="${x}" y2="${y}" stroke="#334155" stroke-width="2.2"/>`;
  }
  if (door.side === 'left') {
    return `<path d="M ${x} ${y} A ${radius} ${radius} 0 0 1 ${x + radius} ${y - radius}" fill="none" stroke="#334155" stroke-width="1.5"/><line x1="${x}" y1="${y}" x2="${x}" y2="${y - radius}" stroke="#334155" stroke-width="2.2"/>`;
  }
  if (door.side === 'top') {
    return `<path d="M ${x - radius} ${y} A ${radius} ${radius} 0 0 1 ${x} ${y + radius}" fill="none" stroke="#334155" stroke-width="1.5"/><line x1="${x - radius}" y1="${y}" x2="${x}" y2="${y}" stroke="#334155" stroke-width="2.2"/>`;
  }
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

    return `
      <g>
        <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${isOutdoor ? 14 : 12}" fill="${roomFill(r.type)}" stroke="${wallStroke}" stroke-width="${strokeWidth}" ${dash ? `stroke-dasharray="${dash}"` : ''}/>
        <text x="${x + 10}" y="${titleY}" font-size="${titleSize}" font-family="Inter, Arial, sans-serif" font-weight="700" fill="#0f172a">${escapeXml(r.name)}</text>
        ${showArea ? `<text x="${x + 10}" y="${titleY + 16}" font-size="${labelSize}" font-family="Inter, Arial, sans-serif" fill="#64748b">${Math.round(r.w * r.h)} m²</text>` : ''}
        ${renderFurniture(r, scale)}
      </g>
    `;
  }).join('');

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#0f172a" flood-opacity="0.08"/>
        </filter>
        <pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#edf0f3" stroke-width="1"/>
        </pattern>
      </defs>

      <rect width="100%" height="100%" rx="28" fill="#f6f7f8"/>
      <rect x="14" y="14" width="${Math.round(width - 28)}" height="${Math.round(height - 28)}" rx="26" fill="url(#grid)"/>
      <g filter="url(#shadow)">${roomSvg}</g>
      <g>${translatedWindows.map(w => renderWindow(w, scale)).join('')}${translatedDoors.map(d => renderDoor(d, scale)).join('')}</g>
      <g>
        <rect x="18" y="18" width="320" height="64" rx="16" fill="#ffffff" fill-opacity="0.96" stroke="#e5e7eb"/>
        <text x="36" y="45" font-size="22" font-family="Inter, Arial, sans-serif" font-weight="800" fill="#0f172a">${escapeXml(plan.summary.title)}</text>
        <text x="36" y="64" font-size="12" font-family="Inter, Arial, sans-serif" fill="#475569">${escapeXml(`${plan.summary.bedrooms} bed • ${plan.summary.bathrooms} bath • ${plan.summary.estimatedArea} • ${plan.summary.style}`)}</text>
        <text x="36" y="78" font-size="10" font-family="Inter, Arial, sans-serif" fill="#94a3b8">Rendered floor plan preview</text>
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
  return { ...layout, ...image };
}

async function buildPlanFromRevision(currentProgram, revisionRequest) {
  const program = await reviseProgram(currentProgram, revisionRequest);
  const layout = buildLayout(program);
  const image = renderSvg(layout);
  return { ...layout, ...image };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, app: 'archai-floorplan-renderer' });
});

app.get('/api/meta', (_req, res) => {
  res.json({ ok: true, features: ['generate-floor-plan-image', 'revise-floor-plan-image'], version: '2.1.0' });
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
  const currentProgram = normalizeProgram(req.body?.currentProgram || req.body?.plan?.program || DEFAULT_PROGRAM);

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
