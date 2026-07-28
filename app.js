(() => {
  'use strict';

  const STORAGE_KEY = 'talamone-trip-v1';
  const boardBody = document.getElementById('board-body');
  const dateInput = document.getElementById('trip-date');
  const toggle = document.getElementById('stop-toggle');
  const toggleOpts = toggle.querySelectorAll('.toggle-opt');
  const resetBtn = document.getElementById('reset-btn');

  const sheet = document.getElementById('flap-editor');
  const sheetTitle = document.getElementById('flap-editor-title');
  const sheetInput = document.getElementById('flap-editor-input');
  const sheetCancel = document.getElementById('flap-editor-cancel');
  const sheetSave = document.getElementById('flap-editor-save');

  const gmaps = (from, to) =>
    `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=transit`;

  // ---- Itinerario: la struttura non cambia, solo alcuni tratti in base al toggle ----
  function buildLegs(mode) {
    const legs = [
      {
        id: 'l1',
        mode: 'treno',
        line: 'FL1',
        from: 'Monterotondo-Mentana',
        to: 'Roma Tiburtina / Termini',
        note: 'Diverse corse ogni ora, circa 30-35 min di viaggio.',
        live: gmaps('Stazione Monterotondo-Mentana', 'Roma Tiburtina')
      }
    ];

    if (mode === 'diretto') {
      legs.push({
        id: 'l2',
        mode: 'treno',
        line: 'Regionale / IC · linea Tirrenica',
        from: 'Roma Tiburtina / Termini',
        to: 'Talamone',
        note: 'Verifica che il treno scelto sia tra quelli che fermano davvero a Talamone: è una fermata solo per alcuni regionali.',
        live: gmaps('Roma Termini', 'Stazione di Talamone')
      });
      legs.push({
        id: 'l3',
        mode: 'bus',
        line: 'Autolinee Toscane',
        from: 'Stazione di Talamone',
        to: 'Talamone Porto',
        note: 'La stazione è a circa 4 km dal paese: bus di collegamento, in alternativa taxi.',
        live: gmaps('Stazione di Talamone', 'Talamone Porto')
      });
    } else {
      legs.push({
        id: 'l2',
        mode: 'treno',
        line: 'Regionale / IC · linea Tirrenica',
        from: 'Roma Tiburtina / Termini',
        to: 'Grosseto (o Orbetello)',
        note: 'Scegli Grosseto o Orbetello in base alla coincidenza bus migliore per l’orario che trovi.',
        live: gmaps('Roma Termini', 'Stazione di Grosseto')
      });
      legs.push({
        id: 'l3',
        mode: 'bus',
        line: 'Autolinee Toscane',
        from: 'Stazione di Grosseto / Orbetello',
        to: 'Talamone Porto',
        note: 'Corse meno frequenti dei treni: controlla l’orario prima di scegliere questa opzione.',
        live: gmaps('Stazione di Grosseto', 'Talamone Porto')
      });
    }

    legs.push({
      id: 'l4',
      mode: 'piedi',
      line: 'A piedi',
      from: 'Talamone Porto',
      to: 'Via Giuseppe Garibaldi, 5',
      note: 'Pochi minuti nel centro storico, nessun binario.',
      live: null,
      noPlatform: true
    });

    return legs;
  }

  const modeLabel = { treno: 'Treno', bus: 'Autobus', piedi: 'A piedi' };
  const modeDot = { treno: 'dot-treno', bus: 'dot-bus', piedi: 'dot-piedi' };

  // ---- Persistenza binari ----
  function loadStore() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch { return {}; }
  }
  function saveStore(store) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  }
  function tripKey() {
    const date = dateInput.value || 'senza-data';
    const mode = toggle.querySelector('.is-active').dataset.val;
    return `${date}__${mode}`;
  }
  function getPlatform(legId, which) {
    const store = loadStore();
    const trip = store[tripKey()] || {};
    return trip[`${legId}_${which}`] || '';
  }
  function setPlatform(legId, which, value) {
    const store = loadStore();
    const key = tripKey();
    store[key] = store[key] || {};
    store[key][`${legId}_${which}`] = value;
    saveStore(store);
  }

  // ---- Render ----
  let currentLegs = [];

  function render() {
    const mode = toggle.querySelector('.is-active').dataset.val;
    currentLegs = buildLegs(mode);
    boardBody.innerHTML = '';

    currentLegs.forEach(leg => {
      const row = document.createElement('div');
      row.className = 'leg-row' + (leg.mode === 'piedi' ? ' is-walk' : '');
      row.setAttribute('role', 'row');

      const modeCell = document.createElement('div');
      modeCell.className = 'leg-mode';
      modeCell.innerHTML = `<span class="dot ${modeDot[leg.mode]}"></span>${modeLabel[leg.mode]}`;
      row.appendChild(modeCell);

      const routeCell = document.createElement('div');
      routeCell.className = 'leg-route';
      routeCell.innerHTML = `
        <span class="leg-line">${leg.line}</span>
        <span class="leg-from-to">${leg.from} → ${leg.to}</span>
        <span class="leg-note">${leg.note}</span>
        ${leg.live ? `<a class="leg-live" href="${leg.live}" target="_blank" rel="noopener">Verifica orario live ↗</a>` : ''}
      `;
      row.appendChild(routeCell);

      row.appendChild(buildCellGroup(leg));

      boardBody.appendChild(row);
    });

    updateInstallHint();
  }

  function buildCellGroup(leg) {
    const group = document.createElement('div');
    group.className = 'leg-cell-group';

    group.appendChild(buildTimeCell('Partenza', 'consulta live'));
    group.appendChild(buildFlapCell(leg, 'dep', 'Bin. partenza'));
    group.appendChild(buildTimeCell('Arrivo', 'consulta live'));
    group.appendChild(buildFlapCell(leg, 'arr', 'Bin. arrivo'));

    return group;
  }

  function buildTimeCell(label, value) {
    const cell = document.createElement('div');
    cell.className = 'time-cell';
    cell.innerHTML = `<span class="cell-label">${label}</span><span class="time-value">${value}</span>`;
    return cell;
  }

  function buildFlapCell(leg, which, label) {
    const cell = document.createElement('div');
    cell.className = 'time-cell';

    const cellLabel = document.createElement('span');
    cellLabel.className = 'cell-label';
    cellLabel.textContent = label;
    cell.appendChild(cellLabel);

    if (leg.noPlatform) {
      const span = document.createElement('span');
      span.className = 'flap is-empty';
      span.textContent = '—';
      cell.appendChild(span);
      return cell;
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    const value = getPlatform(leg.id, which);
    btn.className = 'flap ' + (value ? 'is-set' : 'is-empty');
    btn.textContent = value || '?';
    btn.setAttribute('aria-label', `${label} per ${leg.from} → ${leg.to}. ${value ? 'Valore attuale ' + value : 'Non ancora inserito'}`);
    btn.addEventListener('click', () => openEditor(leg, which, label, btn));
    cell.appendChild(btn);
    return cell;
  }

  // ---- Editor a foglio ----
  let editingCtx = null;

  function openEditor(leg, which, label, btn) {
    editingCtx = { leg, which, btn };
    sheetTitle.textContent = label;
    sheetInput.value = getPlatform(leg.id, which);
    sheet.hidden = false;
    setTimeout(() => sheetInput.focus(), 50);
  }

  function closeEditor() {
    sheet.hidden = true;
    editingCtx = null;
  }

  sheetCancel.addEventListener('click', closeEditor);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) closeEditor(); });

  sheetSave.addEventListener('click', () => {
    if (!editingCtx) return;
    const value = sheetInput.value.trim();
    setPlatform(editingCtx.leg.id, editingCtx.which, value);
    editingCtx.btn.textContent = value || '?';
    editingCtx.btn.className = 'flap flap-flip ' + (value ? 'is-set' : 'is-empty');
    closeEditor();
  });

  sheetInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sheetSave.click();
    if (e.key === 'Escape') closeEditor();
  });

  // ---- Controlli ----
  toggleOpts.forEach(opt => {
    opt.addEventListener('click', () => {
      toggleOpts.forEach(o => { o.classList.remove('is-active'); o.setAttribute('aria-checked', 'false'); });
      opt.classList.add('is-active');
      opt.setAttribute('aria-checked', 'true');
      render();
    });
  });

  dateInput.addEventListener('change', render);

  resetBtn.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    render();
  });

  function updateInstallHint() {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    document.getElementById('install-hint').hidden = !!isStandalone;
  }

  // Data di default: oggi
  (function initDate() {
    const today = new Date();
    dateInput.value = today.toISOString().slice(0, 10);
    dateInput.min = today.toISOString().slice(0, 10);
  })();

  render();

  // ---- Service worker ----
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
