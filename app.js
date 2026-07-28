(() => {
  'use strict';

  const STORAGE_KEY = 'talamone-trip-v1';
  const VT_CACHE_KEY = 'talamone-vt-station-cache';
  const VT_BASE = 'https://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/';

  const boardBody = document.getElementById('board-body');
  const dateInput = document.getElementById('trip-date');
  const timeInput = document.getElementById('trip-time');
  const toggle = document.getElementById('stop-toggle');
  const toggleOpts = toggle.querySelectorAll('.toggle-opt');
  const resetBtn = document.getElementById('reset-btn');

  const directionToggle = document.getElementById('direction-toggle');
  const directionOpts = directionToggle.querySelectorAll('.toggle-opt');
  const profileToggle = document.getElementById('profile-toggle');
  const profileOpts = profileToggle.querySelectorAll('.toggle-opt');
  const stopFrom = document.getElementById('stop-from');
  const stopTo = document.getElementById('stop-to');
  const routeSub = document.getElementById('route-sub');

  const sheet = document.getElementById('flap-editor');
  const sheetTitle = document.getElementById('flap-editor-title');
  const sheetInput = document.getElementById('flap-editor-input');
  const sheetCancel = document.getElementById('flap-editor-cancel');
  const sheetSave = document.getElementById('flap-editor-save');

  const START_POINTS = {
    io: { label: 'Monterotondo, Stazione FS', title: 'MONTEROTONDO', sub: 'Stazione FS' },
    papa: { label: 'Flaminio, Roma', title: 'FLAMINIO (con papà)', sub: 'Flaminio' }
  };
  let direction = 'andata';
  let profile = 'io';
  let currentLegs = [];

  const gmaps = (from, to) =>
    `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(from)}&destination=${encodeURIComponent(to)}&travelmode=transit`;

  // ================= ViaggiaTreno (gratis, senza chiave, solo treni) =================
  function vtLoadCache() {
    try { return JSON.parse(localStorage.getItem(VT_CACHE_KEY)) || {}; }
    catch { return {}; }
  }
  function vtSaveCache(cache) {
    localStorage.setItem(VT_CACHE_KEY, JSON.stringify(cache));
  }

  async function vtResolveStationId(name) {
    const cache = vtLoadCache();
    const key = name.trim().toUpperCase();
    if (cache[key]) return cache[key];

    const query = name.split(',')[0].split('(')[0].trim(); // "Roma Termini" da "Roma Termini, ..."
    const res = await fetch(VT_BASE + 'autocompletaStazione/' + encodeURIComponent(query));
    if (!res.ok) throw new Error('ViaggiaTreno non raggiungibile (stazione "' + query + '").');
    const text = await res.text();
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('Nessuna stazione trovata per "' + query + '".');

    // preferisci la corrispondenza più vicina al nome cercato
    const upperQuery = query.toUpperCase();
    let best = lines[0];
    let bestScore = -1;
    lines.forEach(line => {
      const [stationName] = line.split('|');
      let score = 0;
      if (stationName === upperQuery) score = 100;
      else if (stationName.startsWith(upperQuery)) score = 50;
      else if (stationName.includes(upperQuery)) score = 10;
      if (score > bestScore) { bestScore = score; best = line; }
    });

    const id = best.split('|')[1];
    if (!id) throw new Error('Formato di risposta inatteso per "' + query + '".');
    cache[key] = id.trim();
    vtSaveCache(cache);
    return cache[key];
  }

  async function vtFetchJSON(path) {
    const res = await fetch(VT_BASE + path);
    if (!res.ok) throw new Error('ViaggiaTreno ha risposto con errore (' + res.status + ').');
    return res.json();
  }

  function vtDestinationKeywords(toText) {
    // estrae parole chiave "forti" dal nome destinazione per il match sui treni
    return toText
      .replace(/\(.*?\)/g, '')
      .split(/[\s,/]+/)
      .map(w => w.trim().toUpperCase())
      .filter(w => w.length > 3 && !['STAZIONE', 'ROMA', 'PORTO'].includes(w));
  }

  async function vtRefreshTrainLeg(leg) {
    const originId = await vtResolveStationId(leg.from);
    const date = dateInput.value;
    const time = timeInput.value || '08:00';
    const when = date ? new Date(`${date}T${time}:00`) : new Date();

    const departures = await vtFetchJSON('partenze/' + originId + '/' + encodeURIComponent(when.toString()));
    if (!Array.isArray(departures) || !departures.length) {
      throw new Error('Nessun treno in partenza trovato da questa stazione in quella fascia oraria.');
    }

    const keywords = vtDestinationKeywords(leg.to);
    const scored = departures.map(t => {
      const dest = (t.destinazione || '').toUpperCase();
      const matches = keywords.filter(k => dest.includes(k)).length;
      return { t, matches };
    }).sort((a, b) => b.matches - a.matches);

    const chosen = (scored[0] && scored[0].matches > 0) ? scored[0].t : departures[0];
    const approx = !(scored[0] && scored[0].matches > 0);

    const ritardo = typeof chosen.ritardo === 'number' ? chosen.ritardo : 0;
    const depTimeBase = chosen.compOrarioPartenza || '';
    leg.depTime = depTimeBase + (ritardo > 0 ? ` (+${ritardo}′)` : ritardo < 0 ? ` (${ritardo}′)` : '');
    const binarioPart = chosen.binarioEffettivoPartenzaDescrizione || chosen.binarioProgrammatoPartenzaDescrizione;
    if (binarioPart) setPlatform(leg.id, 'dep', String(binarioPart));

    leg.trainLabel = (chosen.compNumeroTreno || '').trim();
    leg.approxMatch = approx;

    // prova a recuperare orario/binario di arrivo dalla stazione di destinazione
    try {
      const destId = await vtResolveStationId(leg.to);
      const arrivals = await vtFetchJSON('arrivi/' + destId + '/' + encodeURIComponent(when.toString()));
      const match = Array.isArray(arrivals)
        ? arrivals.find(a => a.numeroTreno === chosen.numeroTreno)
        : null;
      if (match) {
        leg.arrTime = match.compOrarioArrivo || '';
        const binarioArr = match.binarioEffettivoArrivoDescrizione || match.binarioProgrammatoArrivoDescrizione;
        if (binarioArr) setPlatform(leg.id, 'arr', String(binarioArr));
      }
    } catch {
      // arrivo non recuperabile: lasciamo solo la partenza, nessun errore bloccante
    }

    return { approx };
  }

  // ================= Direzione (andata/ritorno) e profilo (io / con papà) =================
  function updateHeaderForDirection() {
    const sp = START_POINTS[profile];
    if (direction === 'andata') {
      stopFrom.textContent = sp.title;
      stopTo.textContent = 'TALAMONE';
      routeSub.textContent = `${sp.sub} → via Giuseppe Garibaldi, 5 · Fonteblanda, Orbetello (GR)`;
    } else {
      stopFrom.textContent = 'TALAMONE';
      stopTo.textContent = sp.title;
      routeSub.textContent = `Via Giuseppe Garibaldi, 5 → ${sp.sub} (RM)`;
    }
  }

  profileOpts.forEach(opt => {
    opt.addEventListener('click', () => {
      if (opt.dataset.val === profile) return;
      profileOpts.forEach(o => { o.classList.remove('is-active'); o.setAttribute('aria-checked', 'false'); });
      opt.classList.add('is-active');
      opt.setAttribute('aria-checked', 'true');
      profile = opt.dataset.val;
      updateHeaderForDirection();
      render();
    });
  });

  directionOpts.forEach(opt => {
    opt.addEventListener('click', () => {
      if (opt.dataset.val === direction) return;
      directionOpts.forEach(o => { o.classList.remove('is-active'); o.setAttribute('aria-checked', 'false'); });
      opt.classList.add('is-active');
      opt.setAttribute('aria-checked', 'true');
      direction = opt.dataset.val;
      updateHeaderForDirection();
      render();
    });
  });

  // ================= Itinerario =================
  function buildLegsAndata(mode, profile) {
    const legs = profile === 'papa' ? [
      {
        id: 'l1p', mode: 'metro', line: 'Metro A · direzione Anagnina',
        from: 'Flaminio', to: 'Roma Termini',
        note: 'Collegamento diretto, circa 10 min.',
        depTime: '', arrTime: '',
        live: gmaps('Flaminio', 'Roma Termini')
      }
    ] : [
      {
        id: 'l1', mode: 'treno', line: 'FL1',
        from: 'Monterotondo-Mentana', to: 'Roma Tiburtina',
        note: 'Diverse corse ogni ora, circa 30-35 min di viaggio.',
        depTime: '', arrTime: '',
        live: gmaps('Stazione Monterotondo-Mentana', 'Roma Tiburtina')
      },
      {
        id: 'l1b', mode: 'metro', line: 'Metro B · direzione Laurentina',
        from: 'Roma Tiburtina', to: 'Roma Termini',
        note: 'Collegamento interno a Roma, circa 10 min (o 15-20 min a piedi se preferisci).',
        depTime: '', arrTime: '',
        live: gmaps('Roma Tiburtina', 'Roma Termini')
      }
    ];

    if (mode === 'diretto') {
      legs.push({
        id: 'l2', mode: 'treno', line: 'Regionale / IC · linea Tirrenica',
        from: 'Roma Termini', to: 'Talamone',
        note: 'Verifica che il treno scelto fermi davvero a Talamone: è una fermata solo per alcuni regionali. Alcuni regionali partono da Tiburtina invece che da Termini: controlla il binario di partenza sul biglietto.',
        depTime: '', arrTime: '',
        live: gmaps('Roma Termini', 'Stazione di Talamone')
      });
      legs.push({
        id: 'l3', mode: 'bus', line: 'Autolinee Toscane',
        from: 'Stazione di Talamone', to: 'Talamone Porto',
        note: 'La stazione è a circa 4 km dal paese: bus di collegamento, in alternativa taxi.',
        depTime: '', arrTime: '',
        live: gmaps('Stazione di Talamone', 'Talamone Porto')
      });
    } else {
      legs.push({
        id: 'l2', mode: 'treno', line: 'Regionale / IC · linea Tirrenica',
        from: 'Roma Termini', to: 'Grosseto (o Orbetello)',
        note: 'Scegli Grosseto o Orbetello in base alla coincidenza bus migliore. Alcuni regionali partono da Tiburtina invece che da Termini: controlla il binario di partenza sul biglietto.',
        depTime: '', arrTime: '',
        live: gmaps('Roma Termini', 'Stazione di Grosseto')
      });
      legs.push({
        id: 'l3', mode: 'bus', line: 'Autolinee Toscane',
        from: 'Stazione di Grosseto / Orbetello', to: 'Talamone Porto',
        note: 'Corse meno frequenti dei treni: controlla l’orario prima di scegliere questa opzione.',
        depTime: '', arrTime: '',
        live: gmaps('Stazione di Grosseto', 'Talamone Porto')
      });
    }

    legs.push({
      id: 'l4', mode: 'piedi', line: 'A piedi',
      from: 'Talamone Porto', to: 'Via Giuseppe Garibaldi, 5',
      note: 'Pochi minuti nel centro storico, nessun binario.',
      depTime: '', arrTime: '',
      live: null, noPlatform: true
    });

    return legs;
  }

  function buildLegsRitorno(mode, profile) {
    const legs = [
      {
        id: 'r1', mode: 'piedi', line: 'A piedi',
        from: 'Via Giuseppe Garibaldi, 5', to: 'Talamone Porto',
        note: 'Pochi minuti nel centro storico, nessun binario.',
        depTime: '', arrTime: '',
        live: null, noPlatform: true
      }
    ];

    if (mode === 'diretto') {
      legs.push({
        id: 'r2', mode: 'bus', line: 'Autolinee Toscane',
        from: 'Talamone Porto', to: 'Stazione di Talamone',
        note: 'La stazione è a circa 4 km dal paese: bus di collegamento, in alternativa taxi.',
        depTime: '', arrTime: '',
        live: gmaps('Talamone Porto', 'Stazione di Talamone')
      });
      legs.push({
        id: 'r3', mode: 'treno', line: 'Regionale / IC · linea Tirrenica',
        from: 'Talamone', to: 'Roma Termini',
        note: 'Verifica che il treno scelto fermi davvero a Talamone: è una fermata solo per alcuni regionali. Alcuni regionali arrivano a Tiburtina invece che a Termini: controlla la stazione di arrivo sul biglietto.',
        depTime: '', arrTime: '',
        live: gmaps('Stazione di Talamone', 'Roma Termini')
      });
    } else {
      legs.push({
        id: 'r2', mode: 'bus', line: 'Autolinee Toscane',
        from: 'Talamone Porto', to: 'Stazione di Grosseto / Orbetello',
        note: 'Corse meno frequenti dei treni: controlla l’orario prima di scegliere questa opzione.',
        depTime: '', arrTime: '',
        live: gmaps('Talamone Porto', 'Stazione di Grosseto')
      });
      legs.push({
        id: 'r3', mode: 'treno', line: 'Regionale / IC · linea Tirrenica',
        from: 'Grosseto (o Orbetello)', to: 'Roma Termini',
        note: 'Scegli Grosseto o Orbetello in base alla coincidenza bus migliore. Alcuni regionali arrivano a Tiburtina invece che a Termini: controlla la stazione di arrivo sul biglietto.',
        depTime: '', arrTime: '',
        live: gmaps('Stazione di Grosseto', 'Roma Termini')
      });
    }

    if (profile === 'papa') {
      legs.push({
        id: 'r4p', mode: 'metro', line: 'Metro A · direzione Battistini',
        from: 'Roma Termini', to: 'Flaminio',
        note: 'Collegamento diretto, circa 10 min.',
        depTime: '', arrTime: '',
        live: gmaps('Roma Termini', 'Flaminio')
      });
    } else {
      legs.push({
        id: 'r3b', mode: 'metro', line: 'Metro B · direzione Rebibbia',
        from: 'Roma Termini', to: 'Roma Tiburtina',
        note: 'Collegamento interno a Roma, circa 10 min (o 15-20 min a piedi se preferisci).',
        depTime: '', arrTime: '',
        live: gmaps('Roma Termini', 'Roma Tiburtina')
      });

      legs.push({
        id: 'r4', mode: 'treno', line: 'FL1',
        from: 'Roma Tiburtina', to: 'Monterotondo-Mentana',
        note: 'Diverse corse ogni ora, circa 30-35 min di viaggio.',
        depTime: '', arrTime: '',
        live: gmaps('Roma Tiburtina', 'Stazione Monterotondo-Mentana')
      });
    }

    return legs;
  }

  function buildLegs() {
    const mode = toggle.querySelector('.is-active').dataset.val;
    return direction === 'ritorno' ? buildLegsRitorno(mode, profile) : buildLegsAndata(mode, profile);
  }

  const modeLabel = { treno: 'Treno', bus: 'Autobus', metro: 'Metro', piedi: 'A piedi' };
  const modeDot = { treno: 'dot-treno', bus: 'dot-bus', metro: 'dot-metro', piedi: 'dot-piedi' };

  // ================= Persistenza binari =================
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
    return `${direction}__${profile}__${date}__${mode}`;
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

  // ================= Render =================
  function render() {
    currentLegs = buildLegs();
    renderBoard(currentLegs);
  }

  function renderBoard(legs) {
    boardBody.innerHTML = '';

    legs.forEach(leg => {
      const row = document.createElement('div');
      row.className = 'leg-row' + (leg.mode === 'piedi' ? ' is-walk' : '');
      row.setAttribute('role', 'row');

      const modeCell = document.createElement('div');
      modeCell.className = 'leg-mode';
      modeCell.innerHTML = `<span class="dot ${modeDot[leg.mode]}"></span>${modeLabel[leg.mode]}`;
      row.appendChild(modeCell);

      const routeCell = document.createElement('div');
      routeCell.className = 'leg-route';
      const isTrain = leg.mode === 'treno';
      routeCell.innerHTML = `
        <span class="leg-line">${leg.line}</span>
        <span class="leg-from-to">${leg.from}${leg.to ? ' → ' + leg.to : ''}</span>
        ${leg.note ? `<span class="leg-note">${leg.note}</span>` : ''}
        ${isTrain ? `
          <div class="leg-refresh-row">
            <button type="button" class="leg-refresh" data-leg-id="${leg.id}">Aggiorna orario ↻</button>
            <span class="leg-refresh-msg"></span>
          </div>` : (leg.live ? `<a class="leg-gmaps" href="${leg.live}" target="_blank" rel="noopener">Apri su Google Maps ↗</a>` : '')}
      `;
      row.appendChild(routeCell);

      row.appendChild(buildCellGroup(leg));

      boardBody.appendChild(row);

      if (isTrain) {
        const btn = routeCell.querySelector('.leg-refresh');
        const msgEl = routeCell.querySelector('.leg-refresh-msg');
        btn.addEventListener('click', () => refreshTrainLeg(leg, btn, msgEl));
      }
    });

    updateInstallHint();
  }

  function refreshTrainLeg(leg, btn, msgEl) {
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Aggiorno…';
    msgEl.textContent = '';
    msgEl.className = 'leg-refresh-msg';

    vtRefreshTrainLeg(leg)
      .then(({ approx }) => {
        const depEl = document.getElementById(`time-${leg.id}-dep`);
        const arrEl = document.getElementById(`time-${leg.id}-arr`);
        if (depEl) depEl.textContent = leg.depTime || 'consulta live';
        if (arrEl) arrEl.textContent = leg.arrTime || 'consulta live';

        const depFlap = document.querySelector(`[data-flap="${leg.id}-dep"]`);
        const arrFlap = document.querySelector(`[data-flap="${leg.id}-arr"]`);
        const depVal = getPlatform(leg.id, 'dep');
        const arrVal = getPlatform(leg.id, 'arr');
        if (depFlap) { depFlap.textContent = depVal || '?'; depFlap.className = 'flap flap-flip ' + (depVal ? 'is-set' : 'is-empty'); }
        if (arrFlap) { arrFlap.textContent = arrVal || '?'; arrFlap.className = 'flap flap-flip ' + (arrVal ? 'is-set' : 'is-empty'); }

        msgEl.textContent = (leg.trainLabel ? leg.trainLabel + ' — ' : '') + (approx ? 'corrispondenza approssimativa, verifica.' : 'aggiornato ora.');
        msgEl.className = 'leg-refresh-msg ' + (approx ? 'is-warn' : 'is-ok');
      })
      .catch((err) => {
        const isNetErr = err instanceof TypeError;
        msgEl.textContent = isNetErr
          ? 'ViaggiaTreno non raggiungibile da qui (possibile blocco del browser). Controlla su viaggiatreno.it.'
          : (err.message || 'Errore nell\'aggiornamento.');
        msgEl.className = 'leg-refresh-msg is-error';
      })
      .finally(() => {
        btn.disabled = false;
        btn.textContent = originalText;
      });
  }

  function buildCellGroup(leg) {
    const group = document.createElement('div');
    group.className = 'leg-cell-group';

    group.appendChild(buildTimeCell('Partenza', leg.depTime || 'consulta live', `time-${leg.id}-dep`));
    group.appendChild(buildFlapCell(leg, 'dep', 'Bin. partenza'));
    group.appendChild(buildTimeCell('Arrivo', leg.arrTime || 'consulta live', `time-${leg.id}-arr`));
    group.appendChild(buildFlapCell(leg, 'arr', 'Bin. arrivo'));

    return group;
  }

  function buildTimeCell(label, value, id) {
    const cell = document.createElement('div');
    cell.className = 'time-cell';
    cell.innerHTML = `<span class="cell-label">${label}</span><span class="time-value" id="${id || ''}">${value}</span>`;
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
    btn.dataset.flap = `${leg.id}-${which}`;
    const value = getPlatform(leg.id, which);
    btn.className = 'flap ' + (value ? 'is-set' : 'is-empty');
    btn.textContent = value || '?';
    btn.setAttribute('aria-label', `${label} per ${leg.from}${leg.to ? ' → ' + leg.to : ''}. ${value ? 'Valore attuale ' + value : 'Non ancora inserito'}`);
    btn.addEventListener('click', () => openEditor(leg, which, label, btn));
    cell.appendChild(btn);
    return cell;
  }

  // ================= Editor a foglio =================
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

  // ================= Controlli =================
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

  // Data/ora di default: adesso
  (function initDate() {
    const now = new Date();
    dateInput.value = now.toISOString().slice(0, 10);
    dateInput.min = now.toISOString().slice(0, 10);
    timeInput.value = now.toTimeString().slice(0, 5);
  })();

  updateHeaderForDirection();
  render();

  // ================= Service worker =================
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }
})();
