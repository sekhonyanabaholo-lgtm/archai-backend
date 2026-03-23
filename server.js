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
      max_tokens: 3000,
      temperature: 0.1
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || 'Groq request failed');
  }

  if (!data?.choices?.[0]?.message?.content) {
    throw new Error('Groq returned no content');
  }

  return data.choices[0].message.content.trim();
}

function cleanJson(text) {
  return text.replace(/```json/g, '').replace(/```/g, '').trim();
}

function safeParseJson(text) {
  return JSON.parse(cleanJson(text));
}

async function generateAndRepair(prompt) {
  const firstPass = await callGroq([{ role: 'user', content: prompt }]);
  const firstJson = cleanJson(firstPass);

  const repairPrompt = `You are a senior residential architectural reviewer.

Review and repair this generated floor plan JSON.

YOUR JOB:
- Keep the same overall house concept where possible
- Fix overlap
- Fix bad circulation
- Fix floating or detached en-suites
- Fix main bathroom conflicts
- Fix scattered secondary bedrooms
- Fix decorative or useless passages
- Fix unrealistic open-plan relationships
- Fix illogical door placement
- Fix windows on internal walls
- Make the plan feel like a real house

CRITICAL REPAIR PRIORITIES:
1. Secondary bedrooms must be organised into a wing, cluster, or passage layout
2. En-suites must share a full wall with their bedroom
3. Shared bathrooms must sit in shared circulation, not inside private suites
4. Passages must be true corridors, not labels or filler strips
5. Doors must reflect real human movement
6. Windows must only be on external walls
7. If a room arrangement is structurally weak, reorganise it

FINAL QUESTION:
"Would a competent architect actually draw this?"

If no, fix it before returning.

Return ONLY raw JSON.
No markdown.
No explanation.

JSON TO REVIEW:
${firstJson}`;

  const repaired = await callGroq([{ role: 'user', content: repairPrompt }]);
  return safeParseJson(repaired);
}

