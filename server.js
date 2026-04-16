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
app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const GROQ_KEY = process.env.GROQ_KEY;
const FAL_KEY = process.env.FAL_KEY;
const FAL_MODEL = process.env.FAL_MODEL || 'fal-ai/qwen-image';
const FAL_IMAGE_SIZE = process.env.FAL_IMAGE_SIZE || 'landscape_4_3';
const FAL_SYNC_URL = process.env.FAL_SYNC_URL || 'https://fal.run';

if (!GROQ_KEY) {
  throw new Error('Missing GROQ_KEY environment variable');
}

if (!FAL_KEY) {
  throw new Error('Missing FAL_KEY environment variable');
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

async function callGroq(messages, temperature = 0.2, maxTokens = 1400) {
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

function normalizeBrief(brief) {
  const b = brief || {};
  return {
    title: text(b.title, 'Family Home'),
    style: text(b.style, 'modern'),
    floors: clamp(Number(b.floors || 1), 1, 3),
    bedrooms: clamp(Number(b.bedrooms || 3), 1, 8),
    bathrooms: clamp(Number(b.bathrooms || 2), 1, 6),
    garage: toBool(b.garage, true),
    study: toBool(b.study, false),
    patio: toBool(b.patio, true),
    laundry: toBool(b.laundry, true),
    scullery: toBool(b.scullery, false),
    walkInCloset: toBool(b.walkInCloset, false),
    masterEnsuite: toBool(b.masterEnsuite, true),
    priorities: Array.isArray(b.priorities) ? b.priorities.map(v => text(v)).filter(Boolean).slice(0, 10) : ['good circulation', 'natural light', 'practical family layout'],
    mustInclude: Array.isArray(b.mustInclude) ? b.mustInclude.map(v => text(v)).filter(Boolean).slice(0, 14) : [],
    architecturalNotes: Array.isArray(b.architecturalNotes) ? b.architecturalNotes.map(v => text(v)).filter(Boolean).slice(0, 16) : [],
    imageStyleNotes: Array.isArray(b.imageStyleNotes) ? b.imageStyleNotes.map(v => text(v)).filter(Boolean).slice(0, 10) : [],
    notes: text(b.notes)
  };
}

async function generateBrief(description) {
  const prompt = `You are an expert residential architect and prompt strategist.

Convert the user's request into a detailed house-design brief for generating a top-down rendered floor plan image.

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
  "walkInCloset": false,
  "masterEnsuite": true,
  "priorities": ["string"],
  "mustInclude": ["string"],
  "architecturalNotes": ["string"],
  "imageStyleNotes": ["string"],
  "notes": "string"
}

Rules:
- infer practical family-home details intelligently
- make the brief specific enough to drive image generation
- favor realistic layouts over novelty
- architecturalNotes should describe layout relationships and spatial intent
- imageStyleNotes should describe how the plan should look visually
- do not include coordinates
- do not include markdown

USER REQUEST:
${description}`;

  const raw = await callGroq([
    { role: 'system', content: 'You create detailed residential design briefs for floor plan image generation and return only JSON.' },
    { role: 'user', content: prompt }
  ], 0.15, 1200);

  return normalizeBrief(await parseJsonWithRepair(raw));
}

async function reviseBrief(currentBrief, revisionRequest) {
  const prompt = `You are revising a residential design brief for floor plan image generation.

CURRENT BRIEF:
${JSON.stringify(currentBrief, null, 2)}

REVISION REQUEST:
${revisionRequest}

Return updated JSON only in the same exact structure.
Keep the design coherent and realistic.`;

  const raw = await callGroq([
    { role: 'system', content: 'You revise residential design briefs for floor plan image generation and return only JSON.' },
    { role: 'user', content: prompt }
  ], 0.15, 1200);

  return normalizeBrief(await parseJsonWithRepair(raw));
}

function buildImagePrompt(brief) {
  const features = [
    `${brief.bedrooms} bedroom`,
    `${brief.bathrooms} bathroom`,
    brief.garage ? 'garage' : null,
    brief.study ? 'study' : null,
    brief.patio ? 'covered patio' : null,
    brief.laundry ? 'laundry' : null,
    brief.scullery ? 'scullery' : null,
    brief.walkInCloset ? 'walk-in closet' : null,
    brief.masterEnsuite ? 'main en-suite' : null
  ].filter(Boolean).join(', ');

  const priorityLine = brief.priorities.length ? `Design priorities: ${brief.priorities.join(', ')}.` : '';
  const includeLine = brief.mustInclude.length ? `Must include: ${brief.mustInclude.join(', ')}.` : '';
  const layoutLine = brief.architecturalNotes.length ? `Layout guidance: ${brief.architecturalNotes.join(' ')}.` : '';
  const styleLine = brief.imageStyleNotes.length ? `Visual rendering guidance: ${brief.imageStyleNotes.join(' ')}.` : '';
  const notesLine = brief.notes ? `Additional notes: ${brief.notes}.` : '';

  return [
    `Create a unique top-down architectural floor plan render for a ${brief.style} ${brief.title}.`,
    `Show a believable residential layout for a ${features} home.${brief.floors > 1 ? ` Indicate ${brief.floors} floors in a coherent plan composition.` : ''}`,
    'The image must look like a premium floor plan presentation, not a generic template.',
    'Use distinct room proportions and a realistic arrangement of public, private, and service spaces.',
    'Make the circulation believable and avoid repeated stacked identical room modules.',
    'Top-down view only. Clean architectural presentation. Crisp black wall outlines. Clear labeled rooms. Subtle soft interior fills. Premium real-estate brochure style.',
    'Include recognizable spaces such as living room, kitchen, dining area, bedrooms, bathrooms, garage and outdoor spaces when relevant.',
    'Make the patio connect naturally to the living or dining spaces when present.',
    'Keep the plan readable, balanced, and visually refined.',
    priorityLine,
    includeLine,
    layoutLine,
    styleLine,
    notesLine
  ].filter(Boolean).join(' ');
}

async function generateFloorPlanImage(prompt) {
  const response = await fetch(`${FAL_SYNC_URL}/${FAL_MODEL}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${FAL_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt,
      image_size: FAL_IMAGE_SIZE,
      num_images: 1,
      output_format: 'png',
      enable_safety_checker: true,
      sync_mode: false
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.detail || data?.error?.message || 'fal image generation request failed');
  }

  const image = Array.isArray(data?.images) ? data.images[0] : null;
  const url = image?.url || null;
  if (!url) {
    throw new Error('fal did not return an image URL');
  }

  return {
    dataUrl: url,
    imageUrl: url,
    mimeType: image?.content_type || 'image/url'
  };
}

function estimateArea(brief) {
  const base = brief.bedrooms * 28 + brief.bathrooms * 8 + 52;
  const extras =
    (brief.garage ? 28 : 0) +
    (brief.study ? 10 : 0) +
    (brief.patio ? 12 : 0) +
    (brief.laundry ? 5 : 0) +
    (brief.scullery ? 4 : 0) +
    (brief.walkInCloset ? 4 : 0);
  return `${Math.round(base + extras)} m²`;
}

function buildPlanPayload(brief, imagePrompt, image) {
  return {
    program: brief,
    summary: {
      title: brief.title,
      bedrooms: brief.bedrooms,
      bathrooms: brief.bathrooms,
      estimatedArea: estimateArea(brief),
      style: brief.style,
      floors: brief.floors
    },
    prompt: imagePrompt,
    dataUrl: image.dataUrl,
    imageUrl: image.imageUrl,
    mimeType: image.mimeType
  };
}

async function buildPlanFromDescription(description) {
  const brief = await generateBrief(description);
  const imagePrompt = buildImagePrompt(brief);
  const image = await generateFloorPlanImage(imagePrompt);
  return buildPlanPayload(brief, imagePrompt, image);
}

async function buildPlanFromRevision(currentBrief, revisionRequest) {
  const brief = await reviseBrief(currentBrief, revisionRequest);
  const imagePrompt = buildImagePrompt(brief);
  const image = await generateFloorPlanImage(imagePrompt);
  return buildPlanPayload(brief, imagePrompt, image);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, app: 'archai-floorplan-image-backend' });
});

app.get('/api/meta', (_req, res) => {
  res.json({
    ok: true,
    features: ['generate-floor-plan-image', 'revise-floor-plan-image'],
    version: '4.1.0',
    mode: 'image-first-fal'
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
    res.status(500).json({ error: err?.message || 'Could not generate floor plan right now.' });
  }
});

app.post('/api/floor-plans/revise', async (req, res) => {
  const revisionRequest = text(req.body?.revisionRequest);
  const currentProgram = normalizeBrief(req.body?.currentProgram || req.body?.plan?.program || {});

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
  console.log(`ArchAI floor plan image backend running on port ${PORT}`);
});
