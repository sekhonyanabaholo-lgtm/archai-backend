const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const GROQ_KEY = process.env.GROQ_KEY;

async function callGroq(messages) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: 2048,
      temperature: 0.1
    })
  });
  const data = await response.json();
  return data.choices[0].message.content.trim();
}

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
    }]);
    res.json({ questions: text });
  } catch(err) {
    console.error('ASK ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/generate', async (req, res) => {
  const { description, answers, style, size } = req.body;
  const fullContext = `Original description: ${description}\nClient answers: ${answers}`;

  const isDouble =
    description.toLowerCase().includes('double') ||
    description.toLowerCase().includes('2 stor') ||
    description.toLowerCase().includes('two stor') ||
    (answers && (
      answers.toLowerCase().includes('double') ||
      answers.toLowerCase().includes('2 stor') ||
      answers.toLowerCase().includes('two stor')
    ));

  const prompt = `You are a highly experienced South African residential architect with deep expertise in functional design, spatial planning, and lifestyle-driven layouts.

Your goal is to design a practical, buildable, and well-thought-out floor plan based on the client's needs, not just place rooms randomly.

CLIENT BRIEF:
${fullContext}

Style preference: ${style}
Size preference: ${size}

DESIGN THINKING (VERY IMPORTANT):
- Interpret the client's lifestyle, not just their words
- Prioritise flow, privacy, and usability
- Group spaces logically into public and private zones
- Ensure natural movement between spaces with no awkward layouts
- Bedrooms should feel private and separated from living areas
- Kitchens should connect naturally to dining and living areas
- Consider real South African living including indoor-outdoor flow, entertaining, and practicality
- Avoid dead space and inefficient passages

SPATIAL RULES FOR ALL HOMES:
- Study must be near master bedroom or quiet zone — NEVER next to garage
- Garage must be isolated at the side — never adjacent to bedrooms or study
- Guest bathroom must be accessible from living area not bedroom wing
- Scullery must be directly next to kitchen only
- En-suite must always be directly adjacent to its bedroom
- Garden and patio must be at the bottom of the plan

${isDouble ? `
THIS IS A DOUBLE STOREY HOME — YOU MUST RETURN TWO SEPARATE FLOOR PLANS.

DOUBLE STOREY RULES:
- Ground floor contains ONLY: living room, kitchen, dining, scullery, guest bathroom, garage, study, patio, garden, stairs
- First floor contains ONLY: ALL bedrooms, ALL en-suites, main bathroom, passage, stairs
- NO bedrooms on ground floor
- NO kitchen or living room on first floor
- Stairs must appear on BOTH floors at the EXACT SAME x and y position
- Stairs type is "stairs" and size must be exactly 2 wide by 3 deep
- First floor passage must span the full width of the bedroom wing
- Master bedroom must be furthest from stairs for privacy
` : `
THIS IS A SINGLE STOREY HOME — RETURN ONE FLOOR PLAN ONLY.

SINGLE STOREY RULES:
- Living areas including living, dining, and kitchen at the top (y=0 area)
- Bedrooms below connected via at least one passage
- For larger homes create separate bedroom wings with a central passage
- Garden and patio at the very bottom
`}

TECHNICAL RULES:
- Room types must be one of: room, passage, bathroom, ensuite, kitchen, living, dining, garage, study, garden, patio, scullery, laundry, stairs
- 1 grid unit = 1 metre
- Rooms MUST NOT overlap — check every single room pair carefully before returning
- Ensure all rooms align cleanly on the grid

MINIMUM SIZES:
- Bedrooms minimum 3x4
- Master bedroom minimum 5x5
- En-suite minimum 2x3
- Bathrooms minimum 2x3
- Kitchen minimum 4x4
- Living room minimum 6x5
- Passage minimum 1m wide spanning full width of bedroom wing
- Study minimum 3x3
- Garage minimum 6x6 double or 3x6 single
- Stairs exactly 2 wide by 3 deep

QUALITY REQUIREMENTS:
- The layout must feel like a real home someone would build
- Avoid boxy unrealistic or repetitive layouts
- Ensure passages actually connect spaces meaningfully
- For 6 or more bedrooms use two bedroom wings on either side of a central passage

${isDouble ? `
YOU MUST RETURN THIS EXACT JSON STRUCTURE — NO EXCEPTIONS:
{
  "desc": "one sentence summary of the design",
  "storey": "double",
  "ground": [
    {"name": "Living room", "t": "living", "x": 0, "y": 0, "w": 8, "h": 5},
    {"name": "Kitchen", "t": "kitchen", "x": 8, "y": 0, "w": 5, "h": 4},
    {"name": "Dining", "t": "dining", "x": 8, "y": 4, "w": 5, "h": 3},
    {"name": "Scullery", "t": "scullery", "x": 13, "y": 0, "w": 3, "h": 4},
    {"name": "Guest bath", "t": "bathroom", "x": 0, "y": 5, "w": 3, "h": 2},
    {"name": "Study", "t": "study", "x": 3, "y": 5, "w": 4, "h": 3},
    {"name": "Garage", "t": "garage", "x": 13, "y": 4, "w": 6, "h": 6},
    {"name": "Stairs", "t": "stairs", "x": 0, "y": 7, "w": 2, "h": 3},
    {"name": "Patio", "t": "patio", "x": 0, "y": 10, "w": 13, "h": 4},
    {"name": "Garden", "t": "garden", "x": 0, "y": 14, "w": 16, "h": 6}
  ],
  "first": [
    {"name": "Passage", "t": "passage", "x": 0, "y": 0, "w": 13, "h": 1},
    {"name": "Stairs", "t": "stairs", "x": 0, "y": 1, "w": 2, "h": 3},
    {"name": "Master bed", "t": "room", "x": 8, "y": 1, "w": 5, "h": 5},
    {"name": "En-suite", "t": "ensuite", "x": 8, "y": 6, "w": 3, "h": 3},
    {"name": "Bedroom 2", "t": "room", "x": 0, "y": 4, "w": 4, "h": 4},
    {"name": "Bedroom 3", "t": "room", "x": 4, "y": 4, "w": 4, "h": 4},
    {"name": "Main bath", "t": "bathroom", "x": 0, "y": 8, "w": 4, "h": 3}
  ],
  "sum": {"beds": 3, "baths": 2, "size": "~220m²", "floors": 2}
}

THE "ground" ARRAY MUST ONLY CONTAIN GROUND FLOOR ROOMS.
THE "first" ARRAY MUST ONLY CONTAIN FIRST FLOOR ROOMS.
DO NOT PUT BEDROOMS IN THE "ground" ARRAY.
DO NOT PUT KITCHEN OR LIVING IN THE "first" ARRAY.
` : `
YOU MUST RETURN THIS EXACT JSON STRUCTURE — NO EXCEPTIONS:
{
  "desc": "one sentence summary of the design",
  "storey": "single",
  "rooms": [
    {"name": "Living room", "t": "living", "x": 0, "y": 0, "w": 7, "h": 5},
    {"name": "Kitchen", "t": "kitchen", "x": 7, "y": 0, "w": 5, "h": 3},
    {"name": "Scullery", "t": "scullery", "x": 7, "y": 3, "w": 5, "h": 2},
    {"name": "Passage", "t": "passage", "x": 0, "y": 5, "w": 12, "h": 1},
    {"name": "Master bed", "t": "room", "x": 0, "y": 6, "w": 5, "h": 5},
    {"name": "En-suite", "t": "ensuite", "x": 5, "y": 6, "w": 3, "h": 3},
    {"name": "Garden", "t": "garden", "x": 0, "y": 16, "w": 14, "h": 6}
  ],
  "sum": {"beds": 3, "baths": 2, "size": "~180m²", "floors": 1}
}
`}

CRITICAL — READ THIS CAREFULLY:
- Return ONLY the raw JSON object
- Do NOT include any text before or after the JSON
- Do NOT use markdown code blocks or backticks
- Do NOT include any explanation
- Double check that no rooms overlap before returning
- For double storey the stairs x and y must be identical in both ground and first arrays`;

  try {
    const text = await callGroq([{ role: 'user', content: prompt }]);
    const clean = text.replace(/```json/g,'').replace(/```/g,'').trim();
    const json = JSON.parse(clean);
    res.json(json);
  } catch(err) {
    console.error('GENERATE ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/revise', async (req, res) => {
  const { currentRooms, request, description, isDoubleStorey } = req.body;

  const currentPlanStr = isDoubleStorey
    ? `Ground floor:\n${JSON.stringify(currentRooms.ground, null, 2)}\n\nFirst floor:\n${JSON.stringify(currentRooms.first, null, 2)}`
    : JSON.stringify(currentRooms, null, 2);

  const prompt = `You are a highly experienced South African residential architect.

A client wants to revise their existing floor plan. Apply their requested change carefully and intelligently.

ORIGINAL BRIEF: ${description}
CLIENT REVISION REQUEST: "${request}"

CURRENT FLOOR PLAN:
${currentPlanStr}

REVISION RULES:
- Only change what the client asked to change
- Keep all other rooms in their exact current positions
- If a room gets bigger shift neighbouring rooms to avoid overlap
- Study must never be placed next to garage
- Garage must stay isolated from bedrooms and study
- En-suite must stay directly adjacent to its bedroom
- Scullery must stay next to kitchen
- Guest bathroom must stay accessible from living area
- Passages must still connect all rooms logically after the change
- Garden stays at the bottom
- If double storey stairs must remain on both floors at identical x and y positions

TECHNICAL RULES:
- Room types: room, passage, bathroom, ensuite, kitchen, living, dining, garage, study, garden, patio, scullery, laundry, stairs
- Rooms MUST NOT overlap after revision
- 1 grid unit = 1 metre
- Stairs exactly 2x3

${isDoubleStorey ? `
THIS IS A DOUBLE STOREY HOME.
Return this exact structure:
{
  "desc": "one sentence describing what changed and why",
  "storey": "double",
  "ground": [...all ground floor rooms...],
  "first": [...all first floor rooms...],
  "sum": {"beds": 3, "baths": 2, "size": "~220m²", "floors": 2}
}
` : `
THIS IS A SINGLE STOREY HOME.
Return this exact structure:
{
  "desc": "one sentence describing what changed and why",
  "storey": "single",
  "rooms": [...all rooms including unchanged ones...],
  "sum": {"beds": 3, "baths": 2, "size": "~180m²", "floors": 1}
}
`}

CRITICAL:
- Return ONLY raw JSON
- No markdown, no backticks, no text outside the JSON
- Double check every room pair for overlap before returning`;

  try {
    const text = await callGroq([{ role: 'user', content: prompt }]);
    const clean = text.replace(/```json/g,'').replace(/```/g,'').trim();
    const json = JSON.parse(clean);
    res.json(json);
  } catch(err) {
    console.error('REVISE ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log('ArchAI backend running on http://localhost:3000');
});