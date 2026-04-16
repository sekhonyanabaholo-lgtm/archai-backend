const descriptionEl = document.getElementById('description');
const revisionEl = document.getElementById('revision');
const generateBtn = document.getElementById('generateBtn');
const reviseBtn = document.getElementById('reviseBtn');
const planImage = document.getElementById('planImage');
const placeholder = document.getElementById('placeholder');
const summaryContent = document.getElementById('summaryContent');
const prioritiesContent = document.getElementById('prioritiesContent');
const planTitle = document.getElementById('planTitle');
const planMeta = document.getElementById('planMeta');
const statusPill = document.getElementById('statusPill');
const historyEl = document.getElementById('history');
const canvasPanel = document.querySelector('.canvas-panel');

let currentPlan = null;
let historyItems = [];

function setStatus(type, label) {
  statusPill.className = `status-pill ${type}`;
  statusPill.textContent = label;
}

function renderHistory() {
  if (!historyItems.length) {
    historyEl.innerHTML = '<div class="empty-history">No revisions yet.</div>';
    return;
  }

  historyEl.innerHTML = historyItems.map((item) => `
    <div class="history-item">
      <div class="history-type">${item.type}</div>
      <div class="history-note">${escapeHtml(item.note)}</div>
      <div class="history-time">${new Date(item.at).toLocaleString()}</div>
    </div>
  `).join('');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showError(message) {
  removeError();
  const banner = document.createElement('div');
  banner.className = 'error-banner';
  banner.id = 'errorBanner';
  banner.textContent = message;
  canvasPanel.appendChild(banner);
}

function removeError() {
  const old = document.getElementById('errorBanner');
  if (old) old.remove();
}

function renderSummary(plan) {
  const summary = plan.summary || {};
  const program = plan.program || {};

  summaryContent.classList.remove('muted');
  summaryContent.innerHTML = `
    <div class="summary-list">
      <div><strong>Bedrooms</strong><br>${summary.bedrooms ?? '-'}</div>
      <div><strong>Bathrooms</strong><br>${summary.bathrooms ?? '-'}</div>
      <div><strong>Estimated area</strong><br>${escapeHtml(summary.estimatedArea || '-')}</div>
      <div><strong>Style</strong><br>${escapeHtml(summary.style || '-')}</div>
      <div><strong>Floors</strong><br>${summary.floors ?? '-'}</div>
      <div><strong>Features</strong><br>${[
        program.garage ? 'Garage' : null,
        program.study ? 'Study' : null,
        program.patio ? 'Patio' : null,
        program.laundry ? 'Laundry' : null,
        program.walkInCloset ? 'Walk-in closet' : null
      ].filter(Boolean).join(', ') || 'Standard layout'}</div>
    </div>
  `;

  const priorities = Array.isArray(program.priorities) ? program.priorities : [];
  prioritiesContent.classList.remove('muted');
  prioritiesContent.innerHTML = priorities.length
    ? `<div class="priority-list">${priorities.map((item) => `<div>${escapeHtml(item)}</div>`).join('')}</div>`
    : 'No explicit priorities captured.';
}

function renderPlan(plan) {
  currentPlan = plan;
  removeError();
  planTitle.textContent = plan.summary?.title || 'Rendered floor plan';
  planMeta.textContent = `${plan.summary?.bedrooms || '-'} bedrooms • ${plan.summary?.bathrooms || '-'} bathrooms • ${plan.summary?.estimatedArea || '-'}`;
  planImage.src = plan.dataUrl;
  planImage.style.display = 'block';
  placeholder.style.display = 'none';
  renderSummary(plan);
}

async function callApi(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

generateBtn.addEventListener('click', async () => {
  const description = descriptionEl.value.trim();
  if (!description) {
    showError('Please describe the house you want first.');
    setStatus('error', 'Missing brief');
    return;
  }

  generateBtn.disabled = true;
  reviseBtn.disabled = true;
  setStatus('loading', 'Generating');
  removeError();

  try {
    const data = await callApi('/api/floor-plans/generate', { description });
    renderPlan(data.plan);
    historyItems.unshift({
      type: 'generated',
      note: description,
      at: new Date().toISOString()
    });
    renderHistory();
    setStatus('success', 'Generated');
  } catch (error) {
    showError(error.message || 'Could not generate floor plan.');
    setStatus('error', 'Error');
  } finally {
    generateBtn.disabled = false;
    reviseBtn.disabled = false;
  }
});

reviseBtn.addEventListener('click', async () => {
  const revisionRequest = revisionEl.value.trim();

  if (!currentPlan) {
    showError('Generate a plan before requesting revisions.');
    setStatus('error', 'No plan');
    return;
  }

  if (!revisionRequest) {
    showError('Enter a revision request first.');
    setStatus('error', 'Missing revision');
    return;
  }

  generateBtn.disabled = true;
  reviseBtn.disabled = true;
  setStatus('loading', 'Revising');
  removeError();

  try {
    const data = await callApi('/api/floor-plans/revise', {
      currentProgram: currentPlan.program,
      revisionRequest
    });
    renderPlan(data.plan);
    historyItems.unshift({
      type: 'revision',
      note: revisionRequest,
      at: new Date().toISOString()
    });
    renderHistory();
    revisionEl.value = '';
    setStatus('success', 'Revised');
  } catch (error) {
    showError(error.message || 'Could not revise floor plan.');
    setStatus('error', 'Error');
  } finally {
    generateBtn.disabled = false;
    reviseBtn.disabled = false;
  }
});

setStatus('idle', 'Idle');
renderHistory();