app.post('/ask', async (req, res) => {
  const { description } = req.body;

  try {
    const text = await callGroq([{
      role: 'user',
      content: `You are a friendly South African architect assistant.

A client said:
"${description}"

Ask exactly 4 short, useful clarifying questions before designing the floor plan.

Your questions should cover the most important missing items, such as:
- number of bedrooms or bathrooms
- single or double storey
- garage or carport
- study, scullery, laundry, staff room, outside room
- plot size or site limitations
- budget level
- patio, braai, garden, entertainment needs

RULES:
- Write one short friendly intro sentence
- Then write exactly 4 numbered questions
- Keep it conversational
- Keep it short
- Do NOT generate a floor plan yet`
    }]);

    res.json({ questions: text });
  } catch (err) {
    console.error('ASK ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/generate', async (req, res) => {
  const { description, answers, style, size } = req.body;

  const fullContext = `Original description: ${description}\nClient answers: ${answers || 'None provided'}`;

  const isDouble =
    (description || '').toLowerCase().includes('double') ||
    (description || '').toLowerCase().includes('2 stor') ||
    (description || '').toLowerCase().includes('two stor') ||
    ((answers || '').toLowerCase().includes('double')) ||
    ((answers || '').toLowerCase().includes('2 stor')) ||
    ((answers || '').toLowerCase().includes('two stor'));

  const prompt = `You are a highly experienced South African residential architect and spatial planner.

Your task is to generate a realistic, buildable residential floor plan that feels like a real home, not a random box layout.

CLIENT BRIEF:
${fullContext}

Style preference: ${style}
Size preference: ${size}

CORE GOAL:
Create a practical, elegant, realistic floor plan with sensible circulation, privacy, room grouping, bathroom logic, door placement, and window placement.

ABSOLUTE PRIORITIES:
- The plan must feel like a real house someone would actually build
- Do not place rooms randomly
- Do not return decorative geometry pretending to be circulation
- Do not create floating bathroom blocks, floating en-suites, or isolated bedrooms
- No overlaps under any circumstances
- The whole plan must be organised around one clear structural layout pattern

STRUCTURAL LAYOUT RULE (CRITICAL):
Before placing rooms, you MUST choose exactly ONE layout strategy and build the whole plan around it.

Allowed layout strategies:
1. CENTRAL PASSAGE LAYOUT
- One main passage
- Bedrooms branch off the passage
- Shared bathrooms connect to the passage
- Master bedroom sits at one end or in the most private position

2. BEDROOM WING LAYOUT
- Public zone and private zone clearly separated
- Bedrooms grouped together in one private wing
- One clear circulation spine through the wing
- Shared bathrooms sit inside the bedroom wing

3. CLUSTERED FAMILY LAYOUT
- Bedrooms grouped in logical clusters
- One shared circulation route connects the clusters
- Master bedroom is separated for privacy

YOU MUST:
- Pick one of these patterns first
- Place all rooms according to that pattern
- Keep the structure clear and readable
- NEVER scatter bedrooms across unrelated positions

ZONING RULES:
- Public zone: living, dining, kitchen, patio
- Private zone: bedrooms, en-suites, main/shared bathroom
- Service zone: garage, scullery, laundry, guest bathroom
- Public, private, and service zones must be clearly separated
- Bedrooms must never feel mixed into public spaces
- Garage must never sit next to bedrooms or study
- Study must sit in a quiet zone, never beside garage
- Patio and garden must remain at the bottom of the plan

BEDROOM ORGANISATION RULE:
- All secondary bedrooms must be grouped into a logical cluster or wing
- Secondary bedrooms must share a common access path
- Avoid scattering bedrooms individually around the plan
- Master bedroom must be the most private bedroom
- Master bedroom should not be the main access route to anything else

EN-SUITE ATTACHMENT RULE (CRITICAL):
- Every en-suite must share a full wall with its bedroom
- Every en-suite must be directly accessible from its bedroom only
- An en-suite must feel like an extension of its bedroom, not a detached box
- If this cannot be satisfied cleanly, do NOT include the en-suite
- En-suites must never overlap or visually merge with shared bathrooms

MAIN BATHROOM RULE:
- Main/shared bathroom must be separate from all en-suites
- Main/shared bathroom must be accessed from passage or shared circulation
- Main/shared bathroom must not sit inside master suite
- Main/shared bathroom should serve secondary bedrooms logically
- If multiple shared bathrooms exist, each must have a clear purpose

PASSAGE RULE (CRITICAL):
- Passage type is for real circulation only
- A passage must connect at least 3 meaningful destinations, OR 2 rooms while acting as a true corridor between zones
- If a passage does not serve a real movement purpose, remove it
- Do not create decorative or token passages
- Do not create random thin strips labelled as passage
- Bedroom wings should preferably have one clear organising passage

OPEN-PLAN RULE:
- Open plan does NOT mean shapeless empty space
- Living, dining, and kitchen must still read as separate functional zones
- Dining should sit naturally between or beside kitchen and living
- Avoid awkward leftover voids
- Open-plan spaces must not block private circulation

DOOR RULES:
- Doors must follow realistic movement paths
- Every bedroom must have one logical entry door
- Every en-suite must open only from its bedroom
- Every shared bathroom must open to passage or shared circulation
- Kitchen should connect logically to dining/living and optionally scullery
- Garage should connect to service/public circulation, not directly to bedroom
- Doors may only exist between touching rooms or room-to-exterior
- Do not place doors on walls where the two spaces do not touch
- Do not create unusable door positions in corners
- Do not create nonsense door conflicts

WINDOW RULES:
- Windows must only be placed on exterior walls
- Bedrooms must have at least one exterior window
- Living room should have generous exterior windows
- Kitchen should have at least one exterior window if possible
- Bathrooms and en-suites should have a small exterior window if possible
- Never place a window on an internal shared wall

SPACE PLANNING RULES:
- Kitchen must connect naturally to dining and living
- Scullery must sit directly next to kitchen only
- Guest bathroom must be accessible from public zone
- Study should sit near quiet/private edge or controlled public edge
- Bedrooms should be separated from noisy social spaces
- Avoid dead ends and wasted corners
- Avoid tiny leftover spaces between rooms

${isDouble ? `
THIS IS A DOUBLE STOREY HOME. RETURN TWO FLOOR PLANS.

DOUBLE STOREY RULES:
- Ground floor contains only public/service spaces: living, dining, kitchen, scullery, guest bathroom, garage, study, patio, garden, stairs
- First floor contains private spaces: bedrooms, en-suites, main bathroom, passage, stairs
- No bedrooms on ground floor
- No kitchen or living room on first floor
- Stairs must exist on both floors at identical x and y
- Stairs type must be "stairs"
- Stairs size exactly 2 wide by 3 deep
- First floor must use one clear bedroom organisation pattern
- Master bedroom should be furthest from stairs where practical
` : `
THIS IS A SINGLE STOREY HOME. RETURN ONE FLOOR PLAN.

SINGLE STOREY RULES:
- Public spaces should sit in the upper portion of the plan
- Private bedroom zone should sit below
- Use one clear bedroom wing, central passage, or clustered family layout
- Patio and garden must be at the bottom
`}

TECHNICAL RULES:
- Room types allowed: room, passage, bathroom, ensuite, kitchen, living, dining, garage, study, garden, patio, scullery, laundry, stairs
- 1 grid unit = 1 metre
- All rooms must align to the grid
- Rooms must not overlap
- Avoid duplicate room names unless numbered
- Every room must have practical proportions
- Avoid thin, awkward, or unusable rooms

MINIMUM ROOM SIZES:
- Bedroom minimum 3x4
- Master bedroom minimum 5x5
- En-suite minimum 2x3
- Bathroom minimum 2x3
- Kitchen minimum 4x4
- Living room minimum 6x5
- Study minimum 3x3
- Garage minimum 6x6 double or 3x6 single
- Stairs exactly 2x3
- Passage minimum 1m wide

OUTPUT REQUIREMENTS:
- Return realistic room coordinates
- Return sensible room relationships
- Return a "doors" array
- Return a "windows" array
- Each door must reference two touching rooms or a room and "exterior"
- Each window must reference one room and one exterior side
- Exterior side must be one of: top, right, bottom, left

DOOR FORMAT:
{"from":"Bedroom 2","to":"Passage","side":"top","x":4,"y":10,"width":1}

WINDOW FORMAT:
{"room":"Living room","side":"bottom","x":3,"y":5,"width":2}

FINAL SANITY CHECK (CRITICAL):
Before returning, ask:
"Does this feel like a real house a human architect would design?"

If the answer is NO:
- reorganise the layout completely
- prioritise structure over symmetry
- fix circulation, bathroom logic, room grouping, and access before returning

VALIDATION CHECKLIST BEFORE YOU RETURN:
1. No overlaps
2. Secondary bedrooms are grouped logically
3. En-suites are attached properly to their bedrooms
4. Main/shared bathrooms are separate from en-suites
5. Passages are meaningful and not decorative
6. Doors only connect touching spaces
7. Windows only sit on exterior walls
8. Public/private/service zones are clear
9. Open-plan spaces still have functional zoning
10. The plan feels like a real house, not random boxes

${isDouble ? `
RETURN EXACTLY THIS JSON SHAPE:
{
  "desc":"one sentence summary",
  "storey":"double",
  "ground":[
    {"name":"Living room","t":"living","x":0,"y":0,"w":8,"h":5}
  ],
  "first":[
    {"name":"Passage","t":"passage","x":0,"y":0,"w":10,"h":1}
  ],
  "doors":[
    {"from":"Bedroom 2","to":"Passage","side":"top","x":4,"y":10,"width":1}
  ],
  "windows":[
    {"room":"Living room","side":"bottom","x":3,"y":5,"width":2}
  ],
  "sum":{"beds":4,"baths":3,"size":"~240m²","floors":2}
}
` : `
RETURN EXACTLY THIS JSON SHAPE:
{
  "desc":"one sentence summary",
  "storey":"single",
  "rooms":[
    {"name":"Living room","t":"living","x":0,"y":0,"w":7,"h":5}
  ],
  "doors":[
    {"from":"Bedroom 2","to":"Passage","side":"top","x":4,"y":10,"width":1}
  ],
  "windows":[
    {"room":"Living room","side":"bottom","x":3,"y":5,"width":2}
  ],
  "sum":{"beds":4,"baths":3,"size":"~180m²","floors":1}
}
`}

CRITICAL:
- Return raw JSON only
- No markdown
- No explanation
- No text before or after JSON
- If the layout looks awkward, fix it before returning
- Prioritise realism over symmetry`;

  try {
    const json = await generateAndRepair(prompt);
    res.json(json);
  } catch (err) {
    console.error('GENERATE ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/revise', async (req, res) => {
  const { currentRooms, request, description, isDoubleStorey, currentDoors, currentWindows } = req.body;

  const currentPlanStr = isDoubleStorey
    ? `Ground floor:\n${JSON.stringify(currentRooms?.ground || [], null, 2)}\n\nFirst floor:\n${JSON.stringify(currentRooms?.first || [], null, 2)}`
    : JSON.stringify(currentRooms || [], null, 2);

  const prompt = `You are a highly experienced South African residential architect.

A client wants to revise their existing floor plan. Apply their requested change carefully and intelligently.

ORIGINAL BRIEF:
${description}

CLIENT REVISION REQUEST:
"${request}"

CURRENT FLOOR PLAN:
${currentPlanStr}

CURRENT DOORS:
${JSON.stringify(currentDoors || [], null, 2)}

CURRENT WINDOWS:
${JSON.stringify(currentWindows || [], null, 2)}

REVISION GOAL:
Make only the requested changes while preserving the rest of the plan as much as possible.

REVISION RULES:
- Only change what the client asked to change
- Keep the overall structure stable where possible
- Preserve the chosen layout pattern unless the requested change forces a reorganisation
- Secondary bedrooms must remain grouped logically
- En-suites must remain attached to their bedroom by a full shared wall
- Main/shared bathrooms must remain separate from en-suites
- Passages must remain meaningful, not decorative
- Garage must stay isolated from bedrooms and study
- Study must never sit next to garage
- Scullery must stay next to kitchen
- Doors must still reflect real movement
- Windows must remain on exterior walls only
- Garden and patio remain at the bottom
- If double storey, stairs must remain on both floors at identical x and y

If the requested change breaks the layout, intelligently reorganise the affected zone while keeping the rest as consistent as possible.

DOOR RULES:
- Doors may only exist between touching rooms or room-to-exterior
- En-suite door must connect only to its bedroom
- Main bathroom must connect to circulation or shared access
- Do not create nonsensical direct bedroom-to-living access unless clearly requested

WINDOW RULES:
- Windows only on exterior walls
- Bedrooms should keep at least one exterior window
- Living room should keep strong external light where possible
- Bathrooms should keep small external windows where possible

TECHNICAL RULES:
- Room types allowed: room, passage, bathroom, ensuite, kitchen, living, dining, garage, study, garden, patio, scullery, laundry, stairs
- Rooms must NOT overlap
- 1 grid unit = 1 metre
- Stairs exactly 2x3

${isDoubleStorey ? `
RETURN EXACTLY THIS JSON SHAPE:
{
  "desc":"one sentence describing what changed and why",
  "storey":"double",
  "ground":[...],
  "first":[...],
  "doors":[...],
  "windows":[...],
  "sum":{"beds":4,"baths":3,"size":"~240m²","floors":2}
}
` : `
RETURN EXACTLY THIS JSON SHAPE:
{
  "desc":"one sentence describing what changed and why",
  "storey":"single",
  "rooms":[...],
  "doors":[...],
  "windows":[...],
  "sum":{"beds":4,"baths":3,"size":"~180m²","floors":1}
}
`}

VALIDATION CHECKLIST:
1. No overlaps
2. Bathrooms and en-suites separated correctly
3. Doors only where spaces touch
4. Windows only on exterior walls
5. Circulation still works
6. Requested change has actually been applied
7. Plan still feels realistic

CRITICAL:
- Return ONLY raw JSON
- No markdown
- No explanation
- No text outside JSON`;

  try {
    const json = await generateAndRepair(prompt);
    res.json(json);
  } catch (err) {
    console.error('REVISE ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => {
  console.log('ArchAI backend running on http://localhost:3000');
});